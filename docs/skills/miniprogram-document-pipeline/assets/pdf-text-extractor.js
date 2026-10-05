// PDF 文字层抽取（纯 JS，小程序可用）
//
// 为什么需要它：小程序端没有可执行的服务端，云 SDK 的大模型接口也只支持
// text / image_url 两种内容块（不支持 PDF 直传），所以「直接读 PDF 里的生词」
// 只能在端上把 PDF 的文字层抽出来，再交给现有的大模型分块解析。
//
// 适用范围：带文字层的电子版 PDF（发行商排版、Word/LaTeX 导出等）。
// 扫描版 PDF（整页是图片、没有文字层）无法抽取，调用方需据此降级为截图/拍照识别。
//
// 实现要点：
//  - 不使用 TextDecoder / Buffer / 任何 Node 或浏览器 API，只用 Uint8Array。
//  - 不支持 xref 时暴力扫描 "N G obj"，并递归处理对象流（ObjStm），
//    因此对 xref 损坏、增量更新、PDF 1.5+ 压缩对象都相对鲁棒。
//  - 自实现 inflate（DEFLATE）与 LZW 解码，避免引入第三方库（小程序无打包器）。
//  - 字体编码：优先 ToUnicode CMap，其次 WinAnsi / MacRoman / Standard，
//    再不行退到 /Differences 与内置字形名表。
// 内存护栏：手机端要留足余地，解压总量与单流都设上限，防解压炸弹
const MAX_INFLATE_TOTAL = 48 * 1024 * 1024
const MAX_INFLATE_STREAM = 24 * 1024 * 1024
const MAX_OUTPUT_CHARS = 200000

// ============================ 字节工具 ============================

function toBytes(input) {
  if (!input) return new Uint8Array(0)
  if (input instanceof Uint8Array) return input
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  if (input.buffer instanceof ArrayBuffer) return new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength)
  return new Uint8Array(0)
}

/** 在 [from, end) 内查找字节序列，找不到返回 -1 */
function indexOfBytes(bytes, pattern, from, end) {
  const limit = typeof end === 'number' ? end : bytes.length
  const first = pattern[0]
  for (let i = from || 0; i + pattern.length <= limit; i++) {
    if (bytes[i] !== first) continue
    let ok = true
    for (let j = 1; j < pattern.length; j++) {
      if (bytes[i + j] !== pattern[j]) {
        ok = false
        break
      }
    }
    if (ok) return i
  }
  return -1
}

const P_OBJ = [0x6f, 0x62, 0x6a] // obj
const P_ENDOBJ = [0x65, 0x6e, 0x64, 0x6f, 0x62, 0x6a] // endobj
const P_STREAM = [0x73, 0x74, 0x72, 0x65, 0x61, 0x6d] // stream
const P_ENDSTREAM = [0x65, 0x6e, 0x64, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d] // endstream

/** 字节 -> Latin-1 字符串（分块，避免 apply 栈溢出）；仅用于解析结构，不用于输出文本 */
function latin1(bytes, start, end) {
  const s = start || 0
  const e = typeof end === 'number' ? end : bytes.length
  let out = ''
  const CHUNK = 8192
  for (let i = s; i < e; i += CHUNK) {
    const stop = Math.min(i + CHUNK, e)
    let part = ''
    for (let j = i; j < stop; j++) part += String.fromCharCode(bytes[j])
    out += part
  }
  return out
}

function isWhite(b) {
  return b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09 || b === 0x0c || b === 0x00
}
function isDelim(b) {
  return b === 0x28 || b === 0x29 || b === 0x3c || b === 0x3e || b === 0x5b || b === 0x5d || b === 0x7b || b === 0x7d || b === 0x2f || b === 0x25
}
function isDigit(b) {
  return b >= 0x30 && b <= 0x39
}

// ============================ inflate（DEFLATE） ============================
// 移植自经典 puff 实现：LSB-first 读位、逐位建码，逻辑简单且不依赖查表优化。

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]

function buildHuffman(lengths) {
  const MAXBITS = 15
  const count = new Array(MAXBITS + 1).fill(0)
  let i
  for (i = 0; i < lengths.length; i++) count[lengths[i]]++
  if (count[0] === lengths.length) return { count, symbol: [] }
  // 检查是否为完整码
  let left = 1
  for (let len = 1; len <= MAXBITS; len++) {
    left <<= 1
    left -= count[len]
    if (left < 0) throw new Error('PDF: 无效的 Huffman 码')
  }
  const offs = new Array(MAXBITS + 2).fill(0)
  for (let len = 1; len <= MAXBITS; len++) offs[len + 1] = offs[len] + count[len]
  const symbol = new Array(lengths.length)
  for (i = 0; i < lengths.length; i++) {
    if (lengths[i]) symbol[offs[lengths[i]]++] = i
  }
  return { count, symbol }
}

function decodeSym(st, huff) {
  let code = 0
  let first = 0
  let index = 0
  for (let len = 1; len <= 15; len++) {
    code |= st.bits(1)
    const count = huff.count[len]
    if (count > 0 && code - first < count) return huff.symbol[index + (code - first)]
    index += count
    first += count
    first <<= 1
    code <<= 1
  }
  throw new Error('PDF: Huffman 解码失败')
}

function fixedTables() {
  const l = new Array(288)
  for (let i = 0; i < 144; i++) l[i] = 8
  for (let i = 144; i < 256; i++) l[i] = 9
  for (let i = 256; i < 280; i++) l[i] = 7
  for (let i = 280; i < 288; i++) l[i] = 8
  return { lit: buildHuffman(l), dist: buildHuffman(new Array(30).fill(5)) }
}

let FIXED = null

function dynamicTables(st) {
  const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]
  const nlen = st.bits(5) + 257
  const ndist = st.bits(5) + 1
  const ncode = st.bits(4) + 4
  const clens = new Array(19).fill(0)
  for (let i = 0; i < ncode; i++) clens[ORDER[i]] = st.bits(3)
  const clh = buildHuffman(clens)
  const lengths = new Array(nlen + ndist).fill(0)
  let i = 0
  while (i < lengths.length) {
    const sym = decodeSym(st, clh)
    if (sym < 16) {
      lengths[i++] = sym
    } else if (sym === 16) {
      if (i === 0) throw new Error('PDF: 无效的码长度重复')
      const prev = lengths[i - 1]
      let n = 3 + st.bits(2)
      while (n-- > 0 && i < lengths.length) lengths[i++] = prev
    } else if (sym === 17) {
      let n = 3 + st.bits(3)
      while (n-- > 0 && i < lengths.length) lengths[i++] = 0
    } else {
      let n = 11 + st.bits(7)
      while (n-- > 0 && i < lengths.length) lengths[i++] = 0
    }
  }
  return {
    lit: buildHuffman(lengths.slice(0, nlen)),
    dist: buildHuffman(lengths.slice(nlen)),
  }
}

function inflateRaw(src, limit) {
  const cap = limit || MAX_INFLATE_STREAM
  let out = new Uint8Array(Math.min(cap, Math.max(4096, src.length * 3 + 64)))
  let outLen = 0
  let incnt = 0
  let bitbuf = 0
  let bitcnt = 0

  function bits(need) {
    let val = bitbuf
    while (bitcnt < need) {
      if (incnt >= src.length) throw new Error('PDF: 压缩流提前结束')
      val |= src[incnt++] << bitcnt
      bitcnt += 8
    }
    bitbuf = val >>> need
    bitcnt -= need
    return val & ((1 << need) - 1)
  }
  function put(byte) {
    if (outLen >= cap) throw new Error('PDF: 解压结果过大，已中止')
    if (outLen >= out.length) {
      const next = new Uint8Array(Math.min(cap, out.length * 2))
      next.set(out.subarray(0, outLen))
      out = next
    }
    out[outLen++] = byte
  }

  const st = { bits }
  let last = 0
  let type = 0
  do {
    last = bits(1)
    type = bits(2)
    if (type === 0) {
      // 未压缩块
      bitbuf = 0
      bitcnt = 0
      if (incnt + 4 > src.length) throw new Error('PDF: 未压缩块损坏')
      const len = src[incnt] | (src[incnt + 1] << 8)
      incnt += 4
      if (incnt + len > src.length) throw new Error('PDF: 未压缩块越界')
      for (let i = 0; i < len; i++) put(src[incnt++])
    } else if (type === 1 || type === 2) {
      let tables
      if (type === 1) {
        if (!FIXED) FIXED = fixedTables()
        tables = FIXED
      } else {
        tables = dynamicTables(st)
      }
      for (;;) {
        const sym = decodeSym(st, tables.lit)
        if (sym < 256) {
          put(sym)
        } else if (sym === 256) {
          break
        } else {
          const li = sym - 257
          if (li >= LEN_BASE.length) throw new Error('PDF: 无效的长度码')
          const length = LEN_BASE[li] + bits(LEN_EXTRA[li])
          const dsym = decodeSym(st, tables.dist)
          if (dsym >= DIST_BASE.length) throw new Error('PDF: 无效的距离码')
          const dist = DIST_BASE[dsym] + bits(DIST_EXTRA[dsym])
          if (dist > outLen) throw new Error('PDF: 无效的回溯距离')
          let from = outLen - dist
          for (let i = 0; i < length; i++) put(out[from++])
        }
      }
    } else {
      throw new Error('PDF: 不支持的压缩块类型')
    }
  } while (!last)
  return out.subarray(0, outLen)
}

/** PDF 的 FlateDecode：先按 zlib 头处理，失败再按裸 deflate 重试 */
function inflate(bytes, limit) {
  if (!bytes || !bytes.length) return new Uint8Array(0)
  const looksZlib = bytes.length > 2 && (bytes[0] & 0x0f) === 8 && ((bytes[0] << 8) | bytes[1]) % 31 === 0
  if (looksZlib) {
    try {
      return inflateRaw(bytes.subarray(2, bytes.length), limit)
    } catch (e) {
      /* 落到裸 deflate 重试 */
    }
  }
  try {
    return inflateRaw(bytes, limit)
  } catch (e) {
    if (looksZlib) throw e
    // 有些流没有 zlib 头，去掉首字节再试
    if (bytes.length > 1) return inflateRaw(bytes.subarray(1, bytes.length), limit)
    throw e
  }
}

/** LZWDecode（PDF 1.2 时代的教材扫描件偶见） */
function lzwDecode(bytes, earlyChange, limit) {
  const cap = limit || MAX_INFLATE_STREAM
  const out = []
  let dict = []
  function reset() {
    dict = []
    for (let i = 0; i < 256; i++) dict.push([i])
  }
  reset()
  let bitbuf = 0
  let bitcnt = 0
  let codeLen = 9
  let prev = null
  let pos = 0
  for (;;) {
    while (bitcnt < codeLen) {
      if (pos >= bytes.length) {
        return Uint8Array.from(out)
      }
      bitbuf = (bitbuf << 8) | bytes[pos++]
      bitcnt += 8
    }
    bitcnt -= codeLen
    const code = (bitbuf >> bitcnt) & ((1 << codeLen) - 1)
    if (code === 256) {
      reset()
      codeLen = 9
      prev = null
      continue
    }
    if (code === 257) break
    let entry
    if (code < dict.length && dict[code]) {
      entry = dict[code]
    } else if (code === dict.length && prev) {
      entry = prev.concat([prev[0]])
    } else {
      break
    }
    for (let i = 0; i < entry.length; i++) {
      if (out.length >= cap) throw new Error('PDF: LZW 解压结果过大')
      out.push(entry[i])
    }
    if (prev) {
      const added = prev.concat([entry[0]])
      if (dict.length < 4096) {
        dict.push(added)
        const limitLen = dict.length + (earlyChange === 0 ? 0 : 1)
        if (limitLen >= 512) codeLen = 10
        if (limitLen >= 1024) codeLen = 11
        if (limitLen >= 2048) codeLen = 12
      }
    }
    prev = entry
  }
  return Uint8Array.from(out)
}

/** PNG/TIFF 预测器（多见于 xref 流，少数内容流也用） */
function applyPredictor(data, parms) {
  if (!parms || !parms.predictor || parms.predictor <= 1) return data
  const colors = parms.colors || 1
  const bpc = parms.bitsPerComponent || 8
  const columns = parms.columns || 1
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8))
  const rowLen = Math.ceil((colors * bpc * columns) / 8)
  if (parms.predictor === 2) {
    // TIFF predictor 2：仅支持 8 位
    if (bpc !== 8) return data
    for (let r = 0; r + rowLen <= data.length; r += rowLen) {
      for (let i = bpp; i < rowLen; i++) data[r + i] = (data[r + i] + data[r + i - bpp]) & 0xff
    }
    return data
  }
  // PNG 预测器：每行前有 1 字节 filter
  const rows = Math.floor(data.length / (rowLen + 1))
  const out = new Uint8Array(rows * rowLen)
  for (let r = 0; r < rows; r++) {
    const ft = data[r * (rowLen + 1)]
    const srcOff = r * (rowLen + 1) + 1
    const dstOff = r * rowLen
    const prevOff = dstOff - rowLen
    for (let i = 0; i < rowLen; i++) {
      const raw = data[srcOff + i]
      const left = i >= bpp ? out[dstOff + i - bpp] : 0
      const up = r > 0 ? out[prevOff + i] : 0
      const upLeft = r > 0 && i >= bpp ? out[prevOff + i - bpp] : 0
      let val
      if (ft === 0) val = raw
      else if (ft === 1) val = raw + left
      else if (ft === 2) val = raw + up
      else if (ft === 3) val = raw + ((left + up) >> 1)
      else if (ft === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        val = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)
      } else val = raw
      out[dstOff + i] = val & 0xff
    }
  }
  return out
}

// ============================ 文本解码表 ============================

// WinAnsiEncoding 在 0x80–0x9F 区间的特殊字符（其余与 Latin-1 一致）
const WIN_ANSI_HIGH =
  '\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f' +
  '\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178'

// MacRomanEncoding 0x80–0xFF
const MAC_ROMAN =
  '\u00c4\u00c5\u00c7\u00c9\u00d1\u00d6\u00dc\u00e1\u00e0\u00e2\u00e4\u00e3\u00e5\u00e7\u00e9\u00e8' +
  '\u00ea\u00eb\u00ed\u00ec\u00ee\u00ef\u00f1\u00f3\u00f2\u00f4\u00f6\u00f5\u00fa\u00f9\u00fb\u00fc' +
  '\u2020\u00b0\u00a2\u00a3\u00a7\u2022\u00b6\u00df\u00ae\u00a9\u2122\u00b4\u00a8\u2260\u00c6\u00d8' +
  '\u221e\u00b1\u2264\u2265\u00a5\u00b5\u2202\u2211\u220f\u03c0\u222b\u00aa\u00ba\u03a9\u00e6\u00f8' +
  '\u00bf\u00a1\u00ac\u221a\u0192\u2248\u2206\u00ab\u00bb\u2026\u00a0\u00c0\u00c3\u00d5\u0152\u0153' +
  '\u2013\u2014\u201c\u201d\u2018\u2019\u00f7\u25ca\u00ff\u0178\u2044\u20ac\u2039\u203a\ufb01\ufb02' +
  '\u2021\u00b7\u201a\u201e\u2030\u00c2\u00ca\u00c1\u00cb\u00c8\u00cd\u00ce\u00cf\u00cc\u00d3\u00d4' +
  '\uf8ff\u00d2\u00da\u00db\u00d9\u0131\u02c6\u02dc\u00af\u02d8\u02d9\u02da\u00b8\u02dd\u02db\u02c7'

// 内置字形名表（用于 /Differences 与缺少 ToUnicode 的简单字体）
const GLYPHS = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&',
  quotesingle: "'", quoteright: '\u2019', quoteleft: '\u2018', quotesinglbase: '\u201a', parenleft: '(',
  parenright: ')', asterisk: '*', plus: '+', comma: ',', hyphen: '-', period: '.', slash: '/', zero: '0',
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>', question: '?', at: '@', bracketleft: '[',
  backslash: '\\', bracketright: ']', asciicircum: '^', underscore: '_', grave: '`', braceleft: '{',
  bar: '|', braceright: '}', asciitilde: '~', nbspace: ' ', endash: '\u2013', emdash: '\u2014',
  quotedblleft: '\u201c', quotedblright: '\u201d', guillemotleft: '\u00ab', guillemotright: '\u00bb',
  bullet: '\u2022', ellipsis: '\u2026', euro: '\u20ac', degree: '\u00b0', periodcentered: '\u00b7',
  Aacute: 'Á', Acircumflex: 'Â', Adieresis: 'Ä', Agrave: 'À', Aring: 'Å', Ccedilla: 'Ç', Eacute: 'É',
  Ecircumflex: 'Ê', Edieresis: 'Ë', Egrave: 'È', Iacute: 'Í', Icircumflex: 'Î', Idieresis: 'Ï',
  Igrave: 'Ì', Ntilde: 'Ñ', Oacute: 'Ó', Ocircumflex: 'Ô', Odieresis: 'Ö', Ograve: 'Ò', Oslash: 'Ø',
  Otilde: 'Õ', OE: 'Œ', Scaron: 'Š', Uacute: 'Ú', Ucircumflex: 'Û', Udieresis: 'Ü', Ugrave: 'Ù',
  Yacute: 'Ý', Ydieresis: 'Ÿ', Zcaron: 'Ž', aacute: 'á', acircumflex: 'â', adieresis: 'ä', agrave: 'à',
  aring: 'å', ccedilla: 'ç', eacute: 'é', ecircumflex: 'ê', edieresis: 'ë', egrave: 'è', iacute: 'í',
  icircumflex: 'î', idieresis: 'ï', igrave: 'ì', ntilde: 'ñ', oacute: 'ó', ocircumflex: 'ô',
  odieresis: 'ö', ograve: 'ò', oslash: 'ø', otilde: 'õ', oe: 'œ', scaron: 'š', uacute: 'ú',
  ucircumflex: 'û', udieresis: 'ü', ugrave: 'ù', yacute: 'ý', ydieresis: 'ÿ', zcaron: 'ž',
  florin: 'ƒ', dagger: '†', daggerdbl: '‡', perthousand: '‰', trademark: '™', minus: '\u2212',
  fi: 'fi', fl: 'fl', ffi: 'ffi', ffl: 'ffl', AE: 'Æ', ae: 'æ', Thorn: 'Þ', thorn: 'þ', Eth: 'Ð', eth: 'ð',
}

function glyphToUnicode(name) {
  if (!name) return ''
  if (GLYPHS[name]) return GLYPHS[name]
  // uniXXXX / uXXXX
  let m = /^uni([0-9A-Fa-f]{4})$/.exec(name)
  if (m) return String.fromCharCode(parseInt(m[1], 16))
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name)
  if (m) {
    const cp = parseInt(m[1], 16)
    if (cp > 0xffff) {
      const v = cp - 0x10000
      return String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff))
    }
    return String.fromCharCode(cp)
  }
  // 去掉后缀（如 Eacute.sc / aacute.alt）
  const base = name.split('.')[0]
  if (base !== name && GLYPHS[base]) return GLYPHS[base]
  return ''
}

function decodeWithEncoding(bytes, encodingName, differences) {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]
    if (differences && differences[b]) {
      out += differences[b]
      continue
    }
    if (b < 0x80) {
      out += String.fromCharCode(b)
    } else if (encodingName === 'macroman') {
      out += MAC_ROMAN[b - 0x80] || ''
    } else if (encodingName === 'winansi' || !encodingName) {
      out += b >= 0xa0 ? String.fromCharCode(b) : WIN_ANSI_HIGH[b - 0x80] || ''
    } else {
      // StandardEncoding / PDFDocEncoding：高位近似为 Latin-1
      out += b >= 0x20 ? String.fromCharCode(b) : ''
    }
  }
  return out
}

// ============================ 语法解析 ============================

/** 从字节流按 PDF 语法解析一个值（用于 dict/array/数字/字符串/名称/引用） */
function Parser(bytes, pos, end) {
  this.b = bytes
  this.i = pos
  this.end = typeof end === 'number' ? end : bytes.length
}
Parser.prototype.skipWs = function () {
  while (this.i < this.end) {
    const c = this.b[this.i]
    if (isWhite(c)) {
      this.i++
    } else if (c === 0x25) {
      while (this.i < this.end && this.b[this.i] !== 0x0a && this.b[this.i] !== 0x0d) this.i++
    } else {
      break
    }
  }
}
Parser.prototype.parseName = function () {
  // 假定当前在 '/'
  this.i++
  let name = ''
  while (this.i < this.end) {
    const c = this.b[this.i]
    if (isWhite(c) || isDelim(c)) break
    if (c === 0x23 && this.i + 2 < this.end) {
      const hex = latin1(this.b, this.i + 1, this.i + 3)
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        name += String.fromCharCode(parseInt(hex, 16))
        this.i += 3
        continue
      }
    }
    name += String.fromCharCode(c)
    this.i++
  }
  return name
}
Parser.prototype.parseLiteralString = function () {
  // 假定当前在 '('
  this.i++
  const out = []
  let depth = 1
  while (this.i < this.end) {
    const c = this.b[this.i++]
    if (c === 0x5c) {
      const n = this.b[this.i]
      if (n === 0x6e) { out.push(10); this.i++ }
      else if (n === 0x72) { out.push(13); this.i++ }
      else if (n === 0x74) { out.push(9); this.i++ }
      else if (n === 0x62) { out.push(8); this.i++ }
      else if (n === 0x66) { out.push(12); this.i++ }
      else if (n === 0x28 || n === 0x29 || n === 0x5c) { out.push(n); this.i++ }
      else if (n === 0x0a) { this.i++ }
      else if (n === 0x0d) { this.i++; if (this.b[this.i] === 0x0a) this.i++ }
      else if (isDigit(n)) {
        let oct = ''
        while (oct.length < 3 && isDigit(this.b[this.i])) oct += String.fromCharCode(this.b[this.i++])
        out.push(parseInt(oct, 8) & 0xff)
      } else {
        out.push(n === undefined ? 0x5c : n)
        this.i++
      }
    } else if (c === 0x28) {
      depth++
      out.push(c)
    } else if (c === 0x29) {
      depth--
      if (depth === 0) break
      out.push(c)
    } else {
      out.push(c)
    }
  }
  return Uint8Array.from(out)
}
Parser.prototype.parseHexString = function () {
  // 假定当前在 '<'（不是 '<<'）
  this.i++
  let digits = ''
  while (this.i < this.end) {
    const c = this.b[this.i++]
    if (c === 0x3e) break
    if (isWhite(c)) continue
    digits += String.fromCharCode(c)
  }
  if (digits.length % 2) digits += '0'
  const out = new Uint8Array(digits.length / 2)
  for (let k = 0; k < out.length; k++) {
    const v = parseInt(digits.substr(k * 2, 2), 16)
    out[k] = isNaN(v) ? 0 : v
  }
  return out
}
Parser.prototype.parseDict = function () {
  // 假定当前在 '<<'
  this.i += 2
  const dict = {}
  for (;;) {
    this.skipWs()
    if (this.i >= this.end) break
    const c = this.b[this.i]
    if (c !== 0x2f) break // 不是名称，dict 结束（异常时容错退出）
    const key = this.parseName()
    this.skipWs()
    if (this.b[this.i] === 0x3e && this.b[this.i + 1] === 0x3e) {
      this.i += 2
      break
    }
    dict[key] = this.parseValue()
  }
  return dict
}
Parser.prototype.parseValue = function () {
  this.skipWs()
  if (this.i >= this.end) return null
  const c = this.b[this.i]
  if (c === 0x2f) return { name: this.parseName() }
  if (c === 0x28) return { str: this.parseLiteralString() }
  if (c === 0x5b) {
    this.i++
    const arr = []
    for (;;) {
      this.skipWs()
      if (this.i >= this.end || this.b[this.i] === 0x5d) {
        this.i++
        break
      }
      const v = this.parseValue()
      if (v === null) break
      arr.push(v)
    }
    return { arr }
  }
  if (c === 0x3c) {
    if (this.b[this.i + 1] === 0x3c) return { dict: this.parseDict() }
    return { str: this.parseHexString() }
  }
  if (c === 0x74 && this.b[this.i + 1] === 0x72 && this.b[this.i + 2] === 0x75 && this.b[this.i + 3] === 0x65) {
    this.i += 4
    return { bool: true }
  }
  if (c === 0x66 && this.b[this.i + 1] === 0x61 && this.b[this.i + 2] === 0x6c) {
    this.i += 3
    this.i += 2 // 'se'
    return { bool: false }
  }
  if (c === 0x6e) {
    this.i += 4 // null
    return null
  }
  // 数字或间接引用
  const start = this.i
  if (c === 0x2b || c === 0x2d || c === 0x2e || isDigit(c)) {
    while (this.i < this.end) {
      const d = this.b[this.i]
      if (isDigit(d) || d === 0x2b || d === 0x2d || d === 0x2e || d === 0x45 || d === 0x65) this.i++
      else break
    }
    const text = latin1(this.b, start, this.i)
    const intVal = /^[+-]?\d+$/.test(text) ? parseInt(text, 10) : null
    // 尝试识别 "num gen R"
    if (intVal !== null) {
      const save = this.i
      this.skipWs()
      const s2 = this.i
      while (this.i < this.end && isDigit(this.b[this.i])) this.i++
      const genText = latin1(this.b, s2, this.i)
      if (genText !== '') {
        this.skipWs()
        if (this.b[this.i] === 0x52 && !/[A-Za-z0-9]/.test(String.fromCharCode(this.b[this.i + 1] || 0x20))) {
          this.i++
          return { ref: intVal, gen: parseInt(genText, 10) }
        }
      }
      this.i = save
    }
    return { num: parseFloat(text) }
  }
  // 关键字或其他，跳过
  this.i++
  return { op: String.fromCharCode(c) }
}

// ============================ 对象与文档结构 ============================

const NUM_RE = /[0-9]/

/** 取 PDF 名称值（解析结果里名称被包成 {name:'X'}，直接字典值可能是字符串） */
function nameOf(value) {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (value.name !== undefined) return String(value.name)
  if (value.obj && value.obj.dict && value.obj.dict.name !== undefined) return String(value.obj.dict.name)
  return ''
}

/** 暴力扫描所有 "N G obj ... endobj"，返回对象表 {num: {dict, raw(stream bytes), dictEnd}} */
function scanObjects(bytes, budget) {
  const objects = {}
  let pos = 0
  let count = 0
  for (;;) {
    const at = indexOfBytes(bytes, P_OBJ, pos)
    if (at < 0) break
    pos = at + 3
    if (count++ > 200000) break
    // 向前取 "num gen"
    let s = at - 1
    while (s >= 0 && isWhite(bytes[s])) s--
    const genEnd = s + 1
    while (s >= 0 && isDigit(bytes[s])) s--
    const genStart = s + 1
    if (genStart === genEnd) continue
    while (s >= 0 && isWhite(bytes[s])) s--
    const numEnd = s + 1
    while (s >= 0 && isDigit(bytes[s])) s--
    const numStart = s + 1
    if (numStart === numEnd) continue
    const num = parseInt(latin1(bytes, numStart, numEnd), 10)
    const gen = parseInt(latin1(bytes, genStart, genEnd), 10)
    if (typeof num !== 'number' || isNaN(num)) continue

    const p = new Parser(bytes, pos)
    p.skipWs()
    let dict = null
    let dictEnd = p.i
    if (bytes[p.i] === 0x3c && bytes[p.i + 1] === 0x3c) {
      try {
        dict = p.parseDict()
        dictEnd = p.i
      } catch (e) {
        dict = null
      }
    }
    // 查找 stream
    let stream = null
    if (dict) {
      const searchEnd = Math.min(bytes.length, dictEnd + 32)
      const stAt = indexOfBytes(bytes, P_STREAM, dictEnd, searchEnd)
      if (stAt >= 0 && stAt - dictEnd <= 24) {
        let dataStart = stAt + 6
        if (bytes[dataStart] === 0x0d) dataStart++
        if (bytes[dataStart] === 0x0a) dataStart++
        // 优先按 /Length（直接数值）取长度，其后必须紧跟 endstream；
        // 否则退回搜索 endstream（二进制数据里可能恰好出现该字样）
        let dataEnd = -1
        const lenVal = dict.Length
        if (lenVal && typeof lenVal.num === 'number' && lenVal.num >= 0 && dataStart + lenVal.num <= bytes.length) {
          const guessEnd = dataStart + lenVal.num
          if (indexOfBytes(bytes, P_ENDSTREAM, guessEnd, Math.min(bytes.length, guessEnd + 8)) >= 0) {
            dataEnd = guessEnd
          }
        }
        if (dataEnd < 0) {
          const endAt = indexOfBytes(bytes, P_ENDSTREAM, dataStart)
          dataEnd = endAt < 0 ? bytes.length : endAt
        }
        while (dataEnd > dataStart && (bytes[dataEnd - 1] === 0x0a || bytes[dataEnd - 1] === 0x0d)) dataEnd--
        stream = bytes.subarray(dataStart, dataEnd)
      }
    }
    const existing = objects[num]
    // 同号对象：保留带 stream 的 / 更靠后的（增量更新场景）
    if (!existing || (stream && !existing.stream) || (!!stream === !!existing.stream && at > existing.at)) {
      objects[num] = { num, gen, dict, stream, at, decoded: null }
    }
  }
  // 递归展开对象流（ObjStm）：其内部的字典对象不在文件中直接出现
  const keys = Object.keys(objects)
  for (let k = 0; k < keys.length; k++) {
    const obj = objects[keys[k]]
    if (!obj.dict || !obj.stream) continue
    if (nameOf(obj.dict.Type) !== 'ObjStm') continue
    try {
      const data = decodeStream(obj, budget)
      if (!data) continue
      const n = (obj.dict.N && obj.dict.N.num) || 0
      const first = (obj.dict.First && obj.dict.First.num) || 0
      const header = new Parser(data, 0, Math.min(first, data.length))
      const pairs = []
      for (let i = 0; i < n; i++) {
        header.skipWs()
        const s1 = header.i
        while (header.i < header.end && isDigit(data[header.i])) header.i++
        const numText = latin1(data, s1, header.i)
        header.skipWs()
        const s2 = header.i
        while (header.i < header.end && isDigit(data[header.i])) header.i++
        const offText = latin1(data, s2, header.i)
        if (!numText || !offText) break
        pairs.push([parseInt(numText, 10), parseInt(offText, 10)])
      }
      for (let i = 0; i < pairs.length; i++) {
        const [num, off] = pairs[i]
        if (objects[num]) continue
        const start = first + off
        const stop = i + 1 < pairs.length ? first + pairs[i + 1][1] : data.length
        if (start >= data.length) continue
        const sub = data.subarray(start, Math.min(stop, data.length))
        const inner = new Parser(sub, 0, sub.length)
        inner.skipWs()
        if (sub[inner.i] === 0x3c && sub[inner.i + 1] === 0x3c) {
          try {
            objects[num] = { num, gen: 0, dict: inner.parseDict(), stream: null, at: -1, decoded: null }
          } catch (e) {
            /* 忽略单个坏对象 */
          }
        }
      }
    } catch (e) {
      /* 忽略坏的对象流 */
    }
  }
  return objects
}

function filtersOf(dict) {
  const f = dict && dict.Filter
  if (!f) return []
  if (f.name) return [f.name]
  if (f.arr) return f.arr.map((x) => (x && x.name) || '').filter(Boolean)
  return []
}

function decodeStream(obj, budget) {
  if (!obj || !obj.stream) return null
  let data = obj.stream
  if (obj.decoded) return obj.decoded
  const filters = filtersOf(obj.dict)
  const parms = obj.dict.DecodeParms
  let parmList = []
  if (parms && parms.arr) parmList = parms.arr
  else if (parms && parms.dict) parmList = [parms]
  for (let i = 0; i < filters.length; i++) {
    const name = filters[i]
    const parmDict = parmList[i] && parmList[i].dict ? parmList[i].dict : parmList[0] && parmList[0].dict ? parmList[0].dict : null
    const remaining = Math.max(1024, budget.limit - budget.used)
    if (name === 'FlateDecode' || name === 'Fl') {
      const inflated = inflate(data, Math.min(remaining, MAX_INFLATE_STREAM))
      budget.used += inflated.length
      if (budget.used > budget.limit) throw new Error('PDF: 解压总量超出上限')
      data = applyPredictor(inflated, paramNumbers(parmDict))
    } else if (name === 'LZWDecode' || name === 'LZW') {
      const early = parmDict && typeof parmDict.EarlyChange === 'number' ? parmDict.EarlyChange : 1
      const inflated = lzwDecode(data, early, Math.min(remaining, MAX_INFLATE_STREAM))
      budget.used += inflated.length
      if (budget.used > budget.limit) throw new Error('PDF: 解压总量超出上限')
      data = applyPredictor(inflated, paramNumbers(parmDict))
    } else if (name === 'ASCIIHexDecode' || name === 'AHx') {
      data = asciiHex(data)
    } else if (name === 'ASCII85Decode' || name === 'A85') {
      data = ascii85(data)
    } else if (name === 'Crypt') {
      // 已加密内容无法解析
      throw new Error('PDF: 内容已加密')
    } else {
      throw new Error('PDF: 不支持的压缩方式 ' + name)
    }
  }
  obj.decoded = data
  return data
}

/** DecodeParms 里的数值项可能被写成间接引用，这里只取直接数值 */
function paramNumbers(dict) {
  if (!dict) return null
  const out = {}
  const map = { Predictor: 'predictor', Colors: 'colors', BitsPerComponent: 'bitsPerComponent', Columns: 'columns' }
  Object.keys(map).forEach((k) => {
    const v = dict[k]
    if (v && typeof v.num === 'number') out[map[k]] = v.num
  })
  return Object.keys(out).length ? out : null
}

function hexVal(c) {
  if (c >= 0x30 && c <= 0x39) return c - 0x30
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10
  return -1
}

function asciiHex(data) {
  const out = []
  let hi = -1
  for (let i = 0; i < data.length; i++) {
    const c = data[i]
    if (c === 0x3e) break
    const v = hexVal(c)
    if (v < 0) continue
    if (hi < 0) hi = v
    else {
      out.push((hi << 4) | v)
      hi = -1
    }
  }
  if (hi >= 0) out.push(hi << 4)
  return Uint8Array.from(out)
}

function ascii85(data) {
  const out = []
  let tuple = 0
  let count = 0
  for (let i = 0; i < data.length; i++) {
    const c = data[i]
    if (isWhite(c)) continue
    if (c === 0x7e) break
    if (c === 0x7a && count === 0) {
      out.push(0, 0, 0, 0)
      continue
    }
    if (c < 0x21 || c > 0x75) continue
    tuple = tuple * 85 + (c - 0x21)
    count++
    if (count === 5) {
      out.push((tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff)
      tuple = 0
      count = 0
    }
  }
  if (count > 0) {
    for (let i = count; i < 5; i++) tuple = tuple * 85 + 84
    out.push((tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff)
    out.length -= 5 - count
  }
  return Uint8Array.from(out)
}

// ============================ 字体与编码 ============================

function resolve(objects, value) {
  if (!value) return null
  if (value.ref !== undefined) return objects[value.ref] || null
  return value
}

function dictOf(objects, value) {
  const obj = resolve(objects, value)
  if (!obj) return null
  if (obj.dict) return obj.dict
  if (value && value.dict) return value.dict
  return null
}

/** 解析 ToUnicode CMap 文本 -> {map, codeBytes} */
function parseToUnicode(text) {
  const map = Object.create(null)
  let codeBytes = 0
  let m
  const csRe = /begincodespacerange([\s\S]*?)endcodespacerange/g
  while ((m = csRe.exec(text))) {
    const range = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/.exec(m[1])
    if (range) codeBytes = Math.max(codeBytes, Math.ceil(range[1].length / 2))
  }
  const bfcharRe = /beginbfchar([\s\S]*?)endbfchar/g
  while ((m = bfcharRe.exec(text))) {
    const body = m[1]
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g
    let pair
    while ((pair = re.exec(body))) {
      const code = parseInt(pair[1], 16)
      codeBytes = Math.max(codeBytes, Math.ceil(pair[1].length / 2))
      map[code] = utf16FromHex(pair[2])
    }
  }
  const bfrangeRe = /beginbfrange([\s\S]*?)endbfrange/g
  while ((m = bfrangeRe.exec(text))) {
    const body = m[1]
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]*>|\[[^\]]*\])/g
    let item
    while ((item = re.exec(body))) {
      const lo = parseInt(item[1], 16)
      const hi = parseInt(item[2], 16)
      codeBytes = Math.max(codeBytes, Math.ceil(item[1].length / 2))
      const target = item[3]
      if (target[0] === '[') {
        const parts = target.match(/<([0-9A-Fa-f]*)>/g) || []
        for (let i = 0; i < parts.length && lo + i <= hi; i++) {
          map[lo + i] = utf16FromHex(parts[i].replace(/[<>]/g, ''))
        }
      } else {
        const startHex = target.replace(/[<>]/g, '')
        const startCode = parseInt(startHex, 16) || 0
        const width = startHex.length
        for (let code = lo; code <= hi && code - lo < 65536; code++) {
          let nc = startCode + (code - lo)
          let hex = nc.toString(16).toUpperCase()
          while (hex.length < width) hex = '0' + hex
          map[code] = utf16FromHex(hex)
        }
      }
    }
  }
  return { map, codeBytes: codeBytes || 1 }
}

function utf16FromHex(hex) {
  let out = ''
  for (let i = 0; i + 4 <= hex.length; i += 4) {
    out += String.fromCharCode(parseInt(hex.substr(i, 4), 16))
  }
  if (!out && hex.length === 2) out = String.fromCharCode(parseInt(hex, 16))
  return out
}

/** 构建字体信息：{decode(bytes) -> string} */
function buildFont(objects, fontDict) {
  const info = { toUnicode: null, codeBytes: 1, encodingName: '', differences: null, unmapped: 0 }
  if (!fontDict) return info
  const subtype = nameOf(fontDict.Subtype)
  const tuRef = resolve(objects, fontDict.ToUnicode)
  if (tuRef && tuRef.stream) {
    try {
      const data = decodeStream(tuRef, { used: 0, limit: MAX_INFLATE_TOTAL })
      if (data) {
        const parsed = parseToUnicode(latin1(data, 0, data.length))
        info.toUnicode = parsed.map
        info.codeBytes = parsed.codeBytes
      }
    } catch (e) {
      /* 忽略坏 CMap */
    }
  }
  // 编码（Encoding 可能是名称、直接字典，或指向字典的间接引用）
  let encDict = null
  const rawEnc = fontDict.Encoding
  if (rawEnc && rawEnc.ref !== undefined) {
    const encObj = resolve(objects, rawEnc)
    encDict = (encObj && encObj.dict) || null
    const baseName = encDict ? nameOf(encDict.BaseEncoding) : ''
    info.encodingName = baseName.toLowerCase().replace('encoding', '')
  } else if (rawEnc && rawEnc.dict) {
    encDict = rawEnc.dict
    info.encodingName = nameOf(encDict.BaseEncoding).toLowerCase().replace('encoding', '')
  } else if (rawEnc && rawEnc.name) {
    info.encodingName = String(rawEnc.name).toLowerCase().replace('encoding', '')
  }
  if (encDict) {
    const diffs = resolve(objects, encDict.Differences)
    const arr = Array.isArray(diffs) ? diffs : diffs && diffs.arr ? diffs.arr : null
    if (arr) {
      const map = Object.create(null)
      let code = 0
      arr.forEach((item) => {
        if (!item) return
        if (typeof item.num === 'number') {
          code = item.num
        } else if (item.name) {
          const ch = glyphToUnicode(item.name)
          if (ch) map[code] = ch
          code++
        }
      })
      info.differences = map
    }
  }
  if (subtype === 'Type0' && !info.toUnicode) {
    // 无 ToUnicode 的复合字体无法可靠映射，按 2 字节跳过
    info.codeBytes = 2
  }
  if (info.encodingName === 'identity-h' || info.encodingName === 'identityv') info.codeBytes = 2
  return info
}

function fontDecoder(font) {
  const info = font || {}
  return function (bytes) {
    if (info.toUnicode) {
      let out = ''
      const n = info.codeBytes || 1
      for (let i = 0; i + n <= bytes.length; i += n) {
        let code = 0
        for (let k = 0; k < n; k++) code = (code << 8) | bytes[i + k]
        const ch = info.toUnicode[code]
        if (ch === undefined) info.unmapped = (info.unmapped || 0) + 1
        out += ch === undefined ? '' : ch
      }
      return out
    }
    return decodeWithEncoding(bytes, info.encodingName, info.differences)
  }
}

// ============================ 内容流文本抽取 ============================

const TEXT_OPS = { Tj: 1, TJ: 1, "'": 1, '"': 1 }

/** 从内容流解码文本，返回行数组 */
function extractFromContent(data, ctx, depth) {
  const lines = []
  let cur = ''
  let pendingSpace = false
  let curFont = null
  let fontSize = 12
  let x = 0
  let y = 0
  let leading = 0
  let lastY = null
  let textObj = false
  const stack = []

  function flushLine() {
    const t = cur.replace(/\s+$/, '')
    if (t) lines.push(t)
    cur = ''
    pendingSpace = false
  }
  function moveBy(dx, dy) {
    x += dx
    y += dy
    if (lastY === null) lastY = y
    if (Math.abs(y - lastY) > 0.6) {
      flushLine()
      lastY = y
    }
  }

  const p = new Parser(data, 0, data.length)
  while (p.i < p.end) {
    p.skipWs()
    if (p.i >= p.end) break
    const c = data[p.i]
    // 操作数
    if (c === 0x2f) {
      stack.push({ name: p.parseName() })
      continue
    }
    if (c === 0x28) {
      stack.push({ str: p.parseLiteralString() })
      continue
    }
    if (c === 0x5b) {
      const v = p.parseValue()
      stack.push(v || { arr: [] })
      continue
    }
    if (c === 0x3c) {
      stack.push({ str: p.parseHexString() })
      continue
    }
    if (c === 0x5d) {
      p.i++
      continue
    }
    if (isDigit(c) || c === 0x2b || c === 0x2d || c === 0x2e) {
      const v = p.parseValue()
      stack.push(v)
      continue
    }
    // 操作符
    const start = p.i
    while (p.i < p.end && !isWhite(data[p.i]) && !isDelim(data[p.i])) p.i++
    const op = latin1(data, start, p.i)
    if (!op) {
      p.i++
      continue
    }
    applyOp(op, stack, {
      show(strBytes) {
        const decoder = fontDecoder(curFont)
        const text = decoder(strBytes)
        if (!text) return
        if (pendingSpace && cur && !/\s$/.test(cur) && !/^\s/.test(text)) cur += ' '
        pendingSpace = false
        cur += text
      },
      newline() {
        flushLine()
      },
      setFont(name, size) {
        curFont = (ctx.fonts && ctx.fonts[name]) || null
        if (size) fontSize = size
      },
      moveBy,
      setLeading(v) {
        leading = v
      },
      getLeading() {
        return leading
      },
      space() {
        pendingSpace = true
      },
      beginText() {
        textObj = true
      },
      endText() {
        textObj = false
        flushLine()
      },
      doXObject(name) {
        if (depth >= 3 || !ctx.xobjects || !ctx.xobjects[name]) return
        const xobj = ctx.xobjects[name]
        const sub = xobj.dict || {}
        const subType = nameOf(sub.Subtype)
        if (subType && subType !== 'Form') return
        let subData
        try {
          subData = decodeStream(xobj, ctx.budget)
        } catch (e) {
          return
        }
        if (!subData) return
        const subCtx = {
          fonts: readFontMap(ctx.objects, sub.Resources || ctx.resources),
          xobjects: readXObjectMap(ctx.objects, sub.Resources || ctx.resources),
          budget: ctx.budget,
          objects: ctx.objects,
        }
        const subLines = extractFromContent(subData, subCtx, depth + 1)
        subLines.forEach((l) => lines.push(l))
      },
    })
    if (op !== 'Tf' && op !== 'Td' && op !== 'TD' && op !== 'Tm' && op !== 'T*') {
      // 其余操作符的栈已在 applyOp 内消费
    }
  }
  flushLine()
  return lines
}

function applyOp(op, stack, api) {
  const nums = stack.filter((t) => t && typeof t.num === 'number').map((t) => t.num)
  const names = stack.filter((t) => t && t.name !== undefined)
  const strs = stack.filter((t) => t && t.str)
  if (op === 'BT') {
    api.beginText()
  } else if (op === 'ET') {
    api.endText()
  } else if (op === 'Tf') {
    const size = nums.length ? nums[nums.length - 1] : 12
    const name = names.length ? names[names.length - 1].name : ''
    api.setFont(name, size)
  } else if (op === 'Td' || op === 'TD') {
    const dy = nums.length >= 2 ? nums[nums.length - 1] : 0
    const dx = nums.length >= 2 ? nums[nums.length - 2] : 0
    if (op === 'TD') api.setLeading(-dy)
    // Td 是相对行首的位移：仅当 Y 变化时换行
    api.moveBy(0, dy)
  } else if (op === 'Tm') {
    const f = nums.length >= 6 ? nums[nums.length - 1] : 0
    api.moveBy(0, f)
  } else if (op === 'T*') {
    api.moveBy(0, -api.getLeading())
  } else if (op === 'Tj' || op === 'TJ' || op === "'" || op === '"') {
    if (op === "'" || op === '"') {
      if (op === '"' && nums.length >= 2) api.setLeading(nums[0])
      api.moveBy(0, -api.getLeading())
    }
    if (op === 'TJ') {
      const arr = stack.length ? stack[stack.length - 1] : null
      const items = arr && arr.arr ? arr.arr : []
      items.forEach((item) => {
        if (item && item.str) {
          api.show(item.str)
        } else if (item && typeof item.num === 'number') {
          // 数值在 -1000/字宽 单位下：明显为负说明是词间距
          if (item.num <= -200) api.space()
        }
      })
    } else if (strs.length) {
      strs.forEach((s) => api.show(s.str))
    }
  } else if (op === 'Do') {
    if (names.length) api.doXObject(names[names.length - 1].name)
  }
  // 除操作数栈清空外不做额外处理（内容流按从左到右消费）
  stack.length = 0
}

// ============================ 文档组装 ============================

function readFontMap(objects, resources) {
  const out = {}
  const res = dictOf(objects, resources)
  if (!res) return out
  const fonts = dictOf(objects, res.Font)
  if (!fonts) return out
  Object.keys(fonts).forEach((name) => {
    const fontObj = resolve(objects, fonts[name])
    const fontDict = fontObj && fontObj.dict ? fontObj.dict : null
    if (!fontDict) return
    out[name] = buildFont(objects, fontDict)
  })
  return out
}

function readXObjectMap(objects, resources) {
  const out = {}
  const res = dictOf(objects, resources)
  if (!res) return out
  const xo = dictOf(objects, res.XObject)
  if (!xo) return out
  Object.keys(xo).forEach((name) => {
    const obj = resolve(objects, xo[name])
    if (obj) out[name] = obj
  })
  return out
}

/** 找文档页对象（按页面树顺序；找不到则退回文件顺序） */
function collectPages(objects) {
  const pages = []
  let root = null
  const keys = Object.keys(objects)
  for (let i = 0; i < keys.length; i++) {
    const obj = objects[keys[i]]
    if (obj.dict && nameOf(obj.dict.Type) === 'Catalog') {
      root = obj
      break
    }
  }
  const seen = Object.create(null)
  function walk(node, inherited, depth) {
    if (!node || !node.dict || depth > 32 || pages.length > 3000) return
    const dict = node.dict
    const res = dict.Resources || inherited
    const type = nameOf(dict.Type)
    const kids = dict.Kids && dict.Kids.arr ? dict.Kids.arr : null
    if (type === 'Pages' || (kids && type !== 'Page')) {
      ;(kids || []).forEach((kid) => {
        const child = resolve(objects, kid)
        if (child && child.num !== undefined && !seen[child.num]) {
          seen[child.num] = true
          walk(child, res, depth + 1)
        }
      })
      return
    }
    if (type === 'Page' || (dict.Contents && !kids)) pages.push({ page: node, resources: res })
  }
  if (root) {
    const pagesRef = resolve(objects, root.dict.Pages)
    if (pagesRef) {
      seen[pagesRef.num] = true
      walk(pagesRef, null, 0)
    }
  }
  if (!pages.length) {
    keys.forEach((k) => {
      const obj = objects[k]
      if (obj.dict && nameOf(obj.dict.Type) === 'Page') pages.push({ page: obj, resources: obj.dict.Resources })
    })
    // 有些生成器不写 /Type /Page，这里按「有 Contents 的页容器」兜底（按对象号排序）
    if (!pages.length) {
      keys
        .filter((k) => objects[k].dict && objects[k].dict.Contents && !objects[k].stream)
        .sort((a, b) => Number(a) - Number(b))
        .forEach((k) => pages.push({ page: objects[k], resources: objects[k].dict.Resources }))
    }
  }
  return pages
}

function cleanText(lines) {
  const out = []
  lines.forEach((raw) => {
    let line = String(raw).replace(/\u0000/g, '').replace(/\u00a0/g, ' ')
    line = line.replace(/\s+/g, ' ').trim()
    if (!line) return
    // 丢掉纯数字/纯符号等噪音行（页码、装饰线），但保留含字母或中日韩文字的行
    if (!/[A-Za-z\u00c0-\u024f\u4e00-\u9fff]/.test(line)) return
    out.push(line)
  })
  return out
}

/**
 * 抽取 PDF 文字层。
 * @param {ArrayBuffer|Uint8Array} input PDF 字节
 * @param {{maxPages?:number, maxChars?:number}} [options]
 * @returns {{text:string, pageCount:number, charCount:number, hasTextLayer:boolean, encrypted:boolean, limited:boolean, reason:string}}
 */
function extractPdfText(input, options) {
  const opts = options || {}
  const maxPages = opts.maxPages || 80
  const maxChars = Math.min(opts.maxChars || MAX_OUTPUT_CHARS, MAX_OUTPUT_CHARS)
  const result = {
    text: '',
    pageCount: 0,
    charCount: 0,
    alphaRatio: 0,
    hasTextLayer: false,
    encrypted: false,
    limited: false,
    reason: '',
  }
  const bytes = toBytes(input)
  if (!bytes.length) {
    result.reason = 'empty'
    return result
  }
  const budget = { used: 0, limit: MAX_INFLATE_TOTAL }
  let objects = {}
  try {
    // 加密标记（正文流可能整体被加密，抽取会失败）
    const encAt = indexOfBytes(bytes, [0x2f, 0x45, 0x6e, 0x63, 0x72, 0x79, 0x70, 0x74], 0)
    if (encAt >= 0) result.encrypted = true
    objects = scanObjects(bytes, budget)
  } catch (e) {
    result.reason = 'parse_failed'
    return result
  }
  let pages = []
  try {
    pages = collectPages(objects)
  } catch (e) {
    pages = []
  }
  result.pageCount = pages.length
  if (!pages.length) {
    result.reason = 'no_pages'
    return result
  }
  const pageTexts = []
  let chars = 0
  const limit = Math.min(pages.length, maxPages)
  for (let i = 0; i < limit; i++) {
    const entry = pages[i]
    let data = null
    try {
      const contents = entry.page.dict.Contents
      const list = contents && contents.arr ? contents.arr : [contents]
      const chunks = []
      list.forEach((c) => {
        const obj = resolve(objects, c)
        if (!obj || !obj.stream) return
        const d = decodeStream(obj, budget)
        if (d) chunks.push(d)
      })
      if (chunks.length) {
        let total = 0
        chunks.forEach((c) => (total += c.length))
        data = new Uint8Array(total)
        let off = 0
        chunks.forEach((c) => {
          data.set(c, off)
          off += c.length
        })
      }
    } catch (e) {
      data = null
    }
    if (!data) continue
    const ctx = {
      objects,
      budget,
      fonts: readFontMap(objects, entry.resources || entry.page.dict.Resources),
      xobjects: readXObjectMap(objects, entry.resources || entry.page.dict.Resources),
    }
    let lines = []
    try {
      lines = extractFromContent(data, ctx, 0)
    } catch (e) {
      lines = []
    }
    const clean = cleanText(lines)
    if (clean.length) {
      const pageText = clean.join('\n')
      pageTexts.push(pageText)
      chars += pageText.length
      if (chars >= maxChars) {
        result.limited = true
        break
      }
    }
  }
  result.text = pageTexts.join('\n\n')
  result.charCount = result.text.length
  // 文字质量：字母/汉字占比过低说明字体编码没映射对，抽出来是乱码，宁可降级
  const letters = (result.text.match(/[A-Za-z\u00c0-\u024f\u4e00-\u9fff]/g) || []).length
  result.alphaRatio = result.charCount ? letters / result.charCount : 0
  const extractedPages = pageTexts.length
  result.hasTextLayer =
    result.charCount >= 120 && extractedPages >= Math.min(2, limit) && result.alphaRatio >= 0.35
  if (!result.hasTextLayer) {
    if (result.encrypted) result.reason = 'encrypted'
    else if (result.charCount >= 120 && result.alphaRatio < 0.35) result.reason = 'low_quality'
    else result.reason = 'no_text_layer'
  }
  return result
}

module.exports = {
  extractPdfText,
  // 供测试与复用
  _internals: {
    inflate,
    lzwDecode,
    scanObjects,
    parseToUnicode,
    decodeWithEncoding,
    glyphToUnicode,
    applyPredictor,
    ascii85,
    asciiHex,
    Parser,
  },
}
