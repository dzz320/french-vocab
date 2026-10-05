// AI 能力封装：教材解析 / 例句与记忆技巧 / 词条补全 / 学习建议
// 全部走 cloud.llm.chat.completions.create({ stream: true })，messages[0] 必须是 system。
const { cloud, requireTextModel, getImageModel } = require('./cloud')

const DEFAULT_TIMEOUT = 45000
const PARSE_TIMEOUT = 120000
// 单次最多交给 AI 解析的字符数：每 3000 字一批，30k 上限约 10 次调用。
// 防止用户粘贴/上传超长文本时触发成百上千次模型调用。
const MAX_PARSE_CHARS = 30000

const SYSTEM_PARSE =
  '你是面向零基础（A1）法语教材的解析助手。从给定内容中识别单元（Leçon / Unité / Chapitre）以及每个单元的生词表。' +
  '只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释。格式：' +
  '{"units":[{"title":"单元标题","summary":"一句话简介","words":[{"word":"法语单词","phonetic":"音标","pos":"词性缩写如 n./v./adj.","meaning_zh":"最常用中文释义"}]}]}。' +
  '中文释义要简短准确；若片段不完整，也请尽力抽取其中出现的生词并归入命名合理的单元。'

const SYSTEM_EXAMPLE =
  '你是面向零基础（A1）的法语老师。只输出一个 JSON 对象，不要 markdown 代码块。格式：' +
  '{"example_fr":"适合 A1 水平的简单法语例句","example_zh":"例句的中文翻译","mnemonic":"中文记忆技巧，结合词源/谐音/联想，不超过 60 字"}'

const SYSTEM_COMPLETE =
  '你是法语词典助手。根据法语单词输出严格 JSON，不要 markdown 代码块。格式：' +
  '{"phonetic":"音标","pos":"词性缩写","meaning_zh":"最常用的中文释义","example_fr":"A1 难度例句","example_zh":"例句中文翻译"}'

const SYSTEM_ADVICE =
  '你是法语学习规划师。根据用户的学习目标与最近学习数据，用中文给出 3-5 条简短、可执行的学习建议，每条一行，' +
  '不要使用 markdown 标题或表格，直接输出建议文本。'

// ---------------- 基础流式调用 ----------------
async function runStream(options) {
  const model = options.model
  const messages = options.messages
  const temperature = typeof options.temperature === 'number' ? options.temperature : 0.3
  const onChunk = options.onChunk
  // AbortController 在小程序基础库不一定可用，存在才用于超时中断
  const canAbort = typeof AbortController === 'function'
  const controller = canAbort ? new AbortController() : null
  const timer = setTimeout(() => {
    if (controller) controller.abort()
  }, options.timeoutMs || DEFAULT_TIMEOUT)

  let text = ''
  try {
    const payload = {
      model: model.id,
      messages,
      stream: true,
      temperature,
    }
    if (controller) payload.signal = controller.signal
    for await (const chunk of cloud.llm.chat.completions.create(payload)) {
      const choice = chunk && chunk.choices && chunk.choices[0]
      const piece = choice && choice.delta && choice.delta.content
      if (piece) {
        text += piece
        if (onChunk) onChunk(piece, text)
      }
    }
    return text
  } finally {
    clearTimeout(timer)
  }
}

function stripFence(text) {
  return String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()
}

/** 结构化输出容错：整体 parse → 剥围栏 → 截取首个 {...} 块 */
function extractJSON(text) {
  const trimmed = stripFence(text)
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch (e) {
    /* 继续尝试 */
  }
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1))
    } catch (e) {
      /* 放弃 */
    }
  }
  return null
}

// ---------------- 教材解析 ----------------
function splitText(text, maxLen) {
  const limit = maxLen || 3000
  const chunks = []
  let buf = ''
  String(text || '')
    .split(/\n{2,}/)
    .forEach((para) => {
      if (buf && (buf + '\n\n' + para).length > limit) {
        chunks.push(buf)
        buf = para
      } else {
        buf = buf ? buf + '\n\n' + para : para
      }
      while (buf.length > limit) {
        chunks.push(buf.slice(0, limit))
        buf = buf.slice(limit)
      }
    })
  if (buf) chunks.push(buf)
  return chunks
}

/** 把多批解析结果按单元标题归并（保持首次出现顺序），并按词去重 */
function mergeUnits(batches) {
  const units = []
  const byTitle = Object.create(null)
  ;(batches || []).forEach((batch) => {
    ;(Array.isArray(batch) ? batch : []).forEach((unit) => {
      const title = String((unit && unit.title) || '').trim() || '未命名单元'
      if (!byTitle[title]) {
        const created = { title, summary: '', words: [] }
        byTitle[title] = created
        units.push(created)
      }
      const target = byTitle[title]
      if (!target.summary && unit && unit.summary) target.summary = String(unit.summary)
      ;((unit && unit.words) || []).forEach((w) => {
        const word = String((w && w.word) || '').trim()
        if (!word) return
        const dup = target.words.some((x) => x.word.toLowerCase() === word.toLowerCase())
        if (dup) return
        target.words.push({
          word,
          phonetic: String((w && w.phonetic) || ''),
          pos: String((w && w.pos) || ''),
          meaning_zh: String((w && w.meaning_zh) || ''),
        })
      })
    })
  })
  return units
}

/** 文本通道：txt 内容或用户粘贴的词表/课文（超出上限只解析前 MAX_PARSE_CHARS 个字符） */
async function parseTextbookText(text, onProgress) {
  const model = await requireTextModel()
  const source = String(text || '').slice(0, MAX_PARSE_CHARS)
  const chunks = splitText(source, 3000)
  const batches = []
  for (let i = 0; i < chunks.length; i++) {
    if (onProgress) onProgress(i + 1, chunks.length)
    const user = '请解析下面的法语教材片段并输出 JSON：\n"""\n' + chunks[i] + '\n"""'
    const raw = await runStream({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PARSE },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
      timeoutMs: PARSE_TIMEOUT,
    })
    const json = extractJSON(raw)
    batches.push(json && Array.isArray(json.units) ? json.units : [])
  }
  return mergeUnits(batches)
}

/** 图片通道：逐页交给多模态模型识别（模型不支持图像时抛 no_vision_model） */
async function parseTextbookImages(images, onProgress) {
  const model = await getImageModel()
  if (!model) {
    const err = new Error('当前没有支持图像识别的模型，请改用「粘贴文本」方式导入')
    err.code = 'no_vision_model'
    throw err
  }
  const batches = []
  for (let i = 0; i < images.length; i++) {
    if (onProgress) onProgress(i + 1, images.length)
    const item = images[i]
    const messages = [
      { role: 'system', content: SYSTEM_PARSE },
      {
        role: 'user',
        content: [
          { type: 'text', text: '请识别这页法语教材内容，抽取其中的单元与生词并输出 JSON。' },
          { type: 'image_url', image_url: { url: 'data:' + (item.mime || 'image/jpeg') + ';base64,' + item.base64 } },
        ],
      },
    ]
    let raw = ''
    try {
      raw = await runStream({
        model,
        messages,
        temperature: 0.2,
        timeoutMs: PARSE_TIMEOUT,
      })
    } catch (e) {
      batches.push([]) // 单页失败不阻塞其余页
      continue
    }
    const json = extractJSON(raw)
    batches.push(json && Array.isArray(json.units) ? json.units : [])
  }
  return mergeUnits(batches)
}

// ---------------- 词条级 AI ----------------
async function generateExample(word, meaningZh) {
  const model = await requireTextModel()
  const user = '法语单词：' + word + (meaningZh ? '\n已知释义：' + meaningZh : '')
  const raw = await runStream({
    model,
    messages: [
      { role: 'system', content: SYSTEM_EXAMPLE },
      { role: 'user', content: user },
    ],
    temperature: 0.6,
  })
  const json = extractJSON(raw)
  if (!json) {
    const err = new Error('AI 返回内容无法解析')
    err.code = 'bad_json'
    throw err
  }
  return {
    example_fr: String(json.example_fr || ''),
    example_zh: String(json.example_zh || ''),
    mnemonic: String(json.mnemonic || ''),
  }
}

async function completeWord(word) {
  const model = await requireTextModel()
  const raw = await runStream({
    model,
    messages: [
      { role: 'system', content: SYSTEM_COMPLETE },
      { role: 'user', content: '法语单词：' + word },
    ],
    temperature: 0.2,
  })
  const json = extractJSON(raw)
  if (!json) {
    const err = new Error('AI 返回内容无法解析')
    err.code = 'bad_json'
    throw err
  }
  return {
    phonetic: String(json.phonetic || ''),
    pos: String(json.pos || ''),
    meaning_zh: String(json.meaning_zh || ''),
    example_fr: String(json.example_fr || ''),
    example_zh: String(json.example_zh || ''),
  }
}

/** 学习建议：纯文本流式输出，onChunk 用于逐段渲染 */
async function studyAdvice(payload, onChunk) {
  const model = await requireTextModel()
  const user =
    '学习目标与最近数据：\n' + JSON.stringify(payload, null, 1) + '\n请给出学习建议。'
  return runStream({
    model,
    messages: [
      { role: 'system', content: SYSTEM_ADVICE },
      { role: 'user', content: user },
    ],
    temperature: 0.7,
    onChunk,
    timeoutMs: 60000,
  })
}

module.exports = {
  MAX_PARSE_CHARS,
  parseTextbookText,
  parseTextbookImages,
  generateExample,
  completeWord,
  studyAdvice,
  extractJSON,
  mergeUnits,
}
