// CSV / Excel(.xlsx) 端上解析 —— 纯 JS，小程序可直接 require。
//
// 为什么放在端上：
//   1. 云 SDK 传不了二进制，大模型也只吃 text / image_url，没有服务端可以做解析；
//   2. 词表文件本来就不大（几十 KB），端上解析既快又不消耗流量；
//   3. 解析结果走的是「预览 → 去重 → 确认」这条老路，不需要新链路。
//
// .xlsx 本质是 ZIP + XML：复用 utils/docx.js 里已验证的 ZIP 中央目录解析
// 与 pdf.js 里的 inflate，再从 sharedStrings.xml + worksheet XML 里取单元格。
//
// 明确不支持：旧版二进制 .xls（BIFF）—— 不是 ZIP，结构完全不同，别假装能读。
const { _internals } = require('./docx')
const listEntries = _internals.listEntries
const readEntryData = _internals.readEntryData
const utf8ToString = _internals.utf8ToString

// 词表文件不需要支持到几万行；设上限是为了别把手机内存顶爆
const MAX_ROWS = 2000
const MAX_COLS = 30
const MAX_CELL_CHARS = 300

// ---------------- 文本解码 ----------------

function decodeUtf16(bytes, little) {
  const parts = []
  let buf = ''
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const u = little ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1]
    if (u === 0xfeff && i === 0) continue // 内部 BOM
    buf += String.fromCharCode(u)
    if (buf.length >= 4096) {
      parts.push(buf)
      buf = ''
    }
  }
  parts.push(buf)
  return parts.join('')
}

/**
 * 字节 → 文本。
 * 只看 BOM 与 UTF-8 合法性，不做编码嗅探魔法：解不出来就如实告诉用户，
 * 而不是猜一个 GBK 硬解出一堆乱码塞进词库。
 */
function decodeText(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) {
    const text = utf8ToString(u8.subarray(3))
    return { text, encoding: 'utf-8', suspicious: false }
  }
  if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xfe) {
    return { text: decodeUtf16(u8.subarray(2), true), encoding: 'utf-16le', suspicious: false }
  }
  if (u8.length >= 2 && u8[0] === 0xfe && u8[1] === 0xff) {
    return { text: decodeUtf16(u8.subarray(2), false), encoding: 'utf-16be', suspicious: false }
  }
  const text = utf8ToString(u8)
  let bad = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0xfffd) bad += 1
  }
  const ratio = text.length ? bad / text.length : 0
  const suspicious = bad >= 4 && ratio > 0.02
  return { text, encoding: suspicious ? 'unknown' : 'utf-8', suspicious }
}

// ---------------- CSV ----------------

/** 分隔符嗅探：选「列数最稳定且 >= 2」的那个，逗号优先 */
function sniffDelimiter(text) {
  const candidates = [',', '\t', ';', '|']
  const lines = text.slice(0, 20000).split(/\r?\n/).filter((l) => l.trim()).slice(0, 12)
  if (!lines.length) return ','
  let best = ','
  let bestScore = 0
  for (let c = 0; c < candidates.length; c++) {
    const d = candidates[c]
    const counts = lines.map((line) => countDelims(line, d))
    const tally = Object.create(null)
    counts.forEach((n) => {
      tally[n] = (tally[n] || 0) + 1
    })
    let modal = 0
    let modalHit = 0
    Object.keys(tally).forEach((k) => {
      if (tally[k] > modalHit) {
        modalHit = tally[k]
        modal = Number(k)
      }
    })
    const cols = modal + 1
    if (cols < 2) continue
    const score = cols * (modalHit / lines.length)
    if (score > bestScore) {
      bestScore = score
      best = d
    }
  }
  return best
}

function countDelims(line, d) {
  let n = 0
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') inQuotes = !inQuotes
    else if (!inQuotes && c === d) n += 1
  }
  return n
}

/** RFC4180 风格：支持引号包裹、"" 转义、字段内换行与 CRLF */
function parseCsv(text, delim) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  let started = false
  const pushField = () => {
    row.push(field)
    field = ''
  }
  const pushRow = () => {
    pushField()
    rows.push(row)
    row = []
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
      started = true
      continue
    }
    if (ch === delim) {
      pushField()
      started = true
      continue
    }
    if (ch === '\r') continue
    if (ch === '\n') {
      pushRow()
      started = false
      continue
    }
    field += ch
    started = true
  }
  if (started || field !== '' || row.length) pushRow()
  return rows
}

// ---------------- XLSX ----------------

function isZip(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input)
  return u8.length >= 4 && u8[0] === 0x50 && u8[1] === 0x4b
}

function decodeXmlEntities(text) {
  return String(text)
    .replace(/&#x([0-9A-Fa-f]+);/g, (m, h) => {
      const cp = parseInt(h, 16)
      if (cp > 0xffff) {
        const v = cp - 0x10000
        return String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff))
      }
      return String.fromCharCode(cp)
    })
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** <t> / <t xml:space="preserve"> 里的纯文本（去标签 + 实体还原） */
function textOfTags(fragment) {
  let out = ''
  const re = /<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g
  let m = re.exec(fragment)
  while (m) {
    out += m[1] === undefined ? '' : decodeXmlEntities(m[1])
    m = re.exec(fragment)
  }
  return out
}

function parseSharedStrings(xml) {
  const list = []
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g
  let m = re.exec(xml)
  while (m) {
    list.push(m[1] === undefined ? '' : textOfTags(m[1]))
    m = re.exec(xml)
  }
  return list
}

/** "BC" -> 54（A=0） */
function colIndexOf(ref) {
  const letters = String(ref || '').replace(/[^A-Za-z]/g, '').toUpperCase()
  if (!letters) return -1
  let n = 0
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64)
  return n - 1
}

function parseSheetXml(xml, shared) {
  const grid = []
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g
  let rm = rowRe.exec(xml)
  while (rm) {
    const body = rm[2] || ''
    const cells = []
    let seq = 0
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
    let cm = cellRe.exec(body)
    while (cm) {
      const attrs = cm[1] || ''
      const inner = cm[2] || ''
      const refMatch = attrs.match(/\br\s*=\s*"([^"]*)"/)
      let idx = refMatch ? colIndexOf(refMatch[1]) : seq
      if (idx < 0) idx = seq
      seq = idx + 1
      const typeMatch = attrs.match(/\bt\s*=\s*"([^"]*)"/)
      const type = typeMatch ? typeMatch[1] : 'n'
      let value = ''
      if (type === 'inlineStr') {
        value = textOfTags(inner)
      } else if (type === 's') {
        const vm = inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)
        const si = vm ? parseInt(vm[1], 10) : -1
        value = shared[si] === undefined ? '' : shared[si]
      } else {
        const vm = inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)
        value = vm ? decodeXmlEntities(vm[1]) : textOfTags(inner)
      }
      cells[idx] = value
      cm = cellRe.exec(body)
    }
    const width = cells.length
    const row = []
    for (let i = 0; i < width; i++) row.push(cells[i] === undefined ? '' : cells[i])
    grid.push(row)
    rm = rowRe.exec(xml)
  }
  return grid
}

function findEntry(entries, predicate) {
  for (let i = 0; i < entries.length; i++) {
    if (predicate(entries[i].name)) return entries[i]
  }
  return null
}

/**
 * 读 .xlsx：取第一个工作表（按 sheetN.xml 的数字序）。
 * 不做 workbook.xml → rels → sheet 的完整解引用：词表文件几乎都是单表，
 * 多表时取 sheet1 也是符合直觉的选择。
 */
function readXlsx(bytes) {
  const result = { grid: [], reason: '' }
  let entries = []
  try {
    entries = listEntries(bytes)
  } catch (e) {
    result.reason = 'bad_zip'
    return result
  }
  if (!entries.length) {
    result.reason = 'bad_zip'
    return result
  }

  let shared = []
  const ssEntry = findEntry(entries, (n) => /(^|\/)sharedstrings\.xml$/i.test(n))
  if (ssEntry) {
    try {
      const data = readEntryData(bytes, ssEntry)
      if (data) shared = parseSharedStrings(utf8ToString(data))
    } catch (e) {
      shared = []
    }
  }

  const sheets = entries
    .filter((e) => /^xl\/worksheets\/[^/]*\.xml$/i.test(e.name))
    .sort((a, b) => {
      const na = parseInt((a.name.match(/(\d+)/) || [])[1], 10)
      const nb = parseInt((b.name.match(/(\d+)/) || [])[1], 10)
      if (isNaN(na) && isNaN(nb)) return a.name < b.name ? -1 : 1
      if (isNaN(na)) return 1
      if (isNaN(nb)) return -1
      return na - nb
    })
  if (!sheets.length) {
    result.reason = 'no_sheet'
    return result
  }

  let xml = ''
  try {
    const data = readEntryData(bytes, sheets[0])
    if (!data) {
      result.reason = 'unzip_failed'
      return result
    }
    xml = utf8ToString(data)
  } catch (e) {
    result.reason = 'unzip_failed'
    return result
  }

  result.grid = parseSheetXml(xml, shared)
  result.sheetName = sheets[0].name
  return result
}

// ---------------- 表头识别与列映射 ----------------

const HEADER_HINTS = {
  example_zh: ['例句翻译', '例句中文', '译文', '例句释义', 'examplezh', 'examplezhcn'],
  example_fr: ['例句', '法语例句', '英文例句', 'example', 'exemple', 'sentence', 'usage'],
  phonetic: ['音标', '读音', '发音', 'phonetic', 'phonetics', 'ipa', 'phonetique', 'prononciation', 'pronunciation'],
  pos: ['词性', '词类', '词型', 'pos', 'partofspeech', 'nature', 'categorie'],
  word: ['单词', '生词', '法语', '词汇', '词条', 'mot', 'mots', 'word', 'words', 'francais', 'french', 'terme', 'termes', 'lemma', 'vocabulaire', 'vocab'],
  meaning_zh: ['中文释义', '中文意思', '释义', '中文', '意思', '词义', '翻译', '汉译', '解释', '含义', 'meaning', 'translation', 'traduction', 'trad', 'sense', 'sens', 'definition', 'zh'],
}

// 表头是法语/英语时带重音（phonétique / catégorie / définition），
// 不折叠重音就一条都对不上 —— 这是实测踩出来的。
const DIACRITICS = [
  ['àáâãäå', 'a'],
  ['ç', 'c'],
  ['èéêë', 'e'],
  ['ìíîï', 'i'],
  ['ñ', 'n'],
  ['òóôõö', 'o'],
  ['ùúûü', 'u'],
  ['ýÿ', 'y'],
  ['œ', 'oe'],
  ['æ', 'ae'],
  ['ß', 'ss'],
]

function foldDiacritics(s) {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    let mapped = null
    for (let k = 0; k < DIACRITICS.length; k++) {
      if (DIACRITICS[k][0].indexOf(c) >= 0) {
        mapped = DIACRITICS[k][1]
        break
      }
    }
    out += mapped === null ? c : mapped
  }
  return out
}

function normHeader(s) {
  return foldDiacritics(
    String(s || '')
      .toLowerCase()
      .replace(/[\s_\-（）()【】\[\]:：*·.、,，/\\]/g, ''),
  )
}

/**
 * 表头 → 列下标。先精确匹配，再包含匹配；同一类别只认领一次。
 * 检查顺序有讲究：「例句翻译」必须比「中文」先命中，否则会被当成释义列。
 */
function guessMapping(headers) {
  const map = { word: -1, meaning_zh: -1, phonetic: -1, pos: -1, example_fr: -1, example_zh: -1 }
  const order = ['example_zh', 'example_fr', 'phonetic', 'pos', 'word', 'meaning_zh']
  const normed = headers.map(normHeader)
  const taken = Object.create(null)

  const claim = (i, mode) => {
    if (i < 0) return false
    for (let k = 0; k < order.length; k++) {
      const cat = order[k]
      if (taken[cat]) continue
      const hints = HEADER_HINTS[cat]
      for (let h = 0; h < hints.length; h++) {
        const hint = hints[h]
        const hit = mode === 'exact' ? normed[i] === hint : normed[i].indexOf(hint) >= 0
        if (hit) {
          map[cat] = i
          taken[cat] = true
          return true
        }
      }
    }
    return false
  }

  for (let i = 0; i < normed.length; i++) claim(i, 'exact')
  for (let i = 0; i < normed.length; i++) {
    if (!normed[i]) continue
    const already = order.some((c) => map[c] === i)
    if (!already) claim(i, 'loose')
  }
  return map
}

/** 表头行是否有可信的列名（用来判断要不要跳过首行） */
function looksLikeHeader(row) {
  const normed = row.map(normHeader)
  let hits = 0
  normed.forEach((n) => {
    if (!n) return
    const cats = Object.keys(HEADER_HINTS)
    for (let i = 0; i < cats.length; i++) {
      const hints = HEADER_HINTS[cats[i]]
      for (let h = 0; h < hints.length; h++) {
        if (n === hints[h]) {
          hits += 1
          return
        }
      }
    }
  })
  return hits >= 1
}

// ---------------- 网格 → 词表 ----------------

function cell(row, idx) {
  if (idx < 0 || idx >= row.length) return ''
  const v = row[idx] === undefined || row[idx] === null ? '' : String(row[idx])
  return v.length > MAX_CELL_CHARS ? v.slice(0, MAX_CELL_CHARS) : v
}

function trimGrid(grid, maxRows) {
  const out = []
  const limit = Math.min(grid.length, maxRows || MAX_ROWS)
  for (let i = 0; i < limit; i++) {
    out.push((grid[i] || []).slice(0, MAX_COLS))
  }
  return out
}

/**
 * 把二维网格转成生词数组。
 * 单词列为空的行直接丢弃；释义为空也保留（用户可以之后用「AI 补全」）。
 */
function gridToWords(grid, opts) {
  const options = opts || {}
  const mapping = options.mapping || { word: 0, meaning_zh: 1, phonetic: -1, pos: -1, example_fr: -1, example_zh: -1 }
  const start = options.hasHeader ? 1 : 0
  const words = []
  let skipped = 0
  const seen = Object.create(null)
  for (let i = start; i < grid.length; i++) {
    const row = grid[i] || []
    let word = cell(row, mapping.word).trim()
    if (!word) {
      // 单词列空但整行非空 —— 常见于末尾的空行或合并单元格残留，只统计不算失败
      if (row.some((c) => String(c || '').trim())) skipped += 1
      continue
    }
    word = word.replace(/\s+/g, ' ').trim()
    const key = word.toLowerCase()
    if (seen[key]) {
      skipped += 1
      continue
    }
    seen[key] = true
    words.push({
      word,
      meaning_zh: cell(row, mapping.meaning_zh).trim(),
      phonetic: cell(row, mapping.phonetic).trim(),
      pos: cell(row, mapping.pos).trim(),
      example_fr: cell(row, mapping.example_fr).trim(),
      example_zh: cell(row, mapping.example_zh).trim(),
    })
  }
  return { words, skipped }
}

function blankResult() {
  return {
    words: [],
    grid: [],
    hasHeader: false,
    headerRowIndex: 0,
    titleRow: '',
    headers: [],
    mapping: null,
    encoding: '',
    warnings: [],
    truncated: false,
    skipped: 0,
    reason: '',
  }
}

function defaultMapping() {
  return { word: 0, meaning_zh: 1, phonetic: -1, pos: -1, example_fr: -1, example_zh: -1 }
}

/**
 * 从「已经切好的网格」生产最终结果 —— 字节入口和纯文本入口共用这一段，
 * 保证两条路线的表头识别、列映射、去重规则完全一致。
 */
function processGrid(grid, options, out) {
  // 先丢掉完全空的行，再按「数据行」上限截断 —— 空行不该占用 2000 行的额度
  grid = grid.filter((row) => row.some((c) => String(c === undefined || c === null ? '' : c).trim()))
  const rawRows = grid.length
  // 硬上限只做内存保护（多留一行给可能的表头）；真正的「截断」判定用原始行数，
  // 否则被硬上限砍掉的那部分会悄无声息地消失。
  grid = trimGrid(grid, MAX_ROWS + 1)
  if (!grid.length) {
    out.reason = 'empty'
    return out
  }

  const override = typeof options.hasHeader === 'boolean' ? options.hasHeader : null
  let offset = 0
  let hasHeader = false
  if (override !== null) {
    hasHeader = override
  } else {
    // 首行常常是「法语第一册 生词表」这种整行标题（只有一个非空单元格）。
    // 直接当表头会丢一行、直接当数据会多一个假词，所以先跳过它再判断。
    const r0 = grid[0] || []
    const r1 = grid[1] || []
    if (!looksLikeHeader(r0) && nonEmptyCount(r0) <= 1 && nonEmptyCount(r1) >= 2) {
      offset = 1
      out.titleRow = firstNonEmpty(r0)
    }
    hasHeader = looksLikeHeader(grid[offset] || [])
  }

  const headRow = grid[offset] || []
  out.headerRowIndex = offset
  out.hasHeader = hasHeader
  out.headers = hasHeader ? headRow.map(trimCell) : []

  let mapping = options.mapping || guessMapping(hasHeader ? headRow : [])
  // 没识别出「单词」列时退化为第 1 列=单词、第 2 列=释义
  if (!mapping || mapping.word < 0) mapping = defaultMapping()
  out.mapping = mapping

  // 数据行上限：表头行不吃额度，这样「最多 2000 个词」对用户才是字面意思
  const head = hasHeader ? grid.slice(offset, offset + 1) : []
  let dataRows = grid.slice(offset + (hasHeader ? 1 : 0))
  const rawDataRows = Math.max(0, rawRows - offset - (hasHeader ? 1 : 0))
  if (rawDataRows > MAX_ROWS) {
    out.truncated = true
    dataRows = dataRows.slice(0, MAX_ROWS)
  }
  out.grid = head.concat(dataRows)

  const { words, skipped } = gridToWords(out.grid, { mapping, hasHeader })
  out.words = words
  out.skipped = skipped
  out.reason = words.length ? 'ok' : 'no_word'
  return out
}

/** 纯文本 → 网格（没有分隔符时退化成「每行一个词」） */
function textToGrid(text) {
  const str = String(text === undefined || text === null ? '' : text)
  const hasBreak = str.indexOf('\n') >= 0 || str.indexOf('\r') >= 0
  const hasSep = /[,\t;|]/.test(str)
  if (!hasBreak && !hasSep) {
    const one = str.trim()
    return one ? [[one]] : []
  }
  if (!hasSep) {
    return str
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l)
      .map((l) => [l])
  }
  return parseCsv(str, sniffDelimiter(str))
}

/**
 * 主入口：字节 → 生词数组。
 * @param {ArrayBuffer|Uint8Array} input
 * @param {{ext?:string, hasHeader?:boolean, mapping?:object}} [opts]
 * @returns {{words:Array, grid:Array, hasHeader:boolean, headerRowIndex:number, titleRow:string,
 *            headers:Array, mapping:object, encoding:string, warnings:Array<string>,
 *            truncated:boolean, skipped:number, reason:string}}
 */
function extractWords(input, opts) {
  const options = opts || {}
  const out = blankResult()
  if (!input) {
    out.reason = 'bad_input'
    return out
  }
  const ext = String(options.ext || '').toLowerCase()
  if (ext === 'xls') {
    // 旧版 BIFF 不是 ZIP，端上真的读不了；不要静默返回空列表让用户猜
    out.reason = 'legacy_xls'
    return out
  }

  let grid = []
  if (ext === 'xlsx' || ext === 'xlsm' || (!ext && isZip(input))) {
    if (!isZip(input)) {
      out.reason = 'bad_zip'
      return out
    }
    const res = readXlsx(input)
    if (res.reason) {
      out.reason = res.reason
      return out
    }
    grid = res.grid
  } else {
    const decoded = decodeText(input)
    out.encoding = decoded.encoding
    if (decoded.suspicious) {
      out.warnings.push(
        '文件不是 UTF-8 编码（很可能是 Excel 另存的 GBK 中文），文字可能显示为乱码。建议在 Excel 里「另存为 → CSV UTF-8」或直接改传 .xlsx。',
      )
    }
    grid = textToGrid(decoded.text)
  }
  return processGrid(grid, options, out)
}

/** 粘贴文本入口：与文件入口共用表头识别 / 列映射 / 去重规则 */
function extractWordsFromText(text, opts) {
  const out = blankResult()
  out.encoding = 'utf-8'
  return processGrid(textToGrid(text), opts || {}, out)
}

function trimCell(v) {
  return String(v === undefined || v === null ? '' : v).trim()
}

function nonEmptyCount(row) {
  let n = 0
  for (let i = 0; i < row.length; i++) {
    if (trimCell(row[i])) n += 1
  }
  return n
}

function firstNonEmpty(row) {
  for (let i = 0; i < row.length; i++) {
    const v = trimCell(row[i])
    if (v) return v
  }
  return ''
}

function columnLabels(parsed, width) {
  const labels = []
  const n = width || (parsed.headers.length || (parsed.grid[0] ? parsed.grid[0].length : 0))
  for (let i = 0; i < n; i++) {
    const head = parsed.headers[i]
    labels.push(head ? head : '第 ' + (i + 1) + ' 列')
  }
  return labels
}

module.exports = {
  extractWords,
  extractWordsFromText,
  columnLabels,
  guessMapping,
  looksLikeHeader,
  _internals: {
    decodeText,
    parseCsv,
    sniffDelimiter,
    readXlsx,
    parseSheetXml,
    parseSharedStrings,
    colIndexOf,
    textOfTags,
    decodeXmlEntities,
    gridToWords,
    trimGrid,
    trimCell,
    nonEmptyCount,
    firstNonEmpty,
    normHeader,
    foldDiacritics,
    textToGrid,
    processGrid,
    blankResult,
    defaultMapping,
    MAX_ROWS,
    MAX_COLS,
  },
}
