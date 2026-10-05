const api = require('../../utils/api')
const { projectSchedule } = require('../../utils/schedule')
const { todayLocal, formatCN, weekdayCN, computeStreak } = require('../../utils/date')
const { friendlyError } = require('../../utils/cloud')

const WEEK_OPTIONS = [
  { value: 1, label: '一' },
  { value: 2, label: '二' },
  { value: 3, label: '三' },
  { value: 4, label: '四' },
  { value: 5, label: '五' },
  { value: 6, label: '六' },
  { value: 7, label: '日' },
]

// WXML 表达式不支持方法调用（如 indexOf），用数据映射表达选中态
function weekSelectedMap(days) {
  const map = {}
  ;(days || []).forEach((d) => {
    map[Number(d)] = true
  })
  return map
}

Page({
  data: {
    loading: true,
    signedIn: false,
    error: '',
    saving: false,
    weekOptions: WEEK_OPTIONS,
    form: { daily_new: 10, daily_review_cap: 50, weekly_days: [1, 2, 3, 4, 5] },
    weekSelected: weekSelectedMap([1, 2, 3, 4, 5]),
    books: [],
    bookNames: [],
    bookIndex: 0,
    scopeLabel: '',
    project: { days: [], milestones: [], finishDate: null, finishDateCN: '', totalNew: 0, avgReview: 0, heavy: false },
    recentDays: [],
  },

  onLoad(options) {
    this.queryBookId = options && options.bookId ? Number(options.bookId) : null
    this.queryTitle = options && options.title ? decodeURIComponent(options.title) : ''
  },

  onShow() {
    this.refresh()
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
      const plan = await api.getActivePlan()
      const books = await api.listBooks()
      const bookNames = ['全部生词（含自建）'].concat(books.map((b) => b.title))

      let bookIndex = 0
      const targetBookId = this.queryBookId || (plan && plan.book_id) || null
      if (targetBookId) {
        const idx = books.findIndex((b) => b.id === targetBookId)
        bookIndex = idx >= 0 ? idx + 1 : 0
      }
      const selectedBookId = bookIndex > 0 ? books[bookIndex - 1].id : null

      const effectivePlan = plan || {
        daily_new: 10,
        daily_review_cap: 50,
        weekly_days: [1, 2, 3, 4, 5],
        book_id: selectedBookId,
        level: 'A1',
      }
      const form = {
        daily_new: Number(effectivePlan.daily_new) || 10,
        daily_review_cap: Number(effectivePlan.daily_review_cap) || 50,
        weekly_days: (effectivePlan.weekly_days || [1, 2, 3, 4, 5]).slice(),
        book_id: selectedBookId,
      }
      // book_id 跟随当前选择（未保存前只影响预览）
      form.book_id = selectedBookId

      const scopedPlan = Object.assign({}, effectivePlan, { book_id: selectedBookId })
      const groups = await api.buildScheduleGroups(scopedPlan)
      const project = projectSchedule(scopedPlan, groups, todayLocal())
      project.finishDateCN = project.finishDate ? formatCN(project.finishDate) : ''
      project.milestones.forEach((m, i) => {
        m.key = 'm' + i
        m.done = m.newCount === 0
        m.rangeCN = m.start && m.end ? (m.start === m.end ? formatCN(m.start) : formatCN(m.start) + ' ~ ' + formatCN(m.end)) : ''
      })

      const recentDays = project.days.slice(0, 14).map((d) => ({
        date: d.date,
        dateCN: formatCN(d.date),
        weekCN: weekdayCN(d.date),
        unitTitle: d.unitTitle,
        newCount: d.newCount,
        reviewCount: d.reviewCount,
        isToday: d.date === todayLocal(),
      }))

      const scopeLabel = selectedBookId
        ? '针对《' + (this.queryTitle || bookNames[bookIndex]) + '》按单元推进'
        : '针对全部生词（含自建）'

      this.setData({
        loading: false,
        signedIn: true,
        error: '',
        form,
        weekSelected: weekSelectedMap(form.weekly_days),
        books,
        bookNames,
        bookIndex,
        scopeLabel,
        project,
        recentDays,
      })
    } catch (e) {
      this.setData({ loading: false, error: friendlyError(e) })
    }
  },

  onBookChange(e) {
    const bookIndex = Number(e.detail.value) || 0
    this.setData({ bookIndex }, () => this.reproject())
  },

  onDailyNewChanging(e) {
    this.setData({ 'form.daily_new': e.detail.value })
  },
  onDailyNew(e) {
    this.setData({ 'form.daily_new': e.detail.value }, () => this.reproject())
  },
  onCap(e) {
    this.setData({ 'form.daily_review_cap': e.detail.value }, () => this.reproject())
  },
  decDailyNew() {
    const v = Math.max(1, this.data.form.daily_new - 1)
    this.setData({ 'form.daily_new': v }, () => this.reproject())
  },
  incDailyNew() {
    const v = Math.min(60, this.data.form.daily_new + 1)
    this.setData({ 'form.daily_new': v }, () => this.reproject())
  },
  toggleWeek(e) {
    const value = Number(e.currentTarget.dataset.value)
    const days = this.data.form.weekly_days.slice()
    const idx = days.indexOf(value)
    if (idx >= 0) {
      if (days.length <= 1) {
        wx.showToast({ title: '至少保留一个学习日', icon: 'none' })
        return
      }
      days.splice(idx, 1)
    } else {
      days.push(value)
    }
    days.sort((a, b) => a - b)
    this.setData({ 'form.weekly_days': days, weekSelected: weekSelectedMap(days) }, () => this.reproject())
  },

  /** 参数变化后即时重投影（不写库） */
  async reproject() {
    try {
      const form = this.data.form
      const scopedPlan = {
        daily_new: form.daily_new,
        daily_review_cap: form.daily_review_cap,
        weekly_days: form.weekly_days,
        book_id: form.book_id,
      }
      const groups = await api.buildScheduleGroups(scopedPlan)
      const project = projectSchedule(scopedPlan, groups, todayLocal())
      project.finishDateCN = project.finishDate ? formatCN(project.finishDate) : ''
      project.milestones.forEach((m, i) => {
        m.key = 'm' + i
        m.done = m.newCount === 0
        m.rangeCN = m.start && m.end ? (m.start === m.end ? formatCN(m.start) : formatCN(m.start) + ' ~ ' + formatCN(m.end)) : ''
      })
      const recentDays = project.days.slice(0, 14).map((d) => ({
        date: d.date,
        dateCN: formatCN(d.date),
        weekCN: weekdayCN(d.date),
        unitTitle: d.unitTitle,
        newCount: d.newCount,
        reviewCount: d.reviewCount,
        isToday: d.date === todayLocal(),
      }))
      const scopeLabel = form.book_id ? '按教材单元推进' : '针对全部生词（含自建）'
      this.setData({ project, recentDays, scopeLabel })
    } catch (e) {
      wx.showToast({ title: friendlyError(e), icon: 'none' })
    }
  },

  async save() {
    const form = this.data.form
    if (!form.weekly_days.length) {
      wx.showToast({ title: '至少选择一个学习日', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    try {
      await api.savePlan({
        daily_new: form.daily_new,
        daily_review_cap: form.daily_review_cap,
        weekly_days: form.weekly_days,
        book_id: form.book_id || null,
        level: 'A1',
      })
      getApp().markDirty()
      wx.showToast({ title: '日程已保存', icon: 'success' })
      this.refresh()
    } catch (e) {
      wx.showToast({ title: friendlyError(e), icon: 'none' })
    } finally {
      this.setData({ saving: false })
    }
  },

  goLogin() {
    wx.switchTab({ url: '/pages/mine/mine' })
  },
})
