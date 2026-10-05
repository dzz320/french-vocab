const api = require('../../utils/api')
const llm = require('../../utils/llm')
const audio = require('../../utils/audio')
const { cloud, friendlyError } = require('../../utils/cloud')
const { todayLocal, addDays, formatCN, computeStreak } = require('../../utils/date')

Page({
  data: {
    signedIn: false,
    error: '',
    streak: 0,
    totalCount: 0,
    masteredCount: 0,
    learningCount: 0,
    week: [],
    planName: '',
    advice: '',
    adviceBusy: false,
    adviceError: '',
    avatarText: 'FR',
    // 发音偏好（存在本地，不占云端表）
    autoPlay: false,
    ignoreMute: true,
    audioStatus: '',
  },

  onShow() {
    const prefs = audio.getPrefs()
    this.setData({ autoPlay: prefs.autoPlay, ignoreMute: prefs.ignoreMute })
    this.refresh()
  },

  onAutoPlay(e) {
    const prefs = audio.setPrefs({ autoPlay: !!e.detail.value })
    this.setData({ autoPlay: prefs.autoPlay })
  },

  onIgnoreMute(e) {
    const prefs = audio.setPrefs({ ignoreMute: !!e.detail.value })
    this.setData({ ignoreMute: prefs.ignoreMute })
  },

  /** 试听：一句话里特意带上「兜底音源读不出来」的词，用来当场验证新音源通不通 */
  testAudio() {
    if (!audio.isEnabled()) {
      wx.showToast({ title: '发音功能已关闭', icon: 'none' })
      return
    }
    audio.play('test', 'Test de prononciation : abbaye, thème, gêner.')
    const st = audio.getState()
    this.setData({ audioStatus: st.source ? '正在使用音源：' + st.source : '' })
  },

  async refresh() {
    const app = getApp()
    let user = null
    try {
      user = await app.globalData.loginReady
    } catch (e) {
      user = null
    }
    if (!user) {
      this.setData({ signedIn: false, error: '' })
      return
    }
    this.setData({ signedIn: true, error: '' })
    try {
      const today = todayLocal()
      const counts = await api.countWordsByStatus()
      const logs = await api.recentLogs(addDays(today, -6))
      const plan = await api.getActivePlan()

      const days = []
      for (let i = 6; i >= 0; i--) {
        const date = addDays(today, -i)
        const count = logs.filter((l) => l.reviewed_on === date).length
        days.push({ date, count })
      }
      const max = Math.max.apply(null, [1].concat(days.map((d) => d.count)))
      const week = days.map((d) => ({
        date: d.date,
        label: formatCN(d.date),
        count: d.count,
        height: Math.max(4, Math.round((d.count / max) * 100)),
      }))

      let planName = ''
      if (plan) {
        if (plan.book_id) {
          try {
            const book = await api.getBook(plan.book_id)
            planName = book ? book.title : ''
          } catch (e) {
            planName = ''
          }
        } else {
          planName = '每日 ' + (Number(plan.daily_new) || 10) + ' 词'
        }
      }

      this.setData({
        streak: computeStreak(logs.map((l) => l.reviewed_on), today),
        totalCount: counts.learning + counts.mastered,
        masteredCount: counts.mastered,
        learningCount: counts.learning,
        week,
        planName,
      })
    } catch (e) {
      wx.showToast({ title: friendlyError(e), icon: 'none' })
    }
  },

  async login() {
    this.setData({ error: '' })
    try {
      const { ensureLogin } = require('../../utils/cloud')
      await ensureLogin()
      this.refresh()
    } catch (e) {
      this.setData({ error: friendlyError(e) })
    }
  },

  async logout() {
    try {
      await cloud.auth.signOut()
      getApp().globalData.user = null
      this.setData({ signedIn: false, advice: '', week: [], streak: 0 })
    } catch (e) {
      wx.showToast({ title: friendlyError(e), icon: 'none' })
    }
  },

  async genAdvice() {
    if (this.data.adviceBusy) return
    this.setData({ adviceBusy: true, adviceError: '' })
    try {
      const today = todayLocal()
      const plan = await api.getActivePlan()
      const counts = await api.countWordsByStatus()
      const logs = await api.recentLogs(addDays(today, -6))
      const days = []
      for (let i = 6; i >= 0; i--) {
        const date = addDays(today, -i)
        days.push({ date, count: logs.filter((l) => l.reviewed_on === date).length })
      }
      const payload = {
        目标: {
          每日新词: plan ? Number(plan.daily_new) || 10 : 10,
          每日复习上限: plan ? Number(plan.daily_review_cap) || 50 : 50,
          每周学习日: plan ? plan.weekly_days : [1, 2, 3, 4, 5],
        },
        现状: {
          生词总数: counts.learning + counts.mastered,
          已掌握: counts.mastered,
          学习中: counts.learning,
          连续天数: computeStreak(logs.map((l) => l.reviewed_on), today),
          近7天: days,
        },
      }
      this.setData({ advice: '' })
      const text = await llm.studyAdvice(payload, (piece, full) => {
        this.setData({ advice: full })
      })
      this.setData({ advice: text.trim() || '暂时没有建议，继续保持学习节奏。', adviceBusy: false })
    } catch (e) {
      this.setData({
        adviceBusy: false,
        adviceError: 'AI 暂不可用：' + friendlyError(e),
      })
    }
  },
})
