const api = require('../../utils/api')
const { friendlyError } = require('../../utils/cloud')
const storage = require('../../utils/storage')

const SOURCE_LABEL = {
  image: '拍照/图片',
  pdf: 'PDF 文档',
  word: 'Word 文档',
  text: '文本/粘贴',
  manual: '手动创建',
}

Page({
  data: {
    loading: true,
    error: '',
    book: null,
    sourceLabel: '',
    units: [],
    stats: { total: 0, mastered: 0, fresh: 0 },
    percent: 0,
  },

  onLoad(options) {
    this.bookId = options && options.id ? Number(options.id) : 0
  },

  onShow() {
    this.refresh()
  },

  async refresh() {
    if (!this.bookId) {
      this.setData({ loading: false, book: null })
      return
    }
    this.setData({ loading: true, error: '' })
    try {
      const book = await api.getBook(this.bookId)
      if (!book) {
        this.setData({ loading: false, book: null })
        return
      }
      const units = await api.listUnits(book.id)
      const states = await api.countFreshByUnit(book.id)
      const detail = units.map((u) => {
        const rows = states.filter((w) => w.unit_id === u.id)
        let total = rows.length
        let mastered = 0
        let fresh = 0
        rows.forEach((w) => {
          if (w.status === 'mastered') mastered += 1
          else if (Number(w.stage || 0) === 0 && !w.due_date) fresh += 1
        })
        return {
          id: u.id,
          seq: u.seq,
          title: u.title,
          summary: u.summary || '',
          total,
          mastered,
          fresh,
          percent: total ? Math.round((mastered / total) * 100) : 0,
        }
      })
      const stats = {
        total: detail.reduce((s, u) => s + u.total, 0),
        mastered: detail.reduce((s, u) => s + u.mastered, 0),
        fresh: detail.reduce((s, u) => s + u.fresh, 0),
      }
      this.setData({
        loading: false,
        book,
        sourceLabel: SOURCE_LABEL[book.source_type] || '文本/粘贴',
        units: detail,
        stats,
        percent: stats.total ? Math.round((stats.mastered / stats.total) * 100) : 0,
      })
    } catch (e) {
      this.setData({ loading: false, error: friendlyError(e), book: null })
    }
  },

  learnUnit(e) {
    const unitId = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/study/study?mode=new&unitId=' + unitId })
  },

  goSchedule() {
    wx.navigateTo({
      url: '/pages/schedule/schedule?bookId=' + this.bookId + '&title=' + encodeURIComponent(this.data.book.title),
    })
  },

  async copySource() {
    try {
      const url = await storage.createBookFileUrl(this.data.book.source_path)
      wx.setClipboardData({
        data: url,
        success: () => wx.showToast({ title: '链接已复制（10 分钟内有效）', icon: 'none' }),
      })
    } catch (e) {
      wx.showToast({ title: friendlyError(e), icon: 'none' })
    }
  },

  confirmDelete() {
    const title = this.data.book ? this.data.book.title : ''
    wx.showModal({
      title: '删除教材',
      content: '将同时删除《' + title + '》下的所有单元与生词，且不可恢复。确定删除吗？',
      confirmText: '删除',
      confirmColor: '#D64545',
      success: (res) => {
        if (res.confirm) this.doDelete()
      },
    })
  },

  async doDelete() {
    try {
      await api.deleteBookCascade(this.bookId)
      getApp().markDirty()
      wx.showToast({ title: '已删除', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 600)
    } catch (e) {
      wx.showToast({ title: friendlyError(e), icon: 'none' })
    }
  },

  goBack() {
    wx.navigateBack()
  },
})
