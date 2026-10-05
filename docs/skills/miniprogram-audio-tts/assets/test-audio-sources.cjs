// 音源降级链的自测：用假 wx + 双音源 config 跑真实的 utils/audio.js。
//
// 覆盖这次修的核心问题：主音源（自建发音服务）不响时必须自动切到备用音源，
// 而不是像以前那样「有的词能读、有的词永远读不出来」。
const fs = require('fs')
const os = require('os')
const path = require('path')

const AUDIO_SRC = process.argv[2]
if (!AUDIO_SRC) {
  console.error('用法: node test-audio-sources.cjs <utils/audio.js 的绝对路径>')
  process.exit(2)
}

// ---------------- 造一个带双音源的 fixture 工程 ----------------
const PRIMARY = 'https://tts.example.test'
const FALLBACK = 'https://dict.youdao.com/dictvoice'
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-src-'))
const utils = path.join(work, 'utils')
fs.mkdirSync(utils, { recursive: true })
fs.copyFileSync(AUDIO_SRC, path.join(utils, 'audio.js'))
fs.writeFileSync(
  path.join(utils, 'config.js'),
  'module.exports = { tts: { enabled: true, lang: "fr", sources: [' +
    '{ label: "法语发音服务", url: "' + PRIMARY + '/tts?t={text}" },' +
    '{ label: "有道词典（兜底）", url: "' + FALLBACK + '?le=fr&audio={text}" }' +
    '] } }\n'
)

// ---------------- 假 wx ----------------
const FILES = new Set()
const DIRS = new Set()
const STORAGE = Object.create(null)
const LOG = { toasts: [], modals: [], sources: [], downloads: [] }
let handlers = {}

class FakeAudio {
  constructor() {
    this._src = ''
  }
  set src(v) {
    this._src = v
    LOG.sources.push(v)
  }
  get src() {
    return this._src
  }
  play() {
    if (handlers.play) handlers.play()
  }
  stop() {}
  destroy() {}
  onPlay(fn) {
    handlers.play = fn
  }
  onEnded(fn) {
    handlers.ended = fn
  }
  onStop(fn) {
    handlers.stop = fn
  }
  onError(fn) {
    handlers.error = fn
  }
}

global.wx = {
  env: { USER_DATA_PATH: '/udata' },
  getStorageSync: (k) => (k in STORAGE ? STORAGE[k] : ''),
  setStorageSync: (k, v) => {
    STORAGE[k] = v
  },
  setInnerAudioOption: () => {},
  onAudioInterruptionBegin: () => {},
  createInnerAudioContext: () => new FakeAudio(),
  showToast: (o) => LOG.toasts.push(o.title),
  showModal: (o) => LOG.modals.push(o),
  downloadFile: (o) => {
    LOG.downloads.push(o.url)
    const temp = '/tmp/dl-' + Math.random().toString(36).slice(2) + '.mp3'
    FILES.add(temp)
    o.success && o.success({ statusCode: 200, tempFilePath: temp })
    o.complete && o.complete()
  },
  getFileSystemManager: () => ({
    accessSync: (p) => {
      if (!FILES.has(p) && !DIRS.has(p)) throw new Error('ENOENT')
    },
    mkdirSync: (p) => DIRS.add(p),
    copyFileSync: (from, to) => {
      if (!FILES.has(from)) throw new Error('ENOENT src')
      FILES.add(to)
    },
    readdirSync: (d) =>
      Array.from(FILES)
        .filter((f) => f.indexOf(d + '/') === 0)
        .map((f) => f.slice(d.length + 1)),
    statSync: () => ({ mtime: Date.now(), size: 8000 }),
    unlinkSync: (p) => FILES.delete(p),
  }),
}

const audio = require(path.join(utils, 'audio.js'))

// ---------------- 断言 ----------------
let pass = 0
const fails = []
function ok(name, cond, extra) {
  if (cond) pass += 1
  else fails.push(name + (extra ? '  →  ' + extra : ''))
}
function eq(name, actual, expected) {
  ok(name, actual === expected, 'got ' + JSON.stringify(actual) + ' want ' + JSON.stringify(expected))
}
const lastSrc = () => LOG.sources[LOG.sources.length - 1]
const urlOf = (t) => PRIMARY + '/tts?t=' + encodeURIComponent(t)
const fbOf = (t) => FALLBACK + '?le=fr&audio=' + encodeURIComponent(t)

// A. 音源列表解析
const list = audio.sourceList()
eq('A1 解析出两路音源', list.length, 2)
eq('A2 主音源在最前', list[0].label, '法语发音服务')
eq('A3 备用音源在后', list[1].label, '有道词典（兜底）')
const urls = audio.buildUrls('abbaye')
eq('A4 两路地址都生成了', urls.length, 2)
eq('A5 主音源地址正确', urls[0].url, urlOf('abbaye'))
eq('A6 备用音源地址正确', urls[1].url, fbOf('abbaye'))
eq('A7 buildUrl 取主音源', audio.buildUrl('abbaye'), urlOf('abbaye'))
ok('A8 模板里的 {text} 已全部替换', urls[0].url.indexOf('{text}') < 0, urls[0].url)
const special = audio.buildUrls("chef-d'œuvre").map((u) => u.url)
// encodeURIComponent 按规范不转义撇号（服务端两种写法都能吃下，实测返回同一份音频）
ok('A9 合字被编码、撇号原样保留', special[0].indexOf('%C5%93') > 0 && special[0].indexOf("chef-d'") > 0, special[0])
ok('A9b 空格编成 %20', audio.buildUrl('un abbaye').indexOf('un%20abbaye') > 0, audio.buildUrl('un abbaye'))

// B. 正常播放走主音源
eq('B1 播放返回 true', audio.play('word', 'abbaye'), true)
eq('B2 用的是主音源', lastSrc(), urlOf('abbaye'))
eq('B3 会预热下载主音源', LOG.downloads[LOG.downloads.length - 1], urlOf('abbaye'))
eq('B4 状态记在主音源上', audio.getState().source, '法语发音服务')
eq('B5 备选数记录正确', audio.getState().sourceCount, 2)

// C. 主音源失败 → 静默降级到备用音源（这是这次修的核心）
{
  const toastsBefore = LOG.toasts.length
  const modalsBefore = LOG.modals.length
  handlers.error({ errCode: 10003 })
  eq('C1 自动切到备用音源', lastSrc(), fbOf('abbaye'))
  eq('C2 降级后播放态不丢', audio.getState().key, 'word')
  eq('C3 降级不弹 toast', LOG.toasts.length, toastsBefore)
  eq('C4 非域名错误不弹域名提示', LOG.modals.length, modalsBefore)
  eq('C5 状态显示已切到兜底音源', audio.getState().source, '有道词典（兜底）')
  eq('C6 索引推进到 1', audio.getState().sourceIndex, 1)
}

// D. 备用也失败 → 才提示用户
{
  const toastsBefore = LOG.toasts.length
  handlers.error({ errCode: 10004 })
  eq('D1 全部失败才提示', LOG.toasts.length, toastsBefore + 1)
  eq('D2 提示文案正确', LOG.toasts[LOG.toasts.length - 1], '发音资源不存在')
  eq('D3 失败后清空播放态', audio.getState().key, '')
}

// E. 域名类错误（10002）：要指名道姓说清哪个域名没配，但仍继续降级
{
  LOG.modals.length = 0
  audio.play('word', 'haut')
  handlers.error({ errCode: 10002 })
  eq('E1 10002 弹域名配置提示', LOG.modals.length, 1)
  ok('E2 提示里写明主音源域名', LOG.modals[0].content.indexOf('tts.example.test') > 0, LOG.modals[0].content)
  ok('E3 提示里写明操作路径', LOG.modals[0].content.indexOf('downloadFile') > 0, LOG.modals[0].content)
  eq('E4 仍会降级到备用音源', lastSrc(), fbOf('haut'))
  // 同一个域名只提醒一次
  audio.play('word', 'gêner')
  handlers.error({ errCode: 10002 })
  eq('E5 同一域名不反复弹窗', LOG.modals.length, 1)
  eq('E6 不同词的主音源地址各自正确', LOG.sources[LOG.sources.length - 2], urlOf('gêner'))
}

// F. prefetch
{
  LOG.downloads.length = 0
  eq('F1 prefetch 返回 true', audio.prefetch('thème'), true)
  eq('F2 prefetch 下的是主音源', LOG.downloads[0], urlOf('thème'))
  const n = LOG.downloads.length
  audio.prefetch('thème')
  eq('F3 已缓存不重复下载', LOG.downloads.length, n)
  eq('F4 空文本不预热', audio.prefetch('   '), false)
}

// G. stop 之后迟到的错误不再打扰用户
{
  audio.play('word', 'merci')
  audio.stop()
  const toastsBefore = LOG.toasts.length
  const modalsBefore = LOG.modals.length
  handlers.error({ errCode: 10002 })
  eq('G1 stop 后错误不弹 toast', LOG.toasts.length, toastsBefore)
  eq('G2 stop 后错误不弹域名提示', LOG.modals.length, modalsBefore)
  eq('G3 状态已清空', audio.getState().key, '')
}

// H. 播放态与缓存路径仍按「实际使用的地址」区分
{
  ok('H1 主音源与备用音源缓存路径不同', audio.cachePathFor(urlOf('abbaye')) !== audio.cachePathFor(fbOf('abbaye')))
  ok('H2 缓存路径在用户目录 tts/ 下', audio.cachePathFor(urlOf('abbaye')).indexOf('/udata/tts/') === 0)
}

// ---------------- 收尾 ----------------
try {
  fs.rmSync(work, { recursive: true, force: true })
} catch (e) {
  /* 临时目录清不掉无所谓 */
}

const total = pass + fails.length
console.log(`音源降级链：${pass}/${total} 通过`)
if (fails.length) {
  console.log('失败项：')
  fails.forEach((f) => console.log('  ✗ ' + f))
  process.exit(1)
}
