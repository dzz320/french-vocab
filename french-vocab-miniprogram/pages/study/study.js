const api = require('../../utils/api')
const srs = require('../../utils/srs')
const audio = require('../../utils/audio')
const frText = require('../../utils/fr-text')
const { todayLocal } = require('../../utils/date')
const { requireSession, friendlyError } = require('../../utils/cloud')

const MODE_LABEL = { new: '学习新词', review: '复习', mixed: '混合学习' }
const MAX_REQUEUE = 2

Page({
  data: {
    loading: true,
    error: '',
    signedIn: false,
    index: 0,
    modeLabel: '',
    total: 0,
    answered: 0,
    percent: 0,
    card: null,
    flipped: false,
    // 例句的逐词片段（可点的单词 + 标点），由 utils/fr-text 切出来
    exampleParts: [],
    // 正在播放的是哪个喇叭（'word' | 'example' | ''），由 utils/audio 回填
    playingKey: '',
    finished: false,
    summary: { total: 0, correct: 0, wrong: 0, newCount: 0 },
    summaryEmoji: '🎉',
    finishedTitle: '',
    finishedDesc: '',
  },

  onLoad(options) {
    const mode = options && options.mode ? options.mode : 'mixed'
    this.mode = mode === 'new' || mode === 'review' ? mode : 'mixed'
    this.unitId = options && options.unitId ? Number(options.unitId) : null
    this.queue = []
    this.wordMap = Object.create(null)
    this.firstAnswer = Object.create(null)
    this.requeueCount = Object.create(null)
    // 例句点词的查库结果缓存（词形 → 生词或 null），同一句里反复点不重复查库
    this.lookupCache = Object.create(null)
    this.lookupBusy = false
    // 接管播放态与 onUnload（页面卸载时自动停止发音）
    audio.bindPage(this)
    this.setData({ modeLabel: MODE_LABEL[this.mode] })
    this.load()
  },

  reload() {
    this.setData({ loading: true, error: '' })
    this.load()
  },

  async load() {
    try {
      await requireSession()
      const today = todayLocal()
      const plan = await api.getActivePlan()
      const N = plan ? Number(plan.daily_new) || 10 : 10
      const C = plan ? Number(plan.daily_review_cap) || 50 : 50
      const todayNewDone = await api.countTodayNew(today)

      let newWords = []
      let dueWords = []
      if (this.mode !== 'review') {
        const limit = Math.max(0, N - todayNewDone)
        newWords = limit > 0 ? await api.listFreshWords(limit) : []
        if (this.unitId) newWords = newWords.filter((w) => w.unit_id === this.unitId)
      }
      if (this.mode !== 'new') {
        dueWords = await api.listDueWords(today, C)
        if (this.unitId) dueWords = dueWords.filter((w) => w.unit_id === this.unitId)
      }

      this.queue = srs.buildQueue(newWords, dueWords, this.mode)
      this.queue.forEach((w) => {
        this.wordMap[w.id] = w
      })
      this.total = this.queue.length
      this.setData({
        loading: false,
        signedIn: true,
        total: this.total,
        answered: 0,
        percent: 0,
        finished: false,
      })
      if (!this.queue.length) {
        this.showSummary(true)
        return
      }
      this.setData({ index: 0 })
      this.showCard()
    } catch (e) {
      this.setData({ loading: false, error: friendlyError(e) })
    }
  },

  showCard() {
    const card = this.queue[this.data.index]
    if (!card) {
      this.finish()
      return
    }
    // 换卡片就掐掉上一张的发音，否则连着点会叠着响
    audio.stop()
    this.setData({
      card: {
        id: card.id,
        word: card.word,
        phonetic: card.phonetic || '',
        pos: card.pos || '',
        meaning_zh: card.meaning_zh || '',
        example_fr: card.example_fr || '',
        example_zh: card.example_zh || '',
        mnemonic: card.mnemonic || '',
        kind: srs.isFresh(card) ? 'new' : 'review',
      },
      flipped: false,
      exampleParts: frText.tokenize(card.example_fr || ''),
    })
    // 预热：不等用户点就先把这个词下到本地，点的时候直接读文件，零延迟
    audio.prefetch(card.word)
    // 自动发音是可选开关（「我的」→ 发音设置），默认关：
    // 首张卡片不在用户手势里，系统可能直接拦掉，静默失败反而像 bug。
    if (audio.getPrefs().autoPlay) this.speakWord()
  },

  /** 读单词（音标旁那个喇叭） */
  speakWord() {
    const card = this.data.card
    if (!card || !card.word) return
    audio.play('word', card.word)
  },

  /** 读例句：整块例句可点，不用精准戳到小喇叭 */
  speakExample() {
    const card = this.data.card
    if (!card || !card.example_fr) return
    audio.play('example', card.example_fr)
  },

  /**
   * 点例句里的单词：
   *   库里已有这个词 → 跳到它的生词详情
   *   库里没有       → 带着这个词开新增页（不静默吞掉点击，否则像点了没反应）
   * 例句里的词常是变位/复数形式，精确匹配会大量落空，所以按候选词形依次查
   * （整词 → 本词 → 语素，见 utils/fr-text.js）。
   */
  async onExampleWord(e) {
    const raw = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.word) || ''
    const token = String(raw).trim()
    if (!/[A-Za-zÀ-ÖØ-ÿŒœ]/.test(token)) return
    // 查库有一次往返，连点会开出多个页面
    if (this.lookupBusy) return
    this.lookupBusy = true
    audio.stop()
    wx.showLoading({ title: '查词中', mask: false })
    try {
      const hit = await this.lookup(token)
      wx.hideLoading()
      const url = hit
        ? '/pages/word-detail/word-detail?id=' + hit.id
        : '/pages/word-detail/word-detail?word=' + encodeURIComponent(frText.headWord(token) || token)
      wx.navigateTo({ url })
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: friendlyError(err), icon: 'none' })
    } finally {
      this.lookupBusy = false
    }
  },

  /** 候选词形逐个查，命中即返回；结果缓存到本次学习会话 */
  async lookup(token) {
    const cache = this.lookupCache || (this.lookupCache = Object.create(null))
    const cands = frText.lookupCandidates(token)
    for (let i = 0; i < cands.length; i++) {
      const key = cands[i].toLowerCase()
      if (key in cache) {
        if (cache[key]) return cache[key]
        continue
      }
      const hit = await api.findWordByText(cands[i])
      cache[key] = hit || null
      if (hit) return hit
    }
    return null
  },

  flip() {
    if (this.data.flipped) return
    // 翻到背面时把例句也预热掉
    if (this.data.card) audio.prefetch(this.data.card.example_fr)
    this.setData({ flipped: true })
  },

  answerRight() {
    this.answer(true)
  },
  answerWrong() {
    this.answer(false)
  },

  answer(correct) {
    const card = this.data.card
    if (!card) return
    const id = card.id
    // 首次作答决定 SRS 状态与日志（会话内重复作答只作强化，不重复记账，
    // 避免同一天同一词被多次计数，也不奖励"蒙对"）
    if (!(id in this.firstAnswer)) {
      this.firstAnswer[id] = { correct, kind: card.kind }
    }
    if (!correct) {
      const retried = Number(this.requeueCount[id] || 0)
      if (retried < MAX_REQUEUE) {
        this.requeueCount[id] = retried + 1
        const rest = this.queue.slice(this.data.index + 1)
        rest.splice(Math.min(3, rest.length), 0, this.queue[this.data.index])
        this.queue = this.queue.slice(0, this.data.index + 1).concat(rest)
      }
    }
    const answered = Object.keys(this.firstAnswer).length
    this.setData({
      answered,
      percent: this.total ? Math.round((answered / this.total) * 100) : 100,
    })
    this.advance()
  },

  advance() {
    const nextIndex = this.data.index + 1
    if (nextIndex >= this.queue.length) {
      this.finish()
      return
    }
    this.setData({ index: nextIndex })
    this.showCard()
  },

  async finish() {
    const ids = Object.keys(this.firstAnswer)
    const today = todayLocal()
    if (!ids.length) {
      this.showSummary(true)
      return
    }
    this.setData({ loading: true })
    try {
      const updates = []
      const logs = []
      let correct = 0
      let wrong = 0
      let newCount = 0
      ids.forEach((key) => {
        const entry = this.firstAnswer[key]
        const word = this.wordMap[Number(key)]
        if (entry.correct) correct += 1
        else wrong += 1
        if (entry.kind === 'new') newCount += 1
        if (word) updates.push(api.updateWord(word.id, srs.applyResult(word, entry.correct, today)))
        logs.push({
          word_id: Number(key),
          kind: entry.kind,
          result: entry.correct ? 'correct' : 'wrong',
          reviewed_on: today,
        })
      })
      await Promise.all([Promise.all(updates), api.insertLogs(logs)])
      getApp().markDirty()
      this.setData({ loading: false })
      this.showSummary(false, { total: ids.length, correct, wrong, newCount })
    } catch (e) {
      this.setData({ loading: false })
      wx.showToast({ title: '学习记录保存失败：' + friendlyError(e), icon: 'none' })
      this.showSummary(false, { total: ids.length, correct: 0, wrong: 0, newCount: 0 }, true)
    }
  },

  showSummary(empty, summary, saveFailed) {
    const s = summary || { total: 0, correct: 0, wrong: 0, newCount: 0 }
    let title = '本轮完成！'
    let desc = '继续保持，每天进步一点点'
    let emoji = '🎉'
    if (empty) {
      title = this.mode === 'review' ? '今天没有需要复习的词' : '今日任务已完成'
      desc = this.mode === 'review' ? '明天再来复习吧' : '可以去教材或生词本添加新词'
      emoji = '☕'
    } else if (saveFailed) {
      title = '学习已完成'
      desc = '但记录保存失败，请稍后在生词本查看'
      emoji = '⚠️'
    } else if (s.total > 0 && s.wrong === 0) {
      desc = '全对！太棒了，继续保持 🇫🇷'
    }
    this.setData({
      finished: true,
      loading: false,
      card: null,
      summary: s,
      summaryEmoji: emoji,
      finishedTitle: title,
      finishedDesc: desc,
    })
    audio.stop()
  },

  onUnload() {
    audio.stop()
  },

  confirmExit() {
    const answered = Object.keys(this.firstAnswer).length
    if (!answered) {
      wx.navigateBack()
      return
    }
    wx.showModal({
      title: '结束学习',
      content: '已作答 ' + answered + ' 个词，退出会保存这些记录。确定结束吗？',
      confirmText: '结束',
      success: (res) => {
        if (res.confirm) this.finish()
      },
    })
  },

  goBack() {
    wx.navigateBack()
  },
})
