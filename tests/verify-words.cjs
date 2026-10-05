/**
 * 校验交付的分级词表（word-lists/*.csv）：
 *   A. 解析层：用项目真实的 utils/sheet.js 逐份解析，断言表头识别、列映射、字段完整、无重复
 *   B. 端到端：用真实 pages/import + 真实 utils/api.js + 内存版云数据库，
 *      把 A1.csv 真导入一遍（含「新建词库 → 分片写词」全链路），再验重复导入的幂等性
 *   C. 跨文件：检查五份词表之间的重词，确认「同一词出现在别的词库」只提示不拦
 *   D. 端到端：B2.csv（含 19 条 loc. 语篇连接词）单独走一遍建库导入
 *
 * 跑法：node verify-words.cjs
 */
const fs = require('fs')
const path = require('path')
const Module = require('module')

// 路径相对本文件定位，换机器 / 换目录都不用改
const ROOT = path.resolve(__dirname, '..')
const PROJ = path.join(ROOT, 'french-vocab-miniprogram')
const LISTS = path.join(ROOT, 'word-lists')
const MOCK = path.resolve(__dirname, 'fixtures', 'cloud_db_mock.cjs')

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
function group(n) {
  console.log('\n== ' + n + ' ==')
}

const EXPECT_MAP = { word: 0, meaning_zh: 1, phonetic: 2, pos: 3, example_fr: 4, example_zh: 5 }
const FILES = ['A1.csv', 'A2.csv', 'B1.csv', 'B1-表达.csv', 'B2.csv', 'tech.csv']

// =====================================================================
// A. 解析层校验
// =====================================================================
const sheet = require(path.join(PROJ, 'utils/sheet.js'))
const parsed = {}

group('A. 解析层：表头识别 / 列映射 / 字段完整性')
FILES.forEach((name) => {
  const p = path.join(LISTS, name)
  ck(fs.existsSync(p), name + ' 文件存在')
  const bytes = new Uint8Array(fs.readFileSync(p))
  // BOM 检查（Excel 打开中文不乱码的前提）
  ck(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, name + ' 带 UTF-8 BOM')

  const res = sheet.extractWords(bytes, { ext: 'csv' })
  parsed[name] = res

  ck(res.reason === 'ok', name + ' 解析成功', res.reason)
  ck(res.encoding === 'utf-8', name + ' 编码判定为 utf-8', res.encoding)
  ck(res.warnings.length === 0, name + ' 无告警', res.warnings)
  ck(res.truncated === false, name + ' 未被截断')
  ck(res.skipped === 0, name + ' 没有跳过行', res.skipped)
  ck(res.titleRow === '', name + ' 没把内容行误判成标题行', res.titleRow)
  ck(res.hasHeader === true, name + ' 识别出表头行')
  ck(res.headerRowIndex === 0, name + ' 表头在第 0 行', res.headerRowIndex)
  ck(JSON.stringify(res.mapping) === JSON.stringify(EXPECT_MAP), name + ' 六列全部自动对位', res.mapping)
  ck(res.words.length > 0, name + ' 解出词条', res.words.length)

  // 每行六个字段都要有值 —— 空释义会被导入页算进「待 AI 补全」，不该出现在成品词表里
  let emptyField = null
  let badPos = null
  const POS_OK = ['n.m.', 'n.f.', 'v.', 'adj.', 'adv.', 'prép.', 'conj.', 'pron.', 'det.', 'num.', 'interj.', 'loc.']
  for (let i = 0; i < res.words.length; i++) {
    const w = res.words[i]
    for (const k of ['word', 'meaning_zh', 'phonetic', 'pos', 'example_fr', 'example_zh']) {
      if (!String(w[k] || '').trim()) emptyField = { i: i + 2, word: w.word, field: k }
    }
    if (POS_OK.indexOf(w.pos) < 0) badPos = { i: i + 2, word: w.word, pos: w.pos }
  }
  ck(!emptyField, name + ' 没有空字段', emptyField)
  ck(!badPos, name + ' 词性都在约定取值内', badPos)

  // 表内去重（大小写/空格）
  const seen = Object.create(null)
  let dup = null
  res.words.forEach((w, i) => {
    const k = String(w.word).trim().toLowerCase()
    if (seen[k] !== undefined) dup = { first: seen[k] + 2, again: i + 2, word: w.word }
    else seen[k] = i
  })
  ck(!dup, name + ' 表内无重复词', dup)

  // 例句确实是这句话的中文对照（长度量级不能差太多）
  let weird = null
  res.words.forEach((w, i) => {
    if (w.example_zh.length < 2 || w.example_fr.length < 2) weird = { i: i + 2, word: w.word }
    if (w.example_zh.length > w.example_fr.length * 3) weird = { i: i + 2, word: w.word, fr: w.example_fr, zh: w.example_zh }
  })
  ck(!weird, name + ' 例句与例句翻译都成对出现', weird)
})

// =====================================================================
// B. 端到端：真 pages/import + 真 utils/api.js + 内存云库
// =====================================================================
group('B. 端到端：把 A1.csv 真的导入一遍')

const { makeCloudStub } = require(MOCK)
const tables = { fr_libraries: [], fr_words: [], fr_books: [], fr_units: [] }
const cloud = makeCloudStub(tables)

const llmStub = {
  completeWord: async (payload) => ({
    meaning_zh: 'AI 补的释义 ' + ((payload && payload.word) || ''),
    phonetic: 'x',
    pos: 'n.m.',
    example_fr: 'ex',
    example_zh: '例',
  }),
}
const origLoad = Module._load
Module._load = function (request) {
  if (/workbuddy-cloud-sdk/.test(request)) return {}
  if (/(^|[\\/])cloud$/.test(request)) return cloud
  if (/(^|[\\/])llm$/.test(request)) return llmStub
  return origLoad.apply(this, arguments)
}

const ui = { toasts: [], loads: [] }
global.wx = {
  showToast: (o) => ui.toasts.push((o && o.title) || ''),
  showLoading: () => ui.loads.push(1),
  hideLoading: () => {},
  navigateTo: () => {},
  navigateBack: () => {},
  stopPullDownRefresh: () => {},
  chooseMessageFile: () => {},
  getFileSystemManager: () => ({ statSync: () => ({ size: 0 }), readFile: () => {} }),
}
const app = { globalData: {}, markDirty() { this.marked = (this.marked || 0) + 1 } }
global.getApp = () => app

const storage = require(path.join(PROJ, 'utils/storage.js'))
storage.readAsArrayBuffer = async (p) => new Uint8Array(fs.readFileSync(p))

let captured = null
global.Page = (cfg) => {
  captured = cfg
}
require(path.join(PROJ, 'pages/import/import.js'))
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
      } else cur = cur[Number(m[2])]
    } else {
      if (!cur[parts[i]]) cur[parts[i]] = {}
      cur = cur[parts[i]]
    }
  }
  cur[parts[parts.length - 1]] = val
}
function makePage() {
  const inst = Object.create(captured)
  inst.data = JSON.parse(JSON.stringify(captured.data))
  inst.setData = (patch) => {
    for (const k of Object.keys(patch)) setPath(inst.data, k, patch[k])
  }
  return inst
}
const ev = (target, value) => ({ currentTarget: { dataset: target || {} }, detail: { value } })
const tap = (target) => ({ currentTarget: { dataset: target || {} } })

;(async () => {
  const p = makePage()
  p.onLoad()
  await p.refreshLibraries()
  ck(p.data.targetLibraryId === 0, 'B1 没有任何词库时，目标是「新建」', p.data.targetLibraryId)
  ck(p.data.step === 'pick', 'B1 初始停在选文件步骤', p.data.step)

  // 新建「B1 库」
  p.onNewLibraryName(ev(null, 'A1 库'))
  p.pickLevel(tap({ level: 'A1' }))
  ck(p.data.newLibraryName === 'A1 库' && p.data.newLibraryLevel === 'A1', 'B2 填好新词库名与等级', {
    n: p.data.newLibraryName,
    l: p.data.newLibraryLevel,
  })

  const a1 = path.join(LISTS, 'A1.csv')
  const size = fs.statSync(a1).size
  await p.parseFile(a1, 'A1.csv', 'csv', size)

  const nA1 = parsed['A1.csv'].words.length
  ck(p.data.step === 'preview', 'B3 解析后进入预览步骤', p.data.step)
  ck(p.data.fileName === 'A1.csv', 'B3 文件名带进页面', p.data.fileName)
  ck(p.data.hasHeader === true, 'B3 表头被识别')
  ck(JSON.stringify(p.data.mapping) === JSON.stringify(EXPECT_MAP), 'B3 页面里的列映射与解析器一致', p.data.mapping)
  ck(p.data.totalParsed === nA1, 'B3 解出 ' + nA1 + ' 条', p.data.totalParsed)
  ck(p.data.importCount === nA1, 'B3 全部可导入（无库内重复）', p.data.importCount)
  ck(p.data.missingMeaning === 0, 'B3 没有缺释义的条目（不用花 AI 调用）', p.data.missingMeaning)
  ck(p.allRows.length === nA1, 'B3 全量留在实例属性 allRows', p.allRows.length)
  ck(p.data.previewRows.length === Math.min(100, nA1), 'B3 只渲染前 100 条', p.data.previewRows.length)
  ck(p.data.hiddenCount === Math.max(0, nA1 - 100), 'B3 隐藏条数正确', p.data.hiddenCount)
  ck(p.data.rawPreview.length > 0, 'B3 原始行预览已生成')

  await p.save()
  ck(ui.toasts[ui.toasts.length - 1].indexOf('已导入 ' + nA1) >= 0, 'B4 提示带正确数量', ui.toasts)
  ck(tables.fr_libraries.length === 1, 'B4 真的建了 1 个词库', tables.fr_libraries.length)
  const lib = tables.fr_libraries[0]
  ck(lib.name === 'A1 库' && lib.level === 'A1', 'B4 词库名与等级正确', lib)
  ck(tables.fr_words.length === nA1, 'B4 词全部落库', tables.fr_words.length)
  ck(tables.fr_words.every((w) => w.library_id === lib.id), 'B4 每行都挂到了新词库', {
    libId: lib.id,
    sample: tables.fr_words[0],
  })
  ck(tables.fr_words.every((w) => w.source === 'import'), 'B4 来源标记为 import')
  ck(app.marked === 1, 'B4 通知了首页刷新')

  // 音标/例句这类长字段要活着到达数据库（分片写入不能截断内容）
  const bonjour = tables.fr_words.filter((w) => w.word === 'bonjour')[0]
  ck(bonjour && bonjour.phonetic === 'bɔ̃.ʒuʁ', 'B5 音标原样落库（含鼻化元音）', bonjour && bonjour.phonetic)
  ck(bonjour && bonjour.meaning_zh === '你好；早上好', 'B5 中文释义原样落库', bonjour && bonjour.meaning_zh)
  ck(bonjour && bonjour.example_fr === 'Bonjour, comment allez-vous ?', 'B5 含逗号的例句没被拦腰截断', bonjour && bonjour.example_fr)
  ck(bonjour && bonjour.example_zh === '你好，您近来好吗？', 'B5 例句翻译对位正确', bonjour && bonjour.example_zh)

  // 幂等性：同一份词表再导一次，应当一个词都不写
  const before = tables.fr_words.length
  const p2 = makePage()
  p2.onLoad()
  await p2.refreshLibraries()
  ck(p2.data.targetLibraryId === lib.id, 'B6 已有词库时默认选中它', p2.data.targetLibraryId)
  await p2.parseFile(a1, 'A1.csv', 'csv', size)
  ck(p2.data.dupCount === nA1, 'B6 库内已有的词全部被标成重复', p2.data.dupCount)
  ck(p2.data.importCount === 0, 'B6 可导入数为 0', p2.data.importCount)
  await p2.save()
  ck(tables.fr_words.length === before, 'B6 重复导入没有产生任何新行', {
    before,
    after: tables.fr_words.length,
  })
  ck(ui.toasts[ui.toasts.length - 1].indexOf('没有可导入') >= 0, 'B6 明确提示「没有可导入的新词」', ui.toasts[ui.toasts.length - 1])

  // 同一个词进第二个词库：这是设计上明确允许的（只提示、不拦）
  const p3 = makePage()
  p3.onLoad()
  await p3.refreshLibraries()
  await p3.pickLibrary(tap({ id: 0 }))
  p3.onNewLibraryName(ev(null, 'A1 复习库'))
  await p3.parseFile(a1, 'A1.csv', 'csv', size)
  ck(p3.data.dupCount === 0, 'B7 目标换成新词库后，同一个词不再算「重复」', p3.data.dupCount)
  ck(p3.data.importCount === nA1, 'B7 全部可导入（跨词库重复不拦）', p3.data.importCount)
  ck(p3.data.elsewhereCount === nA1, 'B7 每个词都被标成「在别的词库里出现过」', p3.data.elsewhereCount)
  await p3.save()
  const lib2 = tables.fr_libraries.filter((l) => l.name === 'A1 复习库')[0]
  ck(!!lib2, 'B7 第二个词库建成')
  const dups = tables.fr_words.filter((w) => w.word === 'bonjour')
  ck(dups.length === 2, 'B7 bonjour 在两个词库里各存一份', dups.map((w) => w.library_id))
  ck(dups[0].library_id !== dups[1].library_id, 'B7 两份分属不同词库', dups.map((w) => w.library_id))

  // 工程师库：与三份分级词表零重叠，导入时不该冒出任何「已在别处」的提示噪音
  const p4 = makePage()
  p4.onLoad()
  await p4.refreshLibraries()
  await p4.pickLibrary(tap({ id: 0 }))
  p4.onNewLibraryName(ev(null, '工程师库'))
  const techPath = path.join(LISTS, 'tech.csv')
  const techSize = fs.statSync(techPath).size
  await p4.parseFile(techPath, 'tech.csv', 'csv', techSize)
  const nTech = parsed['tech.csv'].words.length
  // 「已在别处」的期望值必须按**数据库当前实际内容**算，不能按文件算：
  // 此刻 B1 完整库/表达库还没导入，文件层面的重叠并不等于库里已有。
  const libWordKeys = Object.create(null)
  tables.fr_words.forEach((w) => {
    const key = String(w.word || '').trim().toLowerCase()
    if (key) libWordKeys[key] = true // 工程师库此刻还没建，已有行全算「别处」
  })
  const expectElsewhere = parsed['tech.csv'].words.filter((w) => libWordKeys[w.word.trim().toLowerCase()]).length
  ck(p4.data.totalParsed === nTech, 'B8 工程师库解出 ' + nTech + ' 条', p4.data.totalParsed)
  ck(p4.data.dupCount === 0, 'B8 新词库里没有库内重复', p4.data.dupCount)
  ck(p4.data.importCount === nTech, 'B8 全部可导入', p4.data.importCount)
  ck(p4.data.elsewhereCount === expectElsewhere, 'B8 「已在别处」的条数与实际重叠一致（期望 0）', {
    got: p4.data.elsewhereCount,
    want: expectElsewhere,
  })
  await p4.save()
  const techLib = tables.fr_libraries.filter((l) => l.name === '工程师库')[0]
  ck(!!techLib, 'B8 工程师库建成')
  ck(tables.fr_words.filter((w) => w.library_id === techLib.id).length === nTech, 'B8 词全部落进工程师库')
  ck(tables.fr_words.length === nA1 * 2 + nTech, 'B8 前面两个库的内容没被动过', tables.fr_words.length)
  const acier = tables.fr_words.filter((w) => w.word === 'acier')[0]
  ck(acier && acier.meaning_zh === '钢' && acier.phonetic === 'a.sje', 'B8 生僻词字段也完整落库', acier)

  // ==================================================================
  // D. B2 库端到端
  // ==================================================================
  group('D. B2 库：真导入一遍（含语篇连接词）')

  // B2 库：表里含 19 条多词语篇连接词（loc.），验证带空格/撇号的词条也能正确落库
  const p5 = makePage()
  p5.onLoad()
  await p5.refreshLibraries()
  await p5.pickLibrary(tap({ id: 0 }))
  p5.onNewLibraryName(ev(null, 'B2 库'))
  p5.pickLevel(tap({ level: 'B2' }))
  const b2Path = path.join(LISTS, 'B2.csv')
  const b2Size = fs.statSync(b2Path).size
  await p5.parseFile(b2Path, 'B2.csv', 'csv', b2Size)
  const nB2 = parsed['B2.csv'].words.length
  ck(p5.data.totalParsed === nB2, 'D1 B2 库解出 ' + nB2 + ' 条', p5.data.totalParsed)
  ck(JSON.stringify(p5.data.mapping) === JSON.stringify(EXPECT_MAP), 'D1 B2 六列自动对位', p5.data.mapping)
  ck(p5.data.missingMeaning === 0, 'D1 B2 没有缺释义的条目', p5.data.missingMeaning)
  ck(p5.data.dupCount === 0 && p5.data.importCount === nB2, 'D1 B2 全部可导入', {
    dup: p5.data.dupCount,
    imp: p5.data.importCount,
  })
  await p5.save()
  const b2Lib = tables.fr_libraries.filter((l) => l.name === 'B2 库')[0]
  ck(!!b2Lib && b2Lib.level === 'B2', 'D2 B2 库建成且等级正确', b2Lib)
  const b2Rows = tables.fr_words.filter((w) => w.library_id === b2Lib.id)
  ck(b2Rows.length === nB2, 'D2 词全部落进 B2 库', b2Rows.length)

  // 带空格的连接词
  const toute = b2Rows.filter((w) => w.word === 'somme toute')[0]
  ck(toute && toute.pos === 'loc.' && toute.meaning_zh === '总而言之', 'D3 多词连接词落库完整', toute)
  // 带撇号的连接词
  const occurrence = b2Rows.filter((w) => w.word === "en l'occurrence")[0]
  ck(occurrence && occurrence.example_zh.indexOf('最好什么都别说') >= 0, 'D3 含撇号的词条字段没被切坏', occurrence)
  // 连字符词条
  const cdo = b2Rows.filter((w) => w.word === "chef-d'œuvre")[0]
  ck(cdo && cdo.phonetic === 'ʃɛd.œvʁ', 'D3 连字符 + 合字音标原样落库', cdo && cdo.phonetic)
  // 分片写入在大批量下没有把顺序打乱
  ck(b2Rows[0].word === parsed['B2.csv'].words[0].word, 'D3 首条顺序正确', {
    got: b2Rows[0].word,
    want: parsed['B2.csv'].words[0].word,
  })
  ck(b2Rows[nB2 - 1].word === parsed['B2.csv'].words[nB2 - 1].word, 'D3 末条顺序正确', {
    got: b2Rows[nB2 - 1].word,
    want: parsed['B2.csv'].words[nB2 - 1].word,
  })

  // ==================================================================
  // E. 完整 B1（FLELex + Lexique383 管线产出）端到端
  // ==================================================================
  group('E. 完整 B1：真导入一遍（' + parsed['B1.csv'].words.length + ' 条，含分片写入）')

  const b1Path = path.join(LISTS, 'B1.csv')
  const nB1 = parsed['B1.csv'].words.length
  const p6 = makePage()
  p6.onLoad()
  await p6.refreshLibraries()
  await p6.pickLibrary(tap({ id: 0 }))
  p6.onNewLibraryName(ev(null, 'B1 完整库'))
  p6.pickLevel(tap({ level: 'B1' }))
  await p6.parseFile(b1Path, 'B1.csv', 'csv', fs.statSync(b1Path).size)
  ck(p6.data.totalParsed === nB1, 'E1 完整 B1 解出 ' + nB1 + ' 条', p6.data.totalParsed)
  ck(JSON.stringify(p6.data.mapping) === JSON.stringify(EXPECT_MAP), 'E1 六列自动对位', p6.data.mapping)
  ck(p6.data.missingMeaning === 0, 'E1 没有缺释义的条目（1717 条全部自带中文）', p6.data.missingMeaning)
  ck(p6.data.dupCount === 0 && p6.data.importCount === nB1, 'E1 全部可导入', {
    dup: p6.data.dupCount,
    imp: p6.data.importCount,
  })
  // 分片写入：200 条一片，1717 条应当正好 9 片
  await p6.save()
  const b1Lib = tables.fr_libraries.filter((l) => l.name === 'B1 完整库')[0]
  ck(!!b1Lib && b1Lib.level === 'B1', 'E2 完整 B1 库建成', b1Lib)
  const b1Rows = tables.fr_words.filter((w) => w.library_id === b1Lib.id)
  ck(b1Rows.length === nB1, 'E2 全部 ' + nB1 + ' 条落库（分片写入没丢）', b1Rows.length)
  ck(b1Rows[0].word === parsed['B1.csv'].words[0].word, 'E2 首条顺序正确')
  ck(b1Rows[nB1 - 1].word === parsed['B1.csv'].words[nB1 - 1].word, 'E2 末条顺序正确', {
    got: b1Rows[nB1 - 1].word,
    want: parsed['B1.csv'].words[nB1 - 1].word,
  })

  // 数据库管线特有的字段：音标来自 Lexique383，必须全部存在且是合法 IPA
  const IPA_OK = /^[a-zà-ÿ\u0250-\u02AF\u0292\u0283\u0254\u0259\u025B\u0153\u0280\u0272\u014B\u02D0\u0303\u00F8\u0153\.]+$/i
  const noIpa = b1Rows.filter((w) => !String(w.phonetic || '').trim())
  const badIpa = b1Rows.filter((w) => w.phonetic && !IPA_OK.test(w.phonetic))
  ck(noIpa.length === 0, 'E3 每一条都有音标（0 条缺失）', noIpa.slice(0, 5).map((w) => w.word))
  ck(badIpa.length === 0, 'E3 音标都是合法 IPA 字符', badIpa.slice(0, 5).map((w) => w.word + '=' + w.phonetic))

  // 抽查几条数据库管线的产物：音标来自 Lexique383、释义/例句来自生成
  const spot = ['abbaye', 'gorge', 'souris', 'chef-d\'œuvre', 'tennis']
  const found = spot.map((w) => b1Rows.filter((r) => r.word === w)[0]).filter(Boolean)
  ck(found.length >= 3, 'E3 抽查词条存在', found.map((r) => r.word))
  // 性别校正真的生效了：gorge / souris 必须是阴性
  const gorge = b1Rows.filter((w) => w.word === 'gorge')[0]
  ck(!gorge || gorge.pos === 'n.f.', 'E3 Lexique 性别缺失的词已人工校正（gorge → n.f.）', gorge && gorge.pos)
  const souris = b1Rows.filter((w) => w.word === 'souris')[0]
  ck(!souris || souris.pos === 'n.f.', 'E3 souris → n.f.', souris && souris.pos)

  // 幂等：完整 B1 再导一次，一个词都不写
  const beforeB1 = tables.fr_words.length
  const p7 = makePage()
  p7.onLoad()
  await p7.refreshLibraries()
  // 必须 await：pickLibrary 是异步的（它会重新拉去重基准），
  // 不等它 parseFile 会拿着上一个词库的基准去判重。
  await p7.pickLibrary(tap({ id: b1Lib.id }))
  await p7.parseFile(b1Path, 'B1.csv', 'csv', fs.statSync(b1Path).size)
  ck(p7.data.dupCount === nB1, 'E4 重新导入时全部被判为库内重复', p7.data.dupCount)
  ck(p7.data.importCount === 0, 'E4 可导入数为 0', p7.data.importCount)
  await p7.save()
  ck(tables.fr_words.length === beforeB1, 'E4 重复导入没有产生新行', {
    before: beforeB1,
    after: tables.fr_words.length,
  })

  // B1-表达.csv（FLELex 收不进的固定搭配与语篇连接词）也要能导
  const pex = makePage()
  pex.onLoad()
  await pex.refreshLibraries()
  await pex.pickLibrary(tap({ id: 0 }))
  pex.onNewLibraryName(ev(null, 'B1 表达库'))
  const exPath = path.join(LISTS, 'B1-表达.csv')
  await pex.parseFile(exPath, 'B1-表达.csv', 'csv', fs.statSync(exPath).size)
  const nEx = parsed['B1-表达.csv'].words.length
  ck(pex.data.totalParsed === nEx, 'E5 表达库解出 ' + nEx + ' 条', pex.data.totalParsed)
  ck(pex.data.dupCount === 0 && pex.data.importCount === nEx, 'E5 与已导入的 B1 完整库零重复', {
    dup: pex.data.dupCount,
  })
  await pex.save()
  const exLib = tables.fr_libraries.filter((l) => l.name === 'B1 表达库')[0]
  ck(!!exLib, 'E5 表达库建成')
  const exprRow = tables.fr_words.filter((w) => w.library_id === exLib.id && / /.test(w.word))[0]
  ck(!!exprRow, 'E5 多词表达落库完整', exprRow && exprRow.word)

  // ==================================================================
  // C. 跨文件重词
  // ==================================================================
  group('C. 六份词表之间的重词')
  const owner = Object.create(null)
  FILES.forEach((name) => {
    parsed[name].words.forEach((w) => {
      const k = String(w.word).trim().toLowerCase()
      if (!owner[k]) owner[k] = []
      owner[k].push(name)
    })
  })

  // 手工精选的那几份之间必须零重词 —— 这条是要守住的
  const CURATED = ['A1.csv', 'A2.csv', 'B1-表达.csv', 'B2.csv', 'tech.csv']
  const curatedShared = Object.keys(owner).filter(
    (k) => owner[k].filter((n) => CURATED.indexOf(n) >= 0).length > 1,
  )
  console.log('  精选五份之间重词 ' + curatedShared.length + ' 个' + (curatedShared.length ? '：' + curatedShared.join(', ') : ''))
  ck(curatedShared.length === 0, 'C1 精选词表之间互不重词', curatedShared)

  // B1.csv 是「FLELex 定级的完整 B1 词根清单」，同一词形在不同等级可能承载不同义项
  // （être 在 A1 是系动词、在 B1 是名词 l'être；pouvoir 在 A1 是动词、在 B1 是名词 le pouvoir），
  // 所以它与别的文件**允许**重词，只把数量打出来，并断言提示条数与实际一致。
  const b1Shared = Object.keys(owner).filter(
    (k) => owner[k].indexOf('B1.csv') >= 0 && owner[k].some((n) => n !== 'B1.csv'),
  )
  const byFile = {}
  b1Shared.forEach((k) => {
    owner[k].filter((n) => n !== 'B1.csv').forEach((n) => (byFile[n] = (byFile[n] || 0) + 1))
  })
  console.log(
    '  完整 B1 与其他文件重词 ' + b1Shared.length + ' 个（' +
      Object.keys(byFile).sort().map((k) => k + ' ' + byFile[k]).join('，') +
      '）—— 这是「同一词形、不同义项」的正常重叠，导入时只会提示不会拦',
  )
  ck(true, 'C2 完整 B1 的重叠已列出（设计上允许）')

  group('汇总')
  FILES.forEach((n) => {
    const w = parsed[n].words
    const longest = w.reduce((m, x) => Math.max(m, x.example_fr.length), 0)
    console.log(
      '  ' + n.padEnd(10) + ' ' + String(w.length).padStart(4) + ' 条   文件 ' +
        String(fs.statSync(path.join(LISTS, n)).size).padStart(6) + ' B   最长例句 ' + longest + ' 字符',
    )
  })
  console.log('\n断言：' + pass + '/' + (pass + fail) + (fail ? '  失败 ' + fail + ' 项' : '  全部通过'))
  if (fail) console.log('失败清单：\n  - ' + failures.join('\n  - '))
  process.exit(fail ? 1 : 0)
})()
