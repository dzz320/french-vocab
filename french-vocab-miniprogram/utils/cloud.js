const { createMiniProgramWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk/miniprogram')
const { createDiagnosticWx } = require('./workbuddy-cloud-diagnostics')
const CONFIG = require('./config')

// 整个小程序只初始化一次云客户端；Auth / Database / Storage / LLM 共用同一实例。
const cloud = createMiniProgramWorkBuddyCloud({
  endpoint: CONFIG.endpoint,
  publishableKey: CONFIG.publishableKey,
  wx: createDiagnosticWx(wx),
})

let loginPromise = null

function wxLoginCode() {
  return new Promise((resolve, reject) => {
    wx.login({
      success(res) {
        if (res && res.code) resolve(res.code)
        else reject(new Error('wx.login 未返回 code'))
      },
      fail(err) {
        reject(new Error((err && err.errMsg) || '微信登录失败'))
      },
    })
  })
}

function runtimeAppid() {
  // 必须传当前运行时的小程序 appid（试用版与正式版是两个小程序），不要写死。
  try {
    const info = wx.getAccountInfoSync()
    return (info && info.miniProgram && info.miniProgram.appId) || ''
  } catch (e) {
    return ''
  }
}

/**
 * 幂等登录：已有会话直接复用，否则走 wx.login + 微信登录。
 * 失败后清空缓存，允许下一次重试（code 是一次性的，不能复用旧 Promise）。
 */
function ensureLogin() {
  if (loginPromise) return loginPromise
  loginPromise = (async () => {
    const { data: session } = await cloud.auth.getSession()
    if (session && session.user) return session
    const code = await wxLoginCode()
    const { data, error } = await cloud.auth.signInWithWechat(code, runtimeAppid())
    if (error) throw error
    return data
  })()
  loginPromise.catch(() => {
    loginPromise = null
  })
  return loginPromise
}

/** 需要登录态的数据/存储操作前调用；未登录抛出 code === 'not_signed_in'。 */
async function requireSession() {
  const session = await ensureLogin()
  if (!session || !session.user) {
    const err = new Error('请先登录')
    err.code = 'not_signed_in'
    throw err
  }
  return session
}

async function getUserId() {
  const session = await requireSession()
  return session.user.id
}

// ---------------- 模型目录 ----------------
let modelsPromise = null
let cachedTextModel = null
let cachedImageModel = null

function listUsableModels() {
  if (!modelsPromise) {
    modelsPromise = cloud.llm.models
      .list()
      .then((models) => {
        const list = Array.isArray(models) ? models : []
        const usable = list.filter((m) => m && m.disabled !== true)
        cachedTextModel = usable.length ? usable[0] : null
        cachedImageModel = usable.find((m) => m.supportsImages === true) || null
        return usable
      })
      .catch((err) => {
        modelsPromise = null
        throw err
      })
  }
  return modelsPromise
}

/** 返回可用文本模型；目录为空时抛错（不虚构模型 id）。 */
async function requireTextModel() {
  await listUsableModels()
  if (!cachedTextModel) {
    const err = new Error('AI 暂不可用')
    err.code = 'no_model'
    throw err
  }
  return cachedTextModel
}

/** 返回支持图像的模型；不支持时返回 null（调用方据此降级，视为未知能力而非否定）。 */
async function getImageModel() {
  await listUsableModels()
  return cachedImageModel
}

/** 把底层错误转成用户能看懂的一句话，不泄露内部细节。 */
function friendlyError(err) {
  const message = err && err.message ? String(err.message) : ''
  const code = err && err.code ? String(err.code) : ''
  if (err && err.code === 'not_signed_in') return '请先在「我的」页面登录'
  if (code.indexOf('quota_') === 0) return 'AI 额度不足，请稍后再试'
  if (code.indexOf('auth_') === 0) return '服务暂不可用，请稍后再试'
  if (code === 'no_model') return 'AI 暂不可用'
  if (message.indexOf('url not in domain list') >= 0) return '网络域名未配置，请重新发布小程序'
  if (message.indexOf('timeout') >= 0 || message.indexOf('abort') >= 0) return '请求超时，请重试'
  if (message.indexOf('network') >= 0 || message.indexOf('fail') >= 0) return '网络异常，请检查网络后重试'
  return message || '操作失败，请重试'
}

module.exports = {
  cloud,
  ensureLogin,
  requireSession,
  getUserId,
  requireTextModel,
  getImageModel,
  friendlyError,
}
