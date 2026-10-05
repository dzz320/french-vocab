// 法语句子切词：把例句拆成「可点的单词」和「标点 / 空白」两类片段，
// 供 WXML 逐片渲染（可点的挂 catchtap）。
//
// 两条硬约束：
//   ① 拼回去必须与原文逐字符相等。少一个空格就是排版事故，而例句里的
//      标点（, . ? ! « » -）在两个方向上都有，所以标点单独成片、原样保留。
//   ② 「可点」的判定要贴合法语真实词形：撇号（l'école / qu'il / aujourd'hui）
//      和连字符（est-ce / allez-vous / chef-d'œuvre）都是**词内字符**，不是分隔符。

// 允许出现在单词里的字母：
//   A-Z a-z
//   À-Ö Ø-ÿ  Latin-1 的带音标字母（故意跳过中间的 × ÷）
//   Œ œ      合字不在 Latin-1 区间，要单独列
const LETTER = 'A-Za-zÀ-ÖØ-ÿŒœ'
// 词内连接符：直/弯撇号 + 半角/不换行/连字符类
const APOS = "'\u2019"
const HYPHEN = '\\-\u2010\u2011'
const JOINER = APOS + HYPHEN

// 词首成分（clitique）。只有「这些前缀 + 撇号」才剥：
//   l'école → école ✓     qu'il → il ✓
//   但 aujourd'hui 的 hui、quelqu'un 的 un 不能当本词 —— 库里真有 un，
//   剥错就会把 quelqu'un 跳到「un」的词条上去。
const CLITICS = ['l', 'd', 'j', 'm', 'n', 's', 't', 'c', 'qu', 'jusqu', 'lorsqu', 'presqu', 'puisqu', 'quoiqu']

function wordRe() {
  // 每次现造，避免共享 /g 正则的 lastIndex 状态互相污染
  return new RegExp('[' + LETTER + ']+(?:[' + JOINER + '][' + LETTER + ']+)*', 'g')
}

function hyphenRe() {
  return new RegExp('[' + HYPHEN + ']')
}

function elisionRe() {
  return new RegExp('^(?:' + CLITICS.join('|') + ')[' + APOS + '](.+)$', 'i')
}

/**
 * 切分。返回 [{ i, t, w }]，t 是片段文本，w=true 表示这是个可点的单词。
 * i 只作为 wx:key 用。
 * @param {string} text
 * @returns {Array<{i:number,t:string,w:boolean}>}
 */
function tokenize(text) {
  const s = text == null ? '' : String(text)
  const raw = []
  const re = wordRe()
  let last = 0
  let m
  while ((m = re.exec(s))) {
    if (m.index > last) raw.push({ t: s.slice(last, m.index), w: false })
    raw.push({ t: m[0], w: true })
    last = m.index + m[0].length
  }
  if (last < s.length) raw.push({ t: s.slice(last), w: false })
  return raw.map((p, i) => ({ i, t: p.t, w: p.w }))
}

/** 连字符切分：est-ce → ['est','ce']；chef-d'œuvre → ['chef',"d'œuvre"] */
function splitHyphen(token) {
  return String(token || '')
    .split(hyphenRe())
    .filter(Boolean)
}

/** 剥掉词首成分；不是词首成分则返回空串（调用方据此判断「改没改动」） */
function elide(token) {
  const m = elisionRe().exec(String(token || ''))
  return m ? m[1] : ''
}

/**
 * 词条「本词」：从例句点进来但库里没有时，用它开新增页。
 * 只有词首成分（l' d' qu'…）会被剥掉，其余原样 —— 可预期，不会把
 * quelqu'un 变成 un、chef-d'œuvre 变成 chef。
 */
function headWord(token) {
  const t = String(token || '').trim()
  if (!t) return ''
  const e = elide(t)
  return e.length >= 2 ? e : t
}

/**
 * 查词候选，按「越像词条本形」排序：
 *   ① 整词    —— 词库里真的有 d'ailleurs / chef-d'œuvre / aujourd'hui 这类词条
 *   ② 去词首成分 —— l'école → école
 *   ③ 连字符各段及其去词首成分 —— est-ce → est / ce，chef-d'œuvre → chef / œuvre
 * 单字母（l / d / à / y）不进候选：只会在库里撞出一堆噪音。
 * 例：l'école → [l'école, école]；est-ce → [est-ce, est, ce, ce]→去重 [est-ce, est, ce]
 */
function lookupCandidates(token) {
  const t = String(token || '').trim()
  if (!t) return []
  const out = []
  const seen = Object.create(null)
  const push = (v) => {
    const s = String(v || '')
    if (s.length < 2) return
    const k = s.toLowerCase()
    if (seen[k]) return
    seen[k] = true
    out.push(s)
  }
  push(t)
  push(elide(t))
  splitHyphen(t).forEach((part) => {
    // 连字符段若自带词首成分（chef-d'œuvre 的 d'œuvre），先查剥掉后的 œuvre，
    // 命中的话就不用再发那次没意义的查询
    const e = elide(part)
    if (e.length >= 2) {
      push(e)
      push(part)
    } else {
      push(part)
    }
  })
  return out
}

module.exports = {
  tokenize,
  headWord,
  lookupCandidates,
  // 便于自测
  elide,
  splitHyphen,
}
