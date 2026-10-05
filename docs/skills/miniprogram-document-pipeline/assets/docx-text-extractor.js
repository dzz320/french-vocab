// .docx 正文抽取（纯 JS，小程序可用）
//
// .docx 本质是一个 ZIP，正文在 word/document.xml。这里自己读 ZIP 目录 +
// 复用 utils/pdf.js 里已验证的 inflate 解压，再从 OOXML 里抽纯文本。
// 注意：只支持 .docx（含 .doc 另存），旧版二进制 .doc 无法解析。
const { _internals } = require('./pdf')
const inflate = _internals.inflate

const SIG_EOCD = 0x06054b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50

function readU32(b, i) {
  return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0
}
function readU16(b, i) {
  return b[i] | (b[i + 1] << 8)
}

/** 从尾部找 EOCD，定位中央目录 */
function findCentralDirectory(bytes) {
  const min = Math.max(0, bytes.length - 66000)
  for (let i = bytes.length - 22; i >= min; i--) {
    if (readU32(bytes, i) === SIG_EOCD) {
      const count = readU16(bytes, i + 10)
      const offset = readU32(bytes, i + 16)
      if (offset > 0 && offset < bytes.length) return { count, offset }
    }
  }
  return null
}

/** 列出 ZIP 条目：{name, method, compressedSize, size, localOffset} */
function listEntries(bytes) {
  const cd = findCentralDirectory(bytes)
  if (!cd) return []
  const entries = []
  let p = cd.offset
  for (let i = 0; i < cd.count && p + 46 <= bytes.length; i++) {
    if (readU32(bytes, p) !== SIG_CENTRAL) break
    const method = readU16(bytes, p + 10)
    const compressedSize = readU32(bytes, p + 20)
    const size = readU32(bytes, p + 24)
    const nameLen = readU16(bytes, p + 28)
    const extraLen = readU16(bytes, p + 30)
    const commentLen = readU16(bytes, p + 32)
    const localOffset = readU32(bytes, p + 42)
    let name = ''
    for (let k = 0; k < nameLen; k++) name += String.fromCharCode(bytes[p + 46 + k])
    entries.push({ name, method, compressedSize, size, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

function readEntryData(bytes, entry) {
  const p = entry.localOffset
  if (readU32(bytes, p) !== SIG_LOCAL) return null
  const nameLen = readU16(bytes, p + 26)
  const extraLen = readU16(bytes, p + 28)
  const start = p + 30 + nameLen + extraLen
  let end = entry.compressedSize ? start + entry.compressedSize : bytes.length
  if (end > bytes.length) end = bytes.length
  const raw = bytes.subarray(start, end)
  if (entry.method === 0) return raw
  if (entry.method === 8) return inflate(raw, 32 * 1024 * 1024)
  return null
}

/** UTF-8 解码（小程序不保证有 TextDecoder，自己实现；非法字节输出 U+FFFD） */
function utf8ToString(bytes) {
  const parts = []
  let buf = ''
  let i = 0
  const n = bytes.length
  while (i < n) {
    const b = bytes[i++]
    if (b < 0x80) {
      buf += String.fromCharCode(b)
    } else {
      let cp = 0
      let extra = 0
      if (b >= 0xc2 && b < 0xe0) {
        cp = b & 0x1f
        extra = 1
      } else if (b >= 0xe0 && b < 0xf0) {
        cp = b & 0x0f
        extra = 2
      } else if (b >= 0xf0 && b < 0xf5) {
        cp = b & 0x07
        extra = 3
      } else {
        buf += '\ufffd'
        extra = -1
      }
      let ok = extra >= 0
      for (let k = 0; k < extra && ok; k++) {
        const c = bytes[i]
        if (c === undefined || (c & 0xc0) !== 0x80) ok = false
        else {
          cp = (cp << 6) | (c & 0x3f)
          i++
        }
      }
      if (!ok) {
        buf += '\ufffd'
      } else if (cp > 0xffff) {
        const v = cp - 0x10000
        buf += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff))
      } else {
        buf += String.fromCharCode(cp)
      }
    }
    if (buf.length >= 4096) {
      parts.push(buf)
      buf = ''
    }
  }
  parts.push(buf)
  return parts.join('')
}

function cpToString(cp) {
  if (cp <= 0xffff) return String.fromCharCode(cp)
  const v = cp - 0x10000
  return String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff))
}

function decodeXmlEntities(text) {
  return String(text)
    .replace(/&#x([0-9A-Fa-f]+);/g, (m, h) => cpToString(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => cpToString(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 从 word/document.xml 抽纯文本：段落换行、制表符转空格、去掉所有标签 */
function xmlToText(xml) {
  let text = String(xml)
  text = text.replace(/<w:tab\b[^>]*\/?>/g, '\t')
  text = text.replace(/<w:br\b[^>]*\/?>/g, '\n')
  text = text.replace(/<\/w:p>/g, '\n')
  text = text.replace(/<\/w:tr>/g, '\n')
  text = text.replace(/<\/w:tc>/g, '\t')
  text = text.replace(/<[^>]+>/g, '')
  text = decodeXmlEntities(text)
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n')
}

/**
 * 抽取 .docx 正文文本。
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {{text:string, charCount:number, hasText:boolean, reason:string}}
 */
function extractDocxText(input) {
  const result = { text: '', charCount: 0, hasText: false, reason: '' }
  let bytes = null
  if (input instanceof Uint8Array) bytes = input
  else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input)
  if (!bytes) {
    result.reason = 'bad_input'
    return result
  }
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    // 不是 ZIP —— 很可能是旧版二进制 .doc
    result.reason = 'not_docx'
    return result
  }
  let entries = []
  try {
    entries = listEntries(bytes)
  } catch (e) {
    result.reason = 'bad_zip'
    return result
  }
  const main = entries.filter((e) => e.name === 'word/document.xml')[0]
  if (!main) {
    result.reason = 'no_document'
    return result
  }
  let xml = null
  try {
    const data = readEntryData(bytes, main)
    if (!data) {
      result.reason = 'unzip_failed'
      return result
    }
    xml = utf8ToString(data)
  } catch (e) {
    result.reason = 'unzip_failed'
    return result
  }
  const text = xmlToText(xml)
  result.text = text
  result.charCount = text.length
  result.hasText = text.length >= 60
  if (!result.hasText) result.reason = 'empty'
  return result
}

module.exports = { extractDocxText, _internals: { listEntries, xmlToText, readEntryData, utf8ToString } }
