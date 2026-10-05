// utils/audio.js 的离线自测：用假的 wx 跑通发音模块的全部关键路径。
// 小程序没有测试框架，这里用最小 mock 把「有没有声音」之外的所有逻辑都断言掉。
//
// 音源用**自带的单音源 fixture**，不读工程里真实的 config.js —— 否则真实配置里
// 加/减一路音源就会让这里的断言集体失真（降级链由 test-audio-sources.cjs 单独覆盖）。
const fs = require('fs')
const os = require('os')
const path = require('path')

const MODULE = process.argv[2]
if (!MODULE) {
  console.error('用法: node test-audio.cjs <utils/audio.js 的绝对路径>')
  process.exit(2)
}

const FIXTURE_BASE = 'https://dict.youdao.com/dictvoice'
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-mod-'))
const utilsDir = path.join(work, 'utils')
fs.mkdirSync(utilsDir, { recursive: true })
fs.copyFileSync(MODULE, path.join(utilsDir, 'audio.js'))
fs.writeFileSync(
  path.join(utilsDir, 'config.js'),
  'module.exports = { tts: { enabled: true, lang: "fr", sources: [' +
    '{ label: "单音源", url: "' + FIXTURE_BASE + '?le=fr&audio={text}" }' +
    '] } }\n'
)

// ---------------- 假 wx ----------------
const FILES = new Set()
const DIRS = new Set()
const STORAGE = Object.create(null)
const LOG = { toasts: [], modals: [], audioOptions: [], downloads: [], sources: [] }

let audioHandlers = {}
let interruptionHandler = null

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
    if (this._failPlay) throw new Error('play 抛错')
    if (audioHandlers.play) audioHandlers.play()
  }
  stop() {
    LOG.stopped = (LOG.stopped || 0) + 1
  }
  destroy() {}
  onPlay(fn) {
    audioHandlers.play = fn
  }
  onEnded(fn) {
    audioHandlers.ended = fn
  }
  onStop(fn) {
    audioHandlers.stop = fn
  }
  onError(fn) {
    audioHandlers.error = fn
  }
}

global.wx = {
  env: { USER_DATA_PATH: '/udata' },
  getStorageSync: (k) => (k in STORAGE ? STORAGE[k] : ''),
  setStorageSync: (k, v) => {
    STORAGE[k] = v
  },
  setInnerAudioOption: (o) => LOG.audioOptions.push(o),
  onAudioInterruptionBegin: (fn) => {
    interruptionHandler = fn
  },
  createInnerAudioContext: () => new FakeAudio(),
  showToast: (o) => LOG.toasts.push(o.title),
  showModal: (o) => LOG.modals.push(o.content),
  downloadFile: (o) => {
    LOG.downloads.push(o.url)
    if (global.__downloadFails) {
      o.fail && o.fail({ errMsg: 'fail url not in domain list' })
      o.complete && o.complete()
      return
    }
    const temp = '/tmp/dl-' + Math.random().toString(36).slice(2) + '.mp3'
    FILES.add(temp)
    o.success && o.success({ statusCode: 200, tempFilePath: temp })
    o.complete && o.complete()
  },
  getFileSystemManager: () => ({
    accessSync: (p) => {
      if (!FILES.has(p) && !DIRS.has(p)) throw new Error('ENOENT')
    },
    mkdirSync: (p) => {
      DIRS.add(p)
    },
    copyFileSync: (from, to) => {
      if (!FILES.has(from)) throw new Error('ENOENT src')
      FILES.add(to)
    },
    readdirSync: (d) => Array.from(FILES).filter((f) => f.indexOf(d + '/') === 0).map((f) => f.slice(d.length + 1)),
    statSync: () => ({ mtime: Date.now(), size: 8000 }),
    unlinkSync: (p) => {
      FILES.delete(p)
    },
  }),
}

const audio = require(path.join(utilsDir, 'audio.js'))

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

// A. 文本处理与地址拼接
eq('A1 折叠空白', audio.cleanText('  Bonjour,\n  ça  va ? '), 'Bonjour, ça va ?')
eq('A2 超长截断到 180', audio.cleanText('a'.repeat(500)).length, 180)
eq('A3 空文本返回空串', audio.cleanText(null), '')

const u1 = audio.buildUrl('bonjour')
ok('A4 地址带 le=fr', u1.indexOf('le=fr') > 0, u1)
ok('A5 文本已 encode', u1.indexOf('audio=bonjour') > 0, u1)
const u2 = audio.buildUrl("l'école, c'est ça ?")
ok('A6 逗号与问号被编码', u2.indexOf('%2C') > 0 && u2.indexOf('%3F') > 0, u2)
ok('A6b 重音字符被编码', u2.indexOf('%C3%A9') > 0, u2)
eq('A7 hash 稳定', audio.hashKey('bonjour'), audio.hashKey('bonjour'))
ok('A8 不同词 hash 不同', audio.hashKey('bonjour') !== audio.hashKey('merci'))
ok('A9 hash 是 16 位十六进制', /^[0-9a-f]{16}$/.test(audio.hashKey('bonjour')), audio.hashKey('bonjour'))
ok('A10 缓存路径在用户目录下 tts/', audio.cachePathFor(u1).indexOf('/udata/tts/') === 0, audio.cachePathFor(u1))

// B. 偏好
let prefs = audio.getPrefs()
eq('B1 默认不自动发音', prefs.autoPlay, false)
eq('B2 默认静音键也出声', prefs.ignoreMute, true)
audio.setPrefs({ autoPlay: true })
eq('B3 写入后读回一致', audio.getPrefs().autoPlay, true)
eq('B4 偏好落盘', STORAGE.fr_audio_prefs && STORAGE.fr_audio_prefs.autoPlay, true)
ok('B5 setPrefs 会重设音频参数', LOG.audioOptions.length > 0)
eq('B6 忽略静音 → obeyMuteSwitch=false', LOG.audioOptions[LOG.audioOptions.length - 1].obeyMuteSwitch, false)
audio.setPrefs({ ignoreMute: false })
eq('B7 尊重静音 → obeyMuteSwitch=true', LOG.audioOptions[LOG.audioOptions.length - 1].obeyMuteSwitch, true)
audio.setPrefs({ autoPlay: false, ignoreMute: true })

// C. 播放：无缓存 → 网络地址 + 触发下载
const seen = []
const unwatch = audio.watch((s) => seen.push(s.key))

eq('C1 空文本不播放', audio.play('word', '   '), false)
eq('C2 有效文本播放成功', audio.play('word', 'bonjour'), true)
ok('C3 src 是网络地址', LOG.sources[LOG.sources.length - 1] === u1, LOG.sources[LOG.sources.length - 1])
eq('C4 立即点亮播放态', seen[seen.length - 1], 'word')
eq('C5 触发了缓存下载', LOG.downloads.length, 1)
eq('C6 下载的就是当前地址', LOG.downloads[0], u1)

// D. 缓存命中：同一个词再播应当读本地文件
FILES.add(audio.cachePathFor(u1))
const dlBefore = LOG.downloads.length
audio.play('word', 'bonjour')
eq('D1 二次播放读取本地缓存', LOG.sources[LOG.sources.length - 1], audio.cachePathFor(u1))
eq('D2 命中缓存不再重复下载', LOG.downloads.length, dlBefore)
eq('D3 缓存文件确实存在于用户目录', FILES.has(audio.cachePathFor(u1)), true)

// E. 连点：不能出现「先空态再点亮」的闪烁
audio.stop()
seen.length = 0
audio.play('word', 'merci')
audio.play('example', 'Bonjour, comment allez-vous ?')
eq('E1 连点两次只发两帧', seen.length, 2)
eq('E2 第一次是 word', seen[0], 'word')
eq('E3 第二次是 example', seen[1], 'example')
ok('E4 中间没有空态闪烁', seen.indexOf('') < 0, JSON.stringify(seen))
eq('E5 状态停在 example', audio.getState().key, 'example')

// F. 结束 / 停止
seen.length = 0
audioHandlers.ended()
eq('F1 播放结束清空状态', audio.getState().key, '')
eq('F2 结束会通知页面', seen[seen.length - 1], '')
seen.length = 0
audio.play('word', 'eau')
audio.stop()
eq('F3 stop 清空状态', audio.getState().key, '')
eq('F4 stop 通知页面', seen[seen.length - 1], '')
seen.length = 0
audio.stop()
eq('F5 重复 stop 不重复通知', seen.length, 0)
audio.onAudioInterruptionBegin ? null : null
if (interruptionHandler) {
  audio.play('word', 'ami')
  seen.length = 0
  interruptionHandler()
  eq('F6 系统中断会清状态', audio.getState().key, '')
  eq('F7 中断通知页面', seen.length, 1)
}

// G. 错误处理
audio.play('word', 'livre')
const modalBefore = LOG.modals.length
audioHandlers.error({ errCode: 10002 })
eq('G1 10002 首次给出域名提示', LOG.modals.length, modalBefore + 1)
ok('G2 提示里写明域名', LOG.modals[LOG.modals.length - 1].indexOf('dict.youdao.com') > 0, LOG.modals[LOG.modals.length - 1])
eq('G3 出错清空播放态', audio.getState().key, '')
const modalAgain = LOG.modals.length
audio.play('word', 'livre')
audioHandlers.error({ errCode: 10002 })
eq('G4 同类错误不再反复弹窗', LOG.modals.length, modalAgain)
eq('G5 退化为 toast 提示', LOG.toasts[LOG.toasts.length - 1], '发音加载失败（网络或域名未配置）')
const toastCount = LOG.toasts.length
audio.play('word', 'livre')
audioHandlers.error({ errCode: 10003 })
eq('G6 解码错误单独提示', LOG.toasts[LOG.toasts.length - 1], '音频格式不支持')
eq('G7 复用了 toast 通道', LOG.toasts.length, toastCount + 1)

// H. playWithGuard
const guardToasts = LOG.toasts.length
eq('H1 空内容不发声', audio.playWithGuard('word', '  ', '请先输入法语单词'), false)
eq('H2 空内容给提示', LOG.toasts.length, guardToasts + 1)
eq('H3 提示文案正确', LOG.toasts[LOG.toasts.length - 1], '请先输入法语单词')
eq('H4 有内容正常播', audio.playWithGuard('word', 'maison', 'x'), true)

// I. bindPage
audio.stop()
const page = {
  data: { playingKey: '' },
  setData(patch) {
    Object.assign(this.data, patch)
  },
}
let unloaded = 0
page.onUnload = function () {
  unloaded += 1
}
audio.bindPage(page)
audio.play('word', 'parler')
eq('I1 播放态回填到页面', page.data.playingKey, 'word')
audioHandlers.ended()
eq('I2 结束后页面清空', page.data.playingKey, '')
audio.play('example', "c'est la vie")
eq('I3 例句态回填', page.data.playingKey, 'example')

// 重复设同一个 key 不应反复 setData
let setDataCount = 0
const originalSetData = page.setData.bind(page)
page.setData = function (patch) {
  setDataCount += 1
  originalSetData(patch)
}
audio.play('example', "c'est la vie")
eq('I4 同一个 key 不重复渲染', setDataCount, 0)

page.onUnload()
eq('I5 原 onUnload 仍被调用', unloaded, 1)
eq('I6 卸载时停止播放', audio.getState().key, '')
setDataCount = 0
audio.play('word', 'ami')
eq('I7 卸载后不再回填页面', setDataCount, 0)
eq('I8 卸载后 watcher 已解绑', page.data.playingKey, 'example')

// J. 超长例句截断后请求
const longText = Array(40).join('bonjour ') + 'fin'
const longUrl = audio.buildUrl(audio.cleanText(longText))
const decoded = decodeURIComponent(longUrl.split('audio=')[1])
eq('J1 超长文本按 180 字符请求', decoded.length, 180)

// K. 禁用开关
unwatch()
try {
  fs.rmSync(work, { recursive: true, force: true })
} catch (e) {
  /* 临时目录清不掉无所谓 */
}
console.log('')
if (fails.length) {
  console.log('❌ 失败 ' + fails.length + ' 项，通过 ' + pass + ' 项')
  fails.forEach((f) => console.log('   - ' + f))
  process.exit(1)
}
console.log('✅ 发音模块自测全部通过：' + pass + '/' + pass)
