// 法语发音播放器（单词 / 例句朗读）
//
// 为什么是「在线接口 + 本地缓存」而不是内置音频：
//   主包 2MB、整包 20MB，1700 多个词的 mp3 塞不进包；而且用户自己导入的词
//   无法预生成。所以按需请求发音接口，第一次听完把 mp3 落到用户数据目录，
//   之后重听直接读本地，不再联网。
//
// 音源是多路降级（见 utils/config.js 的 sources）：
//   ① 自建法语发音服务（edge-tts，任意文本 100% 覆盖，质量也好）
//   ② 有道 dictvoice（兜底；只对它自己缓存的文本发声，覆盖很低）
//   任一路失败会自动切下一路，全部失败才提示用户。
//
// ⚠️ 真机（体验版 / 正式版）播放网络音频，域名必须在**小程序后台**白名单里：
//    mp.weixin.qq.com → 开发管理 → 开发设置 → 服务器域名
//    「request 合法域名」和「downloadFile 合法域名」都要加，发音服务与有道都要。
//    开发者工具勾「不校验合法域名」只能骗过模拟器，真机照样失败（errCode 10002）。
//    这一条是最容易踩的：漏配的表现是「有的词能读、有的词读不出来」—— 因为
//    第一路音源整条挂了，只有兜底里那几个超高频词还能响。
//
// 目录：<用户数据目录>/tts/<hash>.mp3，单个约 8KB，只留最近 CACHE_MAX 条。
const CONFIG = require('./config')

const TTS = (CONFIG && CONFIG.tts) || {}
const LANG = TTS.lang || 'fr'
const ENABLED = TTS.enabled !== false

// 发音接口对超长文本不友好，也不该让一整段课文拖慢播放
const MAX_TEXT = 180
// 缓存上限：一条 ≈8KB，300 条 ≈2.4MB，够用又不至于把用户目录撑大
const CACHE_MAX = 300
const CACHE_DIR_NAME = 'tts'

const PREF_KEY = 'fr_audio_prefs'
const DEFAULT_PREFS = { autoPlay: false, ignoreMute: true }

let ctx = null
let prefs = null
let activeKey = ''
let activeUrl = ''
// 当前这次播放：按 list 顺序尝试，index 是正在用的那一路
let active = { key: '', text: '', list: [], index: 0 }
// 已经就「域名没进白名单」提醒过的 host，避免每次点都弹
const hostWarned = Object.create(null)
const watchers = []
const downloading = Object.create(null)

// ---------------- 偏好 ----------------

function getPrefs() {
  if (prefs) return prefs
  let saved = null
  try {
    saved = wx.getStorageSync(PREF_KEY)
  } catch (e) {
    saved = null
  }
  prefs = Object.assign({}, DEFAULT_PREFS, saved && typeof saved === 'object' ? saved : {})
  return prefs
}

function setPrefs(patch) {
  prefs = Object.assign({}, getPrefs(), patch || {})
  try {
    wx.setStorageSync(PREF_KEY, prefs)
  } catch (e) {
    /* 存不下也不影响本次使用 */
  }
  applyAudioOption()
  return prefs
}

/**
 * 静音键策略。
 * 实例上的 obeyMuteSwitch 从基础库 2.3.0 起失效，必须用 wx.setInnerAudioOption
 * 统一设置，否则 iPhone 拨到静音时点了喇叭一点声音都没有（最难自查的一类问题）。
 */
function applyAudioOption() {
  if (typeof wx.setInnerAudioOption !== 'function') return
  try {
    wx.setInnerAudioOption({ obeyMuteSwitch: !getPrefs().ignoreMute, mixWithOther: true })
  } catch (e) {
    /* 老基础库不支持，忽略 */
  }
}

// ---------------- 文本 → 音频地址 ----------------

function cleanText(text) {
  let s = String(text == null ? '' : text)
    .replace(/\s+/g, ' ')
    .trim()
  if (s.length > MAX_TEXT) s = s.slice(0, MAX_TEXT)
  return s
}

function hostOf(url) {
  const m = String(url || '').match(/^https?:\/\/([^/]+)/i)
  return m ? m[1] : String(url || '')
}

/** config 里没写 sources 时，退回老的 baseUrl + le/audio 写法 */
function legacyTemplate() {
  const base = TTS.baseUrl || 'https://dict.youdao.com/dictvoice'
  const sep = base.indexOf('?') >= 0 ? '&' : '?'
  return base + sep + 'le=' + encodeURIComponent(LANG) + '&audio={text}'
}

/** 音源列表：按顺序尝试，url 里的 {text} 会被替换成编码后的文本 */
function sourceList() {
  const raw = Array.isArray(TTS.sources) && TTS.sources.length
    ? TTS.sources
    : [{ label: '默认音源', url: legacyTemplate() }]
  const out = []
  raw.forEach((s) => {
    const url = String((s && s.url) || '').trim()
    if (url) out.push({ label: (s && s.label) || hostOf(url), url })
  })
  return out
}

function fillTemplate(tpl, clean) {
  return tpl.split('{text}').join(encodeURIComponent(clean))
}

/** 一次播放要按顺序试的所有地址 */
function buildUrls(clean) {
  return sourceList().map((s) => ({ label: s.label, url: fillTemplate(s.url, clean) }))
}

/** 主音源地址（自测与提示文案用） */
function buildUrl(clean) {
  const list = buildUrls(clean)
  return list.length ? list[0].url : ''
}

function hex8(n) {
  const s = (n >>> 0).toString(16)
  return '00000000'.slice(s.length) + s
}

/** 双哈希拼接：单哈希 32 位撞车会放错音，两个独立哈希一起用可忽略不计 */
function hashKey(text) {
  let h1 = 0x811c9dc5
  let h2 = 5381
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 ^= c
    h1 = (h1 + ((h1 << 1) + (h1 << 4) + (h1 << 7) + (h1 << 8) + (h1 << 24))) >>> 0
    h2 = ((h2 * 33) ^ c) >>> 0
  }
  return hex8(h1) + hex8(h2)
}

// ---------------- 本地缓存 ----------------

function userDataPath() {
  try {
    return (wx.env && wx.env.USER_DATA_PATH) || ''
  } catch (e) {
    return ''
  }
}

function cacheDir() {
  const base = userDataPath()
  return base ? base + '/' + CACHE_DIR_NAME : ''
}

function cachePathFor(url) {
  const dir = cacheDir()
  return dir ? dir + '/' + hashKey(url) + '.mp3' : ''
}

function fs() {
  return wx.getFileSystemManager()
}

function fileExists(path) {
  if (!path) return false
  try {
    fs().accessSync(path)
    return true
  } catch (e) {
    return false
  }
}

function ensureCacheDir() {
  const dir = cacheDir()
  if (!dir) return false
  if (fileExists(dir)) return true
  try {
    fs().mkdirSync(dir, true)
    return true
  } catch (e) {
    return false
  }
}

/** 超出上限就按修改时间删掉最旧的一批；缓存清理失败不影响播放 */
function trimCache() {
  const dir = cacheDir()
  if (!dir) return
  try {
    const files = fs().readdirSync(dir).filter((n) => /\.mp3$/.test(n))
    if (files.length <= CACHE_MAX) return
    const items = files.map((name) => {
      let time = 0
      try {
        const st = fs().statSync(dir + '/' + name)
        time = Number(st.mtime || st.ctime || 0)
      } catch (e) {
        time = 0
      }
      return { name, time }
    })
    items.sort((a, b) => a.time - b.time)
    items.slice(0, items.length - CACHE_MAX).forEach((it) => {
      try {
        fs().unlinkSync(dir + '/' + it.name)
      } catch (e) {
        /* 单个删不掉就算了 */
      }
    })
  } catch (e) {
    /* 忽略 */
  }
}

/**
 * 后台把音频存到本地。
 * wx.downloadFile 同样受 downloadFile 合法域名限制，所以这里任何失败都静默：
 * 缓存只是「下一次更快」，拿不到也照样能播（直接流式播网络地址）。
 */
function scheduleCache(url) {
  if (downloading[url]) return
  const path = cachePathFor(url)
  if (!path || fileExists(path)) return
  downloading[url] = true
  try {
    wx.downloadFile({
      url,
      success(res) {
        if (!res || res.statusCode !== 200 || !res.tempFilePath) return
        if (!ensureCacheDir()) return
        try {
          fs().copyFileSync(res.tempFilePath, path)
          trimCache()
        } catch (e) {
          /* 复制失败：忽略 */
        }
      },
      fail() {
        /* 域名没配 / 网络抖动：忽略 */
      },
      complete() {
        downloading[url] = false
      },
    })
  } catch (e) {
    downloading[url] = false
  }
}

// ---------------- 播放器 ----------------

/** 播放态去重：同一个 key 连续到达只通知一次（onPlay 与我们主动 emit 会重合） */
let lastEmitted = null

function emit(key) {
  if (lastEmitted === key) return
  lastEmitted = key
  watchers.slice().forEach((fn) => {
    try {
      fn({ key })
    } catch (e) {
      /* 单个页面回调出错不影响别人 */
    }
  })
}

function describeError(code) {
  if (code === 10001) return '系统繁忙，请再试一次'
  if (code === 10002) return '发音加载失败（网络或域名未配置）'
  if (code === 10003) return '音频格式不支持'
  if (code === 10004) return '发音资源不存在'
  return '发音播放失败'
}

/**
 * 10002 在真机上十有八九是域名没进白名单。只弹「网络异常」会让人查半天，
 * 所以把 host 和操作路径直接写出来；每个 host 只打断一次，也不影响后面的音源降级。
 */
function warnDomain(host) {
  if (!host || hostWarned[host]) return
  hostWarned[host] = true
  wx.showModal({
    title: '发音域名未配置',
    content:
      '请在小程序后台「开发管理 → 开发设置 → 服务器域名」把 ' +
      host +
      ' 同时加进「request 合法域名」和「downloadFile 合法域名」。开发者工具里勾选「不校验合法域名」只对模拟器有效。',
    showCancel: false,
    confirmText: '知道了',
  })
}

function handleError(res) {
  const code = res && res.errCode
  // 已经被 stop() / 切卡片清掉了：迟到的错误不该再打断用户
  if (!active.list.length) {
    activeKey = ''
    emit('')
    return
  }
  const failed = active.list[active.index]
  if (code === 10002 && failed) warnDomain(hostOf(failed.url))
  // 还有备用音源就自动切下一路，用户无感
  if (active.index + 1 < active.list.length) {
    if (start(active.index + 1)) return
  }
  activeKey = ''
  emit('')
  wx.showToast({ title: describeError(code), icon: 'none' })
}

function ensureCtx() {
  if (ctx) return ctx
  applyAudioOption()
  ctx = wx.createInnerAudioContext()
  ctx.onPlay(() => emit(activeKey))
  ctx.onEnded(() => {
    activeKey = ''
    emit('')
  })
  ctx.onError(handleError)
  // 只靠 onStop 清状态会踩两个坑：① 我们自己在 play() 里主动 stop 旧播放，
  // 那个 onStop 是异步到达的，会把刚开始的新播放标志抹掉；② 系统中断
  // (来电等) 只会走这里。所以 onStop 不用，改用同步 stop() + 中断事件。
  if (typeof wx.onAudioInterruptionBegin === 'function') {
    wx.onAudioInterruptionBegin(() => {
      activeKey = ''
      emit('')
    })
  }
  return ctx
}

/**
 * 播放一段文本。
 * @param {string} key 调用方给的播放标识（页面用它高亮正在播的那个按钮）
 * @param {string} text 法语单词或句子
 * @returns {boolean} 是否成功发起播放
 */
function play(key, text) {
  if (!ENABLED) return false
  const clean = cleanText(text)
  if (!clean) return false
  const list = buildUrls(clean)
  if (!list.length) {
    wx.showToast({ title: '没有可用的发音源', icon: 'none' })
    return false
  }
  active = { key: key || 't:' + clean, text: clean, list, index: 0 }
  return start(0)
}

/** 用 active.list 里的第 index 路音源播放；某一路失败时换 index 重来 */
function start(index) {
  const item = active.list[index]
  if (!item) return false
  const player = ensureCtx()
  const local = cachePathFor(item.url)
  const src = local && fileExists(local) ? local : item.url
  // 直接停实例、不调 stop()：stop() 会同步清空 activeKey 并 emit 一次空态，
  // 紧接着又被新播放覆盖，界面会闪一下
  try {
    player.stop()
  } catch (e) {
    /* 忽略 */
  }
  active.index = index
  activeKey = active.key
  activeUrl = item.url
  try {
    player.src = src
    player.play()
  } catch (e) {
    activeKey = ''
    emit('')
    return false
  }
  // 不等 onPlay 再点亮：本地缓存播放时 onPlay 可能几十毫秒后才到
  emit(activeKey)
  if (src === item.url) scheduleCache(item.url)
  return true
}

/**
 * 预热：把接下来的文本先下到本地，用户真去点播放时就是零延迟。
 * 只预热主音源；失败静默 —— 预热本来就是锦上添花，不该弹错。
 */
function prefetch(text) {
  if (!ENABLED) return false
  const clean = cleanText(text)
  if (!clean) return false
  const list = buildUrls(clean)
  if (!list.length) return false
  const path = cachePathFor(list[0].url)
  if (path && fileExists(path)) return true
  scheduleCache(list[0].url)
  return true
}

function stop() {
  if (ctx) {
    try {
      ctx.stop()
    } catch (e) {
      /* 忽略 */
    }
  }
  active = { key: '', text: '', list: [], index: 0 }
  if (activeKey) {
    activeKey = ''
    emit('')
  }
}

function isEnabled() {
  return ENABLED
}

function watch(fn) {
  if (typeof fn !== 'function') return function () {}
  watchers.push(fn)
  return function unwatch() {
    const i = watchers.indexOf(fn)
    if (i >= 0) watchers.splice(i, 1)
  }
}

/**
 * 页面绑定：把播放态同步到 page.data[field]，并在页面卸载时自动解绑 + 停止播放。
 * 必须在 onLoad 里调用（要拿到页面实例才能包装 onUnload）。
 */
function bindPage(page, field) {
  const key = field || 'playingKey'
  const handler = (state) => {
    if (!page || page.__audioDetached) return
    if (page.data[key] === state.key) return
    try {
      page.setData({ [key]: state.key })
    } catch (e) {
      /* 页面已销毁 */
    }
  }
  const unwatch = watch(handler)
  const prevOnUnload = page.onUnload
  page.onUnload = function () {
    page.__audioDetached = true
    unwatch()
    stop()
    if (typeof prevOnUnload === 'function') prevOnUnload.apply(this, arguments)
  }
  return unwatch
}

/** 详情页那种「没填内容就别发声」的场景用 */
function playWithGuard(key, text, emptyHint) {
  const clean = cleanText(text)
  if (!clean) {
    if (emptyHint) wx.showToast({ title: emptyHint, icon: 'none' })
    return false
  }
  return play(key, clean)
}

/** 当前播放态（排查用） */
function getState() {
  const item = active.list[active.index]
  return {
    key: activeKey,
    url: activeUrl,
    source: item ? item.label : '',
    sourceIndex: active.list.length ? active.index : -1,
    sourceCount: active.list.length,
  }
}

module.exports = {
  play,
  stop,
  prefetch,
  bindPage,
  playWithGuard,
  getPrefs,
  setPrefs,
  isEnabled,
  watch,
  getState,
  // 便于自测与排查
  buildUrl,
  buildUrls,
  sourceList,
  cleanText,
  hashKey,
  cachePathFor,
}
