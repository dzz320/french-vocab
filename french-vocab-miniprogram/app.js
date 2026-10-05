const { ensureLogin } = require('./utils/cloud')

App({
  globalData: {
    user: null,
    loginReady: null,
    // 跨页刷新标记：学习会话结束、词库变动后置 true，tab 页在 onShow 时消费
    dirty: false,
    modelId: null,
    modelSupportsImages: false,
  },

  onLaunch() {
    this.globalData.loginReady = ensureLogin()
      .then((session) => {
        this.globalData.user = session && session.user ? session.user : null
        return this.globalData.user
      })
      .catch(() => {
        this.globalData.user = null
        return null
      })
  },

  markDirty() {
    this.globalData.dirty = true
  },
})
