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
  // 假定当前在 '<<'；结束时消费掉自己的 '>>'，
  // 否则嵌套字典会让外层字典提前结束（/Resources 之后的键会整段丢失）
  this.i += 2
  const dict = {}
  for (;;) {
    this.skipWs()
    if (this.i >= this.end) break
    if (this.b[this.i] === 0x3e && this.b[this.i + 1] === 0x3e) {
      this.i += 2
      break
    }
    if (this.b[this.i] !== 0x2f) break // 不是名称，异常时容错退出
    const key = this.parseName()
    this.skipWs()
    if (this.b[this.i] === 0x3e && this.b[this.i + 1] === 0x3e) {
      this.i += 2
      dict[key] = null
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
    } else if (name === 'RunLengthDecode' || name === 'RL') {
      data = runLength(data)
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

// ============================ 图像层 ============================
//
// 扫描版 PDF 的「页面图」本来就是嵌入的图片流（/Subtype /Image），把它原样取出来
// 比栅格化更忠实，也省内存。但要把它交给多模态模型，就得是 JPEG/PNG：
//   - DCTDecode   → 流本身就是 JPEG，直接透传
//   - CCITTFaxDecode → 传真编码（黑白扫描件最常见），自己解码成 1bit 位图再封 PNG
//   - FlateDecode → 原始位图，封 PNG（需要自己实现 DEFLATE 压缩）
//   - JPXDecode / JBIG2Decode → 无法转码，明确降级
//
// 小程序里没有 zlib、没有打包器，所以 DEFLATE 压缩与 PNG 封装都在这里自实现。

const MAX_IMAGE_PIXELS = 24000000
const MAX_GRAY_PIXELS = 6000000
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

// ---------- 校验和 ----------
let CRC_TABLE = null

function crc32(bytes, start, end) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[n] = c
    }
  }
  let c = -1
  const e = typeof end === 'number' ? end : bytes.length
  for (let i = start || 0; i < e; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function adler32(bytes) {
  let a = 1
  let b = 0
  for (let i = 0; i < bytes.length; i++) {
    a += bytes[i]
    if (a >= 65521) a -= 65521
    b += a
    if (b >= 65521) b -= 65521
  }
  return (b * 65536 + a) >>> 0
}

// ---------- DEFLATE（固定 Huffman + 哈希链 LZ77） ----------
function byteSink(initial) {
  let cap = initial || 65536
  let buf = new Uint8Array(cap)
  let len = 0
  return {
    push(b) {
      if (len === cap) {
        const next = new Uint8Array(cap * 2)
        next.set(buf.subarray(0, len))
        buf = next
        cap *= 2
      }
      buf[len++] = b
    },
    put(arr, from, to) {
      const n = to - from
      while (len + n > cap) {
        const next = new Uint8Array(cap * 2)
        next.set(buf.subarray(0, len))
        buf = next
        cap *= 2
      }
      buf.set(arr.subarray(from, to), len)
      len += n
    },
    bytes() {
      return buf.subarray(0, len)
    },
    size() {
      return len
    },
  }
}

function bitSink(sink) {
  let acc = 0
  let cnt = 0
  return {
    // DEFLATE 里除 Huffman 码以外的字段都是低位在前
    bits(value, count) {
      for (let i = 0; i < count; i++) {
        if ((value >>> i) & 1) acc |= 1 << cnt
        if (++cnt === 8) {
          sink.push(acc)
          acc = 0
          cnt = 0
        }
      }
    },
    // Huffman 码高位在前
    huff(code, count) {
      for (let i = count - 1; i >= 0; i--) {
        if ((code >>> i) & 1) acc |= 1 << cnt
        if (++cnt === 8) {
          sink.push(acc)
          acc = 0
          cnt = 0
        }
      }
    },
    flush() {
      if (cnt) {
        sink.push(acc)
        acc = 0
        cnt = 0
      }
    },
  }
}

/** 固定 Huffman 字面量码表（RFC1951 3.2.6） */
function fixedLitCode(sym) {
  if (sym <= 143) return { code: 0x30 + sym, bits: 8 }
  if (sym <= 255) return { code: 0x190 + (sym - 144), bits: 9 }
  if (sym <= 279) return { code: sym - 256, bits: 7 }
  return { code: 0xc0 + (sym - 280), bits: 8 }
}

/** 长度 -> 长度码（用 inflate 的长度表反查） */
function lengthCode(len) {
  let i = 0
  for (; i < LEN_BASE.length - 1; i++) {
    const span = LEN_EXTRA[i] ? 1 << LEN_EXTRA[i] : 1
    if (len < LEN_BASE[i] + span) break
  }
  return { code: 257 + i, extraBits: LEN_EXTRA[i], extraValue: len - LEN_BASE[i] }
}

function distanceCode(dist) {
  let i = 0
  for (; i < DIST_BASE.length - 1; i++) {
    const span = DIST_EXTRA[i] ? 1 << DIST_EXTRA[i] : 1
    if (dist < DIST_BASE[i] + span) break
  }
  return { code: i, extraBits: DIST_EXTRA[i], extraValue: dist - DIST_BASE[i] }
}

const DEFLATE_WINDOW = 32768
const DEFLATE_WMASK = DEFLATE_WINDOW - 1
const DEFLATE_HASH_SIZE = 1 << 15
const DEFLATE_HASH_MASK = DEFLATE_HASH_SIZE - 1

/**
 * 输出一个 raw DEFLATE 流（固定 Huffman 块）。
 * 图像（尤其扫描页）有大量重复字节，惰性不做的贪心匹配已能得到可观压缩；
 * 哈希链深度按输入规模自适应，避免大图退化成 O(n·chain)。
 */
function deflateRaw(data) {
  const n = data.length
  const sink = byteSink(Math.max(4096, n >>> 1))
  const bs = bitSink(sink)
  bs.bits(1, 1) // BFINAL
  bs.bits(1, 2) // BTYPE = 01 固定 Huffman

  const maxChain = n > 3e6 ? 4 : n > 8e5 ? 8 : 24
  const head = new Int32Array(DEFLATE_HASH_SIZE).fill(-1)
  const prev = new Int32Array(DEFLATE_WINDOW)

  function hash3(i) {
    return ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & DEFLATE_HASH_MASK
  }

  function emitLiteral(b) {
    const c = fixedLitCode(b)
    bs.huff(c.code, c.bits)
  }

  function emitMatch(len, dist) {
    const lc = lengthCode(len)
    const lcCode = fixedLitCode(lc.code)
    bs.huff(lcCode.code, lcCode.bits)
    if (lc.extraBits) bs.bits(lc.extraValue, lc.extraBits)
    const dc = distanceCode(dist)
    bs.huff(dc.code, 5)
    if (dc.extraBits) bs.bits(dc.extraValue, dc.extraBits)
  }

  function insert(i) {
    const h = hash3(i)
    prev[i & DEFLATE_WMASK] = head[h]
    head[h] = i
  }

  let i = 0
  while (i < n) {
    let bestLen = 0
    let bestDist = 0
    if (i + 2 < n) {
      const h = hash3(i)
      let cand = head[h]
      let chain = maxChain
      const maxLen = Math.min(258, n - i)
      while (cand >= 0 && chain-- > 0 && i - cand <= DEFLATE_WINDOW) {
        let l = 0
        while (l < maxLen && data[cand + l] === data[i + l]) l++
        if (l > bestLen) {
          bestLen = l
          bestDist = i - cand
          if (l >= maxLen) break
        }
        cand = prev[cand & DEFLATE_WMASK]
      }
      insert(i)
    }
    if (bestLen >= 3) {
      emitMatch(bestLen, bestDist)
      for (let k = 1; k < bestLen; k++) {
        if (i + k + 2 < n) insert(i + k)
      }
      i += bestLen
    } else {
      emitLiteral(data[i])
      i++
    }
  }
  bs.huff(0, 7) // 结束码 256
  bs.flush()
  return sink.bytes()
}

/**
 * PNG 的 IDAT 需要 zlib 包装：2 字节头 + DEFLATE 数据 + adler32 校验。
 * 注意 adler32 校验的是「未压缩的原始数据」，不是压缩流——
 * 传错会得到一个结构完好但校验失败的 PNG（解压报 incorrect data check）。
 * @param {Uint8Array} compressed DEFLATE 压缩流
 * @param {Uint8Array} source 生成该压缩流的未压缩数据
 */
function zlibWrap(compressed, source) {
  const out = new Uint8Array(compressed.length + 6)
  out[0] = 0x78
  out[1] = 0x01 // 0x7801 % 31 == 0
  out.set(compressed, 2)
  const ad = adler32(source)
  const n = compressed.length
  out[n + 2] = (ad >>> 24) & 0xff
  out[n + 3] = (ad >>> 16) & 0xff
  out[n + 4] = (ad >>> 8) & 0xff
  out[n + 5] = ad & 0xff
  return out
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length)
  const len = data.length
  out[0] = (len >>> 24) & 0xff
  out[1] = (len >>> 16) & 0xff
  out[2] = (len >>> 8) & 0xff
  out[3] = len & 0xff
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  const crc = crc32(out, 4, 8 + len)
  out[8 + len] = (crc >>> 24) & 0xff
  out[9 + len] = (crc >>> 16) & 0xff
  out[10 + len] = (crc >>> 8) & 0xff
  out[11 + len] = crc & 0xff
  return out
}

/**
 * 把像素行封成 PNG。
 * @param {number} width 像素宽
 * @param {number} height 像素高
 * @param {number} bitDepth 1 或 8
 * @param {number} colorType 0=灰度 2=RGB
 * @param {(y:number)=>Uint8Array} rowAt 返回第 y 行的样本字节（1bit 时按位打包）
 */
function encodePNG(width, height, bitDepth, colorType, rowAt) {
  const bpp = colorType === 2 ? 3 : 1
  const rowBytes = bitDepth === 1 ? Math.ceil(width / 8) : width * bpp
  const useUp = bitDepth === 8 && height > 1
  const raw = new Uint8Array((rowBytes + 1) * height)
  let prev = null
  for (let y = 0; y < height; y++) {
    const row = rowAt(y)
    const off = y * (rowBytes + 1)
    if (useUp) {
      raw[off] = 2
      for (let i = 0; i < rowBytes; i++) raw[off + 1 + i] = (row[i] - (prev ? prev[i] : 0)) & 0xff
      // rowAt 可能反复返回同一块缓冲，必须拷贝后再留作上一行
      prev = row.slice(0, rowBytes)
    } else {
      raw[off] = 0
      raw.set(row.subarray(0, rowBytes), off + 1)
    }
  }
  const idat = zlibWrap(deflateRaw(raw), raw)

  const ihdr = new Uint8Array(13)
  ihdr[0] = (width >>> 24) & 0xff
  ihdr[1] = (width >>> 16) & 0xff
  ihdr[2] = (width >>> 8) & 0xff
  ihdr[3] = width & 0xff
  ihdr[4] = (height >>> 24) & 0xff
  ihdr[5] = (height >>> 16) & 0xff
  ihdr[6] = (height >>> 8) & 0xff
  ihdr[7] = height & 0xff
  ihdr[8] = bitDepth
  ihdr[9] = colorType
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const parts = [new Uint8Array(PNG_SIG), pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array(0))]
  let total = 0
  parts.forEach((p) => (total += p.length))
  const out = new Uint8Array(total)
  let off = 0
  parts.forEach((p) => {
    out.set(p, off)
    off += p.length
  })
  return out
}

// ---------- CCITT G3/G4 传真解码（黑白扫描件最常见） ----------
const CCITT_WHITE_TERM = [
  '00110101', '000111', '0111', '1000', '1011', '1100', '1110', '1111',
  '10011', '10100', '00111', '01000', '001000', '000011', '110100', '110101',
  '101010', '101011', '0100111', '0001100', '0001000', '0010111', '0000011', '0000100',
  '0101000', '0101011', '0010011', '0100100', '0011000', '00000010', '00000011', '00011010',
  '00011011', '00010010', '00010011', '00010100', '00010101', '00010110', '00010111', '00101000',
  '00101001', '00101010', '00101011', '00101100', '00101101', '00000100', '00000101', '00001010',
  '00001011', '01010010', '01010011', '01010100', '01010101', '00100100', '00100101', '01011000',
  '01011001', '01011010', '01011011', '01001010', '01001011', '00110010', '00110011', '00110100',
]

const CCITT_BLACK_TERM = [
  '0000110111', '010', '11', '10', '011', '0011', '0010', '00011',
  '000101', '000100', '0000100', '0000101', '0000111', '00000100', '00000111', '000011000',
  '0000010111', '0000011000', '0000001000', '00001100111', '00001101000', '00001101100', '00000110111', '00000101000',
  '00000010111', '00000011000', '000011001010', '000011001011', '000011001100', '000011001101', '000001101000', '000001101001',
  '000001101010', '000001101011', '000011010010', '000011010011', '000011010100', '000011010101', '000011010110', '000011010111',
  '000001101100', '000001101101', '000011011010', '000011011011', '000001010100', '000001010101', '000001010110', '000001010111',
  '000001100100', '000001100101', '000001010010', '000001010011', '000000100100', '000000110111', '000000111000', '000000100111',
  '000000101000', '000001011000', '000001011001', '000000101011', '000000101100', '000001011010', '000001100110', '000001100111',
]

const CCITT_MAKEUP = [
  [64, '11011', '0000001111'],
  [128, '10010', '000011001000'],
  [192, '010111', '000011001001'],
  [256, '0110111', '000001011011'],
  [320, '00110110', '000000110011'],
  [384, '00110111', '000000110100'],
  [448, '01100100', '000000110101'],
  [512, '01100101', '0000001101100'],
  [576, '01101000', '0000001101101'],
  [640, '01100111', '0000001001010'],
  [704, '011001100', '0000001001011'],
  [768, '011001101', '0000001001100'],
  [832, '011010010', '0000001001101'],
  [896, '011010011', '0000001110010'],
  [960, '011010100', '0000001110011'],
  [1024, '011010101', '0000001110100'],
  [1088, '011010110', '0000001110101'],
  [1152, '011010111', '0000001110110'],
  [1216, '011011000', '0000001110111'],
  [1280, '011011001', '0000001010010'],
  [1344, '011011010', '0000001010011'],
  [1408, '011011011', '0000001010100'],
  [1472, '010011000', '0000001010101'],
  [1536, '010011001', '0000001011010'],
  [1600, '010011010', '0000001011011'],
  [1664, '011000', '0000001100100'],
  [1728, '010011011', '0000001100101'],
  [1792, '00000001000', '00000001000'],
  [1856, '00000001100', '00000001100'],
  [1920, '00000001101', '00000001101'],
  [1984, '000000010010', '000000010010'],
  [2048, '000000010011', '000000010011'],
  [2112, '000000010100', '000000010100'],
  [2176, '000000010101', '000000010101'],
  [2240, '000000010110', '000000010110'],
  [2304, '000000010111', '000000010111'],
  [2368, '000000011100', '000000011100'],
  [2432, '000000011101', '000000011101'],
  [2496, '000000011110', '000000011110'],
  [2560, '000000011111', '000000011111'],
]

let CCITT_TRIES = null

function trieAdd(root, code, payload) {
  let node = root
  for (let i = 0; i < code.length; i++) {
    const bit = code[i]
    if (!node[bit]) node[bit] = {}
    node = node[bit]
  }
  node.v = payload
}

/**
 * 白行程表、黑行程表、2D 模式表必须各自成树。
 * 三套码表合并成一棵会出错：例如黑行程 11 是白行程 1100 的前缀，
 * 解码白行程时会停在黑行程的叶子上，从而整块数据错位。
 */
function buildCCITTTries() {
  const white = {}
  const black = {}
  CCITT_WHITE_TERM.forEach((c, i) => trieAdd(white, c, { run: i }))
  CCITT_BLACK_TERM.forEach((c, i) => trieAdd(black, c, { run: i }))
  CCITT_MAKEUP.forEach(([len, w, b]) => {
    trieAdd(white, w, { run: len })
    trieAdd(black, b, { run: len })
  })
  const mode = {}
  trieAdd(mode, '1', { mode: 'V', d: 0 })
  trieAdd(mode, '011', { mode: 'V', d: 1 })
  trieAdd(mode, '000011', { mode: 'V', d: 2 })
  trieAdd(mode, '0000011', { mode: 'V', d: 3 })
  trieAdd(mode, '010', { mode: 'V', d: -1 })
  trieAdd(mode, '000010', { mode: 'V', d: -2 })
  trieAdd(mode, '0000010', { mode: 'V', d: -3 })
  trieAdd(mode, '001', { mode: 'H' })
  trieAdd(mode, '0001', { mode: 'P' })
  trieAdd(mode, '0000001', { mode: 'EXT' })
  return { white, black, mode }
}

function bitReader(data) {
  let pos = 0
  let bitAt = 0
  return {
    read() {
      if (pos >= data.length) return -1
      const b = (data[pos] >> (7 - bitAt)) & 1
      if (++bitAt === 8) {
        bitAt = 0
        pos++
      }
      return b
    },
    alignByte() {
      if (bitAt !== 0) {
        bitAt = 0
        pos++
      }
    },
    eof() {
      return pos >= data.length
    },
    position() {
      return pos
    },
  }
}

function readRun(br, tries, black) {
  const trie = black ? tries.black : tries.white
  let total = 0
  for (let iter = 0; iter < 8; iter++) {
    let node = trie
    let depth = 0
    for (;;) {
      if (node.v !== undefined) break
      const b = br.read()
      if (b < 0) return -1
      node = node[b ? '1' : '0']
      if (!node || ++depth > 14) return -1
    }
    const v = node.v
    if (!v) return -1
    total += v.run
    // 构成码（>=64）后面必须再接一个终止码
    if (v.run < 64) return total
  }
  return -1
}

function read2D(br, modeTrie) {
  let node = modeTrie
  let depth = 0
  for (;;) {
    if (node.v !== undefined && node.v.mode) return node.v
    const b = br.read()
    if (b < 0) return null
    node = node[b ? '1' : '0']
    if (!node || ++depth > 12) return null
  }
}

/** 一行的变化点（变化元素）列表：偶索引 = 白→黑，奇索引 = 黑→白 */
function changesOf(row, columns) {
  const chg = []
  let prev = 0
  for (let x = 0; x < columns; x++) {
    const b = row[x]
    if (b !== prev) {
      chg.push(x)
      prev = b
    }
  }
  if (chg.length & 1) chg.push(columns)
  return chg
}

/**
 * 解码 CCITT G3/G4。
 *
 * 关于颜色起点（关键，且与直觉相反）：T.4 规定每行首个行程是「白」，但真实 PDF 里
 * 生成器（如 libtiff / Pillow）会按 TIFF 光度学约定写，把首个行程编成黑色；
 * 渲染器并不傻看 T.4，而是用 /BlackIs1 决定每行的起始颜色。四种参数组合拿
 * 真实渲染器（PDFium）实测的结果是：
 *   BlackIs1=true  且无 /Decode      -> 起始色=黑，正向
 *   BlackIs1=true  且 /Decode [1 0]  -> 起始色=黑，再整体反色
 *   BlackIs1=false 且无 /Decode      -> 起始色=白，整体反相（黑白颠倒）
 *   BlackIs1=false 且 /Decode [1 0]  -> 起始色=白，再整体反色，正向
 * 因此这里以 /BlackIs1 作为起始色，得到的位图 =「显示意义上的黑」（bit=1），
 * /Decode 的反色交由调用方处理。
 */
function decodeCCITT(data, parms) {
  const tries = CCITT_TRIES || (CCITT_TRIES = buildCCITTTries())
  // DecodeParms 是解析出来的字典：常量被包成 {num:n}/{bool:b}，必须先归一
  const columnsRaw = numOf(parms && parms.Columns, 1728)
  const columns = columnsRaw > 0 ? Math.floor(columnsRaw) : 1728
  const totalRows = Math.floor(numOf(parms && parms.Rows, 0))
  const k = numOf(parms && parms.K, 0)
  const byteAlign = boolOf(parms && parms.EncodedByteAlign)
  const needEol = boolOf(parms && parms.EndOfLine)
  const br = bitReader(data)

  const rowBytes = Math.ceil(columns / 8)
  const maxRows = totalRows > 0 ? totalRows : 20000
  const bits = new Uint8Array(rowBytes * maxRows)

  const row = new Uint8Array(columns)
  let refChanges = []
  let height = 0
  let since2D = k > 0 ? k : 0 // K>0（G3 混合）时首行必须是 1D
  let failed = false

  for (let y = 0; y < maxRows; y++) {
    if (br.eof()) break
    row.fill(0)
    let ok = false
    const want1D = k === 0 || (k > 0 && since2D >= k - 1)
    if (want1D) {
      since2D = 0
      if (needEol) skipEOL(br)
      ok = decode1DLine(br, tries, row, columns)
    } else {
      since2D++
      ok = decode2DLine(br, tries, row, columns, refChanges)
    }
    if (!ok) {
      failed = true
      break
    }
    if (byteAlign) br.alignByte()
    refChanges = changesOf(row, columns)
    const base = y * rowBytes
    for (let x = 0; x < columns; x++) {
      if (row[x]) bits[base + (x >> 3)] |= 1 << (7 - (x & 7))
    }
    height++
  }

  return { width: columns, height, rowBytes, bits, ok: height > 0 && (!failed || height > 1), incomplete: failed }
}

/** 跳过 EOL（000000000001）；连续 6 个 EOL 表示 RTC，即数据结束 */
function skipEOL(br) {
  let zeros = 0
  for (let i = 0; i < 64; i++) {
    const b = br.read()
    if (b < 0) return
    if (b === 0) {
      zeros++
      continue
    }
    if (zeros >= 11) return
    zeros = 0
  }
}

function decode1DLine(br, tries, row, columns) {
  let pos = 0
  let black = false
  let guard = 0
  let stalls = 0
  while (pos < columns) {
    if (++guard > columns + 64) return false
    const run = readRun(br, tries, black)
    if (run < 0) return false
    if (run === 0) {
      // 零长行程是合法的，但连续多次意味着数据已经不同步
      if (++stalls > 4) return false
    } else {
      stalls = 0
    }
    if (black && run > 0) {
      const end = Math.min(columns, pos + run)
      row.fill(1, pos, end)
    }
    pos += run
    black = !black
  }
  return true
}

function decode2DLine(br, tries, row, columns, refChanges) {
  let a0 = 0
  let colour = 0 // 0=白 1=黑（T.4 规范：每行自白起始）
  let first = true
  let scan = 0 // 参考行变化点搜索起点（a0 单调不减，可只前进）
  let guard = 0

  for (;;) {
    if (a0 >= columns) return true
    if (++guard > columns + 128) return false
    const code = read2D(br, tries.mode)
    if (!code) return false
    if (code.mode === 'EXT') return false // 未定义扩展，无法继续

    // 找 b1：参考行上 > a0（首轮 >= a0）且奇偶与当前颜色匹配的变化点
    const parity = colour
    let idx = scan
    if ((idx & 1) !== parity) idx++
    let b1 = columns
    let b2 = columns
    while (idx < refChanges.length) {
      const p = refChanges[idx]
      if (p > a0 || (first && p >= a0)) {
        b1 = p
        b2 = idx + 1 < refChanges.length ? refChanges[idx + 1] : columns
        scan = idx
        break
      }
      idx += 2
    }
    if (b1 === columns) {
      b2 = columns
      scan = refChanges.length
    }
    first = false

    if (code.mode === 'P') {
      row.fill(colour, a0, Math.min(b2, columns))
      a0 = b2
    } else if (code.mode === 'H') {
      const r1 = readRun(br, tries, colour === 1)
      if (r1 < 0) return false
      if (colour && r1 > 0) row.fill(1, a0, Math.min(columns, a0 + r1))
      a0 = Math.min(columns, a0 + r1)
      const r2 = readRun(br, tries, colour === 0)
      if (r2 < 0) return false
      if (!colour && r2 > 0) row.fill(1, a0, Math.min(columns, a0 + r2))
      a0 = Math.min(columns, a0 + r2)
    } else {
      let target = b1 + code.d
      if (target > columns) target = columns
      if (target < a0) target = a0
      if (colour && target > a0) row.fill(1, a0, target)
      a0 = target
      colour = colour ? 0 : 1
    }
  }
}

// ---------- 原始位图 -> PNG ----------
function clampByte(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0
}

/**
 * 用 /BlackIs1 与 /Decode 把「T.4 黑行程」映射成灰度样本值。
 * 极性规则经真实渲染器（PDFium）实测确认：
 *   BlackIs1 为真且无 Decode 时，黑行程就是黑（绝大多数扫描件即此情形）。
 */
function polarityOf(blackIs1, decode) {
  const d0 = Array.isArray(decode) && typeof decode[0] === 'number' ? decode[0] : 0
  const d1 = Array.isArray(decode) && typeof decode[1] === 'number' ? decode[1] : 1
  return { blackIs1: !!blackIs1, invert: d1 < d0 }
}

/**
 * CCITT 位图 -> 1bit 灰度 PNG。
 *
 * decodeCCITT 给出的 bits 沿用 T.4/TIFF 惯例（1 = 黑）。PDF 的 CCITTFaxDecode
 * 默认（BlackIs1 为假）要求 1 = 白，因此默认要整体反色；BlackIs1 为真时反而不反。
 * /Decode [1 0] 再叠加一次反色。
 *   invert = (!BlackIs1) XOR DecodeInverted
 * 该式在 BlackIs1 × Decode 的四种组合上均与 PDFium 实际渲染逐像素一致，
 * 故不再使用「黑得离谱就反色」之类的猜测式兜底（那会把本就深色的页面判错）。
 *
 * @param {object} packed decodeCCITT 的结果
 * @param {boolean} invert 是否整体反色
 */
function ccittToPNG(packed, invert) {
  const { width, height, rowBytes, bits } = packed
  const out = new Uint8Array(rowBytes)
  return encodePNG(width, height, 1, 0, (y) => {
    for (let i = 0; i < rowBytes; i++) {
      // PNG 灰度语义：样本 0 = 黑，1 = 白
      let v = bits[y * rowBytes + i]
      if (invert) v = ~v & 0xff
      out[i] = v
    }
    return out
  })
}

/** 原始样本 -> PNG（灰度/RGB + Indexed），按 /Decode 与 BitDepth 归一 */
function rawToPNG(raw, dict, decode) {
  const width = dict.Width.num || dict.Width || 0
  const height = dict.Height.num || dict.Height || 0
  const bpc = dict.BitsPerComponent ? dict.BitsPerComponent.num : 8
  const csName = colorSpaceName(dict.ColorSpace)
  const { invert } = polarityOf(true, decode)

  if (csName === 'indexed') {
    const pal = indexedPalette(dict.ColorSpace)
    const bpp = bpc || 8
    const rowBytes = Math.ceil((width * bpp) / 8)
    const rgb = new Uint8Array(width * 3)
    return encodePNG(width, height, 8, 2, (y) => {
      const row = raw.subarray(y * rowBytes, (y + 1) * rowBytes)
      for (let x = 0; x < width; x++) {
        let idx = 0
        if (bpp === 8) idx = row[x]
        else if (bpp === 4) idx = (row[x >> 1] >> (x & 1 ? 0 : 4)) & 0x0f
        else if (bpp === 2) idx = (row[x >> 2] >> (6 - 2 * (x & 3))) & 0x03
        else idx = (row[x >> 3] >> (7 - (x & 7))) & 0x01
        const off = idx * 3
        rgb[x * 3] = pal[off] || 0
        rgb[x * 3 + 1] = pal[off + 1] || 0
        rgb[x * 3 + 2] = pal[off + 2] || 0
      }
      return rgb
    })
  }

  if (bpc === 1) {
    const rowBytes = Math.ceil(width / 8)
    const out = new Uint8Array(rowBytes)
    return encodePNG(width, height, 1, 0, (y) => {
      const row = raw.subarray(y * rowBytes, (y + 1) * rowBytes)
      for (let i = 0; i < rowBytes; i++) out[i] = invert ? ~row[i] & 0xff : row[i]
      return out
    })
  }

  if (csName === 'rgb') {
    const rowLen = width * 3
    const out = new Uint8Array(rowLen)
    return encodePNG(width, height, 8, 2, (y) => {
      const row = raw.subarray(y * rowLen, (y + 1) * rowLen)
      if (!invert) return row
      for (let i = 0; i < rowLen; i++) out[i] = 255 - row[i]
      return out
    })
  }

  const rowLen = width
  const out = new Uint8Array(rowLen)
  return encodePNG(width, height, 8, 0, (y) => {
    const row = raw.subarray(y * rowLen, (y + 1) * rowLen)
    if (!invert) return row
    for (let i = 0; i < rowLen; i++) out[i] = 255 - row[i]
    return out
  })
}

/** 解析 /ColorSpace，归一成 rgb / gray / indexed / other */
function colorSpaceName(cs) {
  const name = nameOf(cs)
  if (name) {
    if (name === 'DeviceRGB') return 'rgb'
    if (name === 'DeviceGray' || name === 'CalGray') return 'gray'
    if (name === 'DeviceCMYK' || name === 'CalRGB') return 'other'
    return name
  }
  const arr = cs && cs.arr ? cs.arr : null
  if (arr && arr.length) {
    const head = nameOf(arr[0])
    if (head === 'Indexed' || head === 'I') return 'indexed'
    if (head === 'ICCBased' || head === 'DeviceN' || head === 'Separation') return 'other'
    if (head === 'CalRGB' || head === 'Lab') return 'other'
  }
  return 'gray'
}

function indexedPalette(cs) {
  const arr = cs && cs.arr ? cs.arr : []
  // [/Indexed base hival lookup]：查表既可能是字符串，也可能是另一个流（此处只处理字符串）
  const raw = arr[3]
  if (!raw) return new Uint8Array(0)
  if (raw.str) return raw.str
  if (raw.name === 'DeviceRGB' || raw.name === 'DeviceGray') return new Uint8Array(0)
  return new Uint8Array(0)
}

// ---------- 页面上的图像对象定位 ----------
/** 页面框（MediaBox，允许从父节点继承） */
function pageBox(objects, entry) {
  let node = entry.page
  for (let depth = 0; depth < 8 && node; depth++) {
    const dict = node.dict || {}
    const box = dict.MediaBox || dict.CropBox
    if (box && box.arr && box.arr.length >= 4) {
      const nums = box.arr.map((v) => (v && typeof v.num === 'number' ? v.num : 0))
      const w = Math.abs(nums[2] - nums[0])
      const h = Math.abs(nums[3] - nums[1])
      if (w > 1 && h > 1) return { w, h }
    }
    const parent = resolve(objects, dict.Parent)
    node = parent && parent.num !== node.num ? parent : null
  }
  return { w: 595, h: 842 }
}

const IDENTITY = [1, 0, 0, 1, 0, 0]

function matMul(m, n) {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ]
}

/** 扫页面内容流，记录每个图像 XObject 出现的 CTM（含 Form 递归） */
function collectPageImages(data, ctx, depth, ctm, out) {
  const p = new Parser(data, 0, data.length)
  const stack = []
  const gsStack = []
  let cur = ctm
  while (p.i < p.end) {
    p.skipWs()
    if (p.i >= p.end) break
    const c = data[p.i]
    if (c === 0x2f) {
      stack.push({ name: p.parseName() })
      continue
    }
    if (c === 0x28) {
      stack.push({ str: p.parseLiteralString() })
      continue
    }
    if (c === 0x5b) {
      stack.push(p.parseValue() || { arr: [] })
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
      stack.push(p.parseValue())
      continue
    }
    const start = p.i
    while (p.i < p.end && !isWhite(data[p.i]) && !isDelim(data[p.i])) p.i++
    const op = latin1(data, start, p.i)
    if (!op) {
      p.i++
      continue
    }
    if (op === 'q') {
      gsStack.push(cur)
    } else if (op === 'Q') {
      cur = gsStack.length ? gsStack.pop() : ctm
    } else if (op === 'cm') {
      const nums = []
      for (let i = stack.length - 1; i >= 0 && nums.length < 6; i--) {
        const v = stack[i]
        if (v && typeof v.num === 'number') nums.unshift(v.num)
        else break
      }
      if (nums.length === 6) cur = matMul(nums, cur) // CTM' = 新矩阵 × 旧 CTM（cm 语义，顺序不能反）
    } else if (op === 'Do') {
      let name = ''
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i] && stack[i].name !== undefined) {
          name = stack[i].name
          break
        }
      }
      const xobj = ctx.xobjects && ctx.xobjects[name]
      if (xobj && xobj.dict) {
        const subType = nameOf(xobj.dict.Subtype)
        if (subType === 'Image') {
          out.push({ xobj, ctm: cur.slice() })
        } else if (subType === 'Form' && depth < 3) {
          let subData = null
          try {
            subData = decodeStream(xobj, ctx.budget)
          } catch (e) {
            subData = null
          }
          if (subData) {
            const mtx = xobj.dict.Matrix && xobj.dict.Matrix.arr
              ? xobj.dict.Matrix.arr.map((v) => (v && typeof v.num === 'number' ? v.num : 0))
              : null
            // Form 的 /Matrix 先作用于表单坐标，再叠加外层 CTM：/Matrix × CTM
            const next = mtx && mtx.length === 6 ? matMul(mtx, cur) : cur
            collectPageImages(subData, {
              objects: ctx.objects,
              budget: ctx.budget,
              resources: xobj.dict.Resources || ctx.resources,
              xobjects: readXObjectMap(ctx.objects, xobj.dict.Resources || ctx.resources),
            }, depth + 1, next, out)
          }
        }
      }
    }
    stack.length = 0
  }
}

/** 通用解压链：把 xref/流解码里已实现的逐个用上，遇到图像编码器就停下 */
function decodeUntilImageCodec(obj, budget) {
  const filters = filtersOf(obj.dict)
  const parmsRaw = obj.dict.DecodeParms
  const parms = []
  if (parmsRaw && parmsRaw.arr) parmsRaw.arr.forEach((p) => parms.push(p && p.dict ? p.dict : null))
  else if (parmsRaw && parmsRaw.dict) parms.push(parmsRaw.dict)

  let data = obj.stream
  for (let i = 0; i < filters.length; i++) {
    const f = filters[i]
    const pd = parms[i] || parms[0] || null
    const isLast = i === filters.length - 1
    if (f === 'DCTDecode' || f === 'DCT') {
      return isLast ? { kind: 'jpeg', data, parms: pd } : { error: 'unsupported_chain' }
    }
    if (f === 'JPXDecode') return { error: 'jpx' }
    if (f === 'JBIG2Decode') return { error: 'jbig2' }
    if (f === 'CCITTFaxDecode' || f === 'CCF') {
      return isLast ? { kind: 'ccitt', data, parms: pd } : { error: 'unsupported_chain' }
    }
    try {
      if (f === 'FlateDecode' || f === 'Fl') {
        const inflated = inflate(data, Math.min(MAX_INFLATE_STREAM, budget.limit - budget.used))
        budget.used += inflated.length
        if (budget.used > budget.limit) return { error: 'budget' }
        data = applyPredictor(inflated, paramNumbers(pd))
      } else if (f === 'LZWDecode' || f === 'LZW') {
        const dec = lzwDecode(data, pd && typeof pd.EarlyChange === 'number' ? pd.EarlyChange : 1, Math.min(MAX_INFLATE_STREAM, budget.limit - budget.used))
        budget.used += dec.length
        data = applyPredictor(dec, paramNumbers(pd))
      } else if (f === 'ASCIIHexDecode' || f === 'AHx') {
        data = asciiHex(data)
      } else if (f === 'ASCII85Decode' || f === 'A85') {
        data = ascii85(data)
      } else if (f === 'RunLengthDecode' || f === 'RL') {
        data = runLength(data)
      } else {
        return { error: 'filter:' + f }
      }
    } catch (e) {
      return { error: 'decode_failed' }
    }
  }
  return { kind: 'raw', data }
}

/** RunLengthDecode（PackBits） */
function runLength(data) {
  const out = []
  let i = 0
  while (i < data.length) {
    const n = data[i++]
    if (n === 128) break
    if (n < 128) {
      for (let k = 0; k <= n && i < data.length; k++) out.push(data[i++])
    } else {
      const b = data[i++]
      for (let k = 0; k < 257 - n; k++) out.push(b)
    }
  }
  return Uint8Array.from(out)
}

/**
 * 抽取 PDF 页面里的页面级图像，并转成可直接喂给多模态模型的 JPEG/PNG。
 *
 * @param {ArrayBuffer|Uint8Array} input
 * @param {{maxPages?:number, maxImages?:number, minCoverage?:number, maxBytesPerImage?:number}} [options]
 * @returns {{images:Array, pageCount:number, skipped:Object, encrypted:boolean, reason:string}}
 */
/** 解析结果里的数值/布尔常量（解析器把常量包成 {num:n} / {bool:b}），统一归一 */
function numOf(value, fallback) {
  if (typeof value === 'number') return value
  if (value && typeof value.num === 'number') return value.num
  return fallback
}

function boolOf(value) {
  if (typeof value === 'boolean') return value
  if (value && typeof value.bool === 'boolean') return value.bool
  return false
}

function extractPdfImages(input, options) {
  const opts = options || {}
  const maxPages = opts.maxPages || 40
  const maxImages = opts.maxImages || 16
  const minCoverage = typeof opts.minCoverage === 'number' ? opts.minCoverage : 0.25
  const maxBytesPerImage = opts.maxBytesPerImage || 2.6 * 1024 * 1024

  const result = {
    images: [],
    pageCount: 0,
    scannedPages: 0,
    skipped: { jpx: 0, jbig2: 0, chain: 0, tooBig: 0, decode: 0, budget: 0 },
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

  const limit = Math.min(pages.length, maxPages)
  if (pages.length > limit) result.limited = true

  for (let pi = 0; pi < limit; pi++) {
    if (result.images.length >= maxImages) {
      result.limited = true
      break
    }
    const entry = pages[pi]
    const resources = entry.resources || entry.page.dict.Resources
    let found = []
    try {
      const contents = entry.page.dict.Contents
      const list = contents && contents.arr ? contents.arr : [contents]
      const chunks = []
      list.forEach((c) => {
        const obj = resolve(objects, c)
        if (!obj || !obj.stream) return
        try {
          const d = decodeStream(obj, budget)
          if (d) chunks.push(d)
        } catch (e) {
          /* 单段内容流失败不影响其它段 */
        }
      })
      if (chunks.length) {
        let total = 0
        chunks.forEach((c) => (total += c.length))
        const data = new Uint8Array(total)
        let off = 0
        chunks.forEach((c) => {
          data.set(c, off)
          off += c.length
        })
        collectPageImages(data, {
          objects,
          budget,
          resources,
          xobjects: readXObjectMap(objects, resources),
        }, 0, IDENTITY, found)
      }
    } catch (e) {
      found = []
    }
    if (!found.length) continue

    const box = pageBox(objects, entry)
    const pageArea = Math.max(1, box.w * box.h)
    const rotate = (function () {
      const r = entry.page.dict.Rotate
      const n = r && typeof r.num === 'number' ? r.num : 0
      return ((Math.round(n / 90) % 4) + 4) % 4
    })()

    // 按「在页面上占多大」排序，过滤掉 logo、装饰图这类噪音
    const cands = found
      .map((f) => {
        const dict = f.xobj.dict
        const w = Number(dict.Width && dict.Width.num) || 0
        const h = Number(dict.Height && dict.Height.num) || 0
        const dispW = Math.sqrt(f.ctm[0] * f.ctm[0] + f.ctm[1] * f.ctm[1])
        const dispH = Math.sqrt(f.ctm[2] * f.ctm[2] + f.ctm[3] * f.ctm[3])
        const coverage = Math.min(1.5, (dispW * dispH) / pageArea)
        // 图像在页面上的旋转角（图像 +x 轴相对页面水平方向的偏转）
        const angle = Math.atan2(f.ctm[1], f.ctm[0])
        // 设备坐标 y 向下，用户空间的逆时针角在屏幕上看是反的：
        // 要还原渲染效果，需把光栅顺时针转 -angle。六个方向样本实测确认。
        let quarter = (-Math.round(angle / (Math.PI / 2))) % 4
        if (quarter < 0) quarter += 4
        return { xobj: f.xobj, dict, w, h, dispW, dispH, coverage, quarter, pixels: w * h, ctm: f.ctm }
      })
      .filter((c) => c.w > 0 && c.h > 0 && c.pixels > 1000)

    let keep = cands.filter((c) => c.coverage >= minCoverage)
    if (!keep.length) {
      // 兜底：内容流里没写 cm 时算子坐标会失真（覆盖率趋近 0）。
      // 只有在这种「明显不是正常排版」的情况下才放宽，否则会把正文里的插图当页面图。
      const biggest = cands.slice().sort((a, b) => b.pixels - a.pixels)[0]
      if (biggest && biggest.coverage < 0.05 && biggest.pixels >= 120000) keep = [biggest]
    }
    keep.sort((a, b) => b.coverage - a.coverage)
    if (keep.length) result.scannedPages++

    for (let k = 0; k < keep.length; k++) {
      if (result.images.length >= maxImages) {
        result.limited = true
        break
      }
      const item = keep[k]
      let decoded
      try {
        decoded = decodeUntilImageCodec(item.xobj, budget)
      } catch (e) {
        result.skipped.decode++
        continue
      }
      if (!decoded || decoded.error) {
        const err = (decoded && decoded.error) || 'decode'
        if (err === 'jpx') result.skipped.jpx++
        else if (err === 'jbig2') result.skipped.jbig2++
        else if (err === 'budget') result.skipped.budget++
        else if (String(err).indexOf('chain') >= 0) result.skipped.chain++
        else result.skipped.decode++
        continue
      }
      let out = null
      let format = ''
      try {
        if (decoded.kind === 'jpeg') {
          out = decoded.data
          format = 'jpeg'
        } else if (decoded.kind === 'ccitt') {
          const packed = decodeCCITT(decoded.data, decoded.parms || {})
          if (!packed.height) {
            result.skipped.decode++
            continue
          }
          const dec = item.dict.Decode && item.dict.Decode.arr
            ? item.dict.Decode.arr.map((v) => numOf(v, 0))
            : null
          const invertedDecode = !!dec && dec.length >= 2 && dec[1] < dec[0]
          // invert = (!BlackIs1) XOR Decode 反色 —— 四种参数组合均与 PDFium 实测一致
          const blackIs1 = boolOf(decoded.parms && decoded.parms.BlackIs1)
          out = ccittToPNG(packed, !blackIs1 !== invertedDecode)
          format = 'png'
        } else {
          const csName = colorSpaceName(item.dict.ColorSpace)
          if (csName === 'other') {
            result.skipped.decode++
            continue
          }
          const bpc = item.dict.BitsPerComponent ? item.dict.BitsPerComponent.num : 8
          const expected =
            csName === 'indexed'
              ? Math.ceil((item.w * (bpc || 8)) / 8) * item.h
              : csName === 'rgb'
                ? item.w * item.h * 3 * (bpc / 8)
                : Math.ceil((item.w * item.h * bpc) / 8)
          if (decoded.data.length < expected) {
            result.skipped.decode++
            continue
          }
          out = rawToPNG(decoded.data, item.dict, item.dict.Decode && item.dict.Decode.arr ? item.dict.Decode.arr.map((v) => (v && v.num) || 0) : null)
          format = 'png'
        }
      } catch (e) {
        result.skipped.decode++
        continue
      }
      if (!out || !out.length) {
        result.skipped.decode++
        continue
      }
      if (out.length > maxBytesPerImage) {
        result.skipped.tooBig++
        continue
      }
      result.images.push({
        pageIndex: pi,
        width: item.w,
        height: item.h,
        format,
        mime: format === 'jpeg' ? 'image/jpeg' : 'image/png',
        bytes: out,
        byteLength: out.length,
        coverage: item.coverage,
        quarter: item.quarter,
        pageRotate: rotate,
        rotation: (item.quarter + rotate) % 4,
        ctm: item.ctm,
        dispW: item.dispW,
        dispH: item.dispH,
      })
    }
  }

  if (!result.images.length && !result.reason) {
    if (result.encrypted) result.reason = 'encrypted'
    else if (result.skipped.jpx || result.skipped.jbig2) result.reason = 'unsupported_codec'
    else result.reason = 'no_page_image'
  }
  return result
}

// ---------- 旋转纠正 ----------
/** 把像素行缓冲按 90° 倍数旋转（quarter = 顺时针 90° 的次数） */
function rotateRows(srcRows, srcW, srcH, quarter) {
  const q = ((quarter % 4) + 4) % 4
  if (q === 0) return { rows: srcRows, width: srcW, height: srcH, transpose: false }
  const transposed = q % 2 === 1
  const outW = transposed ? srcH : srcW
  const outH = transposed ? srcW : srcH
  const rowLen = srcRows[0].length
  const outRows = []
  for (let y = 0; y < outH; y++) outRows.push(new Uint8Array(rowLen))
  for (let y = 0; y < srcH; y++) {
    const row = srcRows[y]
    for (let x = 0; x < srcW; x++) {
      const v = row[x]
      let nx
      let ny
      if (q === 1) {
        nx = srcH - 1 - y
        ny = x
      } else if (q === 2) {
        nx = srcW - 1 - x
        ny = srcH - 1 - y
      } else {
        nx = y
        ny = srcW - 1 - x
      }
      outRows[ny][nx] = v
    }
  }
  return { rows: outRows, width: outW, height: outH, transpose: transposed }
}

module.exports = {
  extractPdfText,
  extractPdfImages,
  rotateRows,
  // 供测试与复用
  _internals: {
    inflate,
    deflateRaw,
    lzwDecode,
    scanObjects,
    parseToUnicode,
    decodeWithEncoding,
    glyphToUnicode,
    applyPredictor,
    ascii85,
    asciiHex,
    runLength,
    resolve,
    dictOf,
    filtersOf,
    readXObjectMap,
    collectPages,
    decodeUntilImageCodec,
    Parser,
    encodePNG,
    crc32,
    adler32,
    decodeCCITT,
    bitReader,
    buildCCITTTries,
    colorSpaceName,
    pageBox,
    matMul,
    collectPageImages,
    polarityOf,
  },
}
