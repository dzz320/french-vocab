// 数据访问层：所有数据库读写集中在这里。
// 约定：客户端绝不发送 owner_id（由 DEFAULT auth.uid() 在服务端填充，RLS 负责隔离）。
const { cloud, requireSession } = require('./cloud')

const DB_ERRORS = {
  '42P01': '数据表不存在，请重新发布小程序',
  '42501': '没有权限执行该操作',
  '23505': '内容已存在',
}

function fail(error) {
  const code = error && error.code
  const err = new Error(DB_ERRORS[code] || (error && error.message) || '数据操作失败')
  err.code = code || 'db_error'
  throw err
}

function unwrap(result) {
  if (result && result.error) fail(result.error)
  return result
}

function rows(result) {
  const r = unwrap(result)
  return Array.isArray(r.data) ? r.data : []
}

// ---------------- 生词 ----------------
async function listWords(options) {
  await requireSession()
  const opts = options || {}
  const page = Math.max(1, Number(opts.page) || 1)
  const size = Math.min(50, Math.max(5, Number(opts.size) || 20))
  const from = (page - 1) * size

  let q = cloud.database.from('fr_words').select('*', { count: 'exact' })
  if (opts.status === 'learning' || opts.status === 'mastered') q = q.eq('status', opts.status)
  if (opts.unitId) q = q.eq('unit_id', opts.unitId)
  if (opts.bookId) q = q.eq('book_id', opts.bookId)
  // '*' = 全部；'none' = 未归入任何词库；数字 = 指定词库
  if (opts.libraryId === 'none') q = q.is('library_id', null)
  else if (opts.libraryId) q = q.eq('library_id', opts.libraryId)
  const keyword = String(opts.search || '').replace(/[,()]/g, ' ').trim()
  if (keyword) {
    q = q.or('word.ilike.%' + keyword + '%,meaning_zh.ilike.%' + keyword + '%')
  }
  const result = await q.order('created_at', { ascending: false }).range(from, from + size - 1)
  const r = unwrap(result)
  return { list: rows(r), total: r.count || 0 }
}

async function getWord(id) {
  await requireSession()
  const r = unwrap(await cloud.database.from('fr_words').select('*').eq('id', id).maybeSingle())
  return r.data
}

/**
 * 按词形找库里的生词：大小写不敏感、**精确**匹配（ilike 不带通配符就是这语义，
 * 别加 % —— 加了就变成模糊搜索，例句里点 «Il» 会随机命中某个含 il 的词）。
 * 用于例句点词后判断该跳已有词条还是开新增页；查不到返回 null。
 * 注意：调用方传进来的词形来自 utils/fr-text.js 的候选，只含字母和词内连接符，
 * 不会有 % / _ 这两个 LIKE 通配符。
 */
async function findWordByText(text) {
  await requireSession()
  const w = String(text || '').trim()
  if (!w) return null
  const r = unwrap(
    await cloud.database
      .from('fr_words')
      .select('*')
      .ilike('word', w)
      .order('id', { ascending: true })
      .limit(1),
  )
  const list = rows(r)
  return list.length ? list[0] : null
}

async function createWord(payload) {
  await requireSession()
  const body = Object.assign({}, payload)
  delete body.owner_id
  const r = unwrap(await cloud.database.from('fr_words').insert(body).select())
  return rows(r)[0]
}

async function createWords(list) {
  await requireSession()
  const body = (list || []).map((item) => {
    const row = Object.assign({}, item)
    delete row.owner_id
    return row
  })
  if (!body.length) return []
  const r = unwrap(await cloud.database.from('fr_words').insert(body).select())
  return rows(r)
}

async function updateWord(id, patch) {
  await requireSession()
  const body = Object.assign({}, patch)
  delete body.owner_id
  delete body.id
  body.updated_at = new Date().toISOString()
  const r = unwrap(await cloud.database.from('fr_words').update(body).eq('id', id).select())
  // 空数组意味着 RLS 拦下了这次写入，不能当成成功
  if (!rows(r).length) fail({ code: '42501', message: '未找到该生词或无权修改' })
  return rows(r)[0]
}

async function deleteWord(id) {
  await requireSession()
  const r = unwrap(await cloud.database.from('fr_words').delete().eq('id', id).select())
  return rows(r).length
}

/** 重置 SRS：回到"新词"状态，立即重新进入学习队列 */
async function resetWordSrs(id) {
  return updateWord(id, { stage: 0, due_date: null, status: 'learning', lapses: 0 })
}

async function countWords() {
  await requireSession()
  const r = unwrap(
    await cloud.database.from('fr_words').select('*', { count: 'exact', head: true }),
  )
  return r.count || 0
}

async function countWordsByStatus() {
  await requireSession()
  const learning = unwrap(
    await cloud.database
      .from('fr_words')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'learning'),
  )
  const mastered = unwrap(
    await cloud.database
      .from('fr_words')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'mastered'),
  )
  return { learning: learning.count || 0, mastered: mastered.count || 0 }
}

/** 新词（从未作答过）：stage=0 且无 due_date */
async function listFreshWords(limit) {
  await requireSession()
  return rows(
    await cloud.database
      .from('fr_words')
      .select('*')
      .eq('status', 'learning')
      .eq('stage', 0)
      .is('due_date', null)
      .order('created_at', { ascending: true })
      .limit(limit || 20),
  )
}

/** 今日到期复习词 */
async function listDueWords(today, limit) {
  await requireSession()
  return rows(
    await cloud.database
      .from('fr_words')
      .select('*')
      .eq('status', 'learning')
      .not('due_date', 'is', null)
      .lte('due_date', today)
      .order('due_date', { ascending: true })
      .limit(limit || 100),
  )
}

async function countFreshWords() {
  await requireSession()
  const r = unwrap(
    await cloud.database
      .from('fr_words')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'learning')
      .eq('stage', 0)
      .is('due_date', null),
  )
  return r.count || 0
}

async function countDueWords(today) {
  await requireSession()
  const r = unwrap(
    await cloud.database
      .from('fr_words')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'learning')
      .not('due_date', 'is', null)
      .lte('due_date', today),
  )
  return r.count || 0
}

async function countFreshByUnit(bookId) {
  await requireSession()
  const list = rows(
    await cloud.database
      .from('fr_words')
      .select('unit_id,status,stage,due_date')
      .eq('book_id', bookId),
  )
  return list
}

/** 一本教材的生词统计（总数 / 已掌握 / 未学新词） */
async function bookWordStats(bookId) {
  await requireSession()
  const list = rows(
    await cloud.database
      .from('fr_words')
      .select('status,stage,due_date')
      .eq('book_id', bookId),
  )
  let total = list.length
  let mastered = 0
  let fresh = 0
  list.forEach((w) => {
    if (w.status === 'mastered') mastered += 1
    else if (Number(w.stage || 0) === 0 && !w.due_date) fresh += 1
  })
  return { total, mastered, fresh }
}

/** 与用户已有词比对（用于导入/教材入库去重） */
async function listExistingWordKeys() {
  await requireSession()
  const list = rows(await cloud.database.from('fr_words').select('word'))
  const set = Object.create(null)
  list.forEach((item) => {
    if (item && item.word) set[String(item.word).trim().toLowerCase()] = true
  })
  return set
}

/**
 * 导入去重用的两个词集（一次查询拿全，避免 N+1）：
 * - inLibrary：目标词库内已存在 → 硬跳过，重复导入同一份词表不会产生垃圾；
 * - elsewhere：在你其他词库/教材里出现过 → 只做提示，允许继续导入。
 *   同一个词出现在「B1 库」和「工程师库」是完全合理的，不该被拦。
 */
async function wordKeysForLibrary(libraryId) {
  await requireSession()
  const list = rows(await cloud.database.from('fr_words').select('word,library_id'))
  const inLibrary = Object.create(null)
  const elsewhere = Object.create(null)
  const want = libraryId === null || libraryId === undefined ? '' : String(libraryId)
  list.forEach((item) => {
    if (!item || !item.word) return
    const key = String(item.word).trim().toLowerCase()
    if (!key) return
    const lid = item.library_id === null || item.library_id === undefined ? '' : String(item.library_id)
    if (want && lid === want) inLibrary[key] = true
    else elsewhere[key] = true
  })
  return { inLibrary, elsewhere }
}

// ---------------- 词库（与教材完全独立的一套） ----------------
async function listLibraries() {
  await requireSession()
  return rows(
    await cloud.database.from('fr_libraries').select('*').order('created_at', { ascending: true }),
  )
}

async function getLibrary(id) {
  await requireSession()
  const r = unwrap(await cloud.database.from('fr_libraries').select('*').eq('id', id).maybeSingle())
  return r.data
}

async function createLibrary(payload) {
  await requireSession()
  const p = payload || {}
  const body = {
    name: String(p.name || '').trim() || '未命名词库',
    level: String(p.level || '').trim(),
    description: String(p.description || '').trim(),
  }
  const r = unwrap(await cloud.database.from('fr_libraries').insert(body).select())
  return rows(r)[0]
}

async function updateLibrary(id, patch) {
  await requireSession()
  const body = Object.assign({}, patch)
  delete body.owner_id
  delete body.id
  body.updated_at = new Date().toISOString()
  const r = unwrap(await cloud.database.from('fr_libraries').update(body).eq('id', id).select())
  if (!rows(r).length) fail({ code: '42501', message: '未找到该词库或无权修改' })
  return rows(r)[0]
}

/** 删除词库及其中的生词（UI 侧需先确认）。先删词再删库，顺便拿到准确的删除数量。 */
async function deleteLibraryCascade(id) {
  await requireSession()
  const removed = rows(await cloud.database.from('fr_words').delete().eq('library_id', id).select())
  const r = unwrap(await cloud.database.from('fr_libraries').delete().eq('id', id).select())
  return { deleted: rows(r).length, words: removed.length }
}

/**
 * 词库维度统计：一次拉全量 (library_id, status, stage, due_date) 在端上聚合。
 * 词库数量通常个位数，比每个库发一条 count 请求划算得多。
 * 返回 { byLibrary: { '12': {total, mastered, fresh} }, ungrouped: {…} }。
 */
async function libraryStats() {
  await requireSession()
  const list = rows(await cloud.database.from('fr_words').select('library_id,status,stage,due_date'))
  const byLibrary = Object.create(null)
  const ungrouped = { total: 0, mastered: 0, fresh: 0 }
  list.forEach((w) => {
    const bucket =
      w.library_id === null || w.library_id === undefined
        ? ungrouped
        : byLibrary[String(w.library_id)] || (byLibrary[String(w.library_id)] = { total: 0, mastered: 0, fresh: 0 })
    bucket.total += 1
    if (w.status === 'mastered') bucket.mastered += 1
    else if (Number(w.stage || 0) === 0 && !w.due_date) bucket.fresh += 1
  })
  return { byLibrary, ungrouped }
}

// ---------------- 教材 ----------------
async function listBooks() {
  await requireSession()
  return rows(
    await cloud.database.from('fr_books').select('*').order('created_at', { ascending: false }),
  )
}

async function getBook(id) {
  await requireSession()
  const r = unwrap(await cloud.database.from('fr_books').select('*').eq('id', id).maybeSingle())
  return r.data
}

async function createBook(payload) {
  await requireSession()
  const body = Object.assign({}, payload)
  delete body.owner_id
  const r = unwrap(await cloud.database.from('fr_books').insert(body).select())
  return rows(r)[0]
}

async function updateBook(id, patch) {
  await requireSession()
  const body = Object.assign({}, patch)
  delete body.owner_id
  body.updated_at = new Date().toISOString()
  const r = unwrap(await cloud.database.from('fr_books').update(body).eq('id', id).select())
  if (!rows(r).length) fail({ code: '42501', message: '未找到该教材或无权修改' })
  return rows(r)[0]
}

/** 删除教材及其单元与生词（UI 侧需先确认） */
async function deleteBookCascade(id) {
  await requireSession()
  await cloud.database.from('fr_words').delete().eq('book_id', id)
  await cloud.database.from('fr_units').delete().eq('book_id', id)
  const r = unwrap(await cloud.database.from('fr_books').delete().eq('id', id).select())
  return rows(r).length
}

// ---------------- 教材单元 ----------------
async function listUnits(bookId) {
  await requireSession()
  return rows(
    await cloud.database
      .from('fr_units')
      .select('*')
      .eq('book_id', bookId)
      .order('seq', { ascending: true }),
  )
}

async function createUnits(bookId, units) {
  await requireSession()
  const body = (units || []).map((u, index) => ({
    book_id: bookId,
    seq: Number(u.seq) || index + 1,
    title: String(u.title || '未命名单元'),
    summary: String(u.summary || ''),
  }))
  if (!body.length) return []
  const r = unwrap(await cloud.database.from('fr_units').insert(body).select())
  return rows(r)
}

async function updateUnit(id, patch) {
  await requireSession()
  const body = Object.assign({}, patch)
  delete body.owner_id
  const r = unwrap(await cloud.database.from('fr_units').update(body).eq('id', id).select())
  return rows(r)[0]
}

async function deleteUnit(id) {
  await requireSession()
  const r = unwrap(await cloud.database.from('fr_units').delete().eq('id', id).select())
  return rows(r).length
}

// ---------------- 学习日志 ----------------
async function insertLogs(list) {
  await requireSession()
  const body = (list || []).map((item) => ({
    word_id: item.word_id,
    kind: item.kind,
    result: item.result,
    reviewed_on: item.reviewed_on,
  }))
  if (!body.length) return []
  const r = unwrap(await cloud.database.from('fr_study_logs').insert(body).select())
  return rows(r)
}

/** 近 N 天日志（统计连续天数 / 每日学习量 / 生成 AI 建议用） */
async function recentLogs(since) {
  await requireSession()
  return rows(
    await cloud.database
      .from('fr_study_logs')
      .select('reviewed_on,kind,result')
      .gte('reviewed_on', since),
  )
}

async function countTodayNew(today) {
  await requireSession()
  const r = unwrap(
    await cloud.database
      .from('fr_study_logs')
      .select('*', { count: 'exact', head: true })
      .eq('kind', 'new')
      .eq('reviewed_on', today),
  )
  return r.count || 0
}

// ---------------- 学习日程 ----------------
async function getActivePlan() {
  await requireSession()
  const r = unwrap(
    await cloud.database
      .from('fr_study_plans')
      .select('*')
      .eq('is_active', true)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  )
  return r.data
}

/** 有则更新、无则新建（避免依赖 upsert 冲突语义） */
async function savePlan(patch) {
  await requireSession()
  const existing = await getActivePlan()
  const body = Object.assign({}, patch)
  delete body.owner_id
  body.updated_at = new Date().toISOString()
  if (existing) {
    const r = unwrap(
      await cloud.database.from('fr_study_plans').update(body).eq('id', existing.id).select(),
    )
    if (!rows(r).length) fail({ code: '42501', message: '未找到学习计划或无权修改' })
    return rows(r)[0]
  }
  const r = unwrap(
    await cloud.database.from('fr_study_plans').insert(Object.assign({ is_active: true }, body)).select(),
  )
  return rows(r)[0]
}

/**
 * 日程分组：当前计划教材的各单元（按 seq）+ 自建词虚拟单元。
 * today / schedule 两页共用同一口径。
 */
async function buildScheduleGroups(plan) {
  const groups = []
  if (plan && plan.book_id) {
    const units = await listUnits(plan.book_id)
    const wordRows = await countFreshByUnit(plan.book_id)
    units.forEach((u) => {
      groups.push({
        id: u.id,
        title: u.title,
        freshCount: wordRows.filter(
          (w) => w.unit_id === u.id && w.status === 'learning' && Number(w.stage || 0) === 0 && !w.due_date,
        ).length,
      })
    })
  }
  const allFresh = await countFreshWords()
  const bookFresh = groups.reduce((s, g) => s + g.freshCount, 0)
  const manualFresh = Math.max(0, allFresh - bookFresh)
  if (manualFresh > 0 || groups.length === 0) {
    groups.push({ id: null, title: '自建生词', freshCount: manualFresh })
  }
  return groups
}

module.exports = {
  listWords,
  getWord,
  findWordByText,
  createWord,
  createWords,
  updateWord,
  deleteWord,
  resetWordSrs,
  countWords,
  countWordsByStatus,
  listFreshWords,
  listDueWords,
  countFreshWords,
  countDueWords,
  countFreshByUnit,
  bookWordStats,
  listExistingWordKeys,
  wordKeysForLibrary,
  listLibraries,
  getLibrary,
  createLibrary,
  updateLibrary,
  deleteLibraryCascade,
  libraryStats,
  listBooks,
  getBook,
  createBook,
  updateBook,
  deleteBookCascade,
  listUnits,
  createUnits,
  updateUnit,
  deleteUnit,
  insertLogs,
  recentLogs,
  countTodayNew,
  getActivePlan,
  savePlan,
  buildScheduleGroups,
}
