/**
 * 发音功能的页面级联调测试（无 headless）：
 *   - 真 pages/study、pages/words、pages/word-detail、pages/mine
 *   - 真 utils/audio.js（拦 Module._load 只替换 cloud / api / llm / SDK）
 *   - 假 wx 同时提供「宿主能力」和「音频能力」，断言的是**真正发出去的 TTS 文本**
 *
 * 跑法：node test-audio-pages.cjs
 */
const fs = require('fs')
const path = require('path')
const Module = require('module')

const PROJ = 'C:/Users/24934/WorkBuddy/2026-10-05-13-00-04/french-vocab-miniprogram'

let pass = 0
let fail = 0
const failures = []
function ck(cond, label, extra) {
  if (cond) pass++
  else {
    fail++
    failures.push(label)
    console.log('  FAIL ' + label + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''))
  }
}
function eq(label, actual, expected) {
  ck(actual === expected, label, 'got ' + JSON.stringify(actual) + ' want ' + JSON.stringify(expected))
}
function group(name) {
  console.log('\n== ' + name + ' ==')
}

// =====================================================================
// 假 wx：宿主能力 + 音频能力
// =====================================================================
const ui = { toasts: [], modals: [], navs: [], backs: 0 }
const LOG = { sources: [], stops: 0, downloads: [], audioOptions: [] }
const FILES = new Set()
const DIRS = new Set()
const STORAGE = Object.create(null)
let audioHandlers = {}

class FakeAudio {
  set src(v) {
    this._src = v
    LOG.sources.push(v)
  }
  get src() {
    return this._src
  }
  play() {
    if (audioHandlers.play) audioHandlers.play()
  }
  stop() {
    LOG.stops++
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
  onAudioInterruptionBegin: () => {},
  createInnerAudioContext: () => new FakeAudio(),
  showToast: (o) => ui.toasts.push((o && o.title) || ''),
  showModal: (o) => {
    ui.modals.push(o)
    if (o && typeof o.success === 'function') o.success({ confirm: true, cancel: false })
  },
  showLoading: () => {},
  hideLoading: () => {},
  navigateTo: (o) => ui.navs.push(o && o.url),
  navigateBack: () => {
    ui.backs++
  },
  switchTab: () => {},
  stopPullDownRefresh: () => {},
  getFileSystemManager: () => ({
    accessSync: (p) => {
      if (!FILES.has(p) && !DIRS.has(p)) throw new Error('ENOENT')
    },
    mkdirSync: (p) => DIRS.add(p),
    copyFileSync: (a, b) => FILES.add(b),
    readdirSync: (d) =>
      Array.from(FILES)
        .filter((f) => f.indexOf(d + '/') === 0)
        .map((f) => f.slice(d.length + 1)),
    statSync: () => ({ mtime: Date.now(), size: 8000 }),
    unlinkSync: (p) => FILES.delete(p),
  }),
  downloadFile: (o) => {
    LOG.downloads.push(o.url)
    // 记下「本地缓存路径 -> 文本」的对应关系，供预热命中后的断言反查
    const t = textFromUrl(o.url)
    if (t) CACHE_TEXT[audio.cachePathFor(o.url)] = t
    const temp = '/tmp/x.mp3'
    FILES.add(temp)
    o.success && o.success({ statusCode: 200, tempFilePath: temp })
    o.complete && o.complete()
  },
}

const app = { globalData: { loginReady: Promise.resolve({ id: 'u1' }), dirty: false }, markDirty() { this.marked = (this.marked || 0) + 1 } }
global.getApp = () => app

function resetUi() {
  ui.toasts = []
  ui.modals = []
  ui.navs = []
  ui.backs = 0
}

// =====================================================================
// 数据桩
// =====================================================================
const cards = {
  new: [
    { id: 1, word: 'bonjour', phonetic: 'bɔ̃.ʒuʁ', pos: 'interj.', meaning_zh: '你好', example_fr: 'Bonjour, comment allez-vous ?', example_zh: '你好，你好吗？', mnemonic: '', status: 'new' },
    { id: 2, word: 'bibliothèque', phonetic: 'bi.bli.jɔ.tɛk', pos: 'n.f.', meaning_zh: '图书馆', example_fr: 'Je vais à la bibliothèque.', example_zh: '我去图书馆。', mnemonic: '', status: 'new' },
  ],
}

const apiStub = {
  async getActivePlan() {
    return { daily_new: 10, daily_review_cap: 50, weekly_days: [1, 2, 3, 4, 5] }
  },
  async countTodayNew() {
    return 0
  },
  async listFreshWords() {
    return cards.new.slice()
  },
  async listDueWords() {
    return []
  },
  async updateWord() {
    return {}
  },
  async insertLogs() {
    return {}
  },
  async listLibraries() {
    return [{ id: 7, name: 'B1' }]
  },
  async listWords() {
    return {
      total: 2,
      list: [
        { id: 11, word: 'gorge', phonetic: '', pos: 'n.f.', meaning_zh: '喉咙', status: 'learning' },
        { id: 12, word: 'souris', phonetic: '', pos: 'n.f.', meaning_zh: '老鼠', status: 'mastered' },
      ],
    }
  },
  async getWord(id) {
    return {
      id,
      word: 'gorge',
      phonetic: 'ɡɔʁʒ',
      pos: 'n.f.',
      meaning_zh: '喉咙',
      example_fr: 'Il a mal à la gorge.',
      example_zh: '他喉咙痛。',
      mnemonic: '',
      status: 'learning',
      library_id: 7,
    }
  },
  async createWord() {
    return {}
  },
  async resetWordSrs() {
    return {}
  },
  async deleteWord() {
    return {}
  },
  async countWordsByStatus() {
    return { learning: 3, mastered: 4 }
  },
  async recentLogs() {
    return []
  },
  async getBook() {
    return null
  },
  async listExistingWordKeys() {
    return {}
  },
  async createWords() {
    return {}
  },
}

const llmStub = {
  async completeWord() {
    return {}
  },
  async generateExample() {
    return {}
  },
  async studyAdvice() {
    return ''
  },
}

const cloudStub = {
  cloud: { auth: { signOut: async () => {} } },
  ensureLogin: async () => ({ user: { id: 'u1' } }),
  requireSession: async () => ({ user: { id: 'u1' } }),
  getUserId: async () => 'u1',
  requireTextModel: async () => 'm',
  getImageModel: async () => null,
  friendlyError: (e) => (e && e.message) || '错误',
}

const origLoad = Module._load
Module._load = function (request) {
  if (/workbuddy-cloud-sdk/.test(request)) return { createMiniProgramWorkBuddyCloud: () => ({}) }
  if (/(^|\/)cloud$/.test(request)) return cloudStub
  if (/utils[\\/]api$/.test(request)) return apiStub
  if (/utils[\\/]llm$/.test(request)) return llmStub
  return origLoad.apply(this, arguments)
}

const audio = require(path.join(PROJ, 'utils/audio.js'))

// =====================================================================
// 页面工厂
// =====================================================================
function setPath(root, keyPath, val) {
  const parts = String(keyPath).split('.')
  let cur = root
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]]) cur[parts[i]] = {}
    cur = cur[parts[i]]
  }
  cur[parts[parts.length - 1]] = val
}
const pageConfigs = {}
function loadPage(rel) {
  let captured = null
  global.Page = (cfg) => {
    captured = cfg
  }
  require(path.join(PROJ, rel))
  if (!captured) throw new Error('未捕获 Page 配置: ' + rel)
  pageConfigs[rel] = captured
  return captured
}
function makePage(rel) {
  const cfg = pageConfigs[rel] || loadPage(rel)
  const inst = Object.create(cfg)
  inst.data = JSON.parse(JSON.stringify(cfg.data))
  inst.__setData = 0
  inst.setData = function (patch) {
    inst.__setData++
    for (const k of Object.keys(patch)) setPath(inst.data, k, patch[k])
  }
  return inst
}
const tick = () => new Promise((r) => setTimeout(r, 5))

// 远程地址 -> 文本（兼容两路音源的参数名：自建服务用 t=，有道用 audio=）
function textFromUrl(u) {
  const m = /[?&](?:audio|t)=([^&]*)/.exec(String(u || ''))
  return m ? decodeURIComponent(m[1]) : ''
}
// 本地缓存路径 -> 文本：预热（prefetch）生效后，点播放直接用本地文件，
// src 不再是远程地址，所以要把这条链路也解析出来
const CACHE_TEXT = Object.create(null)
function textOfSrc(src) {
  const s = String(src || '')
  if (/^https?:/i.test(s)) return textFromUrl(s)
  return CACHE_TEXT[s] || ''
}
function lastText() {
  return textOfSrc(LOG.sources[LOG.sources.length - 1])
}
/** 本次记录里所有真正发到 TTS 的文本（本地缓存命中也算） */
function requestedTexts() {
  return LOG.sources.map(textOfSrc).filter(Boolean)
}
function resetPlayLog() {
  LOG.sources = []
  // 一并清掉音频缓存：缓存命中时播放的是本地路径，解析不出 TTS 文本。
  // 「命中缓存不重复下载」由 test-audio.cjs 的 D1/D2 单独覆盖。
  for (const f of Array.from(FILES)) if (f.indexOf('/udata/tts/') === 0) FILES.delete(f)
}
function lastToast() {
  return ui.toasts.length ? ui.toasts[ui.toasts.length - 1] : ''
}

// =====================================================================
// A. 学习卡片
// =====================================================================
async function testStudy() {
  group('A. pages/study 学习卡片')
  resetUi()
  resetPlayLog()
  const p = makePage('pages/study/study.js')
  p.onLoad({ mode: 'new' })
  await p.load()
  await tick()

  eq('A1 绑定后拿到了当前卡片', p.data.card && p.data.card.word, 'bonjour')
  eq('A2 卡片初始未翻开', p.data.flipped, false)
  eq('A3 默认不自动发音（没声音请求）', LOG.sources.length, 0)
  eq('A4 初始没有播放态', p.data.playingKey, '')

  // 读单词
  p.speakWord()
  eq('A5 读单词发到 TTS 的是单词本身', lastText(), 'bonjour')
  eq('A6 播放态标记为 word', audio.getState().key, 'word')
  eq('A7 播放态回填到页面', p.data.playingKey, 'word')
  // 进卡时已经预热过单词音频，所以点播放应当直接读本地文件、不等网络
  ck(/^\/udata\/tts\//.test(LOG.sources[LOG.sources.length - 1]),
    'A7b 预热生效：点播放直接读本地缓存文件', LOG.sources[LOG.sources.length - 1])

  // 读例句
  p.flip()
  eq('A8 翻开卡片', p.data.flipped, true)
  eq('A9 例句存在', p.data.card.example_fr, 'Bonjour, comment allez-vous ?')
  ck(FILES.has(audio.cachePathFor(audio.buildUrls(p.data.card.example_fr)[0].url)),
    'A9b 翻面会顺手预热例句音频')
  p.speakExample()
  eq('A10 读例句发到 TTS 的是整句', lastText(), 'Bonjour, comment allez-vous ?')
  eq('A11 播放态切到 example', p.data.playingKey, 'example')

  // 结束播放 → 页面清空
  audioHandlers.ended()
  eq('A12 播完清空播放态', p.data.playingKey, '')

  // 没有例句时不发声
  resetPlayLog()
  p.setData({ card: Object.assign({}, p.data.card, { example_fr: '' }) })
  p.speakExample()
  eq('A13 没例句不发声', LOG.sources.length, 0)

  // 换卡片会掐掉上一段
  p.setData({ card: Object.assign({}, p.data.card, { example_fr: 'Je vais à la bibliothèque.' }) })
  const before = LOG.stops
  p.speakExample()
  p.advance()
  ck(LOG.stops > before, 'A14 换卡片会停掉上一段发音', LOG.stops - before)
  eq('A15 换到第二张卡', p.data.card.word, 'bibliothèque')
  eq('A16 换卡后播放态已清空', p.data.playingKey, '')

  // 自动发音开关
  audio.setPrefs({ autoPlay: true })
  const auto = makePage('pages/study/study.js')
  resetPlayLog()
  auto.onLoad({ mode: 'new' })
  await tick()
  ck(requestedTexts().indexOf('bonjour') >= 0, 'A17 打开自动发音后进卡即读', JSON.stringify(requestedTexts()))
  eq('A17b 自动发音读的是当前卡片的词', audio.getState().key, 'word')

  audio.setPrefs({ autoPlay: false })
  const noAuto = makePage('pages/study/study.js')
  resetPlayLog()
  noAuto.onLoad({ mode: 'new' })
  await tick()
  eq('A18 关掉自动发音后进卡不发声', LOG.sources.length, 0)

  // 卸载
  p.speakWord()
  p.onUnload()
  eq('A19 卸载后停止播放', audio.getState().key, '')
  const setDataAfter = p.__setData
  p.speakWord()
  eq('A20 卸载后不再回填页面（watcher 已解绑）', p.__setData, setDataAfter)

  // 结算时停止
  const p2 = makePage('pages/study/study.js')
  p2.onLoad({ mode: 'new' })
  await p2.load()
  await tick()
  p2.speakWord()
  p2.showSummary(true)
  eq('A21 结算页停止播放', audio.getState().key, '')
}

// =====================================================================
// B. 生词本列表
// =====================================================================
async function testWords() {
  group('B. pages/words 生词本列表')
  resetUi()
  resetPlayLog()
  const p = makePage('pages/words/words.js')
  p.onLoad({})
  await p.loadPage(1)
  await tick()

  eq('B1 列表拿到 2 条', p.data.list.length, 2)
  eq('B2 每行带播放标识', p.data.list[0].key, 'w11')
  eq('B3 第二行标识正确', p.data.list[1].key, 'w12')

  p.speakWord({ currentTarget: { dataset: { id: 12, word: 'souris' } } })
  eq('B4 点喇叭读的是该行的词', lastText(), 'souris')
  eq('B5 播放标识按行 id 生成', audio.getState().key, 'w12')
  eq('B6 播放态回填', p.data.playingKey, 'w12')

  // 没有 word 字段（异常数据）不应该炸
  resetPlayLog()
  p.speakWord({ currentTarget: { dataset: { id: 99 } } })
  eq('B7 缺词文本不发声', LOG.sources.length, 0)

  p.onUnload()
  eq('B8 卸载停止播放', audio.getState().key, '')
}

// =====================================================================
// C. 生词详情
// =====================================================================
async function testWordDetail() {
  group('C. pages/word-detail 生词详情')
  resetUi()
  resetPlayLog()
  const p = makePage('pages/word-detail/word-detail.js')
  p.onLoad({ id: 11 })
  await p.load()
  await tick()

  eq('C1 载入后表单有词', p.data.form.word, 'gorge')
  p.speakWord()
  eq('C2 读单词用的是输入框现值', lastText(), 'gorge')
  eq('C3 播放态为 word', p.data.playingKey, 'word')

  p.speakExample()
  eq('C4 读例句用的是输入框现值', lastText(), 'Il a mal à la gorge.')
  eq('C5 播放态为 example', p.data.playingKey, 'example')

  // 改了还没保存也能读
  p.data.form.word = 'souris'
  resetPlayLog()
  p.speakWord()
  eq('C6 未保存的改动也能读', lastText(), 'souris')

  // 清空后给提示、不发声
  resetUi()
  resetPlayLog()
  p.data.form.word = '   '
  p.speakWord()
  eq('C7 空单词不发声', LOG.sources.length, 0)
  eq('C8 空单词给提示', lastToast(), '请先输入法语单词')

  resetUi()
  resetPlayLog()
  p.data.form.example_fr = ''
  p.speakExample()
  eq('C9 空例句不发声', LOG.sources.length, 0)
  eq('C10 空例句给提示', lastToast(), '请先填写法语例句')

  // 新建态也一样能读
  resetPlayLog()
  const p2 = makePage('pages/word-detail/word-detail.js')
  p2.onLoad({})
  p2.setData({ 'form.word': 'merci', 'form.example_fr': 'Merci beaucoup !' })
  p2.speakWord()
  eq('C11 新建态也能读单词', lastText(), 'merci')
  p2.speakExample()
  eq('C12 新建态也能读例句', lastText(), 'Merci beaucoup !')

  p.onUnload()
  eq('C13 卸载停止播放', audio.getState().key, '')
}

// =====================================================================
// D. 我的 - 发音设置
// =====================================================================
async function testMine() {
  group('D. pages/mine 发音设置')
  resetUi()
  resetPlayLog()
  audio.setPrefs({ autoPlay: false, ignoreMute: true })
  const p = makePage('pages/mine/mine.js')
  p.onShow()
  await tick()

  eq('D1 进入时读到当前偏好', p.data.autoPlay, false)
  eq('D2 静音偏好也读出来', p.data.ignoreMute, true)

  p.onAutoPlay({ detail: { value: true } })
  eq('D3 打开自动发音写入偏好', audio.getPrefs().autoPlay, true)
  eq('D4 页面状态同步', p.data.autoPlay, true)
  p.onAutoPlay({ detail: { value: false } })
  eq('D5 关掉也生效', audio.getPrefs().autoPlay, false)

  const optBefore = LOG.audioOptions.length
  p.onIgnoreMute({ detail: { value: false } })
  eq('D6 关掉「静音也出声」写入偏好', audio.getPrefs().ignoreMute, false)
  ck(LOG.audioOptions.length > optBefore, 'D7 偏好变化会重设音频参数')
  eq('D8 尊重静音键', LOG.audioOptions[LOG.audioOptions.length - 1].obeyMuteSwitch, true)
  p.onIgnoreMute({ detail: { value: true } })
  eq('D9 重新打开「静音也出声」', LOG.audioOptions[LOG.audioOptions.length - 1].obeyMuteSwitch, false)

  p.testAudio()
  eq('D10 试听真的发起了播放', LOG.sources.length, 1)
  // 试听句里特意放了兜底音源读不出来的词，能读出来才说明主音源真的通了
  ck(lastText().indexOf('Test de prononciation') === 0, 'D11 试听内容是法语', lastText())
  ck(lastText().indexOf('abbaye') > 0 && lastText().indexOf('thème') > 0, 'D11b 试听句含兜底音源读不出的词',
    lastText())
  eq('D12 试听标识为 test', audio.getState().key, 'test')

  const modalBefore = ui.modals.length
  audioHandlers.error({ errCode: 10002 })
  ck(ui.modals.length > modalBefore, 'D13 10002 会给出域名配置提示')
  // 提示里必须写明「是哪个域名」—— 域名没配的表现和「某些词读不出来」一模一样，
  // 不指名道姓用户就会去查词，而不是查配置
  const primaryHost = /^https?:\/\/([^/]+)/.exec(audio.buildUrl('bonjour'))[1]
  ck(ui.modals[ui.modals.length - 1].content.indexOf(primaryHost) > 0, 'D14 提示里写明出错域名', primaryHost)
  ck(ui.modals[ui.modals.length - 1].content.indexOf('downloadFile') > 0, 'D15 提示里写明要配的两处')
  if (audio.sourceList().length > 1) {
    ck(audio.getState().sourceIndex === 1, 'D16 主音源失败自动切到兜底音源', audio.getState().source)
  }
}

// =====================================================================
// E. WXML 静态接线
// =====================================================================
function testWxml() {
  group('E. WXML 接线（静态）')
  const study = fs.readFileSync(path.join(PROJ, 'pages/study/study.wxml'), 'utf8')
  const words = fs.readFileSync(path.join(PROJ, 'pages/words/words.wxml'), 'utf8')
  const detail = fs.readFileSync(path.join(PROJ, 'pages/word-detail/word-detail.wxml'), 'utf8')
  const mine = fs.readFileSync(path.join(PROJ, 'pages/mine/mine.wxml'), 'utf8')

  ck(study.indexOf('catchtap="speakWord"') > 0, 'E1 学习卡片喇叭用 catchtap（不能顺带翻卡）')
  ck(study.indexOf('catchtap="speakExample"') > 0, 'E2 例句整块可点且不翻卡')
  ck(study.indexOf("playingKey === 'word'") > 0, 'E3 单词喇叭有播放态样式')
  ck(study.indexOf("playingKey === 'example'") > 0, 'E4 例句喇叭有播放态样式')

  ck(words.indexOf('catchtap="speakWord"') > 0, 'E5 列表喇叭用 catchtap（不能顺带进详情）')
  ck(/catchtap="speakWord"[\s\S]*?data-word="\{\{item\.word\}\}"/.test(words), 'E6 列表喇叭带上了词文本')
  ck(words.indexOf("playingKey === item.key") > 0, 'E7 列表喇叭按行高亮')

  ck(detail.indexOf('🔊 读单词') > 0 && detail.indexOf('🔊 读例句') > 0, 'E8 详情页两个发音按钮都在')
  ck(detail.indexOf("form.word ? '' : 'speak-pill-off'") > 0, 'E9 空单词时按钮灰掉')

  ck(mine.indexOf('bindchange="onAutoPlay"') > 0, 'E10 自动发音开关在位')
  ck(mine.indexOf('bindchange="onIgnoreMute"') > 0, 'E11 静音键开关在位')
  ck(mine.indexOf('bindtap="testAudio"') > 0, 'E12 试听按钮在位')

  // 所有用到 playingKey 的页面都要在 data 里声明，否则 WXML 取到 undefined 也不报错但样式永远不亮
  for (const name of ['study', 'words', 'word-detail']) {
    const js = fs.readFileSync(path.join(PROJ, 'pages/' + name + '/' + name + '.js'), 'utf8')
    ck(js.indexOf("playingKey: ''") > 0, 'E13 ' + name + ' 声明了 playingKey')
    ck(js.indexOf('audio.bindPage(this)') > 0, 'E14 ' + name + ' 在 onLoad 里 bindPage')
  }
}

// =====================================================================
;(async () => {
  try {
    await testStudy()
    await testWords()
    await testWordDetail()
    await testMine()
    testWxml()
  } catch (e) {
    console.log('\n💥 抛异常：' + (e && e.stack ? e.stack : e))
    fail++
    failures.push('运行时异常')
  }
  console.log('')
  if (fail) {
    console.log('❌ 失败 ' + fail + ' 项，通过 ' + pass + ' 项')
    failures.forEach((f) => console.log('   - ' + f))
    process.exit(1)
  }
  console.log('✅ 发音页面联调全部通过：' + pass + '/' + pass)
})()
