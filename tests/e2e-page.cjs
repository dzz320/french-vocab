// 驱动真实的 book-upload 页面对象，验证「PDF 转图片」这条新链路的完整状态机。
// 做法：拦截模块加载（桩掉云 SDK / api / llm / cloud），用真 storage + 真 pdf.js，
// 用假的 wx 和 Page 捕获页面配置，然后直接调页面方法看 data 与 step 怎么变。
const fs = require('fs')
const path = require('path')
const Module = require('module')

// 路径相对本文件定位，换机器 / 换目录都不用改
const PROJ = path.resolve(__dirname, '..', 'french-vocab-miniprogram')
const IMG = path.resolve(__dirname, 'fixtures', 'pdf')
const PDFTEST = path.resolve(__dirname, 'fixtures', 'pdf')

let pass = 0
let fail = 0
function ck(cond, label, extra) {
  if (cond) {
    pass++
    console.log('  OK   ' + label)
  } else {
    fail++
    console.log('  FAIL ' + label + (extra ? '  → ' + extra : ''))
  }
}

// ---------- 桩 ----------
const cloudStub = { friendlyError: (e) => (e && (e.message || e.errMsg)) || '未知错误', CLOUD_ENDPOINT: 'x', CLOUD_PUBLISHABLE_KEY: 'x' }
const configStub = { CLOUD_ENDPOINT: 'x', CLOUD_PUBLISHABLE_KEY: 'x' }
const apiStub = {
  listExistingWordKeys: async () => ({}),
  createBook: async () => ({ id: 1 }),
  createUnits: async () => [{ id: 1 }],
  createWords: async () => {},
}
const llmCalls = []
const llmStub = {
  MAX_PARSE_CHARS: 30000,
  parseTextbookText: async () => [],
  parseTextbookImages: async (images, onProgress) => {
    llmCalls.push(images.map((i) => i.mime))
    if (onProgress) onProgress(images.length, images.length)
    return [{ title: 'Leçon 1', summary: '', words: [{ word: 'bonjour', meaning_zh: '你好' }] }]
  },
}

const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (/workbuddy-cloud-sdk/.test(request)) return { createMiniProgramWorkBuddyCloud: () => ({}) }
  if (/(^|\/)cloud$/.test(request)) return cloudStub
  if (/(^|\/)config$/.test(request)) return configStub
  if (/utils[\\/]api$/.test(request)) return apiStub
  if (/utils[\\/]llm$/.test(request)) return llmStub
  return origLoad.apply(this, arguments)
}

// ---------- 假的运行环境 ----------
const toasts = []
global.wx = {
  showToast: (o) => toasts.push(o.title),
  chooseMessageFile: () => {},
  chooseMedia: () => {},
  redirectTo: () => {},
}
global.getApp = () => ({ markDirty: () => {} })

let pageConfig = null
global.Page = (cfg) => {
  pageConfig = cfg
}

const storage = require(path.join(PROJ, 'utils/storage.js'))
// 真 storage 的读文件走 wx.getFileSystemManager；这里直接读磁盘
storage.readAsArrayBuffer = async (p) => {
  const b = fs.readFileSync(p)
  const out = new Uint8Array(b.length)
  out.set(b)
  return out
}
storage.readAsText = async (p) => fs.readFileSync(p, 'utf8')

require(path.join(PROJ, 'pages/book-upload/book-upload.js'))
if (!pageConfig) {
  console.log('页面配置未捕获，退出')
  process.exit(1)
}

function setPath(obj, key, val) {
  const m = key.match(/^([^.[]+)(?:\[(\d+)\])?\.?(.*)$/)
  if (!m) return
  const head = m[1]
  const idx = m[2]
  const rest = m[3]
  if (!idx && !rest) {
    obj[head] = val
    return
  }
  if (idx && !rest) {
    obj[head][Number(idx)] = val
    return
  }
  if (idx && rest) {
    setPath(obj[head][Number(idx)], rest, val)
    return
  }
  setPath(obj[head], rest, val)
}

function makePage() {
  const inst = Object.create(pageConfig)
  inst.data = JSON.parse(JSON.stringify(pageConfig.data))
  inst.setData = function (patch) {
    for (const k of Object.keys(patch)) setPath(inst.data, k, patch[k])
  }
  inst.scannedPages = null
  inst.docText = ''
  inst.pendingDoc = null
  return inst
}

function src(name) {
  for (const dir of [IMG + '/samples', PDFTEST]) {
    const p = path.join(dir, name)
    if (fs.existsSync(p)) return p
  }
  throw new Error('找不到样本 ' + name)
}

async function main() {
  // ========== 用例 1：扫描版 PDF 自动兜底（readDocText → 自动转图 → 自动识别） ==========
  console.log('\n[1] 扫描件（G4 传真整页图）：读文字层失败 → 自动转图 → 自动进入识别')
  {
    const inst = makePage()
    const p = src('13-real-g4.pdf')
    inst.data.docHint = true
    inst.data.docName = '13-real-g4.pdf'
    inst.data.sourceType = 'pdf'
    llmCalls.length = 0
    await inst.readDocText(p, fs.statSync(p).size, 'pdf')
    // 自动路径会一路走到校正页
    ck(inst.data.step === 'review', '自动兜底后直接进入校正页', inst.data.step + '/' + inst.data.pdfState)
    ck(inst.data.pdfState === 'scanned', '状态停在 scanned', inst.data.pdfState)
    ck(inst.data.scannedCount > 0, 'scannedCount > 0', String(inst.data.scannedCount))
    ck(inst.data.imageTried === true, 'imageTried 已置位')
    ck(llmCalls.length === 1 && llmCalls[0].length === inst.data.scannedCount, '识别页数与 scannedCount 一致')
    ck(inst.data.units.length === 1 && inst.data.totalWords === 1, '解析结果进入 units')
  }

  // ========== 用例 1b：纯矢量无文字层（没有栅格图可抽） → 如实说明并给出替代路径 ==========
  console.log('\n[1b] 纯矢量 PDF（无文字层也没有整页图）：如实降级，不假装成功')
  {
    const inst = makePage()
    const p = src('scanned.pdf')
    inst.data.docHint = true
    inst.data.docName = 'scanned.pdf'
    inst.data.sourceType = 'pdf'
    llmCalls.length = 0
    await inst.readDocText(p, fs.statSync(p).size, 'pdf')
    ck(inst.data.step === 'choose', '停在选择页而不是硬闯校正页', inst.data.step)
    ck(inst.data.pdfState === 'fail', '状态为 fail', inst.data.pdfState)
    ck(/没有找到可用的整页图片/.test(inst.data.pdfInfo), '说清楚为什么做不到', inst.data.pdfInfo)
    ck(/截图识别或粘贴文本/.test(inst.data.pdfInfo), '给出替代路径')
    ck(inst.data.imageTried === true, '试过就置位，不重复给无效入口')
    ck(llmCalls.length === 0, '未误发起识别')
  }

  // ========== 用例 2：手动「把 PDF 转成图片识别」（转完停下等确认，不自动识别） ==========
  console.log('\n[2] 手动转图片：转完停在确认状态，点按钮才开始识别')
  {
    const inst = makePage()
    const p = src('13-real-g4.pdf')
    inst.data.docHint = true
    inst.data.docName = '13-real-g4.pdf'
    inst.data.isPdf = true
    inst.pendingDoc = { path: p, name: '13-real-g4.pdf', size: fs.statSync(p).size, ext: 'pdf' }
    llmCalls.length = 0
    await inst.convertPdfToImages()
    ck(inst.data.pdfState === 'scanned', '状态为 scanned', inst.data.pdfState)
    ck(inst.data.step === 'choose', '仍停在选择页（未自动识别）', inst.data.step)
    ck(llmCalls.length === 0, '此时还没有发起任何 AI 识别')
    ck(inst.data.scannedCount > 0, 'scannedCount > 0', String(inst.data.scannedCount))
    ck(/点下方按钮开始识别/.test(inst.data.pdfInfo), '提示语引导用户点按钮', inst.data.pdfInfo)
    ck(inst.data.docHeadline.indexOf('未上传') < 0, '已有上传头信息时不被覆盖', inst.data.docHeadline)

    // 第二步：用户点「开始 AI 识别这 N 页图片」
    await inst.parseScannedPages()
    ck(inst.data.step === 'review', '点按钮后进入校正页', inst.data.step)
    ck(llmCalls.length === 1, '恰好发起一轮识别')
    ck(inst.scannedPages === null, '识别完释放页面图缓存')
  }

  // ========== 用例 3：文字层正常、但没有整页图 → 优雅退回「可直接识别文字」 ==========
  console.log('\n[3] 有文字层但无整页图：退回原状态并说明原因')
  {
    const inst = makePage()
    const p = src('fr-core.pdf')
    inst.data.docHint = true
    inst.data.isPdf = true
    inst.data.docName = 'fr-core.pdf'
    inst.docText = 'Bonjour, je m\'appelle Marie.' // 模拟已读到文字层
    inst.pendingDoc = { path: p, name: 'fr-core.pdf', size: fs.statSync(p).size, ext: 'pdf' }
    llmCalls.length = 0
    await inst.convertPdfToImages()
    ck(inst.data.pdfState === 'ok', '退回 ok（仍可直接识别文字）', inst.data.pdfState)
    ck(inst.data.imageTried === true, 'imageTried 置位（按钮不再出现）')
    ck(/仍可直接识别文字/.test(inst.data.pdfInfo), '文案给出替代路径', inst.data.pdfInfo)
    ck(llmCalls.length === 0, '未误发起识别')
  }

  // ========== 用例 4：超过上传上限的分支也能转图片 ==========
  console.log('\n[4] 超大文件（未上传）分支：转图片时补齐引导卡片')
  {
    const inst = makePage()
    const p = src('13-real-g4.pdf')
    inst.data.oversize = true
    inst.data.docHint = false
    inst.data.docName = '13-real-g4.pdf'
    inst.data.isPdf = true
    inst.pendingDoc = { path: p, name: '13-real-g4.pdf', size: 60 * 1024 * 1024, ext: 'pdf' }
    await inst.convertPdfToImages()
    ck(inst.data.oversize === false, 'oversize 已收起')
    ck(inst.data.docHint === true, '切到文档面板')
    ck(inst.data.localOnly === true, '标记为「未上传」')
    ck(inst.data.pdfState === 'scanned', '完成转图', inst.data.pdfState)
  }

  // ========== 用例 5：非 PDF 不给转图片入口；换文件会重置标记 ==========
  console.log('\n[5] 边界：docx 不给转图片入口；重新读取重置 imageTried')
  {
    const inst = makePage()
    const p = src('fr-lesson.docx')
    inst.data.docHint = true
    inst.data.docName = 'fr-lesson.docx'
    inst.data.imageTried = true
    inst.pendingDoc = { path: p, name: 'fr-lesson.docx', size: fs.statSync(p).size, ext: 'docx' }
    toasts.length = 0
    await inst.convertPdfToImages()
    ck(toasts.some((t) => /仅 PDF/.test(t)), '非 PDF 被拒绝并提示', JSON.stringify(toasts))
    ck(inst.data.pdfState === '', '状态未被改动', inst.data.pdfState)
  }
  {
    const inst = makePage()
    const p = src('fr-core.pdf')
    inst.data.docHint = true
    inst.data.docName = 'fr-core.pdf'
    inst.pendingDoc = { path: p, name: 'fr-core.pdf', size: fs.statSync(p).size, ext: 'pdf' }
    await inst.readDocText(p, fs.statSync(p).size, 'pdf')
    ck(inst.data.isPdf === true, 'PDF 时 isPdf = true')
    ck(inst.data.imageTried === false, '每次读取文档都重置 imageTried')
    ck(inst.data.pdfState === 'ok', '文字层读到 → ok', inst.data.pdfState)
  }
  {
    const inst = makePage()
    inst.data.isPdf = true
    inst.data.imageTried = true
    inst.data.scannedCount = 5
    inst.backToChoose()
    ck(inst.data.isPdf === false && inst.data.imageTried === false && inst.data.scannedCount === 0, 'backToChoose 清空转图相关状态')
  }

  console.log('\n页面状态机：' + pass + '/' + (pass + fail) + ' 通过')
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('运行异常：', e)
  process.exit(1)
})
