// 表格解析探针：node sheet_probe.cjs <文件路径|-> [粘贴文本]
// 例：node sheet_probe.cjs 词表.csv
//     node sheet_probe.cjs 生词.xlsx
//     node sheet_probe.cjs - "bonjour|你好
// merci|谢谢"
// 打印编码 / 表头判定 / 列映射 / 告警 / 截断情况 / 前若干条词，用于快速判断解析效果。
//
// 直接跑 assets 目录里的解析器：用 Module._load 把 './pdf'、'./docx' 指到同目录的
// pdf-image-extractor.js / docx-text-extractor.js，这样不必先把资源复制进项目。
const fs = require('fs')
const path = require('path')
const Module = require('module')

const assets = path.resolve(__dirname, '../assets')
const origLoad = Module._load
Module._load = function (request) {
  if (request === './pdf') return require(path.join(assets, 'pdf-image-extractor.js'))
  if (request === './docx' || request === './docx-text-extractor') {
    return require(path.join(assets, 'docx-text-extractor.js'))
  }
  return origLoad.apply(this, arguments)
}

const sheet = require(path.join(assets, 'sheet-parser.js'))

const target = process.argv[2]
if (!target) {
  console.error('用法: node sheet_probe.cjs <文件|-> [文本]')
  process.exit(2)
}

const t0 = Date.now()
let res
if (target === '-') {
  const text = process.argv[3] || ''
  res = sheet.extractWordsFromText(text)
  console.log('[粘贴文本] ' + text.length + ' 字符')
} else {
  const bytes = new Uint8Array(fs.readFileSync(target))
  const ext = target.toLowerCase().split('.').pop()
  res = sheet.extractWords(bytes, { ext })
  console.log('[' + path.basename(target) + '] ' + (bytes.length / 1024).toFixed(1) + 'KB')
}
console.log('耗时=' + (Date.now() - t0) + 'ms  原因=' + (res.reason || '-') + '  编码=' + (res.encoding || '-'))

if (res.reason && res.reason !== 'ok') {
  const HINT = {
    legacy_xls: '旧版 .xls 是 OLE 复合文档（不是 ZIP），端上读不了 → 引导「另存为 .xlsx」',
    bad_zip: '不是有效的 .xlsx（压缩包结构损坏）',
    no_sheet: 'Excel 里没有工作表',
    unzip_failed: '解压失败，文件可能损坏',
    empty: '没读到内容',
    no_word: '按当前列映射没解析出生词 → 多半是「单词」列选错了',
    bad_input: '没有输入内容',
  }
  console.log('提示：' + (HINT[res.reason] || '见 reason 字段'))
  process.exit(0)
}

const width = res.grid.reduce((w, r) => Math.max(w, r.length), 0)
console.log(
  '表头=' + res.hasHeader + '  表头行号=' + res.headerRowIndex + '  列数=' + width +
    '  截断=' + res.truncated + '  跳过行=' + res.skipped,
)
if (res.titleRow) console.log('整行标题：' + res.titleRow)
if (res.headers.length) console.log('列名：' + res.headers.map((h, i) => i + ':' + (h || '无')).join('  '))
console.log('列映射：' + JSON.stringify(res.mapping))
console.log('列下拉：' + JSON.stringify(sheet.columnLabels(res, width)))
res.warnings.forEach((w) => console.log('⚠️  ' + w))

console.log('前 10 条：')
res.words.slice(0, 10).forEach((w, i) => {
  console.log(
    '  ' + (i + 1) + '. ' + w.word +
      (w.phonetic ? '  ' + w.phonetic : '') +
      (w.pos ? '  ' + w.pos : '') +
      (w.meaning_zh ? '  → ' + w.meaning_zh : '  →（无释义）'),
  )
})
console.log('共 ' + res.words.length + ' 条')
