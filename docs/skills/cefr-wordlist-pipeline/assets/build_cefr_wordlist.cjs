/**
 * 从 FLELex（定级）+ Lexique383（词形/音标/词性/性别）构建 B1 词条底表。
 *
 * 两个源的分工：
 *   - FLELex：只说「这个词最典型属于哪一级」，没有音标、没有中文；
 *   - Lexique383：有 IPA（phon）、音节切分（syll）、词性（cgram）、性别（genre）、
 *     频率，以及 lemme / islem 可以判断「这个形本身是不是原形」。
 *
 * 三个必须踩对的坑（都实测验证过）：
 *   1) Lexique383 官方发布文件是 **latin-1** 编码，不是 UTF-8。按 UTF-8 读会把所有
 *      重音字母变成替换字符，于是 435 个带重音的词全部匹配不上（第一版就是这样挂的）。
 *   2) phon 列用的不是标准 IPA，是 Lexique 自己的 ASCII 音素表：
 *      R=ʁ S=ʃ Z=ʒ E=ɛ O=ɔ 2=ø 9=œ 8=ɥ @=ɑ̃ §=ɔ̃ 5=ɛ̃ 1=œ̃ N=ɲ G=ŋ °=ə y=y。
 *      直接拿来当音标展示是错的，必须过一遍映射。
 *   3) 同形词必须按 FLELex 的词性标签消歧：`firme` 既是名词 firme 也是动词 firmer 的变形，
 *      `tu` 既是代词也是 taire 的变形，纯按频率取会把词条整个弄错。
 *
 * 输出 <LEVEL>_base.tsv：word  pos  ipa  freq  gender  notes
 *
 * 用法：LEVEL=B2 node build_cefr_wordlist.cjs     （默认 B1）
 * 需要同目录下有两个数据文件：FleLex_TT_Beacco.tsv、Lexique383.tsv
 */
const fs = require('fs')
const path = require('path')

const LEVEL = String(process.env.LEVEL || 'B1').toUpperCase() // A1/A2/B1/B2/C1/C2

const DIR = __dirname
const FLELEX = path.join(DIR, 'FleLex_TT_Beacco.tsv')
const LEXIQUE = path.join(DIR, 'Lexique383.tsv')
const OUT = path.join(DIR, LEVEL.toLowerCase() + '_base.tsv')
const OUT_REPORT = path.join(DIR, LEVEL.toLowerCase() + '_report.txt')

const report = []
function log(s) {
  report.push(s)
  console.log(s)
}

// ---------------- 音素表（Lexique ASCII → 标准 IPA）----------------
// 建表依据：把 phon 列出现的全部 39 个字符枚举出来，再用一批发音确定的法语词
// （tu/dur/sur → y；huit/lui/nuit → ɥ；bon/montagne → ɔ̃；temps/enfant → ɑ̃；
//   vin/pain/symphonie → ɛ̃；brun → œ̃；jeu/deux/noeud → ø；fleur/soeur/oeil → œ；
//   agneau/montagne → ɲ；parking → ŋ；famille/travail → j）逐个反推。
const PHON_MAP = {
  R: 'ʁ', S: 'ʃ', Z: 'ʒ', N: 'ɲ', G: 'ŋ',
  E: 'ɛ', O: 'ɔ', A: 'ɑ',
  2: 'ø', 9: 'œ', 8: 'ɥ', 1: 'œ̃',
  '@': 'ɑ̃', '§': 'ɔ̃', '5': 'ɛ̃', '°': 'ə',
  x: 'x', 0: '0', '-': '-', r: 'r',
  // 以下与 IPA 同形，列出只为明确「已确认」
  a: 'a', e: 'e', i: 'i', o: 'o', u: 'u', y: 'y', j: 'j', w: 'w',
  p: 'p', b: 'b', t: 't', d: 'd', k: 'k', g: 'g', f: 'f', v: 'v',
  s: 's', z: 'z', m: 'm', n: 'n', l: 'l',
}

/** Lexique ASCII 音标 → 标准 IPA；sep 用于把音节分隔符换成点 */
function toIpa(s, sep) {
  if (!s) return ''
  let out = ''
  let unknown = []
  for (const ch of String(s)) {
    if (ch === '-') {
      out += sep || ''
      continue
    }
    const m = PHON_MAP[ch]
    if (m === undefined) {
      unknown.push(ch)
      out += ch
    } else {
      out += m
    }
  }
  return out + (unknown.length ? '\u0000UNKNOWN:' + unknown.join('') : '')
}

// ---------------- 读 FLELex ----------------
function readFlelex() {
  const lines = fs
    .readFileSync(FLELEX, 'utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter(Boolean)
  return lines.slice(1).map((l) => l.split('\t'))
}

/** 法式小数点：81,36 → 81.36 */
function frNum(s) {
  const t = String(s == null ? '' : s).trim()
  if (!t) return 0
  const v = parseFloat(t.replace(/\s/g, '').replace(',', '.'))
  return isNaN(v) ? 0 : v
}

// ---------------- 读 Lexique383（注意 latin-1）----------------
function readLexique() {
  const raw = fs.readFileSync(LEXIQUE, 'latin1').replace(/^\uFEFF/, '')
  const lines = raw.split(/\r?\n/).filter(Boolean)
  const head = lines[0].split('\t')
  const col = (name) => {
    let i = head.indexOf(name)
    if (i >= 0) return i
    return head.findIndex((h) => h.replace(/^\d+_/, '') === name)
  }
  const idx = {
    ortho: col('ortho'),
    phon: col('phon'),
    lemme: col('lemme'),
    cgram: col('cgram'),
    genre: col('genre'),
    nombre: col('nombre'),
    islem: col('islem'),
    syll: col('syll'),
    freqLemFilm: col('freqlemfilms2'),
    freqLemBook: col('freqlemlivres'),
    freqFilm: col('freqfilms2'),
    freqBook: col('freqlivres'),
  }
  for (const k of Object.keys(idx)) {
    if (idx[k] < 0) throw new Error('Lexique383 缺少列：' + k + '（表头：' + head.join(',') + '）')
  }

  const byOrtho = new Map()
  const byLemme = new Map()
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split('\t')
    const rec = {
      ortho: f[idx.ortho],
      phon: f[idx.phon],
      syll: f[idx.syll],
      lemme: f[idx.lemme] || f[idx.ortho],
      cgram: f[idx.cgram] || '',
      genre: f[idx.genre] || '',
      nombre: f[idx.nombre] || '',
      isLem: f[idx.islem] === '1',
      // 关键：必须用**词形级**频率（freqfilms2/freqlivres）。
      // freqlemfilms2 是**词根级**频率——aller 的全部 42 个变位都写着 9992.77，
      // 拿它比大小等于随机抽，aller 会被抽成 aille 的发音 /aj/。
      freq: frNum(f[idx.freqFilm]) + frNum(f[idx.freqBook]),
      lemFreq: frNum(f[idx.freqLemFilm]) + frNum(f[idx.freqLemBook]),
    }
    let a = byOrtho.get(rec.ortho)
    if (!a) byOrtho.set(rec.ortho, (a = []))
    a.push(rec)
    // lemme 索引必须大小写无关：Lexique 把 vrai 的词根存成大写 VRAI，
    // 按小写查 byLemme('vrai') 会查不到，vrai 就白丢了。
    const lk = rec.lemme.toLowerCase()
    let b = byLemme.get(lk)
    if (!b) byLemme.set(lk, (b = []))
    b.push(rec)
  }
  return { byOrtho, byLemme, head, total: lines.length - 1 }
}

/** 同形词消歧：先看「这个形本身是不是原形」(islem)，再看词性是否与 FLELex 标签同族，
 *  最后才比词形频率。
 *  `firme` 既是名词 firme 也是动词 firmer 的变形，`tu` 既是代词也是 taire 的变形；
 *  只按频率会选错，而频率那一栏还必须用词形级（见 readLexique 里的说明）。 */
function pickBest(list, preferCgram) {
  if (!list || !list.length) return null
  const want = preferCgram ? String(preferCgram).toUpperCase() : ''
  return list
    .slice()
    .sort((a, b) => {
      if (a.isLem !== b.isLem) return a.isLem ? -1 : 1
      const am = want && String(a.cgram).toUpperCase().split(':')[0] === want ? 1 : 0
      const bm = want && String(b.cgram).toUpperCase().split(':')[0] === want ? 1 : 0
      if (am !== bm) return bm - am
      return b.freq - a.freq
    })[0]
}

// FLELex 的 tag → Lexique383 的 cgram 主类（用于同形词消歧）
const TAG_TO_CGRAM = {
  NOM: 'NOM',
  VER: 'VER',
  ADJ: 'ADJ',
  ADV: 'ADV',
  PRO: 'PRO',
  PRP: 'PRE',
  KON: 'CON',
  'DET:ART': 'ART',
  INT: 'INT',
}

// ---------------- 词性映射 ----------------
// 目标（项目既有 12 值）：n.m. n.f. v. adj. adv. prép. conj. pron. det. num. interj. loc.
function mapPos(cgram, genre, isMultiWord) {
  if (isMultiWord) return 'loc.'
  const full = String(cgram || '').toUpperCase()
  const c = full.split(':')[0]
  if (c === 'NOM') return genre === 'f' ? 'n.f.' : 'n.m.'
  if (c === 'VER' || c === 'AUX') return 'v.'
  if (c === 'ADJ') return full.indexOf(':NUM') >= 0 ? 'num.' : 'adj.'
  if (c === 'ADV') return 'adv.'
  if (c === 'PRE') return 'prép.'
  if (c === 'CON') return 'conj.'
  if (c === 'PRO') return 'pron.'
  if (c === 'ART' || c === 'DET') return 'det.'
  if (c === 'INT' || c === 'ONO') return 'interj.'
  return 'n.m.'
}

function mapPosFromTag(tag) {
  const m = {
    NOM: 'n.m.',
    VER: 'v.',
    ADJ: 'adj.',
    ADV: 'adv.',
    PRO: 'pron.',
    PRP: 'prép.',
    KON: 'conj.',
    'DET:ART': 'det.',
    INT: 'interj.',
  }
  return m[tag] || 'n.m.'
}

// FLELex 与 Lexique383 的少数对不上号，手工建桥（数量很少，逐条核对过）
const ALIAS = {
  tandis: 'tandis que', // Lexique 只收录连词整体，没有单独的 tandis
}

// Lexique383 确实没收录的词，音标人工补（会在 notes 里标明，便于日后复核）
const MANUAL_IPA = {
  "est-à-dire": 'ɛs.ta.diʁ',
  'mi-temps': 'mi.tɑ̃',
  médiathèque: 'me.dja.tɛk',
  rentraire: 'ʁɑ̃.tʁɛʁ',
  retraiter: 'ʁə.tʁɛ.te',
}

// Lexique383 的 genre 栏对一部分名词是**空的**，直接默认成阳性会把阴性名词标错。
// 这里只列「确实该是阴性」的那些；两性通用的词（ministre / pilote / spécialiste /
// ancêtre / guide / interprète …）保留阳性的惯例写法，不列。
// 每条都用两个独立信号核对过：① 法语常识；② 生成的例句里的限定词
// （如 la gorge / une auto / la foudre / une ordonnance）。
const GENDER_OVERRIDE = {
  auto: 'f',
  barbe: 'f',
  faune: 'f',
  foudre: 'f',
  gorge: 'f',
  médiathèque: 'f',
  'mi-temps': 'f',
  ordonnance: 'f',
  poche: 'f',
  politique: 'f', // 释义取「政治」，即 la politique
  remarque: 'f',
  souris: 'f',
}

// 省音前缀：Lexique 把 d'ailleurs 拆成 ailleurs，需要按「辅音 + 余下部分」拼回
const ELISION = { "d'": 'd', "l'": 'l', "qu'": 'k', "n'": 'n', "s'": 's', "j'": 'Z', "m'": 'm', "t'": 't', "c'": 's' }

/** 查词：原形 → 词根索引 → 去省音前缀 → null */
function lookup(word, lex, wantCgram) {
  const w = ALIAS[word] || word
  let rec = pickBest(lex.byOrtho.get(w), wantCgram)
  if (rec) return { rec, w, extra: '' }

  // 词根索引兜底：vrai 本身没有条目，但 vrais/vraie 的词根写着 VRAI
  const byL = pickBest(lex.byLemme.get(w.toLowerCase()), wantCgram)
  if (byL) return { rec: byL, w, extra: '经词根索引 ' + byL.lemme + ' 取到' }

  // 去省音前缀：d'ailleurs → ailleurs
  for (const pre of Object.keys(ELISION)) {
    if (w.indexOf(pre) === 0) {
      const rest = w.slice(pre.length)
      const r2 = pickBest(lex.byOrtho.get(rest), wantCgram)
      if (r2) {
        return {
          rec: Object.assign({}, r2, { phon: ELISION[pre] + r2.phon, syll: ELISION[pre] + r2.syll }),
          w,
          extra: '省音前缀 ' + pre + ' 已按 Lexique 的 ' + rest + ' 拼接',
        }
      }
    }
  }
  return null
}

/** 这个形该不该归到词根？
 *  只归一真正的屈折形，否则会误伤独立的词：
 *    - VER 的变位 → 不定式（allons → aller）
 *    - 形容词/限定词/代词的性数变化（grecque → grec、tous → tout）
 *    - 名词复数（mesdames → madame、castagnettes → castagnette）
 *  而 Lexique 习惯把阴性名词也挂到阳性词根下（princesse → prince、
 *  héroïne → héros、demoiselle → damoiseau），照它改会把独立的词弄丢，所以名词单数一律不归一。 */
function shouldNormalize(word, tag, rec) {
  if (!rec || rec.isLem || rec.lemme === word) return false
  if (tag === 'VER') return true
  if (tag && tag !== 'NOM') return true
  if (tag === 'NOM') {
    const w = word.toLowerCase()
    const l = String(rec.lemme || '').toLowerCase()
    return w.endsWith('s') && !l.endsWith('s')
  }
  return false
}

function main() {
  const fle = readFlelex()
  const lex = readLexique()
  log('Lexique383 词形数：' + lex.total)

  const b1 = fle.filter((r) => r[9] === LEVEL)
  log('FLELex ' + LEVEL + ' 原始：' + b1.length + ' 条')

  const dropped = []
  const normalized = []
  const canonical = new Map()

  for (const r of b1) {
    let word = String(r[0] || '').trim()
    let tag = r[1]
    const freqTotal = frNum(r[8])

    // 1) 丢弃碎片（-ci 这类前后缀残片，不是词）；全大写则归一为小写（VRAI → vrai）
    if (!/^[a-zà-ÿ]/.test(word)) {
      if (/^[A-ZÀ-Ý]+$/.test(word)) {
        word = word.toLowerCase()
      } else {
        dropped.push(word + '（非字母开头，碎片）')
        continue
      }
    }

    // 2) 词形规范化：只归一真正的屈折形（见 shouldNormalize 的取舍说明）
    const wantCgram = TAG_TO_CGRAM[tag] || ''
    const hit = lookup(word, lex, wantCgram)
    let rec = hit ? hit.rec : null
    const notes = []
    if (hit && hit.extra) notes.push(hit.extra)
    if (shouldNormalize(word, tag, rec)) {
      const lm = pickBest(lex.byLemme.get(String(rec.lemme).toLowerCase()), wantCgram)
      if (lm) {
        notes.push('归一 ' + word + '→' + rec.lemme)
        normalized.push(word + '→' + rec.lemme)
        word = String(rec.lemme).toLowerCase()
        rec = Object.assign({}, lm, { isLem: true })
      }
    }

    // 3) 音标 / 词性 / 性别
    let ipa = ''
    let pos = ''
    let gender = ''
    if (rec) {
      ipa = toIpa(rec.syll || rec.phon, '.')
      if (!rec.syll) ipa = toIpa(rec.phon, '')
      if (ipa.indexOf('\u0000UNKNOWN') >= 0) {
        notes.push('音标含未映射字符，退回无音节版本')
        ipa = toIpa(rec.phon, '')
      }
      gender = rec.genre || ''
      pos = mapPos(rec.cgram, gender, /\s/.test(word))
    } else {
      pos = mapPosFromTag(tag)
      if (MANUAL_IPA[word]) {
        ipa = MANUAL_IPA[word]
        notes.push('Lexique383 未收录，音标人工补')
      } else {
        notes.push('音标缺失')
      }
    }

    // 性别人工校正放在最后：Lexique 未收录的词（médiathèque / mi-temps）
    // 走的是上面 else 分支，只在校正写在这里才两条路径都能覆盖。
    if (GENDER_OVERRIDE[word]) {
      gender = GENDER_OVERRIDE[word]
      if (pos === 'n.m.' || pos === 'n.f.') pos = gender === 'f' ? 'n.f.' : 'n.m.'
      notes.push('性别人工校正为' + (gender === 'f' ? '阴' : '阳') + '性')
    }

    if (!canonical.has(word)) {
      canonical.set(word, { word, pos, ipa, freq: freqTotal, gender, notes: notes.join('；') })
    } else {
      const old = canonical.get(word)
      old.notes = [old.notes, notes.join('；'), 'FLELex 重复收录'].filter(Boolean).join('；')
      if (!old.ipa && ipa) old.ipa = ipa
    }
  }

  const list = [...canonical.values()].sort((a, b) => a.word.localeCompare(b.word, 'fr'))
  log('规范化去重后：' + list.length + ' 条')
  log('丢弃：' + dropped.length + ' 条 → ' + dropped.join(', '))
  log('词形归一：' + normalized.length + ' 条 → ' + normalized.join(', '))

  const noIpa = list.filter((x) => !x.ipa)
  log('缺音标：' + noIpa.length + ' 条' + (noIpa.length ? ' → ' + noIpa.map((x) => x.word).join(' ') : ''))
  const dotted = list.filter((x) => x.ipa.indexOf('.') >= 0)
  log('带音节点的音标：' + dotted.length + ' 条')

  const posCount = {}
  list.forEach((x) => (posCount[x.pos] = (posCount[x.pos] || 0) + 1))
  log('词性分布：' + JSON.stringify(posCount))

  // 抽样看音标映射结果：挑带鼻化元音/圆唇元音/半元音/重音的词，覆盖各个映射分支
  log('')
  log('音标抽样：')
  const probes = ['bonjour', 'maison', 'fenêtre', 'fleur', 'huit', 'vin', 'temps', 'jeu', 'brun', 'montagne', 'travail', 'agneau', 'vrai', "d'ailleurs", 'tandis que', 'princesse', 'demoiselle']
  const byWord = new Map(list.map((x) => [x.word, x]))
  probes.forEach((p) => {
    const x = byWord.get(p)
    if (x) log('  ' + p.padEnd(14) + x.ipa.padEnd(16) + x.pos)
  })
  // 随机抽 20 条，肉眼看一眼有没有明显走形
  log('')
  log('随机 20 条：')
  const shuffled = list.slice().sort(() => Math.random() - 0.5).slice(0, 20)
  shuffled.forEach((x) => log('  ' + x.word.padEnd(18) + x.ipa.padEnd(18) + x.pos))

  fs.writeFileSync(
    OUT,
    'word\tpos\tipa\tfreq\tgender\tnotes\n' +
      list.map((x) => [x.word, x.pos, x.ipa, x.freq.toFixed(2), x.gender, x.notes].join('\t')).join('\n') +
      '\n',
    'utf8'
  )
  fs.writeFileSync(OUT_REPORT, report.join('\n') + '\n', 'utf8')
  log('')
  log('已写出：' + OUT)
}

main()
