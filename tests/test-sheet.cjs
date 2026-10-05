// 对拍 utils/sheet.js：真实 CSV / Excel 样本 → 生词数组，与 Python 侧期望值逐字段比对。
const fs = require('fs')
const path = require('path')

// 路径相对本文件定位，换机器 / 换目录都不用改
const ROOT = path.resolve(__dirname, '..')
const PROJ = path.join(ROOT, 'french-vocab-miniprogram')
const SAMPLES = path.resolve(__dirname, 'fixtures', 'sheet-samples')
const sheet = require(path.join(PROJ, 'utils', 'sheet.js'))

const expected = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'fixtures', 'sheet-expected.json'), 'utf8'))

let pass = 0
let fail = 0
function ck(cond, label, extra) {
  if (cond) {
    pass++
  } else {
    fail++
    console.log('    FAIL ' + label + (extra !== undefined ? '  → ' + extra : ''))
  }
}

const FIELDS = ['word', 'phonetic', 'pos', 'meaning_zh', 'example_fr', 'example_zh']

function run(name) {
  const exp = expected[name]
  const buf = fs.readFileSync(path.join(SAMPLES, name))
  const ext = name.split('.').pop().toLowerCase()
  const res = sheet.extractWords(new Uint8Array(buf), { ext })

  console.log('  ' + name)
  if (exp.reason && exp.reason !== 'ok') {
    ck(res.reason === exp.reason, 'reason=' + exp.reason, res.reason)
    return
  }
  if (exp.suspicious) {
    ck(res.reason === 'ok', 'reason=ok', res.reason)
    ck(res.warnings.length > 0, '给出了编码警告')
    ck(res.encoding === 'unknown', "encoding='unknown'", res.encoding)
    return
  }
  if (exp.truncated) {
    ck(res.truncated === true, 'truncated=true', res.truncated)
    ck(res.words.length === exp.count, 'count=' + exp.count, res.words.length)
    return
  }

  ck(res.reason === 'ok', 'reason=ok', res.reason)
  ck(res.words.length === exp.count, 'count=' + exp.count, res.words.length)
  if (exp.hasHeader !== undefined) ck(res.hasHeader === exp.hasHeader, 'hasHeader=' + exp.hasHeader, res.hasHeader)
  if (exp.encoding) ck(res.encoding === exp.encoding, 'encoding=' + exp.encoding, res.encoding)
  if (exp.skipped !== undefined) ck(res.skipped === exp.skipped, 'skipped=' + exp.skipped, res.skipped)
  if (exp.titleRow !== undefined) ck(res.titleRow === exp.titleRow, 'titleRow=' + exp.titleRow, res.titleRow)
  if (exp.headerRowIndex !== undefined) {
    ck(res.headerRowIndex === exp.headerRowIndex, 'headerRowIndex=' + exp.headerRowIndex, res.headerRowIndex)
  }
  if (exp.mapping) {
    for (const k of Object.keys(exp.mapping)) {
      ck(res.mapping[k] === exp.mapping[k], 'mapping.' + k + '=' + exp.mapping[k], res.mapping[k])
    }
  }
  ;(exp.words || []).forEach((want, i) => {
    const got = res.words[i]
    if (!got) {
      fail++
      console.log('    FAIL 缺少第 ' + (i + 1) + ' 个词')
      return
    }
    for (const f of FIELDS) {
      if (want[f] === '' && !got[f]) continue
      ck(got[f] === want[f], '#' + (i + 1) + '.' + f, JSON.stringify(got[f]) + ' ≠ ' + JSON.stringify(want[f]))
    }
  })
}

console.log('=== 样本对拍 ===')
Object.keys(expected)
  .sort()
  .forEach(run)

// ---------- 表头识别的定向断言 ----------
console.log('\n=== guessMapping / looksLikeHeader 定向用例 ===')
const gm = sheet.guessMapping
const lh = sheet.looksLikeHeader
{
  const m = gm(['单词', '释义'])
  ck(m.word === 0 && m.meaning_zh === 1, '中文表头', JSON.stringify(m))
}
{
  const m = gm(['Word', 'Meaning', 'IPA', 'POS'])
  ck(m.word === 0 && m.meaning_zh === 1 && m.phonetic === 2 && m.pos === 3, '英文表头', JSON.stringify(m))
}
{
  const m = gm(['mot', 'phonétique', 'nature', 'traduction'])
  ck(m.word === 0 && m.phonetic === 1 && m.pos === 2 && m.meaning_zh === 3, '法语表头', JSON.stringify(m))
}
{
  const m = gm(['词条', '例句中文', '中文'])
  ck(m.word === 0 && m.example_zh === 1 && m.meaning_zh === 2, "'例句中文' 不被当成释义", JSON.stringify(m))
}
{
  const m = gm(['法语', '例句', '中文释义'])
  ck(m.word === 0 && m.example_fr === 1 && m.meaning_zh === 2, "'法语例句' 不抢占单词列", JSON.stringify(m))
}
{
  const m = gm(['A', 'B'])
  ck(m.word === -1 && m.meaning_zh === -1, '无意义表头不瞎猜', JSON.stringify(m))
}
{
  ck(lh(['单词', '释义']) === true, 'looksLikeHeader 中文')
  ck(lh(['bonjour', '你好']) === false, 'looksLikeHeader 数据行不误判')
  ck(lh(['mot', 'mots']) === true, 'looksLikeHeader 法语表头')
}

// ---------- 覆盖开关 ----------
console.log('\n=== 覆盖 hasHeader / mapping ===')
{
  const buf = fs.readFileSync(path.join(SAMPLES, 'a-header-4col.csv'))
  const res = sheet.extractWords(new Uint8Array(buf), { ext: 'csv', hasHeader: false })
  ck(res.words.length === 6, '关掉表头后表头行也当数据（6 行）', res.words.length)
  ck(res.words[0].word === '单词', '首行是表头文字', res.words[0].word)
}
{
  const buf = fs.readFileSync(path.join(SAMPLES, 'b-noheader-2col.csv'))
  const res = sheet.extractWords(new Uint8Array(buf), {
    ext: 'csv',
    hasHeader: false,
    mapping: { word: 1, meaning_zh: 0, phonetic: -1, pos: -1, example_fr: -1, example_zh: -1 },
  })
  ck(res.words[0].word === '你好；早上好', '手动指定列序生效', res.words[0].word)
}

// ---------- columnLabels ----------
console.log('\n=== columnLabels ===')
{
  const buf = fs.readFileSync(path.join(SAMPLES, 'b-noheader-2col.csv'))
  const res = sheet.extractWords(new Uint8Array(buf), { ext: 'csv' })
  const labels = sheet.columnLabels(res)
  ck(labels.length === 2 && labels[0] === '第 1 列', '无表头时给「第 N 列」', JSON.stringify(labels))
}

// ---------- 纯文本入口（粘贴文本）----------
console.log('\n=== extractWordsFromText（粘贴文本走同一套规则）===')
{
  const res = sheet.extractWordsFromText('单词,音标,词性,释义\nbonjour,[bɔ̃ʒuʁ],interj.,你好；早上好\nmerci,[mɛʁsi],interj.,谢谢')
  ck(res.reason === 'ok', 'reason=ok', res.reason)
  ck(res.hasHeader === true, '识别出表头')
  ck(res.words.length === 2, 'count=2', res.words.length)
  ck(res.words[0].word === 'bonjour' && res.words[0].meaning_zh === '你好；早上好', '字段正确', JSON.stringify(res.words[0]))
  ck(res.mapping.word === 0 && res.mapping.meaning_zh === 3, '列映射正确', JSON.stringify(res.mapping))
}
{
  const res = sheet.extractWordsFromText('bonjour,你好\nmerci,谢谢')
  ck(res.hasHeader === false, '无表头不误判', res.hasHeader)
  ck(res.words.length === 2 && res.words[1].meaning_zh === '谢谢', '两行两列', JSON.stringify(res.words))
}
{
  const res = sheet.extractWordsFromText('bonjour\nmerci\nlivre')
  ck(res.words.length === 3 && res.words[0].word === 'bonjour', '每行一个词', JSON.stringify(res.words))
  ck(res.words[0].meaning_zh === '', '无释义列为空')
}
{
  const res = sheet.extractWordsFromText('   ')
  ck(res.reason === 'empty', '空白文本 → empty', res.reason)
}
{
  const res = sheet.extractWordsFromText('法语第一册 生词表\n单词,释义\nbonjour,你好\nmerci,谢谢')
  ck(res.titleRow === '法语第一册 生词表', '跳过整行标题', res.titleRow)
  ck(res.words.length === 2, '标题与表头都不算词', res.words.length)
}

console.log('\n结果：' + pass + '/' + (pass + fail) + ' 通过')
process.exit(fail ? 1 : 0)
