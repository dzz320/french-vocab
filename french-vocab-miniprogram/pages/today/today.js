const api = require('../../utils/api')
const { todayLocal, addDays, formatCN, computeStreak } = require('../../utils/date')
const { todayTasks } = require('../../utils/schedule')

Page({
  data: {
    loading: true,
    signedIn: false,
    error: '',
    newTodo: 0,
    reviewTodo: 0,
    unitIndex: 0,
    totalUnits: 0,
    currentUnitTitle: '',
    streak: 0,
    totalWords: 0,
    masteredWords: 0,
    freshCount: 0,
    hasPlan: false,
    planFinish: '',
  },

  onShow() {
    this.refresh()
  },

  onPullDownRefresh() {
    this.refresh().then(() => wx.stopPullDownRefresh())
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
      this.setData({ loading: false, signedIn: false })
      return
    }
    this.setData({ loading: true, signedIn: true, error: '' })
    try {
      const today = todayLocal()
      const plan = await api.getActivePlan()
      const counts = await api.countWordsByStatus()
      const fresh = await api.countFreshWords()
      const due = await api.countDueWords(today)
      const todayNewDone = await api.countTodayNew(today)
      const logs = await api.recentLogs(addDays(today, -60))

      // 分组：当前计划教材的各单元 + 自建词虚拟单元
      const groups = await api.buildScheduleGroups(plan)

      const fallback = { daily_new: 10, daily_review_cap: 50, weekly_days: [1, 2, 3, 4, 5] }
      const tasks = todayTasks(plan || fallback, groups, due, todayNewDone)
      const project = plan ? require('../../utils/schedule').projectSchedule(plan, groups, today) : null

      this.setData({
        loading: false,
        signedIn: true,
        error: '',
        newTodo: tasks.newTodo,
        reviewTodo: tasks.reviewTodo,
        unitIndex: tasks.unitIndex,
        totalUnits: tasks.totalUnits,
        currentUnitTitle: tasks.currentUnit ? tasks.currentUnit.title : '',
        streak: computeStreak(logs.map((l) => l.reviewed_on), today),
        totalWords: counts.learning + counts.mastered,
        masteredWords: counts.mastered,
        freshCount: fresh,
        hasPlan: !!plan,
        planFinish: project && project.finishDate ? formatCN(project.finishDate) : '',
      })
    } catch (e) {
      this.setData({ loading: false, error: e && e.message ? e.message : '加载失败' })
    }
  },

  startNew() {
    wx.navigateTo({ url: '/pages/study/study?mode=new' })
  },
  startReview() {
    wx.navigateTo({ url: '/pages/study/study?mode=review' })
  },
  startMixed() {
    wx.navigateTo({ url: '/pages/study/study?mode=mixed' })
  },
  goSchedule() {
    wx.navigateTo({ url: '/pages/schedule/schedule' })
  },
  goBooks() {
    wx.switchTab({ url: '/pages/books/books' })
  },
  goWords() {
    wx.switchTab({ url: '/pages/words/words' })
  },
  goLogin() {
    wx.switchTab({ url: '/pages/mine/mine' })
  },
})
