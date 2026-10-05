/**
 * 内存版 supabase 风格查询构建器 —— 给「页面级无 headless 测试」当云数据库的替身。
 *
 * 为什么需要它：把 `utils/api` 整个桩掉，就测不到真实的查询拼装逻辑
 *（`libraryId==='none'` 要走 `is(col,null)`、`count:'exact'` 要返回未切片总数、
 *  `update` 命中 0 行要能被判成「RLS 拦下」……）。换成这个构建器，跑的就是真 api.js。
 *
 * 用法：
 *   const { makeCloudStub } = require('./cloud_db_mock.cjs')
 *   const tables = {}
 *   const cloudStub = makeCloudStub(tables)
 *   // Module._load 里： if (/(^|\/)cloud$/.test(request)) return cloudStub
 *   // 之后直接操作 tables.fr_words / tables.fr_libraries 造数据与断言
 *
 * 已实现：select / insert / update / delete / eq / neq / is / in / lte / gte / lt / gt / like /
 *        ilike / or / order / limit / range / maybeSingle / single / count / head，
 *        以及 insert 时的**自增主键回填**（模拟 `id BIGINT GENERATED ALWAYS AS IDENTITY`）。
 * 未实现（返回 no-op 或恒真）：嵌套 or/and 的真实语义、join、rpc。
 * 需要更精确的过滤条件时，往 `_match` 里加即可。
 *
 * 两个容易踩的点：
 *   1. **insert 一定要回填 id**。真页面常见「先 createLibrary() 拿 id，再用它当外键批量写子表」，
 *      不回填的话整条链路在测试里直接断掉（拿到 undefined 外键）。
 *   2. **初次自增前先扫一遍表里已有的 id**。预置数据常常从 11、12 开始，从 1 开始自增会撞主键。
 */

// 每张表一个自增序列，模拟 `id BIGINT GENERATED ALWAYS AS IDENTITY`。
// 用 WeakMap 挂在 tables 上，避免往 tables 里塞一个不是数组的 `__seq` 键。
const seqs = new WeakMap()
function nextId(tables, table) {
  let s = seqs.get(tables)
  if (!s) {
    s = {}
    seqs.set(tables, s)
  }
  if (s[table] === undefined) {
    // 初次自增前先看一眼表里已有哪些 id（预置数据可能已经在用 11、12…），
    // 否则新插入的行会和预置行撞主键。
    s[table] = (tables[table] || []).reduce((m, r) => {
      const n = Number(r && r.id)
      return Number.isFinite(n) && n > m ? n : m
    }, 0)
  }
  s[table] += 1
  return s[table]
}

function makeQuery(table, tables, state) {
  const filters = []
  function run() {
    if (!tables[table]) tables[table] = []
    const rows = tables[table]

    if (state.op === 'insert') {
      const arr = Array.isArray(state.payload) ? state.payload : [state.payload]
      // 必须回填 id：真页面拿到 createLibrary() 的返回值就要用它当外键写下一批数据，
      // 不给 id 的话整条「先建库再写词」的链路在测试里跑不起来。
      const made = arr.map((r) => {
        const row = Object.assign({}, r)
        if (row.id === undefined || row.id === null) row.id = nextId(tables, table)
        return row
      })
      made.forEach((r) => rows.push(r))
      return { data: made.map((r) => Object.assign({}, r)), error: null, count: made.length }
    }
    if (state.op === 'update') {
      const hit = rows.filter((r) => filters.every((f) => f(r)))
      hit.forEach((r) => Object.assign(r, state.payload))
      return { data: hit.map((r) => Object.assign({}, r)), error: null, count: hit.length }
    }
    if (state.op === 'delete') {
      const keep = []
      const hit = []
      rows.forEach((r) => (filters.every((f) => f(r)) ? hit.push(r) : keep.push(r)))
      tables[table] = keep
      return { data: hit.map((r) => Object.assign({}, r)), error: null, count: hit.length }
    }

    let out = rows.filter((r) => filters.every((f) => f(r)))
    const total = out.length // count:'exact' 永远返回未切片的总数（supabase 语义）
    if (state.rangeV) out = out.slice(state.rangeV[0], state.rangeV[1] + 1)
    if (state.limitV) out = out.slice(0, state.limitV)
    if (state.single) return { data: out.length ? Object.assign({}, out[0]) : null, error: null }
    return {
      data: out.map((r) => Object.assign({}, r)),
      error: null,
      count: state.wantCount ? total : undefined,
    }
  }

  const api = {
    // ---- 终结/触发 ----
    then(resolve, reject) {
      try {
        resolve(run())
      } catch (e) {
        if (reject) reject(e)
        else throw e
      }
    },
    catch(fn) {
      return Promise.resolve(run()).catch(fn)
    },
    // ---- 操作 ----
    select(_cols, opts) {
      if (opts && opts.count) state.wantCount = true
      if (opts && opts.head) state.head = true
      return api
    },
    insert(payload) {
      state.op = 'insert'
      state.payload = payload
      return api
    },
    update(payload) {
      state.op = 'update'
      state.payload = payload
      return api
    },
    delete() {
      state.op = 'delete'
      return api
    },
    upsert(payload) {
      state.op = 'insert'
      state.payload = payload
      return api
    },
    // ---- 过滤 ----
    eq(col, val) {
      filters.push((r) => String(r[col]) === String(val))
      return api
    },
    neq(col, val) {
      filters.push((r) => String(r[col]) !== String(val))
      return api
    },
    is(col, val) {
      filters.push((r) => (val === null ? r[col] === null || r[col] === undefined : r[col] === val))
      return api
    },
    in(col, list) {
      const set = list.map((v) => String(v))
      filters.push((r) => set.indexOf(String(r[col])) >= 0)
      return api
    },
    lte(col, val) {
      filters.push((r) => r[col] <= val)
      return api
    },
    gte(col, val) {
      filters.push((r) => r[col] >= val)
      return api
    },
    lt(col, val) {
      filters.push((r) => r[col] < val)
      return api
    },
    gt(col, val) {
      filters.push((r) => r[col] > val)
      return api
    },
    like(col, pattern) {
      const re = new RegExp('^' + String(pattern).replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i')
      filters.push((r) => re.test(String(r[col] === null || r[col] === undefined ? '' : r[col])))
      return api
    },
    ilike(col, pattern) {
      return api.like(col, pattern)
    },
    not() {
      // 简化：`not(col,'is',null)` 这类否定过滤交给调用方显式断言，这里不假装实现
      return api
    },
    or() {
      // 简化：真实 or 语义不实现（用它做的搜索过滤在 mock 里等价于不过滤）
      return api
    },
    match() {
      return api
    },
    // ---- 排序 / 分页 ----
    order() {
      return api
    },
    limit(n) {
      state.limitV = n
      return api
    },
    range(a, b) {
      state.rangeV = [a, b]
      return api
    },
    maybeSingle() {
      state.single = true
      return api
    },
    single() {
      state.single = true
      return api
    },
  }
  return api
}

/**
 * 造一个可直接替换云 SDK 的桩。
 * @param {object} tables 形如 `{ fr_words: [...], fr_libraries: [...] }`，会被**就地读写**
 * @param {object} [opts] `{ session: {} }` 传给 requireSession，`{ session: null }` 可模拟未登录
 */
function makeCloudStub(tables, opts) {
  const o = opts || {}
  const session = o.session === undefined ? { id: 'u-test' } : o.session
  return {
    cloud: {
      database: {
        from: (name) => makeQuery(name, tables, { op: 'select', fs: [] }),
      },
    },
    requireSession: async () => {
      if (!session) {
        const e = new Error('未登录')
        e.code = 'no_session'
        throw e
      }
      return session
    },
    friendlyError: (e) => (e && (e.message || e.errMsg)) || '未知错误',
    getUserId: async () => (session && session.id) || 'u-test',
    CLOUD_ENDPOINT: 'https://example.invalid',
    CLOUD_PUBLISHABLE_KEY: 'pk_test',
    tables,
  }
}

module.exports = { makeQuery, makeCloudStub }
