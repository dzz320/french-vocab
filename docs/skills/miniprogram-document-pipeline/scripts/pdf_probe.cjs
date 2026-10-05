// 抽文档文字的快速探针：node pdf_probe.cjs <文件路径> [最大页数]
// 打印页数 / 字符数 / 是否可用 / 判定原因 / 前若干行，用于快速判断抽取效果。
const fs = require('fs')
const path = require('path')

const target = process.argv[2]
const maxPages = Number(process.argv[3]) || 12
if (!target) {
  console.error('用法: node pdf_probe.cjs <文件> [最大页数]')
  process.exit(2)
}

// 从本技能 assets 目录取抽取器；实际使用时改成项目 utils 下的路径
const assets = path.resolve(__dirname, '../assets')
const pdf = require(path.join(assets, 'pdf-text-extractor.js'))

const bytes = new Uint8Array(fs.readFileSync(target))
const ext = target.toLowerCase().split('.').pop()
const t0 = Date.now()

if (ext === 'docx' || ext === 'doc') {
  const docx = require(path.join(assets, 'docx-text-extractor.js'))
  const r = docx.extractDocxText(bytes)
  console.log(`[${path.basename(target)}] ${(bytes.length / 1024).toFixed(1)}KB | ${Date.now() - t0}ms`)
  console.log(`可用=${r.hasText} 字符=${r.charCount} 原因=${r.reason || '-'}`)
  r.text.split('\n').slice(0, 15).forEach((l) => console.log('  |', l.slice(0, 120)))
} else {
  const r = pdf.extractPdfText(bytes, { maxPages, maxChars: 60000 })
  console.log(
    `[${path.basename(target)}] ${(bytes.length / 1024).toFixed(1)}KB | ${Date.now() - t0}ms | ` +
      `页数=${r.pageCount} 可用=${r.hasTextLayer} 字符=${r.charCount} 字母占比=${r.alphaRatio.toFixed(2)} ` +
      `加密=${r.encrypted} 截断=${r.limited} 原因=${r.reason || '-'}`,
  )
  r.text.split('\n').filter(Boolean).slice(0, 15).forEach((l) => console.log('  |', l.slice(0, 120)))
}
