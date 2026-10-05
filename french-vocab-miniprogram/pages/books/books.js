const api = require('../../utils/api')

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
    signedIn: false,
    error: '',
    books: [],
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
      const books = await api.listBooks()
      const detailed = await Promise.all(
        books.map(async (book) => {
          let unitCount = 0
          let stats = { total: 0, mastered: 0, fresh: 0 }
          try {
            const units = await api.listUnits(book.id)
            unitCount = units.length
            stats = await api.bookWordStats(book.id)
          } catch (e) {
            /* 单本教材统计失败不阻塞列表 */
          }
          const percent = stats.total ? Math.round((stats.mastered / stats.total) * 100) : 0
          return {
            id: book.id,
            title: book.title,
            level: book.level,
            unitCount,
            stats,
            percent,
            sourceLabel: SOURCE_LABEL[book.source_type] || '文本/粘贴',
          }
        }),
      )
      this.setData({ loading: false, signedIn: true, error: '', books: detailed })
    } catch (e) {
      this.setData({ loading: false, error: e && e.message ? e.message : '加载失败' })
    }
  },

  goUpload() {
    wx.navigateTo({ url: '/pages/book-upload/book-upload' })
  },

  openBook(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/book-detail/book-detail?id=' + id })
  },

  goLogin() {
    wx.switchTab({ url: '/pages/mine/mine' })
  },
})
