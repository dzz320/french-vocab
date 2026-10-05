/**
 * 例句点词命中率量化脚本：用**真 fr-text.js** 跑一遍例句语料，
 * 算「点词能跳到已有词条的比例」，并按不同词库规模对比。
 *
 * 跑法：
 *   node hitrate.cjs <fr-text.js 绝对路径> <例句CSV的目录> <例句CSV文件名> <例题列名> <每行一个词库构成的对比组>
 * 例：
 *   node hitrate.cjs ./fr-text.js ./word-lists B1.csv 例句 "只导B1:B1.csv" "+A1:A1.csv,B1.csv" "+A1+A2:A1.csv,A2.csv,B1.csv"
 *
 * 输出里最有用的两个数：
 *   - 点词命中率：用户点 100 个词，有多少次能跳到**已有**词条（其余会落到新增页）
 *   - 至少一词可跳的句子占比：这个功能对用户是否「看起来有用」
 */
const fs = require('fs')
const path = require('path')

const [frTextPath, dir, csvName, colName, ...cases] = process.argv.slice(2)
if (!frTextPath || !dir || !csvName) {
  console.error('用法: node hitrate.cjs <fr-text.js> <csv目录> <例句csv> <例题列名> ["名称:文件1,文件2" ...]')
  process.exit(2)
}
const frText = require(path.resolve(frTextPath))

function parseCsv(text) {
  const rows = []
  let row = []
  let cell = ''
  let q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else q = false
      } else cell += c
    } else if (c === '"') q = true
    else if (c === ',') {
      row.push(cell)
      cell = ''
    } else if (c === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else if (c !== '\r') cell += c
  }
  if (cell !== '' || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

function read(file) {
  const rows = parseCsv(fs.readFileSync(path.join(dir, file), 'utf8').replace(/^\uFEFF/, ''))
  const head = rows.shift() || []
  return { head, rows }
}

const base = read(csvName)
const iEx = base.head.indexOf(colName)
if (iEx < 0) {
  console.error('例题列名没找到，实际表头:', base.head.join(' | '))
  process.exit(2)
}
const sentences = base.rows.map((r) => String(r[iEx] || '').trim()).filter(Boolean)
console.log('例句数:', sentences.length, ' 列:', colName)

function libWords(files) {
  const set = new Set()
  files.forEach((f) => {
    const { head, rows } = read(f)
    const i = head.indexOf('mot')
    if (i < 0) throw new Error(f + ' 里没有 mot 列（表头: ' + head.join(' | ') + '）')
    rows.forEach((r) => {
      const m = String(r[i] || '').trim().toLowerCase()
      if (m) set.add(m)
    })
  })
  return set
}

function rate(files) {
  const lib = libWords(files)
  let tokens = 0
  let hits = 0
  let sent = 0
  const miss = new Map()
  for (const ex of sentences) {
    let any = false
    for (const p of frText.tokenize(ex)) {
      if (!p.w) continue
      tokens++
      const hit = frText.lookupCandidates(p.t).find((c) => lib.has(c.toLowerCase()))
      if (hit) {
        hits++
        any = true
      } else {
        const k = p.t.toLowerCase()
        miss.set(k, (miss.get(k) || 0) + 1)
      }
    }
    if (any) sent++
  }
  return { lib: lib.size, tokens, hits, miss, sent }
}

const groups = cases.length ? cases : ['只导B1:B1.csv']
console.log('\n词条数   点词命中率   至少一词可跳的句子   词库构成')
let lastMiss = null
for (const spec of groups) {
  const idx = spec.indexOf(':')
  const name = idx < 0 ? spec : spec.slice(0, idx)
  const files = (idx < 0 ? spec : spec.slice(idx + 1)).split(',').map((s) => s.trim()).filter(Boolean)
  const r = rate(files)
  lastMiss = r.miss
  console.log(
    String(r.lib).padStart(5) +
      '   ' +
      (((r.hits / r.tokens) * 100).toFixed(1) + '%').padStart(9) +
      '   ' +
      (((r.sent / sentences.length) * 100).toFixed(1) + '%').padStart(15) +
      '      ' +
      name,
  )
}

if (lastMiss) {
  console.log('\n按最后一组的词库，最常落空的 20 个词（这些点击会落到新增页）:')
  ;[...lastMiss.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .forEach(([w, c], i) => console.log('  ' + String(i + 1).padStart(2) + '. ' + w.padEnd(16) + c))
}
