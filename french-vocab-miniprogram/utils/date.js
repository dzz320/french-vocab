// 统一的"本地日历日"工具。
// due_date / reviewed_on 一律用 YYYY-MM-DD 字符串（DATE 语义），
// 全部在设备本地时区计算，避免与服务器 UTC 产生偏差。

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

function formatDate(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

function todayLocal() {
  return formatDate(new Date())
}

function isDateStr(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
}

function toDate(dateStr) {
  const parts = String(dateStr).split('-').map(Number)
  return new Date(parts[0], parts[1] - 1, parts[2])
}

function addDays(dateStr, n) {
  const d = toDate(dateStr)
  d.setDate(d.getDate() + n)
  return formatDate(d)
}

/** a - b 的天数差（同为 YYYY-MM-DD） */
function diffDays(a, b) {
  return Math.round((toDate(a).getTime() - toDate(b).getTime()) / 86400000)
}

/** 1=周一 … 7=周日 */
function weekday(dateStr) {
  const w = toDate(dateStr).getDay()
  return w === 0 ? 7 : w
}

/** 从 dateStr 起找下一个学习日（含当天）；两周内找不到则原样返回 */
function nextStudyDay(dateStr, weeklyDays) {
  let d = dateStr
  for (let i = 0; i < 14; i++) {
    if (weeklyDays.indexOf(weekday(d)) >= 0) return d
    d = addDays(d, 1)
  }
  return dateStr
}

function formatCN(dateStr) {
  if (!isDateStr(dateStr)) return ''
  const parts = dateStr.split('-')
  return Number(parts[1]) + '月' + Number(parts[2]) + '日'
}

function formatCNElite(dateStr) {
  if (!isDateStr(dateStr)) return ''
  const parts = dateStr.split('-')
  return parts[0] + '年' + Number(parts[1]) + '月' + Number(parts[2]) + '日'
}

/**
 * 连续学习天数：从今天（若今天没学则从昨天）往前数有学习记录的连续天数。
 * dates: YYYY-MM-DD 数组
 */
function computeStreak(dates, today) {
  const set = Object.create(null)
  ;(dates || []).forEach((d) => {
    if (isDateStr(d)) set[d] = true
  })
  let cursor = set[today] ? today : addDays(today, -1)
  let streak = 0
  while (set[cursor]) {
    streak += 1
    cursor = addDays(cursor, -1)
  }
  return streak
}

const WEEKDAY_CN = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']

function weekdayCN(dateStr) {
  return WEEKDAY_CN[weekday(dateStr)] || ''
}

module.exports = {
  todayLocal,
  formatDate,
  isDateStr,
  addDays,
  diffDays,
  weekday,
  nextStudyDay,
  formatCN,
  formatCNElite,
  weekdayCN,
  computeStreak,
}
