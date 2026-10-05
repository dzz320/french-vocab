// 间隔重复（SRS）算法：阶段-间隔表 + 会话队列组织
const { addDays } = require('./date')

// INTERVALS[i] = 词处于 stage i 时，下一次复习距今天的天数
// stage 0 → 明天（1 天）… stage 5 → 60 天；stage 6 视为已掌握，不再排期
const INTERVALS = [1, 2, 4, 7, 15, 30, 60]
const MASTER_STAGE = 6
const MAX_STAGE = INTERVALS.length - 1

// 一个新词在第 0 天学会后，未来各次复习相对第 0 天的累计偏移（用于日程负载估算）
const CUMULATIVE = (function () {
  const out = []
  let acc = 0
  for (let i = 1; i < INTERVALS.length; i++) {
    acc += INTERVALS[i]
    out.push(acc)
  }
  return out
})()

function isFresh(word) {
  return Number(word.stage || 0) === 0 && !word.due_date && word.status !== 'mastered'
}

function isDue(word, today) {
  return word.status === 'learning' && !!word.due_date && word.due_date <= today
}

/**
 * 依据一次作答推进 SRS 状态（不写库，只返回新字段，由调用方 update）。
 * today: 本地日历日 YYYY-MM-DD
 */
function applyResult(word, correct, today) {
  const stage = Number(word.stage || 0)
  const next = {
    stage,
    lapses: Number(word.lapses || 0),
    status: 'learning',
    due_date: word.due_date || null,
    updated_at: new Date().toISOString(),
  }
  if (correct) {
    next.stage = Math.min(stage + 1, MAX_STAGE)
    if (next.stage >= MASTER_STAGE) {
      next.status = 'mastered'
      next.due_date = null
    } else {
      next.due_date = addDays(today, INTERVALS[next.stage])
    }
  } else {
    next.lapses += 1
    next.stage = Math.max(0, stage - 2)
    next.due_date = addDays(today, INTERVALS[next.stage])
  }
  return next
}

/** 组建会话队列：new=只学新词；review=只复习；mixed=每 2 张复习卡插 1 张新卡 */
function buildQueue(newWords, dueWords, mode) {
  if (mode === 'new') return newWords.slice()
  if (mode === 'review') return dueWords.slice()
  const queue = []
  let i = 0
  let j = 0
  while (i < newWords.length || j < dueWords.length) {
    if (j < dueWords.length) queue.push(dueWords[j++])
    if (j < dueWords.length) queue.push(dueWords[j++])
    if (i < newWords.length) queue.push(newWords[i++])
  }
  return queue
}

/** 会话内答错重排：插回当前位置之后约 3 位 */
function reinsertWrong(queue, card) {
  const idx = queue.indexOf(card)
  const target = Math.min(idx + 3, queue.length)
  queue.splice(target, 0, card)
  return queue
}

/** 阶段的可读描述 */
function stageLabel(word) {
  if (word.status === 'mastered') return '已掌握'
  const s = Number(word.stage || 0)
  const names = ['新词', '初识', '模糊', '渐熟', '较熟', '熟练', '已掌握']
  return names[s] || '学习中'
}

module.exports = {
  INTERVALS,
  CUMULATIVE,
  MASTER_STAGE,
  isFresh,
  isDue,
  applyResult,
  buildQueue,
  reinsertWrong,
  stageLabel,
}
