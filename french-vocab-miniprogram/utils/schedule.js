// 学习日程：单元为里程碑 + 每日新词数控制节奏（纯函数即时投影，不落库）
// 好处：中途新增教材 / 单元 / 生词时，只需重算，无需改写任何计划数据。
const { addDays, nextStudyDay, todayLocal } = require('./date')
const { CUMULATIVE } = require('./srs')

function normalizeWeekly(value) {
  const arr = Array.isArray(value) ? value.map(Number).filter((n) => n >= 1 && n <= 7) : []
  const uniq = Array.from(new Set(arr)).sort((a, b) => a - b)
  return uniq.length ? uniq : [1, 2, 3, 4, 5]
}

/**
 * @param {Object} plan    { daily_new, daily_review_cap, weekly_days }
 * @param {Array}  groups  [{ id, title, freshCount }] 按推进顺序（教材单元 → 自建词虚拟单元）
 * @param {String} [startDate] YYYY-MM-DD
 */
function projectSchedule(plan, groups, startDate) {
  const N = Math.max(1, Number(plan.daily_new) || 10)
  const C = Math.max(1, Number(plan.daily_review_cap) || 50)
  const weekly = normalizeWeekly(plan.weekly_days)
  const load = Object.create(null)
  const days = []
  const milestones = []
  let cursor = startDate || todayLocal()

  groups.forEach((group, index) => {
    const fresh = Math.max(0, Number(group.freshCount) || 0)
    const milestone = {
      id: group.id,
      title: group.title,
      seq: index + 1,
      freshCount: fresh,
      newCount: 0,
      studyDays: 0,
      start: null,
      end: null,
    }
    let remaining = fresh
    let guard = 0
    while (remaining > 0 && guard < 4000) {
      guard += 1
      cursor = nextStudyDay(cursor, weekly)
      const count = Math.min(N, remaining)
      remaining -= count

      // 这一批新词未来各次复习的到期日 → 计入当日复习负载
      CUMULATIVE.forEach((offset) => {
        const key = addDays(cursor, offset)
        load[key] = (load[key] || 0) + count
      })

      if (!milestone.start) milestone.start = cursor
      milestone.end = cursor
      milestone.newCount += count
      milestone.studyDays += 1
      days.push({
        date: cursor,
        unitId: group.id,
        unitTitle: group.title,
        newCount: count,
        reviewCount: 0,
      })
      cursor = addDays(cursor, 1)
    }
    milestones.push(milestone)
  })

  // 复习负载受每日封顶约束，超出部分顺延到下一个学习日
  let overflow = 0
  days.forEach((d) => {
    const need = (load[d.date] || 0) + overflow
    d.reviewCount = Math.min(need, C)
    overflow = need - d.reviewCount
  })

  const reviewDays = days.filter((d) => d.reviewCount > 0)
  const avgReview = reviewDays.length
    ? Math.round(reviewDays.reduce((s, d) => s + d.reviewCount, 0) / reviewDays.length)
    : 0

  return {
    dailyNew: N,
    reviewCap: C,
    weeklyDays: weekly,
    days,
    milestones,
    finishDate: days.length ? days[days.length - 1].date : null,
    totalNew: days.reduce((s, d) => s + d.newCount, 0),
    avgReview,
    // 复习压力：平均复习量持续接近封顶值时提示下调每日新词数
    heavy: reviewDays.length > 0 && avgReview >= Math.round(C * 0.8),
  }
}

/** 今日任务：首页与学习会话共用同一口径 */
function todayTasks(plan, groups, dueCount, todayNewDone) {
  const N = Math.max(1, Number(plan.daily_new) || 10)
  const C = Math.max(1, Number(plan.daily_review_cap) || 50)
  const newTodo = Math.max(0, N - (Number(todayNewDone) || 0))
  const reviewTodo = Math.max(0, Math.min(Number(dueCount) || 0, C))
  const current = groups.find((g) => (Number(g.freshCount) || 0) > 0) || null
  return {
    newTodo,
    reviewTodo,
    currentUnit: current,
    unitIndex: current ? groups.indexOf(current) + 1 : groups.length,
    totalUnits: groups.length,
  }
}

module.exports = { projectSchedule, todayTasks, normalizeWeekly }
