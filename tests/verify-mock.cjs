// 验证 scripts/cloud_db_mock.cjs 能当云 SDK 的替身驱动真 api.js
const Module = require('module')
const path = require('path')
const { makeCloudStub } = require('./fixtures/cloud_db_mock.cjs')

const PROJ = path.resolve(__dirname, '..', 'french-vocab-miniprogram')

const tables = {
  fr_libraries: [
    { id: 1, name: 'B1 库' },
    { id: 2, name: '工程师库' },
  ],
  fr_words: [
    { id: 11, word: 'bonjour', library_id: 1, status: 'learning', stage: 0, due_date: null },
    { id: 12, word: 'merci', library_id: 1, status: 'mastered', stage: 5, due_date: '2026-01-01' },
    { id: 13, word: 'livre', library_id: 2, status: 'learning', stage: 2, due_date: '2026-02-01' },
    { id: 14, word: 'eau', library_id: null, status: 'learning', stage: 0, due_date: null },
    { id: 15, word: 'train', library_id: null, status: 'mastered', stage: 5, due_date: '2026-01-01' },
  ],
}

const cloudStub = makeCloudStub(tables)
const origLoad = Module._load
Module._load = function (req) {
  if (/(^|\/)cloud$/.test(req)) return cloudStub
  return origLoad.apply(this, arguments)
}

const api = require(path.join(PROJ, 'utils/api.js'))

let p = 0
let f = 0
const ck = (c, l, e) => {
  if (c) p++
  else {
    f++
    console.log('FAIL', l, JSON.stringify(e))
  }
}

;(async () => {
  const all = await api.listWords({ page: 1, size: 50, libraryId: '' })
  ck(all.total === 5, '全部 5', all.total)

  const none = await api.listWords({ page: 1, size: 50, libraryId: 'none' })
  ck(none.total === 2 && none.list.every((w) => w.library_id === null), 'none 分支', none.total)

  const l1 = await api.listWords({ page: 1, size: 50, libraryId: 1 })
  ck(l1.total === 2, 'libraryId=1', l1.total)

  const keys = await api.wordKeysForLibrary(1)
  ck(keys.inLibrary.bonjour && keys.elsewhere.livre, '去重分桶', keys)

  const st = await api.libraryStats()
  ck(st.byLibrary['1'].total === 2 && st.byLibrary['1'].fresh === 1 && st.ungrouped.total === 2, '统计', st)

  const lib = await api.createLibrary({ name: '  A2 库  ', level: ' A2 ' })
  ck(lib.name === 'A2 库' && lib.level === 'A2', '建库 trim', lib)

  const ren = await api.updateLibrary(1, { name: 'B1 核心库' })
  ck(ren.name === 'B1 核心库' && !!ren.updated_at, '改名', ren.name)

  let threw = false
  try {
    await api.updateLibrary(999, { name: 'x' })
  } catch (e) {
    threw = true
  }
  ck(threw, '无匹配行抛错（RLS 语义）')

  const casc = await api.deleteLibraryCascade(1)
  ck(casc.words === 2 && casc.deleted === 1, '级联删除', casc)

  const n2 = await api.listWords({ page: 1, size: 50, libraryId: '' })
  ck(n2.total === 3, '级联后剩 3', n2.total)

  console.log('cloud_db_mock 驱动真 api.js：', p + '/' + (p + f))
  process.exit(f ? 1 : 0)
})()
