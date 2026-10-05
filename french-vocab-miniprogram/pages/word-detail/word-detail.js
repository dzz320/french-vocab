const api = require('../../utils/api')
const llm = require('../../utils/llm')
const srs = require('../../utils/srs')
const audio = require('../../utils/audio')
const { friendlyError } = require('../../utils/cloud')
const { formatCN } = require('../../utils/date')

const EMPTY_FORM = {
  word: '',
  phonetic: '',
  pos: '',
  meaning_zh: '',
  example_fr: '',
  example_zh: '',
  mnemonic: '',
}

/**
 * 取 query 里的词形。小程序对 navigateTo 的 query 通常已经解过一次码，
 * 但不同基础库/不同入口（如扫码 scene）行为不一致，所以做一次容错：
 * 带 % 才解，解不开就按原样用。词形只可能是字母 + 词内连接符，含 % 必然是没解过的。
 */
function decodeParam(v) {
  const s = v == null ? '' : String(v)
  if (s.indexOf('%') < 0) return s
  try {
    return decodeURIComponent(s)
  } catch (e) {
    return s
  }
}

Page({
  data: {
    loading: false,
    isNew: true,
    form: Object.assign({}, EMPTY_FORM),
    saving: false,
    aiBusy: false,
    aiExampleBusy: false,
    stageLabel: '',
    dueText: '',
    // 所属词库：0 表示不归入任何词库
    libraryOptions: ['不归入词库'],
    libraryIds: [0],
    libraryPick: 0,
    libraryLabel: '不归入词库',
    // 从例句点进来、但库里没有这个词时的提示（普通新增保持空）
    prefillNote: '',
    // 正在播放的是哪个喇叭（'word' | 'example' | ''），由 utils/audio 回填
    playingKey: '',
  },

  onLoad(options) {
    this.wordId = options && options.id ? Number(options.id) : null
    this.setData({ isNew: !this.wordId })
    audio.bindPage(this)
    this.loadLibraries()
    if (this.wordId) {
      this.load()
      return
    }
    // 例句点词但库里没有 → 预填词形开新增页，别让用户重新敲一遍
    const pre = decodeParam(options && options.word)
    if (pre) {
      this.setData({
        'form.word': pre,
        prefillNote: '生词本里还没有「' + pre + '」，补全释义后保存即可',
      })
    }
  },

  /** 词库下拉；拿不到也不阻塞编辑，只是不能改归属 */
  async loadLibraries() {
    try {
      const libs = await api.listLibraries()
      const options = ['不归入词库'].concat(libs.map((l) => l.name))
      const ids = [0].concat(libs.map((l) => l.id))
      this.setData({ libraryOptions: options, libraryIds: ids })
      this.syncLibraryPick(this.data.isNew ? 0 : this.currentLibraryId || 0)
    } catch (e) {
      /* 忽略：词库是可选信息 */
    }
  },

  syncLibraryPick(libraryId) {
    const ids = this.data.libraryIds
    let idx = ids.indexOf(Number(libraryId) || 0)
    if (idx < 0) idx = 0
    this.setData({ libraryPick: idx, libraryLabel: this.data.libraryOptions[idx] })
  },

  onLibrary(e) {
    const idx = Number(e.detail.value)
    const id = this.data.libraryIds[idx] || 0
    this.setData({ libraryPick: idx, libraryLabel: this.data.libraryOptions[idx] })
    this.pickedLibraryId = id
  },

  async load() {
    this.setData({ loading: true })
    try {
      const word = await api.getWord(this.wordId)
      if (!word) {
        wx.showToast({ title: '生词不存在', icon: 'none' })
        setTimeout(() => wx.navigateBack(), 600)
        return
      }
      this.word = word
      this.currentLibraryId = Number(word.library_id) || 0
      this.pickedLibraryId = this.currentLibraryId
      this.setData({
        loading: false,
        isNew: false,
        form: {
          word: word.word || '',
          phonetic: word.phonetic || '',
          pos: word.pos || '',
          meaning_zh: word.meaning_zh || '',
          example_fr: word.example_fr || '',
          example_zh: word.example_zh || '',
          mnemonic: word.mnemonic || '',
        },
        stageLabel: srs.stageLabel(word),
        dueText: word.due_date ? formatCN(word.due_date) : '',
      })
      this.syncLibraryPick(this.currentLibraryId)
    } catch (e) {
      this.setData({ loading: false })
      wx.showToast({ title: friendlyError(e), icon: 'none' })
    }
  },

  onField(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ ['form.' + field]: e.detail.value })
  },

  /** 读单词：直接读输入框里的现值，改完不用先保存就能听 */
  speakWord() {
    audio.playWithGuard('word', this.data.form.word, '请先输入法语单词')
  },

  speakExample() {
    audio.playWithGuard('example', this.data.form.example_fr, '请先填写法语例句')
  },

  onUnload() {
    audio.stop()
  },

  async aiComplete() {
    const word = this.data.form.word.trim()
    if (!word) {
      wx.showToast({ title: '请先输入法语单词', icon: 'none' })
      return
    }
    this.setData({ aiBusy: true })
    try {
      const res = await llm.completeWord(word)
      const form = this.data.form
      this.setData({
        aiBusy: false,
        form: {
          word: form.word,
          phonetic: form.phonetic || res.phonetic,
          pos: form.pos || res.pos,
          meaning_zh: form.meaning_zh || res.meaning_zh,
          example_fr: form.example_fr || res.example_fr,
          example_zh: form.example_zh || res.example_zh,
          mnemonic: form.mnemonic,
        },
      })
    } catch (e) {
      this.setData({ aiBusy: false })
      wx.showToast({ title: friendlyError(e), icon: 'none' })
    }
  },

  async aiExample() {
    const form = this.data.form
    const word = form.word.trim()
    if (!word) {
      wx.showToast({ title: '请先输入法语单词', icon: 'none' })
      return
    }
    this.setData({ aiExampleBusy: true })
    try {
      const res = await llm.generateExample(word, form.meaning_zh)
      this.setData({
        aiExampleBusy: false,
        'form.example_fr': res.example_fr || form.example_fr,
        'form.example_zh': res.example_zh || form.example_zh,
        'form.mnemonic': res.mnemonic || form.mnemonic,
      })
    } catch (e) {
      this.setData({ aiExampleBusy: false })
      wx.showToast({ title: friendlyError(e), icon: 'none' })
    }
  },

  async save() {
    const form = this.data.form
    const word = form.word.trim()
    if (!word) {
      wx.showToast({ title: '请输入法语单词', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    try {
      const payload = {
        word,
        phonetic: form.phonetic.trim(),
        pos: form.pos.trim(),
        meaning_zh: form.meaning_zh.trim(),
        example_fr: form.example_fr.trim(),
        example_zh: form.example_zh.trim(),
        mnemonic: form.mnemonic.trim(),
      }
      // 词库归属：0（或未选）写成 null，否则存词库 id
      const libId = typeof this.pickedLibraryId === 'number' ? this.pickedLibraryId : this.currentLibraryId || 0
      payload.library_id = libId || null
      // 以 wordId 为准判断新增还是编辑（data.isNew 只用于标题展示）
      if (this.wordId) {
        await api.updateWord(this.wordId, payload)
      } else {
        await api.createWord(Object.assign({ source: 'manual' }, payload))
      }
      getApp().markDirty()
      wx.showToast({ title: '已保存', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 500)
    } catch (e) {
      this.setData({ saving: false })
      wx.showToast({ title: friendlyError(e), icon: 'none' })
    }
  },

  resetSrs() {
    wx.showModal({
      title: '重置学习进度',
      content: '该词将回到「新词」状态并重新进入学习队列，确定吗？',
      success: async (res) => {
        if (!res.confirm) return
        try {
          await api.resetWordSrs(this.wordId)
          getApp().markDirty()
          wx.showToast({ title: '已重置', icon: 'success' })
          this.load()
        } catch (e) {
          wx.showToast({ title: friendlyError(e), icon: 'none' })
        }
      },
    })
  },

  confirmDelete() {
    wx.showModal({
      title: '删除生词',
      content: '删除后不可恢复，确定删除「' + this.data.form.word + '」吗？',
      confirmText: '删除',
      confirmColor: '#D64545',
      success: async (res) => {
        if (!res.confirm) return
        try {
          await api.deleteWord(this.wordId)
          getApp().markDirty()
          wx.showToast({ title: '已删除', icon: 'success' })
          setTimeout(() => wx.navigateBack(), 500)
        } catch (e) {
          wx.showToast({ title: friendlyError(e), icon: 'none' })
        }
      },
    })
  },
})
