/**
 * 词库功能的端到端（无 headless）测试：
 *   - 真 api.js + 内存版 supabase 查询构建器（校验 libraryId 'none'/数字/空 三条分支）
 *   - 真 pages/import、pages/libraries、pages/words（拦 Module._load 只替换外部依赖）
 *   - 真 utils/sheet.js（CSV / XLSX 真样本喂进去）
 *
 * 跑法：node test-pages.cjs
 */
const fs = require('fs')
const path = require('path')
const Module = require('module')

// 路径相对本文件定位，换机器 / 换目录都不用改
const ROOT = path.resolve(__dirname, '..')
const PROJ = path.join(ROOT, 'french-vocab-miniprogram')
const SAMPLES = path.resolve(__dirname, 'fixtures', 'sheet-samples')
const TMP = path.resolve(__dirname, '.tmp')

let pass = 0
let fail = 0
const failures = []
function ck(cond, label, extra) {
  if (cond) {
    pass++
  } else {
    fail++
    failures.push(label)
    console.log('  FAIL ' + label + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''))
  }
}
function group(name) {
  console.log('\n== ' + name + ' ==')
}

// =====================================================================
// 内存版 supabase 风格查询构建器（给真 api.js 用）
// =====================================================================
class Query {
  constructor(name, tables) {
    this.name = name
    this.tables = tables
    this.fs = []
    this.op = 'select'
    this.rangeV = null
    this.limitV = null
    this.single = false
    this.wantCount = false
  }
  select(_cols, opts) {
    if (opts && opts.count) this.wantCount = true
    return this
  }
  insert(d) {
    this.op = 'insert'
    this.payload = d
    return this
  }
  update(d) {
    this.op = 'update'
    this.payload = d
    return this
  }
  delete() {
    this.op = 'delete'
    return this
  }
  eq(k, v) {
    this.fs.push((r) => String(r[k]) === String(v))
    return this
  }
  is(k, v) {
    this.fs.push((r) => (v === null ? r[k] === null || r[k] === undefined : r[k] === v))
    return this
  }
  not() {
    return this
  }
  lte(k, v) {
    this.fs.push((r) => r[k] <= v)
    return this
  }
  gte(k, v) {
    this.fs.push((r) => r[k] >= v)
    return this
  }
  or() {
    return this
  }
  order() {
    return this
  }
  limit(n) {
    this.limitV = n
    return this
  }
  range(a, b) {
    this.rangeV = [a, b]
    return this
  }
  maybeSingle() {
    this.single = true
    return this
  }
  _clone(r) {
    return Object.assign({}, r)
  }
  _run() {
    if (!this.tables[this.name]) this.tables[this.name] = []
    const t = this.tables[this.name]
    if (this.op === 'insert') {
      const arr = Array.isArray(this.payload) ? this.payload : [this.payload]
      const made = arr.map((r) => Object.assign({}, r))
      made.forEach((r) => t.push(r))
      return { data: made.map(this._clone), error: null }
    }
    if (this.op === 'update') {
      const hit = t.filter((r) => this.fs.every((f) => f(r)))
      hit.forEach((r) => Object.assign(r, this.payload))
      return { data: hit.map(this._clone), error: null }
    }
    if (this.op === 'delete') {
      const keep = []
      const hit = []
      t.forEach((r) => (this.fs.every((f) => f(r)) ? hit.push(r) : keep.push(r)))
      this.tables[this.name] = keep
      return { data: hit.map(this._clone), error: null }
    }
    let rows = t.filter((r) => this.fs.every((f) => f(r)))
    const total = rows.length
    if (this.rangeV) rows = rows.slice(this.rangeV[0], this.rangeV[1] + 1)
    if (this.limitV) rows = rows.slice(0, this.limitV)
    if (this.single) return { data: rows.length ? this._clone(rows[0]) : null, error: null }
    return {
      data: rows.map(this._clone),
      error: null,
      count: this.wantCount ? total : undefined,
    }
  }
  then(resolve, reject) {
    try {
      resolve(this._run())
    } catch (e) {
      if (reject) reject(e)
      else throw e
    }
  }
}

// =====================================================================
// 全局共享的可变状态
// =====================================================================
const tables = { fr_libraries: [], fr_words: [] }
const cloudStub = {
  cloud: { database: { from: (n) => new Query(n, tables) } },
  requireSession: async () => {},
  friendlyError: (e) => (e && (e.message || e.errMsg)) || '未知错误',
  getUserId: async () => 'u-1',
  CLOUD_ENDPOINT: 'https://example.invalid',
  CLOUD_PUBLISHABLE_KEY: 'pk_test',
}
const configStub = { endpoint: 'https://example.invalid', publishableKey: 'pk_test' }

// api 的桩：给页面测试用（真 api.js 单独测）
const fake = {
  libs: [],
  words: [],
  keys: { inLibrary: Object.create(null), elsewhere: Object.create(null) },
  stats: { byLibrary: {}, ungrouped: { total: 0, mastered: 0, fresh: 0 } },
  calls: { createWords: [], createLibrary: [], updateLibrary: [], listWords: [], deleteCascade: [] },
  nextLibId: 100,
  nextWordId: 1000,
}

const apiStub = {
  async listLibraries() {
    return fake.libs.map((l) => Object.assign({}, l))
  },
  async libraryStats() {
    return fake.stats
  },
  async wordKeysForLibrary(id) {
    apiStub.lastKeysQuery = id
    return fake.keys
  },
  async createLibrary(p) {
    fake.calls.createLibrary.push(Object.assign({}, p))
    const lib = { id: fake.nextLibId++, name: p.name, level: p.level || '' }
    fake.libs.push(lib)
    return lib
  },
  async updateLibrary(id, patch) {
    fake.calls.updateLibrary.push({ id, patch })
    const lib = fake.libs.filter((l) => l.id === id)[0]
    if (!lib) throw new Error('未找到该词库或无权修改')
    Object.assign(lib, patch)
    return lib
  },
  async deleteLibraryCascade(id) {
    fake.calls.deleteCascade.push(id)
    const before = fake.words.length
    fake.words = fake.words.filter((w) => w.library_id !== id)
    const removed = before - fake.words.length
    fake.libs = fake.libs.filter((l) => l.id !== id)
    return { deleted: 1, words: removed }
  },
  async createWords(list) {
    fake.calls.createWords.push(list.map((r) => Object.assign({}, r)))
    list.forEach((r) => fake.words.push(Object.assign({ id: fake.nextWordId++ }, r)))
    return list
  },
  async createWord(p) {
    const w = Object.assign({ id: fake.nextWordId++ }, p)
    fake.words.push(w)
    return w
  },
  async listExistingWordKeys() {
    const s = Object.create(null)
    fake.words.forEach((w) => (s[String(w.word || '').toLowerCase()] = true))
    return s
  },
  async listWords(opts) {
    fake.calls.listWords.push(Object.assign({}, opts))
    let list = fake.words.slice()
    if (opts.libraryId === 'none') list = list.filter((w) => w.library_id === null || w.library_id === undefined)
    else if (opts.libraryId) list = list.filter((w) => Number(w.library_id) === Number(opts.libraryId))
    const size = Number(opts.size) || 20
    const page = Number(opts.page) || 1
    return { list: list.slice((page - 1) * size, page * size), total: list.length }
  },
  async getWord(id) {
    return fake.words.filter((w) => w.id === id)[0] || null
  },
  async updateWord(id, patch) {
    const w = fake.words.filter((x) => x.id === id)[0]
    if (!w) throw new Error('未找到该生词或无权修改')
    Object.assign(w, patch)
    return w
  },
  async deleteWord(id) {
    fake.words = fake.words.filter((w) => w.id !== id)
    return 1
  },
  async resetWordSrs(id) {
    const w = fake.words.filter((x) => x.id === id)[0]
    if (w) Object.assign(w, { stage: 0, due_date: null, status: 'learning', lapses: 0 })
    return w
  },
}

const llmCalls = []
const llmStub = {
  MAX_PARSE_CHARS: 30000,
  async completeWord(word) {
    llmCalls.push(word)
    return { word, phonetic: '[x]', pos: 'n.m.', meaning_zh: '释义-' + word, example_fr: 'Ex ' + word, example_zh: '例' }
  },
  async generateExample() {
    return { example_fr: 'x', example_zh: 'y', mnemonic: '' }
  },
}

const origLoad = Module._load
Module._load = function (request) {
  if (/workbuddy-cloud-sdk/.test(request)) return { createMiniProgramWorkBuddyCloud: () => ({}) }
  if (/(^|\/)cloud$/.test(request)) return cloudStub
  if (/(^|\/)config$/.test(request)) return configStub
  if (/utils[\\/]api$/.test(request)) return apiStub
  if (/utils[\\/]llm$/.test(request)) return llmStub
  return origLoad.apply(this, arguments)
}

// =====================================================================
// 假宿主环境
// =====================================================================
const ui = { toasts: [], modals: [], navs: [], switchTabs: [], backs: 0, loadings: 0, stops: 0 }
function resetUi() {
  ui.toasts = []
  ui.modals = []
  ui.navs = []
  ui.switchTabs = []
  ui.backs = 0
  ui.loadings = 0
  ui.stops = 0
}
function lastToast() {
  return ui.toasts.length ? ui.toasts[ui.toasts.length - 1] : ''
}

global.wx = {
  showToast: (o) => ui.toasts.push((o && o.title) || ''),
  showModal: (o) => {
    ui.modals.push(o)
    if (o && typeof o.success === 'function') o.success({ confirm: true, cancel: false })
  },
  showLoading: () => {
    ui.loadings += 1
  },
  hideLoading: () => {},
  navigateTo: (o) => ui.navs.push(o && o.url),
  navigateBack: () => {
    ui.backs += 1
  },
  switchTab: (o) => ui.switchTabs.push(o && o.url),
  stopPullDownRefresh: () => {
    ui.stops += 1
  },
  chooseMessageFile: () => {},
  chooseMedia: () => {},
  getFileSystemManager: () => ({ statSync: () => ({ size: 0 }), readFile: () => {} }),
}
const app = {
  globalData: {},
  markDirty() {
    this.marked = (this.marked || 0) + 1
  },
}
global.getApp = () => app
global.Component = () => {}

// =====================================================================
// 迷你 setData（支持 'a[0].b' 路径）+ 页面实例工厂
// =====================================================================
function setPath(root, keyPath, val) {
  const parts = String(keyPath).split('.')
  let cur = root
  for (let i = 0; i < parts.length - 1; i++) {
    const m = parts[i].match(/^(.*?)\[(\d+)\]$/)
    if (m) {
      const k = m[1]
      if (k) {
        if (!cur[k]) cur[k] = []
        cur = cur[k][Number(m[2])]
      } else if (Array.isArray(cur)) cur = cur[Number(m[2])]
      else cur = cur[Number(m[2])]
    } else {
      if (!cur[parts[i]]) cur[parts[i]] = {}
      cur = cur[parts[i]]
    }
  }
  const last = parts[parts.length - 1]
  const m2 = last.match(/^(.*?)\[(\d+)\]$/)
  if (m2) {
    const k = m2[1]
    if (k) {
      if (!cur[k]) cur[k] = []
      cur[k][Number(m2[2])] = val
    } else cur[Number(m2[2])] = val
  } else cur[last] = val
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
  inst.__setDataCalls = 0
  inst.data = JSON.parse(JSON.stringify(cfg.data))
  inst.setData = function (patch) {
    inst.__setDataCalls += 1
    for (const k of Object.keys(patch)) setPath(inst.data, k, patch[k])
  }
  return inst
}
function ev(target, value) {
  return { currentTarget: { dataset: target || {} }, detail: { value } }
}
function tap(target) {
  return { currentTarget: { dataset: target || {} } }
}
function reset() {
  resetUi()
  fake.libs = []
  fake.words = []
  fake.keys = { inLibrary: Object.create(null), elsewhere: Object.create(null) }
  fake.stats = { byLibrary: {}, ungrouped: { total: 0, mastered: 0, fresh: 0 } }
  fake.calls = { createWords: [], createLibrary: [], updateLibrary: [], listWords: [], deleteCascade: [] }
  app.globalData = {}
  app.marked = 0
  llmCalls.length = 0
}

// 真 storage + 读盘覆写
const storage = require(path.join(PROJ, 'utils/storage.js'))
storage.readAsArrayBuffer = async (p) => new Uint8Array(fs.readFileSync(p))

function sample(name) {
  return path.join(SAMPLES, name)
}

// 生成 250 行的 CSV，用于校验分片写入；再生成 30 行单列 CSV，用于校验 AI 批量补全上限
const BIG_CSV = path.join(TMP, 'big250.csv')
const SINGLE30_CSV = path.join(TMP, 'single30.csv')
;(function makeBig() {
  if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true })
  const lines = ['mot,definition']
  for (let i = 1; i <= 250; i++) lines.push('motsu' + i + ',词汇' + i)
  fs.writeFileSync(BIG_CSV, lines.join('\n'), 'utf8')
  const one = []
  for (let i = 1; i <= 30; i++) one.push('motseul' + i)
  fs.writeFileSync(SINGLE30_CSV, one.join('\n'), 'utf8')
})()
const tick = () => new Promise((r) => setTimeout(r, 0))

// =====================================================================
async function main() {
  // ---------------------------------------------------------------
  group('A. 真 api.js：词库筛选与统计')
  // ---------------------------------------------------------------
  {
    tables.fr_libraries = [
      { id: 1, name: 'B1 库', level: 'B1' },
      { id: 2, name: '工程师库', level: '' },
    ]
    tables.fr_words = [
      { id: 11, word: 'bonjour', library_id: 1, status: 'learning', stage: 0, due_date: null },
      { id: 12, word: 'merci', library_id: 1, status: 'mastered', stage: 5, due_date: '2026-01-01' },
      { id: 13, word: 'livre', library_id: 2, status: 'learning', stage: 2, due_date: '2026-02-01' },
      { id: 14, word: 'eau', library_id: null, status: 'learning', stage: 0, due_date: null },
      { id: 15, word: 'train', library_id: null, status: 'mastered', stage: 5, due_date: '2026-01-01' },
    ]
    // 清掉 require 缓存，保证 api.js 拿到的是内存 db
    delete require.cache[require.resolve(path.join(PROJ, 'utils/api.js'))]
    const api = require(path.join(PROJ, 'utils/api.js'))

    const all = await api.listWords({ page: 1, size: 20, libraryId: '' })
    ck(all.total === 5, 'listWords 不传词库 → 全部 5 条', all.total)

    const none = await api.listWords({ page: 1, size: 20, libraryId: 'none' })
    ck(none.total === 2, "listWords libraryId='none' → 仅未分组 2 条", none.total)
    ck(
      none.list.every((w) => w.library_id === null),
      "'none' 分支返回的行 library_id 都是 null",
      none.list.map((w) => w.library_id),
    )

    const lib1 = await api.listWords({ page: 1, size: 20, libraryId: 1 })
    ck(lib1.total === 2, 'listWords libraryId=1 → 2 条', lib1.total)
    ck(
      lib1.list.every((w) => w.library_id === 1),
      'libraryId=1 分支只返回该库的词',
      lib1.list.map((w) => w.library_id),
    )

    const lib2 = await api.listWords({ page: 1, size: 20, libraryId: 2 })
    ck(lib2.total === 1 && lib2.list[0].word === 'livre', 'libraryId=2 → 只命中 livre', lib2.list.map((w) => w.word))

    const p2 = await api.listWords({ page: 1, size: 2, libraryId: '' })
    ck(p2.list.length === 5, 'size 有 5 的下限（小值会被抬到 5，避免请求切太碎）', p2.list.length)
    const p3 = await api.listWords({ page: 2, size: 5, libraryId: '' })
    ck(p3.list.length === 0 && p3.total === 5, '翻到超出范围的页：list 空但 total 仍准确', { n: p3.list.length, t: p3.total })

    const keys1 = await api.wordKeysForLibrary(1)
    ck(keys1.inLibrary.bonjour && keys1.inLibrary.merci, 'wordKeysForLibrary(1) 把库内词放进 inLibrary', Object.keys(keys1.inLibrary))
    ck(!keys1.inLibrary.livre && keys1.elsewhere.livre, '库外的 livre 落进 elsewhere')
    ck(keys1.elsewhere.eau && keys1.elsewhere.train, '未分组词也算 elsewhere（另库/未分组都只是提示）')

    const keysNull = await api.wordKeysForLibrary(null)
    ck(
      Object.keys(keysNull.inLibrary).length === 0,
      '目标为「新建词库」时 inLibrary 必为空（没有任何词该被硬跳过）',
      Object.keys(keysNull.inLibrary),
    )
    ck(Object.keys(keysNull.elsewhere).length === 5, '此时全部 5 个词都进 elsewhere', Object.keys(keysNull.elsewhere))

    const stats = await api.libraryStats()
    ck(stats.byLibrary['1'].total === 2, 'libraryStats 库 1 共 2 个', stats.byLibrary['1'])
    ck(stats.byLibrary['1'].mastered === 1, 'libraryStats 库 1 已掌握 1 个', stats.byLibrary['1'])
    ck(stats.byLibrary['1'].fresh === 1, 'libraryStats 库 1 新词 1 个（stage0 且无 due_date）', stats.byLibrary['1'])
    ck(stats.byLibrary['2'].fresh === 0, '库 2 没有新词（stage2 已排期）', stats.byLibrary['2'])
    ck(stats.ungrouped.total === 2 && stats.ungrouped.mastered === 1 && stats.ungrouped.fresh === 1, '未分组统计正确', stats.ungrouped)

    const madeLib = await api.createLibrary({ name: '  A2 库  ', level: ' A2 ' })
    ck(madeLib.name === 'A2 库', 'createLibrary 去掉名称首尾空格', madeLib.name)
    ck(madeLib.level === 'A2', 'createLibrary 去掉 level 首尾空格', madeLib.level)
    const blankLib = await api.createLibrary({})
    ck(blankLib.name === '未命名词库', 'createLibrary 空名退化为「未命名词库」', blankLib.name)

    const renamed = await api.updateLibrary(1, { name: 'B1 核心库' })
    ck(renamed.name === 'B1 核心库' && !!renamed.updated_at, 'updateLibrary 改名并写 updated_at', renamed.name)

    let threw = false
    try {
      await api.updateLibrary(999, { name: 'x' })
    } catch (e) {
      threw = true
    }
    ck(threw, 'updateLibrary 无匹配行 → 抛错（RLS 拦下不能当成功）')

    const casc = await api.deleteLibraryCascade(1)
    ck(casc.words === 2 && casc.deleted === 1, 'deleteLibraryCascade 先删词再删库并返回准确数量', casc)
    ck(tables.fr_words.filter((w) => w.library_id === 1).length === 0, '级联后库 1 的词确实没了')
    ck(tables.fr_libraries.filter((l) => l.id === 1).length === 0, '级联后库 1 本身也没了')
  }

  // ---------------------------------------------------------------
  group('B. pages/import：解析 → 映射 → 去重 → 保存')
  // ---------------------------------------------------------------
  const IMPORT = 'pages/import/import.js'
  {
    // B1 空词库：targetLibraryId 兜底为 0
    reset()
    let p = makePage(IMPORT)
    p.onLoad()
    await p.refreshLibraries()
    ck(p.data.loadingLibs === false, 'B1 无词库时 loadingLibs 落回 false')
    ck(p.data.targetLibraryId === 0, 'B1 无词库时 targetLibraryId=0（走新建分支）', p.data.targetLibraryId)
    ck(p.data.libraries.length === 0, 'B1 无词库时 libraries 为空')
    ck(p.data.sheetMaxMB === 20, 'B1 sheetMaxMB 来自 storage.SHEET_MAX_SIZE', p.data.sheetMaxMB)

    // B2 有词库：默认选中第一个
    reset()
    fake.libs = [
      { id: 7, name: 'B1 库', level: 'B1' },
      { id: 8, name: '工程师库', level: '' },
    ]
    fake.stats = { byLibrary: { 7: { total: 3, mastered: 1, fresh: 2 } }, ungrouped: { total: 4, mastered: 0, fresh: 4 } }
    p = makePage(IMPORT)
    p.onLoad()
    await p.refreshLibraries()
    ck(p.data.targetLibraryId === 7, 'B2 有词库时默认选中第一个库', p.data.targetLibraryId)
    ck(p.data.libraries[0].total === 3 && p.data.libraries[0].mastered === 1, 'B2 libraries 合并了统计', p.data.libraries[0])
    ck(p.data.ungroupedTotal === 4, 'B2 ungroupedTotal 取 stats.ungrouped.total', p.data.ungroupedTotal)
    ck(apiStub.lastKeysQuery === 7, 'B2 拉去重基准时用当前目标库 id', apiStub.lastKeysQuery)

    // 选中的库被删掉 → 回落到列表第一个
    fake.libs = [{ id: 9, name: '新库', level: '' }]
    await p.refreshLibraries()
    ck(p.data.targetLibraryId === 9, '目标库消失后刷新会回落到现存第一个库', p.data.targetLibraryId)

    // B3 解析 6 列表头 → 六个字段全部认领
    reset()
    fake.libs = [{ id: 7, name: 'B1 库', level: 'B1' }]
    p = makePage(IMPORT)
    p.onLoad()
    await p.refreshLibraries()
    await p.parseFile(sample('h-6col.csv'), 'h-6col.csv', 'csv', 1234)
    ck(p.data.step === 'preview', 'B3 解析成功进入 preview', p.data.step)
    ck(p.data.hasHeader === true, 'B3 识别出表头', p.data.hasHeader)
    ck(p.data.fileName === 'h-6col.csv', 'B3 文件名带过来了', p.data.fileName)
    ck(p.data.totalColumns === 6, 'B3 列数 6', p.data.totalColumns)
    ck(
      JSON.stringify(p.data.mapping) ===
        JSON.stringify({ word: 0, meaning_zh: 3, phonetic: 1, pos: 2, example_fr: 4, example_zh: 5 }),
      'B3 6 个字段全部对到正确列（含「例句翻译」不被「中文释义」抢走）',
      p.data.mapping,
    )
    ck(p.data.totalParsed > 0, 'B3 解析出词', p.data.totalParsed)
    ck(p.data.importCount === p.data.totalParsed, 'B3 无重复时 importCount == totalParsed', {
      i: p.data.importCount,
      t: p.data.totalParsed,
    })
    ck(p.data.pickIndex.word === 1, 'B3 pickIndex=列下标+1（0 留给「不导入」）', p.data.pickIndex)
    ck(p.data.mappingLabel.word === p.data.columnOptions[1], 'B3 mappingLabel 取到列名', p.data.mappingLabel.word)
    ck(p.data.rawPreview.length > 0 && typeof p.data.rawPreview[0] === 'string', 'B3 原始行预览已渲染')
    ck(Array.isArray(p.allRows) && p.allRows.length === p.data.totalParsed, 'B3 全量留在实例属性 allRows')
    ck(p.data.previewRows.length === Math.min(100, p.data.totalParsed), 'B3 只把前 100 条塞进 data')
    ck(p.allRows[0].word === 'bonjour', 'B3 首条词正确', p.allRows[0].word)
    ck(p.allRows[0].meaning_zh !== '' && p.allRows[0].example_fr !== '' && p.allRows[0].example_zh !== '', 'B3 释义/例句/例句翻译都进到行里', p.allRows[0])
    ck(p.data.columnOptions[0] === '不导入', 'B3 列下拉第 0 项是「不导入」', p.data.columnOptions[0])
    ck(p.data.columnOptions.length === 7, 'B3 列下拉 = 1 + 6 列', p.data.columnOptions.length)

    // B3b 只有「单词/音标/词性/释义」四列时，例句两列如实留「无」
    await p.parseFile(sample('a-header-4col.csv'), 'a-header-4col.csv', 'csv', 100)
    ck(p.data.mapping.word === 0, 'B3b 第 1 列 → 单词', p.data.mapping)
    ck(p.data.mapping.phonetic === 1 && p.data.mapping.pos === 2, 'B3b 音标/词性对位', p.data.mapping)
    ck(p.data.mapping.meaning_zh === 3, 'B3b 释义 → example_zh 之后才轮到 meaning_zh（不误吞）', p.data.mapping)
    ck(p.data.mapping.example_fr === -1 && p.data.mapping.example_zh === -1, 'B3b 没有例句列时如实留 -1（而不是硬塞）', p.data.mapping)
    ck(p.data.missingMeaning === 0, 'B3b 有释义列时 missingMeaning=0', p.data.missingMeaning)

    // B3c 只有一个单词列（每行一个词）→ 没有释义列，全部缺释义
    await p.parseFile(sample('m-single-column.csv'), 'm-single-column.csv', 'csv', 100)
    ck(p.data.hasHeader === false, 'B3c 纯单词列表不误判表头', p.data.hasHeader)
    ck(p.data.totalParsed === 5, 'B3c 5 行 → 5 个词', p.data.totalParsed)
    ck(p.data.mapping.word === 0, 'B3c 单词落到第 1 列', p.data.mapping)
    ck(p.data.mapping.meaning_zh === 1, 'B3c 无表头时按「第 1 列单词、第 2 列释义」退化', p.data.mapping)
    ck(p.data.missingMeaning === p.data.totalParsed, 'B3c 全部条目都缺释义（可交给 AI 批量补全）', {
      m: p.data.missingMeaning,
      t: p.data.totalParsed,
    })

    // B4 法语重音表头（回归：phonétique / catégorie / définition）
    reset()
    fake.libs = [{ id: 7, name: 'B1 库', level: 'B1' }]
    p = makePage(IMPORT)
    p.onLoad()
    await p.refreshLibraries()
    await p.parseFile(sample('c-semicolon.csv'), 'c-semicolon.csv', 'csv', 900)
    ck(p.data.hasHeader === true, 'B4 分号分隔 + 法语表头仍识别表头')
    ck(p.data.mapping.word === 0, 'B4 mot → 单词列', p.data.mapping)
    ck(p.data.mapping.phonetic === 1, 'B4 phonétique → 音标列（重音折叠回归）', p.data.mapping)
    ck(p.data.mapping.meaning_zh === 2, 'B4 traduction → 释义列', p.data.mapping)
    ck(p.allRows[0].meaning_zh !== '', 'B4 释义确实被填上了（不是空列）', p.allRows[0])
    ck(p.allRows[0].phonetic !== '', 'B4 音标确实被填上了', p.allRows[0])

    // B4b 认领顺序回归：「例句中文」必须先于「中文」被认领
    reset()
    fake.libs = [{ id: 7, name: 'B1 库', level: 'B1' }]
    p = makePage(IMPORT)
    p.onLoad()
    await p.refreshLibraries()
    await p.parseFile(sample('p-tricky-headers.csv'), 'p-tricky-headers.csv', 'csv', 100)
    ck(p.data.mapping.word === 0, 'B4b 词条 → 单词列', p.data.mapping)
    ck(p.data.mapping.example_zh === 1, 'B4b 例句中文 → 例句翻译列（先认领）', p.data.mapping)
    ck(p.data.mapping.meaning_zh === 2, 'B4b 中文 → 释义列（没被「例句中文」截胡）', p.data.mapping)
    ck(p.allRows[0].example_zh !== '' && p.allRows[0].meaning_zh !== '', 'B4b 两列都拿到了值', p.allRows[0])

    // B4c UTF-16 + Tab 分隔
    reset()
    fake.libs = [{ id: 7, name: 'B1 库', level: 'B1' }]
    p = makePage(IMPORT)
    p.onLoad()
    await p.refreshLibraries()
    await p.parseFile(sample('g-utf16-tab.csv'), 'g-utf16-tab.csv', 'csv', 100)
    ck(p.data.encoding === undefined || p.data.warnings.length === 0, 'B4c UTF-16 不产生乱码警告', p.data.warnings)
    ck(p.data.mapping.word === 0 && p.data.mapping.meaning_zh === 1, 'B4c Tab 分隔 + 中文表头对位', p.data.mapping)
    ck(p.allRows[0].meaning_zh !== '', 'B4c UTF-16 正文没乱码', p.allRows[0])

    // B4d 标题行 + UTF-8 BOM
    reset()
    fake.libs = [{ id: 7, name: 'B1 库', level: 'B1' }]
    p = makePage(IMPORT)
    p.onLoad()
    await p.refreshLibraries()
    await p.parseFile(sample('s-title-row.csv'), 's-title-row.csv', 'csv', 100)
    ck(p.data.titleRow.indexOf('生词表') >= 0, 'B4d 识别并展示整行标题', p.data.titleRow)
    ck(p.data.hasHeader === true, 'B4d 标题行之后仍认出表头', p.data.hasHeader)
    ck(p.allRows[0].word === 'bonjour', 'B4d 标题行没变成假词', p.allRows[0].word)

    await p.parseFile(sample('e-utf8bom.csv'), 'e-utf8bom.csv', 'csv', 100)
    ck(p.allRows[0].word === 'bonjour', 'B4d UTF-8 BOM 不污染首个单元格', p.allRows[0].word)
    ck(p.data.mapping.word === 0 && p.data.mapping.meaning_zh === 1, 'B4d BOM 下中文表头仍能识别', p.data.mapping)

    // B4e 非 UTF-8（GBK）→ 只告警不硬猜
    reset()
    fake.libs = [{ id: 7, name: 'B1 库', level: 'B1' }]
    p = makePage(IMPORT)
    p.onLoad()
    await p.refreshLibraries()
    await p.parseFile(sample('f-gbk.csv'), 'f-gbk.csv', 'csv', 100)
    ck(p.data.warnings.length >= 1, 'B4e GBK 文件给出编码警告', p.data.warnings)
    ck(p.data.warnings[0].indexOf('UTF-8') >= 0, 'B4e 警告里给了可执行建议', p.data.warnings[0])

    // B5 去重：目标库内已有 → 硬跳过；别处有 → 只提示
    reset()
    fake.libs = [
      { id: 7, name: 'B1 库', level: 'B1' },
      { id: 8, name: '工程师库', level: '' },
    ]
    fake.keys = {
      inLibrary: { bonjour: true },
      elsewhere: { merci: true },
    }
    p = makePage(IMPORT)
    p.onLoad()
    await p.refreshLibraries()
    await p.parseFile(sample('a-header-4col.csv'), 'a.c.csv', 'csv', 100)
    const rowByWord = {}
    p.allRows.forEach((r) => (rowByWord[r.word] = r))
    ck(!!rowByWord.bonjour, 'B5 能按词取到行（前置条件）', Object.keys(rowByWord))
    ck(rowByWord.bonjour.dup === true, 'B5 目标库内已有的词标记 dup')
    ck(rowByWord.bonjour.include === false, 'B5 dup 行默认不勾选')
    ck(rowByWord.merci.dup === false && rowByWord.merci.elsewhere === true, 'B5 别处出现过的词只标记 elsewhere', rowByWord.merci)
    ck(rowByWord.merci.include === true, 'B5 elsewhere 行保持勾选（同词多库是合法用法）')
    ck(p.data.dupCount === 1, 'B5 dupCount=1', p.data.dupCount)
    ck(p.data.elsewhereCount === 1, 'B5 elsewhereCount=1（只统计真正要导入的行）', p.data.elsewhereCount)
    ck(p.data.importCount === p.data.totalParsed - 1, 'B5 importCount 已扣掉 dup', {
      i: p.data.importCount,
      t: p.data.totalParsed,
    })
    const beforeToggle = p.data.importCount
    p.toggleInclude(tap({ i: 0 }))
    ck(p.data.importCount === beforeToggle, 'B5 dup 行不可被勾选（toggleInclude 直接 return）', p.data.importCount)

    // B6 切换目标词库 → 去重标记整体翻转
    fake.keys = {
      inLibrary: { merci: true },
      elsewhere: { bonjour: true },
    }
    await p.pickLibrary(tap({ id: 8 }))
    ck(p.data.targetLibraryId === 8, 'B6 切库后 targetLibraryId=8', p.data.targetLibraryId)
    const after = {}
    p.allRows.forEach((r) => (after[r.word] = r))
    ck(after.merci.dup === true && after.merci.include === false, 'B6 切库后 merci 变成 dup', after.merci)
    ck(after.bonjour.dup === false && after.bonjour.elsewhere === true, 'B6 切库后 bonjour 变回 elsewhere', after.bonjour)
    ck(p.data.dupCount === 1 && p.data.elsewhereCount === 1, 'B6 切库后重新统计正确', {
      d: p.data.dupCount,
      e: p.data.elsewhereCount,
    })

    // B7 列映射：冲突让位 + 单词列必须存在
    reset()
    fake.libs = [{ id: 7, name: 'B1 库', level: 'B1' }]
    p = makePage(IMPORT)
    p.onLoad()
    await p.refreshLibraries()
    await p.parseFile(sample('h-6col.csv'), 'h-6col.csv', 'csv', 100)
    ck(p.data.mapping.word === 0 && p.data.mapping.phonetic === 1, 'B7 前置：单词/音标在第 1/2 列', p.data.mapping)
    // 把「释义」指到第 2 列（音标列）→ 音标该让位
    p.onMapping(ev({ field: 'meaning_zh' }, 2))
    ck(p.data.mapping.meaning_zh === 1, 'B7 释义改指音标列成功', p.data.mapping)
    ck(p.data.mapping.phonetic === -1, 'B7 同一列被抢走后原字段让回「不导入」', p.data.mapping)
    ck(p.data.mapping.word === 0, 'B7 未受影响的字段保持不动', p.data.mapping)
    ck(p.allRows[0].meaning_zh === '[bɔ̃ʒuʁ]', 'B7 重建后释义取到了音标列的文字（映射真的生效了）', p.allRows[0].meaning_zh)
    ck(p.allRows[0].phonetic === '', 'B7 让位后音标列为空', p.allRows[0].phonetic)
    // 把单词列指到第 3 列（词性列）
    p.onMapping(ev({ field: 'word' }, 3))
    ck(p.data.mapping.word === 2, 'B7 单词列可改指到第 3 列', p.data.mapping)
    ck(p.data.mapping.pos === -1, 'B7 词性列同时让位', p.data.mapping)
    ck(p.allRows[0].word === 'interj.', 'B7 重建后首条词变成了词性列内容', p.allRows[0].word)
    // 拒绝把单词列设为「不导入」
    resetUi()
    p.onMapping(ev({ field: 'word' }, 0))
    ck(p.data.mapping.word === 2, 'B7 把单词列设为「不导入」被拒绝（否则整张表废掉）', p.data.mapping)
    ck(lastToast().indexOf('单词') >= 0, 'B7 拒绝时有明确提示', lastToast())

    // B8 关掉表头开关 → 表头行变成数据行
    reset()
    fake.libs = [{ id: 7, name: 'B1 库', level: 'B1' }]
    p = makePage(IMPORT)
    p.onLoad()
    await p.refreshLibraries()
    await p.parseFile(sample('a-header-4col.csv'), 'a-header-4col.csv', 'csv', 100)
    const withHeader = p.data.totalParsed
    p.onToggleHeader(ev(null, false))
    ck(p.data.hasHeader === false, 'B8 关闭表头开关')
    ck(p.data.totalParsed === withHeader + 1, 'B8 表头行变成一条数据，词数 +1', {
      a: withHeader,
      b: p.data.totalParsed,
    })
    ck(p.allRows[0].word === '单词', 'B8 第一行确实是原表头文字（没被吞掉）', p.allRows[0].word)
    p.onToggleHeader(ev(null, true))
    ck(p.data.totalParsed === withHeader, 'B8 再打开恢复原状', p.data.totalParsed)

    // B9 行级编辑：removeRow / onRowField / toggleInclude
    p.removeRow(tap({ i: 0 }))
    ck(p.data.totalParsed === withHeader - 1, 'B9 removeRow 后总数 -1', p.data.totalParsed)
    ck(p.allRows.length === withHeader - 1, 'B9 allRows 同步删掉', p.allRows.length)
    const target = p.allRows[0].word
    p.onRowField(ev({ i: 0, field: 'meaning_zh' }, '手动改的释义'))
    ck(p.allRows[0].meaning_zh === '手动改的释义', 'B9 onRowField 写回 allRows', p.allRows[0].meaning_zh)
    ck(p.data.previewRows[0].meaning_zh === '手动改的释义', 'B9 onRowField 同步视图', p.data.previewRows[0].meaning_zh)
    ck(!!target, 'B9 前置：行有词')

    // B10 单词列空但有释义的行 → 计入 skipped，不产生假词
    reset()
    fake.libs = [{ id: 7, name: 'B1 库', level: 'B1' }]
    p = makePage(IMPORT)
    p.onLoad()
    await p.refreshLibraries()
    await p.parseFile(sample('k-messy.xlsx'), 'k-messy.xlsx', 'xlsx', 5000)
    ck(p.data.totalParsed > 0, 'B10 脏数据 xlsx 也能解析', p.data.totalParsed)
    ck(p.data.skipped > 0, 'B10 空行/孤儿释义被计入 skipped', p.data.skipped)

    // B11 文本粘贴路径
    reset()
    fake.libs = [{ id: 7, name: 'B1 库', level: 'B1' }]
    p = makePage(IMPORT)
    p.onLoad()
    await p.refreshLibraries()
    p.onTextInput(ev(null, 'mot,définition\nbonjour,你好\nmerci,谢谢'))
    ck(p.data.textInput.indexOf('bonjour') >= 0, 'B11 文本已进入 data')
    await p.parseTextInput()
    ck(p.data.step === 'preview', 'B11 文本解析进入 preview')
    ck(p.data.fileName === '粘贴文本', 'B11 来源标记为粘贴文本', p.data.fileName)
    ck(p.data.totalParsed === 2, 'B11 解析出 2 个词', p.data.totalParsed)
    ck(p.allRows[0].meaning_zh === '你好', 'B11 释义列映射正确', p.allRows[0])

    resetUi()
    p2 = makePage(IMPORT)
    p2.onLoad()
    p2.data.textInput = '   '
    await p2.parseTextInput()
    ck(lastToast().indexOf('粘贴') >= 0, 'B11 空文本有提示', lastToast())

    // B12 文件选择的体积闸门
    reset()
    p = makePage(IMPORT)
    p.onLoad()
    let chosen = null
    global.wx.chooseMessageFile = (o) => {
      chosen = o
    }
    p.chooseSheet()
    ck(!!chosen, 'B12 chooseSheet 调起了文件选择器')
    ck(
      Array.isArray(chosen.extension) && chosen.extension.indexOf('csv') >= 0 && chosen.extension.indexOf('xlsx') >= 0,
      'B12 选择器限定 csv/xlsx 等词表扩展名',
      chosen.extension,
    )
    resetUi()
    chosen.success({ tempFiles: [{ name: 'big.xlsx', path: 'x', size: 21 * 1024 * 1024 }] })
    ck(lastToast().indexOf('20MB') >= 0, 'B12 超过 20MB 直接拦住并提示', lastToast())
    ck(p.data.step === 'pick', 'B12 超限不进 preview', p.data.step)

    // B13 不可解析的文件 → 明确文案
    reset()
    fake.libs = [{ id: 7, name: 'B1 库', level: 'B1' }]
    p = makePage(IMPORT)
    p.onLoad()
    await p.refreshLibraries()
    await p.parseFile(sample('l-legacy.xls'), 'l-legacy.xls', 'xls', 100)
    ck(p.data.step === 'pick', 'B13 .xls 不进入 preview', p.data.step)
    ck(p.data.error.indexOf('另存为') >= 0, 'B13 .xls 给了「另存为 .xlsx」的可执行指引', p.data.error)
    ck(p.data.parsing === false, 'B13 parsing 收尾为 false', p.data.parsing)

    await p.parseFile(sample('n-empty.csv'), 'n-empty.csv', 'csv', 10)
    ck(p.data.error.indexOf('没有读到内容') >= 0, 'B13 空文件有明确文案', p.data.error)

    // B14 保存：没有可导入的条目
    reset()
    p = makePage(IMPORT)
    p.onLoad()
    await p.save()
    ck(lastToast().indexOf('没有可导入') >= 0, 'B14 无词可导入时提示', lastToast())
    ck(fake.calls.createWords.length === 0, 'B14 不会发写入请求')

    // B15 保存：参数不完整 / 文件不完整
    reset()
    fake.libs = [{ id: 7, name: 'B1 库', level: 'B1' }]
    p = makePage(IMPORT)
    p.onLoad()
    await p.refreshLibraries()
    await p.parseFile(sample('a-header-4col.csv'), 'a-header-4col.csv', 'csv', 100)
    p.setData({ targetLibraryId: 0, newLibraryName: '工程师库', newLibraryLevel: 'B1' })
    const n = p.data.importCount
    await p.save()
    ck(fake.calls.createLibrary.length === 1, 'B15 targetLibraryId=0 时先建词库', fake.calls.createLibrary)
    ck(fake.calls.createLibrary[0].name === '工程师库', 'B15 用输入的名称建库')
    ck(fake.calls.createLibrary[0].level === 'B1', 'B15 带上选择的等级')
    ck(fake.calls.createWords.length === 1, 'B15 一次写完（未超分片）', fake.calls.createWords.length)
    ck(fake.calls.createWords[0].length === n, 'B15 写入条数 == importCount', {
      got: fake.calls.createWords[0].length,
      want: n,
    })
    ck(
      fake.calls.createWords[0].every((r) => r.library_id === 100 && r.source === 'import'),
      'B15 每行都挂上新建词库 id 且 source=import',
      fake.calls.createWords[0][0],
    )
    ck(app.marked > 0, 'B15 写入后通知首页刷新')
    ck(p.data.error === '', 'B15 未产生错误', p.data.error)

    // B16 保存：不选词库又不起名 → 拦截
    reset()
    fake.libs = [{ id: 7, name: 'B1 库', level: 'B1' }]
    p = makePage(IMPORT)
    p.onLoad()
    await p.refreshLibraries()
    await p.parseFile(sample('a-header-4col.csv'), 'a-header-4col.csv', 'csv', 100)
    p.setData({ targetLibraryId: 0, newLibraryName: '' })
    await p.save()
    ck(p.data.error.indexOf('起个名字') >= 0, 'B16 未选词库也未起名时明确报错', p.data.error)
    ck(fake.calls.createLibrary.length === 0, 'B16 不会建空名词库')

    // B17 保存：250 条 → 200 + 50 两片
    reset()
    fake.libs = [{ id: 7, name: 'B1 库', level: 'B1' }]
    p = makePage(IMPORT)
    p.onLoad()
    await p.refreshLibraries()
    await p.parseFile(BIG_CSV, 'big250.csv', 'csv', 9999)
    ck(p.data.totalParsed === 250, 'B17 250 行全解析到', p.data.totalParsed)
    ck(p.data.hiddenCount === 150, 'B17 预览只放 100 条，其余 150 条隐藏', p.data.hiddenCount)
    ck(p.data.previewRows.length === 100, 'B17 previewRows 正好 100')
    p.setData({ targetLibraryId: 7 })
    await p.save()
    ck(fake.calls.createLibrary.length === 0, 'B17 已选词库时不建新库')
    ck(fake.calls.createWords.length === 2, 'B17 分片写入两批', fake.calls.createWords.map((c) => c.length))
    ck(fake.calls.createWords[0].length === 200 && fake.calls.createWords[1].length === 50, 'B17 分片 200 + 50', fake.calls.createWords.map((c) => c.length))
    ck(fake.calls.createWords[1][0].word === 'motsu201', 'B17 第二片从第 201 条开始（顺序没乱）', fake.calls.createWords[1][0].word)
    ck(lastToast().indexOf('250') >= 0, 'B17 成功提示带数量', lastToast())

    // B18 AI 批量补全受 AI_BULK_LIMIT 限制
    reset()
    fake.libs = [{ id: 7, name: 'B1 库', level: 'B1' }]
    p = makePage(IMPORT)
    p.onLoad()
    await p.refreshLibraries()
    // 只有一个单词列，没有释义列 → 全部缺释义
    await p.parseFile(SINGLE30_CSV, 'single30.csv', 'csv', 500)
    ck(p.data.totalParsed === 30, 'B18 30 行单列解析出 30 个词', p.data.totalParsed)
    ck(p.data.missingMeaning === 30, 'B18 前置：30 条全部缺释义', p.data.missingMeaning)
    const missingBefore = p.data.missingMeaning
    await p.aiBulk()
    ck(p.data.aiBulkLimit === 20, 'B18 批量上限是 20', p.data.aiBulkLimit)
    ck(p.data.aiBulkTotal === Math.min(p.data.aiBulkLimit, missingBefore), 'B18 批量补全数量被上限截断到 20', {
      total: p.data.aiBulkTotal,
      missing: missingBefore,
      limit: p.data.aiBulkLimit,
    })
    ck(p.data.aiBulkDone === p.data.aiBulkTotal, 'B18 进度跑到最后一条', {
      done: p.data.aiBulkDone,
      total: p.data.aiBulkTotal,
    })
    ck(llmCalls.length === 20, 'B18 实际只调了 20 次模型（成本可控）', llmCalls.length)
    ck(p.allRows[0].meaning_zh === '释义-motseul1', 'B18 补全结果写回 allRows', p.allRows[0].meaning_zh)
    ck(p.allRows[19].meaning_zh !== '', 'B18 第 20 条已补全', p.allRows[19].meaning_zh)
    ck(p.allRows[20].meaning_zh === '', 'B18 第 21 条按上限留空（下一批再补）', p.allRows[20].meaning_zh)
    ck(p.data.missingMeaning === 10, 'B18 补完后仍缺 10 条', p.data.missingMeaning)
    ck(p.data.aiBulkBusy === false, 'B18 结束后 aiBulkBusy 归位', p.data.aiBulkBusy)

    // 单条 AI 补全
    resetUi()
    await p.aiFill(tap({ i: 20 }))
    ck(p.allRows[20].meaning_zh === '释义-motseul21', 'B18 单条 aiFill 也能补', p.allRows[20].meaning_zh)
    ck(p.data.aiBusyKey === '', 'B18 单条补全后 busy key 清空', p.data.aiBusyKey)
    ck(p.data.previewRows[20].meaning_zh === '释义-motseul21', 'B18 单条补全同步到视图', p.data.previewRows[20].meaning_zh)

    // B19 返回与重置
    reset()
    fake.libs = [{ id: 7, name: 'B1 库', level: 'B1' }]
    p = makePage(IMPORT)
    p.onLoad()
    await p.refreshLibraries()
    await p.parseFile(sample('a-header-4col.csv'), 'a-header-4col.csv', 'csv', 100)
    p.back()
    ck(p.data.step === 'pick', 'B19 back 回到选择步', p.data.step)
    ck(p.allRows.length > 0, 'B19 back 保留已解析的词（可再点下一步）', p.allRows.length)
    p.backToStart()
    ck(p.data.step === 'pick' && p.data.totalParsed === 0 && p.data.previewRows.length === 0, 'B19 backToStart 全清', {
      step: p.data.step,
      t: p.data.totalParsed,
    })
    ck(p.allRows.length === 0 && p.grid === null, 'B19 实例属性也清空')
  }

  // ---------------------------------------------------------------
  group('C. pages/libraries：词库管理页')
  // ---------------------------------------------------------------
  const LIB = 'pages/libraries/libraries.js'
  {
    const { friendlyError } = require(path.join(PROJ, 'utils/cloud.js'))

    // C1 未登录
    reset()
    app.globalData = { loginReady: Promise.resolve(null) }
    let p = makePage(LIB)
    await p.refresh()
    ck(p.data.signedIn === false, 'C1 未登录时 signedIn=false', p.data.signedIn)
    ck(p.data.loading === false, 'C1 未登录时不再转圈', p.data.loading)
    ck(fake.calls.listWords.length === 0, 'C1 未登录不发词库请求')

    // C2 已登录 + 统计合并
    reset()
    app.globalData = { loginReady: Promise.resolve({ id: 'u1' }) }
    fake.libs = [
      { id: 7, name: 'B1 库', level: 'B1' },
      { id: 8, name: '工程师库', level: '' },
    ]
    fake.stats = {
      byLibrary: { 7: { total: 8, mastered: 2, fresh: 6 }, 8: { total: 4, mastered: 1, fresh: 3 } },
      ungrouped: { total: 5, mastered: 0, fresh: 5 },
    }
    p = makePage(LIB)
    await p.refresh()
    ck(p.data.signedIn === true && p.data.loading === false, 'C2 已登录正常收尾')
    ck(p.data.libraries.length === 2, 'C2 拿到 2 个词库')
    ck(p.data.libraries[0].total === 8, 'C2 库 1 总数来自统计', p.data.libraries[0])
    ck(p.data.libraries[0].percent === 25, 'C2 percent = mastered/total 取整', p.data.libraries[0].percent)
    ck(p.data.libraries[1].percent === 25, 'C2 库 2 percent 也正确', p.data.libraries[1].percent)
    ck(p.data.ungrouped === 5, 'C2 未分组数量透传', p.data.ungrouped)

    // 空库不除零
    fake.stats = { byLibrary: {}, ungrouped: { total: 0, mastered: 0, fresh: 0 } }
    await p.refresh()
    ck(p.data.libraries[0].percent === 0, 'C2 零词库 percent=0 而不是 NaN', p.data.libraries[0].percent)

    // C3 新建：空名 / 重名 / 成功
    reset()
    app.globalData = { loginReady: Promise.resolve({ id: 'u1' }) }
    fake.libs = [{ id: 7, name: 'B1 库', level: 'B1' }]
    fake.stats = { byLibrary: {}, ungrouped: { total: 0, mastered: 0, fresh: 0 } }
    p = makePage(LIB)
    await p.refresh()

    resetUi()
    p.onNewName(ev(null, '   '))
    await p.create()
    ck(lastToast().indexOf('名称') >= 0, 'C3 空名提示', lastToast())
    ck(fake.calls.createLibrary.length === 0, 'C3 空名不发请求')

    resetUi()
    p.onNewName(ev(null, 'B1 库'))
    await p.create()
    ck(lastToast().indexOf('同名') >= 0, 'C3 同名词库被拦住', lastToast())
    ck(fake.calls.createLibrary.length === 0, 'C3 重名不发请求')

    resetUi()
    p.onNewName(ev(null, '工程师库'))
    p.pickNewLevel(tap({ level: 'B1' }))
    ck(p.data.newLevel === 'B1', 'C3 选等级生效', p.data.newLevel)
    p.pickNewLevel(tap({ level: 'B1' }))
    ck(p.data.newLevel === '', 'C3 再点同一等级取消（可切回不指定）', p.data.newLevel)
    p.pickNewLevel(tap({ level: 'B2' }))
    await p.create()
    await tick()
    ck(fake.calls.createLibrary.length === 1, 'C3 正常建库发一次请求')
    ck(fake.calls.createLibrary[0].level === 'B2', 'C3 等级透传', fake.calls.createLibrary[0])
    ck(p.data.newName === '' && p.data.newLevel === '', 'C3 成功后清空输入')
    ck(p.data.libraries.length === 2, 'C3 成功后列表已刷新', p.data.libraries.length)
    ck(app.marked > 0, 'C3 通知首页刷新')

    // C4 重命名
    resetUi()
    p.startRename(tap({ id: 7 }))
    ck(p.data.editingId === 7 && p.data.editName === 'B1 库', 'C4 进入编辑态并带出原名', {
      id: p.data.editingId,
      name: p.data.editName,
    })
    p.onEditName(ev(null, '  B1 核心库  '))
    await p.saveRename(tap({ id: 7 }))
    await tick()
    ck(fake.calls.updateLibrary.length === 1, 'C4 改名发一次请求')
    ck(fake.calls.updateLibrary[0].patch.name === 'B1 核心库', 'C4 名称去空格后提交', fake.calls.updateLibrary[0])
    ck(p.data.editingId === 0 && p.data.renaming === false, 'C4 编辑态收尾', p.data.editingId)
    ck(p.data.libraries.filter((l) => l.id === 7)[0].name === 'B1 核心库', 'C4 列表里已是新名')

    resetUi()
    p.startRename(tap({ id: 7 }))
    p.onEditName(ev(null, '  '))
    await p.saveRename(tap({ id: 7 }))
    ck(lastToast().indexOf('不能为空') >= 0, 'C4 空名拒绝', lastToast())

    resetUi()
    p.cancelRename()
    ck(p.data.editingId === 0, 'C4 cancelRename 退出编辑态')

    // C5 删除（级联）
    reset()
    app.globalData = { loginReady: Promise.resolve({ id: 'u1' }) }
    fake.libs = [{ id: 7, name: 'B1 库', level: 'B1' }]
    fake.words = [
      { id: 1, word: 'bonjour', library_id: 7 },
      { id: 2, word: 'merci', library_id: 7 },
    ]
    fake.stats = { byLibrary: { 7: { total: 2, mastered: 0, fresh: 2 } }, ungrouped: { total: 0, mastered: 0, fresh: 0 } }
    p = makePage(LIB)
    await p.refresh()
    resetUi()
    p.confirmDelete(tap({ id: 7 }))
    await tick()
    ck(ui.modals.length === 1, 'C5 弹了确认框')
    ck(ui.modals[0].content.indexOf('2 个生词') >= 0, 'C5 确认文案带出会一起删掉的词数', ui.modals[0].content)
    ck(fake.calls.deleteCascade.length === 1 && fake.calls.deleteCascade[0] === 7, 'C5 确认后执行级联删除')
    ck(lastToast().indexOf('2') >= 0, 'C5 提示里带删除数量', lastToast())
    ck(p.data.libraries.length === 0, 'C5 删除后列表刷新为空', p.data.libraries.length)

    // C6 openLibrary 的 globalData 交接
    reset()
    app.globalData = { loginReady: Promise.resolve({ id: 'u1' }) }
    fake.libs = [{ id: 7, name: 'B1 库', level: 'B1' }]
    fake.stats = { byLibrary: {}, ungrouped: { total: 0, mastered: 0, fresh: 0 } }
    p = makePage(LIB)
    await p.refresh()
    resetUi()
    p.openLibrary(tap({ id: 7 }))
    ck(app.globalData.pendingLibraryFilter && app.globalData.pendingLibraryFilter.id === 7, 'C6 写入待消费的筛选条件', app.globalData.pendingLibraryFilter)
    ck(app.globalData.pendingLibraryFilter.name === 'B1 库', 'C6 名称也带过去（用于标题）')
    ck(ui.switchTabs[0] === '/pages/words/words', 'C6 switchTab 到生词本（tabBar 页只能这样传参）', ui.switchTabs)

    resetUi()
    p.goImport()
    ck(ui.navs[0] === '/pages/import/import', 'C6 去导入页', ui.navs)
    ck(typeof friendlyError === 'function', 'C6 错误文案工具可用')
  }

  // ---------------------------------------------------------------
  group('D. pages/words：生词本按词库筛选')
  // ---------------------------------------------------------------
  const WORDS = 'pages/words/words.js'
  {
    // D1 字符串 → 查询参数
    reset()
    fake.words = [
      { id: 1, word: 'bonjour', library_id: 7, status: 'learning', stage: 0, due_date: null },
      { id: 2, word: 'livre', library_id: 8, status: 'learning', stage: 0, due_date: null },
      { id: 3, word: 'eau', library_id: null, status: 'learning', stage: 0, due_date: null },
    ]
    let p = makePage(WORDS)
    p.onLoad({})
    ck(p.libraryFilterArg() === '', "默认 'all' → 查询参数为空串", p.libraryFilterArg())
    p.setData({ libraryFilter: 'none' })
    ck(p.libraryFilterArg() === 'none', "'none' → 原样透传", p.libraryFilterArg())
    p.setData({ libraryFilter: '12' })
    ck(p.libraryFilterArg() === 12, "数字字符串 → Number", p.libraryFilterArg())
    p.setData({ libraryFilter: 'abc' })
    ck(p.libraryFilterArg() === '', '非法值退化为空（不会把怪值塞进查询）', p.libraryFilterArg())

    // D2 默认加载 = 全部
    reset()
    fake.words = [
      { id: 1, word: 'bonjour', library_id: 7, status: 'learning', stage: 0, due_date: null },
      { id: 2, word: 'livre', library_id: 8, status: 'learning', stage: 0, due_date: null },
      { id: 3, word: 'eau', library_id: null, status: 'learning', stage: 0, due_date: null },
    ]
    fake.libs = [
      { id: 7, name: 'B1 库' },
      { id: 8, name: '工程师库' },
    ]
    p = makePage(WORDS)
    p.onLoad({})
    p.onShow()
    await new Promise((r) => setTimeout(r, 0))
    ck(fake.calls.listWords.length >= 1, 'D2 onShow 触发了列表加载')
    ck(fake.calls.listWords[0].libraryId === '', 'D2 默认不带词库筛选', fake.calls.listWords[0])
    ck(p.data.list.length === 3, 'D2 全部 3 条', p.data.list.length)
    ck(p.data.libraries.length === 2, 'D2 筛选条拿到 2 个词库', p.data.libraries)
    ck(p.data.libraries[0].key === '7' && p.data.libraries[0].name === 'B1 库', 'D2 筛选条项格式 {id,key,name}', p.data.libraries[0])

    // D3 点筛选芯片
    resetUi()
    p.setLibrary(tap({ filter: '7' }))
    await new Promise((r) => setTimeout(r, 0))
    ck(p.data.libraryFilter === '7', 'D3 选中词库芯片', p.data.libraryFilter)
    ck(fake.calls.listWords[fake.calls.listWords.length - 1].libraryId === 7, 'D3 请求带上词库 id', fake.calls.listWords[fake.calls.listWords.length - 1])
    ck(p.data.list.length === 1 && p.data.list[0].word === 'bonjour', 'D3 只列出该库的词', p.data.list.map((w) => w.word))

    resetUi()
    p.setLibrary(tap({ filter: 'none' }))
    await new Promise((r) => setTimeout(r, 0))
    ck(fake.calls.listWords[fake.calls.listWords.length - 1].libraryId === 'none', "D3 「未分组」走 'none'", fake.calls.listWords[fake.calls.listWords.length - 1])
    ck(p.data.list.length === 1 && p.data.list[0].word === 'eau', 'D3 未分组只剩 eau', p.data.list.map((w) => w.word))

    // 点同一个芯片不重复请求
    const before = fake.calls.listWords.length
    p.setLibrary(tap({ filter: 'none' }))
    ck(fake.calls.listWords.length === before, 'D3 重复点同一芯片不重发请求', fake.calls.listWords.length - before)

    // D4 从词库管理页跳回来（globalData 交接）
    reset()
    fake.words = [
      { id: 1, word: 'bonjour', library_id: 7, status: 'learning', stage: 0, due_date: null },
      { id: 2, word: 'livre', library_id: 8, status: 'learning', stage: 0, due_date: null },
    ]
    fake.libs = [
      { id: 7, name: 'B1 库' },
      { id: 8, name: '工程师库' },
    ]
    app.globalData = { pendingLibraryFilter: { id: 8, name: '工程师库' }, loginReady: Promise.resolve({}) }
    p = makePage(WORDS)
    p.onLoad({})
    p.onShow()
    await new Promise((r) => setTimeout(r, 0))
    ck(p.data.libraryFilter === '8', 'D4 消费 pendingLibraryFilter 后切到该库', p.data.libraryFilter)
    ck(app.globalData.pendingLibraryFilter === null, 'D4 交接值消费后立刻清空（避免下次进来又跳一次）', app.globalData.pendingLibraryFilter)
    ck(fake.calls.listWords.some((c) => c.libraryId === 8), 'D4 用该库 id 发过请求')
    ck(p.data.list.length === 1 && p.data.list[0].word === 'livre', 'D4 列表切到该库', p.data.list.map((w) => w.word))
    ck(p.data.search === '' && p.data.statusFilter === '', 'D4 切库时清掉搜索与状态筛选（否则会看起来是空的）')

    // D5 当前筛选的库被删掉 → 回退「全部」
    reset()
    fake.words = [{ id: 1, word: 'bonjour', library_id: 7, status: 'learning', stage: 0, due_date: null }]
    fake.libs = [{ id: 8, name: '工程师库' }]
    p = makePage(WORDS)
    p.onLoad({})
    p.setData({ libraryFilter: '7' })
    await p.refreshLibraries()
    ck(p.data.libraryFilter === 'all', 'D5 选中的库不存在时回退 all（否则卡在空列表）', p.data.libraryFilter)
    ck(p.data.libraries.length === 1, 'D5 筛选条刷新为现存词库', p.data.libraries.length)

    // 没有任何词库时不动 libraryFilter
    fake.libs = []
    p.setData({ libraryFilter: 'none' })
    await p.refreshLibraries()
    ck(p.data.libraryFilter === 'none', 'D5 一个库都没有时不误改筛选值', p.data.libraryFilter)

    // D6 搜索与状态筛选仍然工作
    reset()
    fake.words = [{ id: 1, word: 'bonjour', library_id: null, status: 'learning', stage: 0, due_date: null }]
    p = makePage(WORDS)
    p.onLoad({})
    p.onSearchInput(ev(null, 'bon'))
    await new Promise((r) => setTimeout(r, 450))
    ck(fake.calls.listWords[fake.calls.listWords.length - 1].search === 'bon', 'D6 搜索词透传', fake.calls.listWords[fake.calls.listWords.length - 1])
    p.setFilter(tap({ status: 'mastered' }))
    await new Promise((r) => setTimeout(r, 0))
    ck(fake.calls.listWords[fake.calls.listWords.length - 1].status === 'mastered', 'D6 状态筛选透传', fake.calls.listWords[fake.calls.listWords.length - 1])
    ck(fake.calls.listWords[fake.calls.listWords.length - 1].libraryId === '', 'D6 状态筛选不影响词库筛选', fake.calls.listWords[fake.calls.listWords.length - 1])

    // D7 去词库管理页 + 空态补样例词
    resetUi()
    p.goLibraries()
    ck(ui.navs[0] === '/pages/libraries/libraries', 'D7 去词库管理页', ui.navs)
    reset()
    p = makePage(WORDS)
    p.onLoad({})
    await p.fillSamples()
    ck(fake.calls.createWords.length === 1, 'D7 空态补样例词发一次请求')
    ck(fake.calls.createWords[0].length === 8, 'D7 样例词 8 条', fake.calls.createWords[0].length)
    ck(fake.calls.createWords[0].every((r) => r.source === 'sample'), 'D7 样例词 source=sample')
  }

  // ---------------------------------------------------------------
  group('E. pages/word-detail：所属词库下拉')
  // ---------------------------------------------------------------
  const DETAIL = 'pages/word-detail/word-detail.js'
  {
    reset()
    fake.libs = [
      { id: 7, name: 'B1 库', level: 'B1' },
      { id: 8, name: '工程师库', level: '' },
    ]
    let p = makePage(DETAIL)
    p.onLoad({})
    await new Promise((r) => setTimeout(r, 0))
    ck(p.data.libraryOptions.length === 3, 'E1 选项 = 不归入 + 2 个词库', p.data.libraryOptions)
    ck(p.data.libraryOptions[0] === '不归入词库' && p.data.libraryIds[0] === 0, 'E1 第 0 项是「不归入词库」', p.data.libraryIds)
    ck(p.data.libraryPick === 0 && p.data.libraryLabel === '不归入词库', 'E1 新增词默认不归入', p.data.libraryLabel)

    // 选库后保存
    resetUi()
    p.onLibrary(ev(null, 1))
    ck(p.data.libraryPick === 1 && p.data.libraryLabel === 'B1 库', 'E1 选中第 1 个词库', p.data.libraryLabel)
    p.data.form.word = 'bonjour'
    await p.save()
    ck(fake.words.length === 1, 'E1 保存写入 1 条', fake.words.length)
    ck(fake.words[0].library_id === 7, 'E1 library_id 落库', fake.words[0])
    ck(fake.words[0].source === 'manual', 'E1 手动词条 source=manual', fake.words[0])

    // 编辑已有词：带出原词库
    reset()
    fake.libs = [
      { id: 7, name: 'B1 库', level: 'B1' },
      { id: 8, name: '工程师库', level: '' },
    ]
    fake.words = [{ id: 55, word: 'livre', library_id: 8, status: 'learning', stage: 0, due_date: null }]
    p = makePage(DETAIL)
    p.onLoad({ id: '55' })
    await new Promise((r) => setTimeout(r, 0))
    ck(p.data.isNew === false, 'E2 编辑态')
    ck(p.data.libraryLabel === '工程师库', 'E2 下拉带出原词库', p.data.libraryLabel)
    ck(p.data.libraryPick === 2, 'E2 pick 下标对应 id=8 的位置', p.data.libraryPick)

    p.onLibrary(ev(null, 0))
    ck(p.data.libraryLabel === '不归入词库', 'E2 可以改回不归入')
    await p.save()
    ck(fake.words[0].library_id === null, 'E2 改成不归入时写 null（不是 0）', fake.words[0].library_id)

    // 词库拉取失败不阻塞编辑
    reset()
    const origListLibraries = apiStub.listLibraries
    apiStub.listLibraries = async () => {
      throw new Error('网络炸了')
    }
    p = makePage(DETAIL)
    p.onLoad({})
    await new Promise((r) => setTimeout(r, 0))
    ck(p.data.libraryOptions.length === 1, 'E3 词库拉取失败时下拉只剩「不归入」', p.data.libraryOptions)
    p.data.form.word = 'eau'
    await p.save()
    ck(fake.words.length === 1 && fake.words[0].library_id === null, 'E3 仍能保存（词库只是可选信息）', fake.words[0])
    apiStub.listLibraries = origListLibraries
  }

  // ---------------------------------------------------------------
  console.log('\n结果：' + pass + '/' + (pass + fail) + ' 通过')
  if (fail) console.log('失败用例：\n - ' + failures.join('\n - '))
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('运行异常：', e)
  process.exit(1)
})
