const api = require('../../utils/api')
const srs = require('../../utils/srs')
const audio = require('../../utils/audio')
const { friendlyError } = require('../../utils/cloud')

const SAMPLE_WORDS = [
  { word: 'bonjour', phonetic: '[bɔ̃ʒuʁ]', pos: 'interj.', meaning_zh: '你好；早上好' },
  { word: 'merci', phonetic: '[mɛʁsi]', pos: 'interj.', meaning_zh: '谢谢' },
  { word: 'eau', phonetic: '[o]', pos: 'n.f.', meaning_zh: '水' },
  { word: 'livre', phonetic: '[livʁ]', pos: 'n.m.', meaning_zh: '书；册' },
  { word: 'parler', phonetic: '[paʁle]', pos: 'v.', meaning_zh: '说话；讲（某种语言）' },
  { word: 'manger', phonetic: '[mɑ̃ʒe]', pos: 'v.', meaning_zh: '吃' },
  { word: 'maison', phonetic: '[mɛzɔ̃]', pos: 'n.f.', meaning_zh: '房子；家' },
  { word: 'ami', phonetic: '[ami]', pos: 'n.m.', meaning_zh: '朋友' },
]

Page({
  data: {
    loading: true,
    loadingMore: false,
    signedIn: false,
    error: '',
    list: [],
    total: 0,
    page: 1,
    hasMore: false,
    search: '',
    statusFilter: '',
    unitId: null,
    unitTitle: '',
    // 词库筛选：'all' 全部 | 'none' 未分组 | 词库 id 的字符串
    libraries: [],
    libraryFilter: 'all',
    // 正在播放的喇叭（'w<id>'），由 utils/audio 回填
    playingKey: '',
  },

  onLoad(options) {
    if (options && options.unitId) {
      this.unitId = Number(options.unitId)
      this.setData({ unitId: this.unitId, unitTitle: options.title ? decodeURIComponent(options.title) : '' })
    }
    audio.bindPage(this)
  },

  onShow() {
    const app = getApp()
    // 词库管理页用 globalData 把「看某个词库」的意图传过来（tabBar 页接不了参数）
    const pending = app.globalData.pendingLibraryFilter
    if (pending) {
      app.globalData.pendingLibraryFilter = null
      this.setData({ libraryFilter: String(pending.id), search: '', statusFilter: '' })
      this.refreshLibraries()
      this.reload()
      return
    }
    if (app.globalData.dirty) {
      app.globalData.dirty = false
      this.refreshLibraries()
      this.reload()
    } else if (!this.data.list.length) {
      this.refreshLibraries()
      this.reload()
    }
  },

  /** 词库筛选条的数据；单个词库出错不影响整页 */
  async refreshLibraries() {
    try {
      const libs = await api.listLibraries()
      const libraries = libs.map((l) => ({ id: l.id, key: String(l.id), name: l.name }))
      // 当前筛选的库被删掉了 → 退回「全部」，否则会卡在一个空列表上
      const patch = { libraries }
      if (libs.length && !libraries.some((l) => l.key === this.data.libraryFilter) && this.data.libraryFilter !== 'all' && this.data.libraryFilter !== 'none') {
        patch.libraryFilter = 'all'
      }
      this.setData(patch)
    } catch (e) {
      /* 筛选条拿不到词库不影响看单词 */
    }
  },

  onPullDownRefresh() {
    this.reload().then(() => wx.stopPullDownRefresh())
  },

  reload() {
    this.setData({ page: 1, list: [], loading: true })
    return this.loadPage(1)
  },

  async loadPage(page) {
    try {
      const res = await api.listWords({
        page,
        size: 20,
        search: this.data.search,
        status: this.data.statusFilter,
        unitId: this.data.unitId,
        libraryId: this.libraryFilterArg(),
      })
      const list = res.list.map((w) => ({
        id: w.id,
        // 每行喇叭的播放标识，wxml 用它判断哪个正在响
        key: 'w' + w.id,
        word: w.word,
        phonetic: w.phonetic || '',
        pos: w.pos || '',
        meaning_zh: w.meaning_zh || '',
        status: w.status,
        stageLabel: srs.stageLabel(w),
      }))
      const hasMore = page * 20 < res.total
      this.setData({
        loading: false,
        loadingMore: false,
        error: '',
        signedIn: true,
        list: page === 1 ? list : this.data.list.concat(list),
        total: res.total,
        page,
        hasMore,
      })
    } catch (e) {
      this.setData({ loading: false, loadingMore: false, error: friendlyError(e), signedIn: true })
    }
  },

  loadMore() {
    if (this.data.loadingMore || !this.data.hasMore) return
    this.setData({ loadingMore: true })
    this.loadPage(this.data.page + 1)
  },

  onReachBottom() {
    this.loadMore()
  },

  onSearchInput(e) {
    const value = e.detail.value
    this.setData({ search: value })
    if (this.searchTimer) clearTimeout(this.searchTimer)
    this.searchTimer = setTimeout(() => {
      this.setData({ page: 1, list: [], loading: true })
      this.loadPage(1)
    }, 400)
  },

  setFilter(e) {
    const status = e.currentTarget.dataset.status || ''
    if (status === this.data.statusFilter) return
    this.setData({ statusFilter: status, page: 1, list: [], loading: true })
    this.loadPage(1)
  },

  /** libraryFilter（UI 用的字符串）→ api.listWords 的 libraryId 参数 */
  libraryFilterArg() {
    const f = this.data.libraryFilter
    if (f === 'all') return ''
    if (f === 'none') return 'none'
    return Number(f) || ''
  },

  setLibrary(e) {
    const filter = String(e.currentTarget.dataset.filter)
    if (filter === this.data.libraryFilter) return
    this.setData({ libraryFilter: filter, page: 1, list: [], loading: true })
    this.loadPage(1)
  },

  goLibraries() {
    wx.navigateTo({ url: '/pages/libraries/libraries' })
  },

  goAdd() {
    wx.navigateTo({ url: '/pages/word-detail/word-detail' })
  },
  /** 列表里直接试听，不用先进详情页 */
  speakWord(e) {
    const ds = e.currentTarget.dataset
    audio.play('w' + ds.id, ds.word)
  },
  onUnload() {
    audio.stop()
  },
  goImport() {
    wx.navigateTo({ url: '/pages/import/import' })
  },
  openWord(e) {
    wx.navigateTo({ url: '/pages/word-detail/word-detail?id=' + e.currentTarget.dataset.id })
  },

  async fillSamples() {
    try {
      wx.showLoading({ title: '添加中…', mask: true })
      const existing = await api.listExistingWordKeys()
      const rows = SAMPLE_WORDS.filter((w) => !existing[w.word.toLowerCase()]).map((w) =>
        Object.assign({ source: 'sample' }, w),
      )
      if (!rows.length) {
        wx.hideLoading()
        wx.showToast({ title: '示例词已存在', icon: 'none' })
        return
      }
      await api.createWords(rows)
      wx.hideLoading()
      getApp().markDirty()
      wx.showToast({ title: '已添加 ' + rows.length + ' 个示例词', icon: 'success' })
      this.reload()
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: friendlyError(e), icon: 'none' })
    }
  },

  goLogin() {
    wx.switchTab({ url: '/pages/mine/mine' })
  },
})
