/**
 * 「例句单词可点跳词条」的离线测试（无 headless）：
 *   A. 切词保真：拼回去必须与原文逐字符相等（少一个空格就是排版事故）
 *   B. 查词候选与 headWord：不能把 quelqu'un 的本词判成 un
 *   C. 真 pages/study + 真 utils/fr-text：点词跳详情 / 未命中跳新增 / 缓存 / 防连点
 *   D. 真 pages/word-detail：?word= 预填与解码容错
 *
 * 跑法：node test-example-link.cjs <小程序根目录>
 */
const path = require('path')
const Module = require('module')

const PROJ = process.argv[2] || 'C:/Users/24934/WorkBuddy/2026-10-05-13-00-04/french-vocab-miniprogram'

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

// ============================ 假 wx ============================
const ui = { toasts: [], navs: [], backs: 0, loadings: 0, hidings: 0 }
const LOG = { sources: [], stops: 0 }
const STORAGE = Object.create(null)
const FILES = new Set()
const DIRS = new Set()

class FakeAudio {
  set src(v) {
    this._src = v
    LOG.sources.push(v)
  }
  get src() {
    return this._src
  }
  play() {}
  stop() {
    LOG.stops++
  }
  destroy() {}
  onPlay() {}
  onEnded() {}
  onStop() {}
  onError() {}
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
  showToast: (o) => ui.toasts.push((o && o.title) || ''),
  showModal: (o) => {
    if (o && typeof o.success === 'function') o.success({ confirm: true, cancel: false })
  },
  showLoading: () => {
    ui.loadings++
  },
  hideLoading: () => {
    ui.hidings++
  },
  navigateTo: (o) => ui.navs.push(o && o.url),
  navigateBack: () => {
    ui.backs++
  },
  switchTab: () => {},
  getFileSystemManager: () => ({
    accessSync: (p) => {
      if (!FILES.has(p) && !DIRS.has(p)) throw new Error('ENOENT')
    },
    mkdirSync: (p) => DIRS.add(p),
    copyFileSync: (a, b) => FILES.add(b),
    readdirSync: () => [],
    statSync: () => ({ mtime: Date.now(), size: 8000 }),
    unlinkSync: (p) => FILES.delete(p),
  }),
  downloadFile: (o) => {
    const temp = '/tmp/x.mp3'
    FILES.add(temp)
    o.success && o.success({ statusCode: 200, tempFilePath: temp })
    o.complete && o.complete()
  },
}
global.getApp = () => ({ globalData: {}, markDirty() {} })

// ============================ 数据桩 ============================
// 假词库：findWordByText 做「大小写不敏感 + 精确」匹配，并记录每次被查的词形
const LIB = [
  { id: 101, word: 'bonjour', phonetic: 'bɔ̃.ʒuʁ', pos: 'interj.', meaning_zh: '你好', status: 'learning', library_id: null },
  { id: 102, word: 'école', phonetic: 'e.kɔl', pos: 'n.f.', meaning_zh: '学校', status: 'learning', library_id: null },
  { id: 103, word: 'bibliothèque', pos: 'n.f.', meaning_zh: '图书馆', status: 'learning', library_id: null },
  // 故意放一个 un：用来证明 quelqu'un 不会被误判成 un
  { id: 104, word: 'un', pos: 'art.', meaning_zh: '一个', status: 'learning', library_id: null },
  { id: 105, word: 'vous', pos: 'pron.', meaning_zh: '您', status: 'learning', library_id: null },
]
const LOOKUPS = []
function resetLookups() {
  LOOKUPS.length = 0
}
function libFind(text) {
  const w = String(text || '').trim().toLowerCase()
  LOOKUPS.push(String(text))
  const hit = LIB.find((r) => String(r.word).toLowerCase() === w)
  return hit || null
}

const cards = {
  new: [
    {
      id: 1,
      word: 'bonjour',
      phonetic: 'bɔ̃.ʒuʁ',
      pos: 'interj.',
      meaning_zh: '你好',
      example_fr: 'Bonjour, comment allez-vous ?',
      example_zh: '你好，你好吗？',
      mnemonic: '',
      status: 'new',
    },
  ],
}

const apiStub = {
  async getActivePlan() {
    return { daily_new: 10, daily_review_cap: 50 }
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
  async findWordByText(text) {
    return libFind(text)
  },
  async getWord(id) {
    const row = LIB.find((r) => r.id === id)
    return row ? Object.assign({ example_fr: '', example_zh: '', mnemonic: '' }, row) : null
  },
  async createWord() {
    return {}
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
  if (/utils[\\/]llm$/.test(request)) return { completeWord: async () => ({}), generateExample: async () => ({}) }
  return origLoad.apply(this, arguments)
}

const frText = require(path.join(PROJ, 'utils/fr-text.js'))

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
  inst.setData = function (patch) {
    for (const k of Object.keys(patch)) setPath(inst.data, k, patch[k])
  }
  return inst
}
const tick = () => new Promise((r) => setTimeout(r, 5))
function tap(page, word) {
  return page.onExampleWord({ currentTarget: { dataset: { word } } })
}

// ============================ A. 切词保真 ============================
async function testTokenize() {
  group('A. 切词保真')
  const sentences = [
    'Bonjour, comment allez-vous ?',
    'Je vais à la bibliothèque.',
    'L\u2019école est fermée aujourd\u2019hui.',
    "Il mange du chef-d'œuvre : c'est délicieux !",
    '« Qu\u2019est-ce que c\u2019est ? »',
    'Deux 3 trois…',
    '',
    '   ',
    '???',
  ]
  sentences.forEach((s, i) => {
    const parts = frText.tokenize(s)
    eq('A' + (i + 1) + ' 拼回去与原文一致', parts.map((p) => p.t).join(''), s)
  })

  const words = (s) => frText.tokenize(s).filter((p) => p.w).map((p) => p.t)
  eq('A10 逗号/空格/问号都留在外层', JSON.stringify(words('Bonjour, comment allez-vous ?')), JSON.stringify(['Bonjour', 'comment', 'allez-vous']))
  eq('A11 弯撇号与连字符算词内字符', JSON.stringify(words('L\u2019école est fermée aujourd\u2019hui.')), JSON.stringify(['L\u2019école', 'est', 'fermée', 'aujourd\u2019hui']))
  eq('A12 合字不拆', JSON.stringify(words("chef-d'œuvre")), JSON.stringify(["chef-d'œuvre"]))
  eq('A13 引号与标点不被当成词', JSON.stringify(words('« Qu\u2019est-ce que c\u2019est ? »')), JSON.stringify(['Qu\u2019est-ce', 'que', 'c\u2019est']))
  eq('A14 空串切出空数组', frText.tokenize('').length, 0)

  // 每个「可点」片段必须只含字母与词内连接符；index 是 wx:key
  const parts = frText.tokenize("L'école, c'est ça ? 3 fois.")
  ck(
    parts.every((p) => !p.w || /^[A-Za-zÀ-ÖØ-ÿŒœ'\u2019\-]+$/.test(p.t)),
    'A15 可点片段只含字母与连接符',
    parts.filter((p) => p.w && !/^[A-Za-zÀ-ÖØ-ÿŒœ'\u2019\-]+$/.test(p.t)),
  )
  ck(
    parts.every((p, i) => p.i === i),
    'A16 片段索引连续（给 wx:key 用）',
    parts.map((p) => p.i),
  )
}

// ============================ B. 候选与 headWord ============================
async function testCandidates() {
  group('B. 查词候选 / headWord')
  eq('B1 l\u2019école 的本词是 école', frText.headWord("l'école"), 'école')
  eq('B2 quelqu\u2019un 不能变成 un', frText.headWord("quelqu'un"), "quelqu'un")
  eq('B3 aujourd\u2019hui 不能变成 hui', frText.headWord("aujourd'hui"), "aujourd'hui")
  eq('B4 chef-d\u2019œuvre 整词优先', frText.headWord("chef-d'œuvre"), "chef-d'œuvre")
  eq('B5 est-ce 不加戏', frText.headWord('est-ce'), 'est-ce')

  eq('B6 l\u2019école 候选', JSON.stringify(frText.lookupCandidates("l'école")), JSON.stringify(["l'école", 'école']))
  eq('B7 est-ce 退化到语素', JSON.stringify(frText.lookupCandidates('est-ce')), JSON.stringify(['est-ce', 'est', 'ce']))
  eq('B8 chef-d\u2019œuvre 也试 œuvre', JSON.stringify(frText.lookupCandidates("chef-d'œuvre")), JSON.stringify(["chef-d'œuvre", 'chef', 'œuvre', "d'œuvre"]))
  eq('B9 quelqu\u2019un 只查整词', JSON.stringify(frText.lookupCandidates("quelqu'un")), JSON.stringify(["quelqu'un"]))
  eq('B10 单字符不进候选', JSON.stringify(frText.lookupCandidates('à')), '[]')
  eq('B11 去重', JSON.stringify(frText.lookupCandidates('peut-être')), JSON.stringify(['peut-être', 'peut', 'être']))
}

// ============================ C. study 页点词 ============================
async function testStudyPage() {
  group('C. study 页点词跳转')
  const p = makePage('pages/study/study.js')
  p.onLoad({ mode: 'new' })
  await p.load()
  await tick()

  eq('C1 例句已切好', p.data.exampleParts.filter((x) => x.w).map((x) => x.t).join('|'), 'Bonjour|comment|allez-vous')
  eq('C2 拼回去与例句一致', p.data.exampleParts.map((x) => x.t).join(''), p.data.card.example_fr)

  // 库里已有 → 跳详情
  resetLookups()
  await tap(p, 'Bonjour')
  eq('C3 命中库里的词 → 跳详情页', ui.navs[ui.navs.length - 1], '/pages/word-detail/word-detail?id=101')
  eq('C4 只查了一次、且是原词形', JSON.stringify(LOOKUPS), JSON.stringify(['Bonjour']))
  ck(LOOKUPS.every((w) => w.indexOf('%') < 0 && w.indexOf('_') < 0), 'C5 查询不带 LIKE 通配符（否则会变成模糊搜索）', LOOKUPS)

  // 缓存：再点同一个词不再查库
  await tap(p, 'Bonjour')
  eq('C6 同词二次点击不再查库', LOOKUPS.length, 1)
  eq('C7 仍然跳到同一个词条', ui.navs[ui.navs.length - 1], '/pages/word-detail/word-detail?id=101')

  // 库里没有 → 带词开新增页
  await tap(p, 'comment')
  eq('C8 未命中 → 开新增页并把词带过去', ui.navs[ui.navs.length - 1], '/pages/word-detail/word-detail?word=comment')

  // 变位形式逐级降级：allez-vous → allez / vous（库里只有 vous）
  await tap(p, 'allez-vous')
  eq('C9 变位/复合形式按候选降级命中', ui.navs[ui.navs.length - 1], '/pages/word-detail/word-detail?id=105')

  // 撇号词：整词没有、本词有
  await tap(p, "l'école")
  eq('C10 l\u2019école → 命中 école', ui.navs[ui.navs.length - 1], '/pages/word-detail/word-detail?id=102')

  // quelqu'un：库里只有 un，绝不能被当成 un
  await tap(p, "quelqu'un")
  // 撇号不被 encodeURIComponent 编码，URL 里就是原样的 quelqu'un
  eq('C11 quelqu\u2019un 未命中就开新增页', ui.navs[ui.navs.length - 1], "/pages/word-detail/word-detail?word=quelqu'un")
  ck(LOOKUPS.indexOf('un') < 0, 'C12 没有拿 un 去查（否则会误跳 un 的词条）', LOOKUPS)

  // 防连点：一次点击只开一个页面
  const before = ui.navs.length
  const busy1 = tap(p, 'bibliothèque')
  const busy2 = tap(p, 'bibliothèque')
  await Promise.all([busy1, busy2])
  await tick()
  eq('C13 连点只跳一次', ui.navs.length, before + 1)
  eq('C14 连点只查一次库', LOOKUPS.filter((w) => w === 'bibliothèque').length, 1)
  eq('C15 loading 开关配对', ui.loadings - ui.hidings, 0)

  // 查库失败：提示而不是静默
  const realFind = apiStub.findWordByText
  apiStub.findWordByText = async () => {
    throw new Error('网络异常，请检查网络后重试')
  }
  resetLookups()
  const navsBeforeFail = ui.navs.length
  await tap(p, 'fermée')
  apiStub.findWordByText = realFind
  ck(ui.toasts[ui.toasts.length - 1].indexOf('网络') >= 0, 'C16 查库失败给出提示', ui.toasts[ui.toasts.length - 1])
  eq('C17 查询失败不跳页', ui.navs.length, navsBeforeFail)
  eq('C18 失败也解锁，不会卡住后续点击', p.lookupBusy, false)

  // 点词会掐掉正在播的例句
  p.speakExample()
  await tick()
  const stopsBefore = LOG.stops
  await tap(p, 'Bonjour')
  ck(LOG.stops > stopsBefore, 'C19 跳转前停止朗读', LOG.stops)
  eq('C20 页面播放态已清空', p.data.playingKey, '')

  // 空/非字母不触发查询
  const navsBefore = ui.navs.length
  const lookupsBefore = LOOKUPS.length
  await tap(p, '')
  await tap(p, '   ')
  await tap(p, '·')
  eq('C21 空片段不查库', LOOKUPS.length, lookupsBefore)
  eq('C22 空片段不跳页', ui.navs.length, navsBefore)

  // 换卡片时重新切词
  p.showCard()
  eq('C23 换卡后例句片段与当前卡一致', p.data.exampleParts.map((x) => x.t).join(''), p.data.card.example_fr)
}

// ============================ D. word-detail 预填 ============================
async function testWordDetail() {
  group('D. 详情页 ?word= 预填')
  const a = makePage('pages/word-detail/word-detail.js')
  a.onLoad({ word: 'comment' })
  eq('D1 预填词形', a.data.form.word, 'comment')
  eq('D2 仍然是新增态', a.data.isNew, true)
  ck(a.data.prefillNote.indexOf('comment') >= 0, 'D3 给出说明文案', a.data.prefillNote)

  const b = makePage('pages/word-detail/word-detail.js')
  b.onLoad({ word: encodeURIComponent("l'école") })
  eq('D4 未解码的入参能兜住', b.data.form.word, "l'école")

  const c = makePage('pages/word-detail/word-detail.js')
  c.onLoad({})
  eq('D5 普通新增不预填', c.data.form.word, '')
  eq('D6 普通新增不显示说明', c.data.prefillNote, '')

  const d = makePage('pages/word-detail/word-detail.js')
  d.onLoad({ id: '102' })
  await tick()
  eq('D7 带 id 仍走编辑态', d.data.isNew, false)
  eq('D8 带 id 时读到的是库里那条', d.data.form.word, 'école')
  eq('D9 带 id 不显示预填说明', d.data.prefillNote, '')
}

async function main() {
  await testTokenize()
  await testCandidates()
  await testStudyPage()
  await testWordDetail()

  console.log('\n----------------------------------------')
  console.log('例句点词：' + pass + '/' + (pass + fail) + ' 通过')
  if (fail) {
    console.log('失败项：')
    failures.forEach((f) => console.log('  - ' + f))
  }
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('测试脚本自身出错：', e)
  process.exit(1)
})
