const api = require('../../utils/api')
const { friendlyError } = require('../../utils/cloud')

const LEVELS = ['A1', 'A2', 'B1', 'B2']

Page({
  data: {
    loading: true,
    signedIn: false,
    error: '',
    libraries: [],
    ungrouped: 0,
    levels: LEVELS,
    newName: '',
    newLevel: '',
    creating: false,
    editingId: 0,
    editName: '',
    renaming: false,
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
      const [libs, stats] = await Promise.all([api.listLibraries(), api.libraryStats()])
      const libraries = libs.map((l) => {
        const s = stats.byLibrary[String(l.id)] || { total: 0, mastered: 0, fresh: 0 }
        return {
          id: l.id,
          name: l.name,
          level: l.level || '',
          total: s.total,
          mastered: s.mastered,
          fresh: s.fresh,
          percent: s.total ? Math.round((s.mastered / s.total) * 100) : 0,
        }
      })
      this.setData({ loading: false, libraries, ungrouped: stats.ungrouped.total })
    } catch (e) {
      this.setData({ loading: false, error: friendlyError(e) })
    }
  },

  // ---------------- 新建 ----------------

  onNewName(e) {
    this.setData({ newName: e.detail.value })
  },

  pickNewLevel(e) {
    const level = e.currentTarget.dataset.level || ''
    this.setData({ newLevel: level === this.data.newLevel ? '' : level })
  },

  async create() {
    const name = this.data.newName.trim()
    if (!name) {
      wx.showToast({ title: '请填写词库名称', icon: 'none' })
      return
    }
    if (this.data.libraries.some((l) => l.name === name)) {
      wx.showToast({ title: '已有同名词库', icon: 'none' })
      return
    }
    this.setData({ creating: true })
    try {
      await api.createLibrary({ name, level: this.data.newLevel })
      this.setData({ creating: false, newName: '', newLevel: '' })
      getApp().markDirty()
      wx.showToast({ title: '已新建「' + name + '」', icon: 'success' })
      this.refresh()
    } catch (e) {
      this.setData({ creating: false })
      wx.showToast({ title: friendlyError(e), icon: 'none' })
    }
  },

  // ---------------- 重命名 ----------------

  startRename(e) {
    const id = Number(e.currentTarget.dataset.id)
    const lib = this.data.libraries.filter((l) => l.id === id)[0]
    if (!lib) return
    this.setData({ editingId: id, editName: lib.name })
  },

  onEditName(e) {
    this.setData({ editName: e.detail.value })
  },

  cancelRename() {
    this.setData({ editingId: 0, editName: '' })
  },

  async saveRename(e) {
    const id = Number(e.currentTarget.dataset.id)
    const name = this.data.editName.trim()
    if (!name) {
      wx.showToast({ title: '名称不能为空', icon: 'none' })
      return
    }
    this.setData({ renaming: true })
    try {
      await api.updateLibrary(id, { name })
      this.setData({ renaming: false, editingId: 0, editName: '' })
      getApp().markDirty()
      wx.showToast({ title: '已改名', icon: 'success' })
      this.refresh()
    } catch (err) {
      this.setData({ renaming: false })
      wx.showToast({ title: friendlyError(err), icon: 'none' })
    }
  },

  // ---------------- 删除 ----------------

  confirmDelete(e) {
    const id = Number(e.currentTarget.dataset.id)
    const lib = this.data.libraries.filter((l) => l.id === id)[0]
    if (!lib) return
    wx.showModal({
      title: '删除词库',
      content:
        '「' +
        lib.name +
        '」' +
        (lib.total ? '及其中的 ' + lib.total + ' 个生词会一起删除，' : '会被删除，') +
        '不可恢复。',
      confirmText: '删除',
      confirmColor: '#D64545',
      success: async (res) => {
        if (!res.confirm) return
        try {
          const out = await api.deleteLibraryCascade(id)
          getApp().markDirty()
          wx.showToast({ title: '已删除' + (out.words ? '（含 ' + out.words + ' 个词）' : ''), icon: 'none' })
          this.refresh()
        } catch (err) {
          wx.showToast({ title: friendlyError(err), icon: 'none' })
        }
      },
    })
  },

  /**
   * 去看这个词库里的词。生词本是 tabBar 页，navigateTo 带不了参数，
   * 所以用 globalData 传一个待消费的筛选条件过去。
   */
  openLibrary(e) {
    const id = Number(e.currentTarget.dataset.id)
    const lib = this.data.libraries.filter((l) => l.id === id)[0]
    if (!lib) return
    getApp().globalData.pendingLibraryFilter = { id, name: lib.name }
    wx.switchTab({ url: '/pages/words/words' })
  },

  goImport() {
    wx.navigateTo({ url: '/pages/import/import' })
  },

  goLogin() {
    wx.switchTab({ url: '/pages/mine/mine' })
  },
})
