const api = require('../../utils/api')
const llm = require('../../utils/llm')
const sheet = require('../../utils/sheet')
const storage = require('../../utils/storage')
const { friendlyError } = require('../../utils/cloud')

// 渲染上限：2000 条全渲染会把视图层拖垮，只把前 100 条放进 data 供预览与编辑，
// 全量留在 this.allRows（页面实例属性，不进 setData）。
const PREVIEW_LIMIT = 100
// 一次「AI 补全缺失释义」最多补多少条 —— 每补一条就是一次模型调用，必须有个上限
const AI_BULK_LIMIT = 20
// 批量写库的分片大小，避免单次请求体过大
const WRITE_CHUNK = 200

const LEVELS = ['A1', 'A2', 'B1', 'B2']

const FIELDS = [
  { key: 'word', label: '单词', required: true },
  { key: 'meaning_zh', label: '释义' },
  { key: 'phonetic', label: '音标' },
  { key: 'pos', label: '词性' },
  { key: 'example_fr', label: '例句' },
  { key: 'example_zh', label: '例句翻译' },
]
const FIELD_KEYS = FIELDS.map((f) => f.key)

const REASON_TEXT = {
  legacy_xls: '.xls 是旧版 Excel 的二进制格式，端上读不了。请在 Excel 里「另存为 → .xlsx」再导入。',
  bad_zip: '这个文件不是有效的 .xlsx（压缩包结构已损坏）。',
  no_sheet: '这个 Excel 里没有找到工作表。',
  unzip_failed: 'Excel 解压失败，文件可能已损坏。',
  empty: '文件里没有读到内容。',
  no_word: '按当前的列设置没有解析出生词，请检查「单词」列是不是选错了。',
  bad_input: '没有读到文件内容。',
}

let uid = 0
function nextKey() {
  uid += 1
  return 'r' + uid
}

Page({
  data: {
    step: 'pick', // 'pick' | 'preview'
    levels: LEVELS,
    sheetMaxMB: Math.round(storage.SHEET_MAX_SIZE / 1024 / 1024),
    previewLimit: PREVIEW_LIMIT,
    aiBulkLimit: AI_BULK_LIMIT,

    // ---- 目标词库 ----
    libraries: [],
    loadingLibs: true,
    targetLibraryId: 0, // 0 = 新建
    newLibraryName: '',
    newLibraryLevel: '',
    ungroupedTotal: 0,

    // ---- 来源 ----
    textInput: '',
    fileName: '',
    fileSize: '',
    parsing: false,

    // ---- 解析结果 ----
    warnings: [],
    truncated: false,
    skipped: 0,
    titleRow: '',
    headerRowIndex: 0,
    totalColumns: 0,
    rawPreview: [],

    // ---- 列映射 ----
    hasHeader: true,
    mappingFields: FIELDS,
    columnOptions: [],
    pickIndex: {},
    mappingLabel: {},

    // ---- 预览与统计 ----
    previewRows: [],
    totalParsed: 0,
    hiddenCount: 0,
    importCount: 0,
    dupCount: 0,
    elsewhereCount: 0,
    missingMeaning: 0,
    aiBulkBusy: false,
    aiBulkDone: 0,
    aiBulkTotal: 0,
    aiBusyKey: '',

    saving: false,
    error: '',
  },

  onLoad() {
    this.allRows = []
    this.grid = null
    this.parsed = null
    this.libraryKeys = { inLibrary: Object.create(null), elsewhere: Object.create(null) }
    this.refreshLibraries()
  },

  // ---------------- 词库 ----------------

  async refreshLibraries() {
    this.setData({ loadingLibs: true })
    try {
      const [libs, stats] = await Promise.all([api.listLibraries(), api.libraryStats()])
      const libraries = libs.map((l) => {
        const s = stats.byLibrary[String(l.id)] || { total: 0, mastered: 0 }
        return { id: l.id, name: l.name, level: l.level || '', total: s.total, mastered: s.mastered }
      })
      const patch = { libraries, loadingLibs: false, ungroupedTotal: stats.ungrouped.total }
      const current = this.data.targetLibraryId
      if (!libraries.length) patch.targetLibraryId = 0
      else if (!libraries.some((l) => l.id === current)) patch.targetLibraryId = libraries[0].id
      this.setData(patch)
      await this.refreshLibraryKeys()
    } catch (e) {
      this.setData({ loadingLibs: false })
      wx.showToast({ title: friendlyError(e), icon: 'none' })
    }
  },

  /**
   * 拉一次「去重基准」：
   * - inLibrary：目标词库内已有的词 → 默认跳过（同一份词表重复导入不该产生重复行）；
   * - elsewhere：你其他词库/教材里出现过的词 → 只提示，不拦。
   */
  async refreshLibraryKeys() {
    try {
      this.libraryKeys = await api.wordKeysForLibrary(this.data.targetLibraryId || null)
    } catch (e) {
      this.libraryKeys = { inLibrary: Object.create(null), elsewhere: Object.create(null) }
    }
  },

  async pickLibrary(e) {
    const id = Number(e.currentTarget.dataset.id) || 0
    if (id === this.data.targetLibraryId) return
    this.setData({ targetLibraryId: id })
    await this.refreshLibraryKeys()
    if (this.allRows.length) this.rebuild()
  },

  onNewLibraryName(e) {
    this.setData({ newLibraryName: e.detail.value })
  },

  pickLevel(e) {
    const level = e.currentTarget.dataset.level || ''
    this.setData({ newLibraryLevel: level === this.data.newLibraryLevel ? '' : level })
  },

  /** 保存前的词库校验，两条入口都要过 */
  ensureLibraryName() {
    if (this.data.targetLibraryId) return true
    if (this.data.newLibraryName.trim()) return true
    this.setData({ error: '请先给新词库起个名字（例如：B1 库、工程师库）' })
    wx.showToast({ title: '请填写词库名称', icon: 'none' })
    return false
  },

  // ---------------- 解析入口 ----------------

  chooseSheet() {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: storage.ALLOWED_SHEET_EXT,
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0]
        if (!file) return
        const ext = storage.extOf(file.name)
        const size = Number(file.size) || storage.fileSizeOf(file.path)
        if (size > storage.SHEET_MAX_SIZE) {
          wx.showToast({
            title: '文件超过 ' + Math.round(storage.SHEET_MAX_SIZE / 1024 / 1024) + 'MB，请拆分后再导入',
            icon: 'none',
          })
          return
        }
        this.parseFile(file.path, file.name, ext, size)
      },
      fail: () => {},
    })
  },

  async parseFile(path, name, ext, size) {
    this.setData({ parsing: true, error: '' })
    let bytes = null
    try {
      bytes = await storage.readAsArrayBuffer(path)
      const res = sheet.extractWords(bytes, { ext })
      if (!res.words.length) {
        this.setData({ parsing: false, error: REASON_TEXT[res.reason] || '没有解析出生词。' })
        return
      }
      await this.applyParsed(res, { fileName: name, fileSize: storage.formatSize(size) })
    } catch (e) {
      this.setData({ parsing: false, error: friendlyError(e) })
    } finally {
      bytes = null
    }
  },

  onTextInput(e) {
    this.setData({ textInput: e.detail.value })
  },

  async parseTextInput() {
    const text = this.data.textInput.trim()
    if (!text) {
      wx.showToast({ title: '请先粘贴文本', icon: 'none' })
      return
    }
    this.setData({ parsing: true, error: '' })
    const res = sheet.extractWordsFromText(text)
    if (!res.words.length) {
      this.setData({ parsing: false, error: REASON_TEXT[res.reason] || '没有解析出生词。' })
      return
    }
    await this.applyParsed(res, { fileName: '粘贴文本', fileSize: '' })
  },

  /** 解析结果 → 预览态。this.grid 留在实例上，不进 setData。 */
  async applyParsed(res, meta) {
    this.parsed = res
    this.grid = res.grid
    let width = 0
    res.grid.forEach((row) => {
      if (row.length > width) width = row.length
    })
    if (res.headers && res.headers.length > width) width = res.headers.length
    const labels = sheet.columnLabels(res, width)
    this.rawWidth = width

    const mapping = Object.assign({}, res.mapping)
    this.setData(
      Object.assign(
        {
          step: 'preview',
          parsing: false,
          hasHeader: res.hasHeader,
          titleRow: res.titleRow || '',
          headerRowIndex: res.headerRowIndex,
          totalColumns: width,
          rawPreview: res.grid
            .slice(0, 4)
            .map((row) => {
              const cells = []
              for (let i = 0; i < width; i++) cells.push(sheet._internals.trimCell(row[i]))
              return cells.join('  |  ')
            }),
          warnings: res.warnings || [],
          truncated: !!res.truncated,
          skipped: res.skipped || 0,
          columnOptions: ['不导入'].concat(labels),
          mapping,
          error: '',
        },
        meta || {},
      ),
    )
    this.syncMappingView()
    this.rebuild()
  },

  /** mapping → picker 的 value / 显示文案 */
  syncMappingView() {
    const mapping = this.data.mapping
    const options = this.data.columnOptions
    const pickIndex = {}
    const mappingLabel = {}
    FIELD_KEYS.forEach((k) => {
      const idx = Number(mapping[k])
      const valid = idx >= 0 && idx + 1 < options.length
      pickIndex[k] = valid ? idx + 1 : 0
      mappingLabel[k] = options[pickIndex[k]]
    })
    this.setData({ pickIndex, mappingLabel })
  },

  onToggleHeader(e) {
    this.setData({ hasHeader: !!e.detail.value })
    this.rebuild()
  },

  onMapping(e) {
    const field = e.currentTarget.dataset.field
    const pick = Number(e.detail.value)
    const col = pick - 1
    if (field === 'word' && col < 0) {
      wx.showToast({ title: '必须指定「单词」列', icon: 'none' })
      return
    }
    const mapping = Object.assign({}, this.data.mapping)
    // 一列只能有一个用途：被抢走的列让回「不导入」
    if (col >= 0) {
      FIELD_KEYS.forEach((k) => {
        if (k !== field && Number(mapping[k]) === col) mapping[k] = -1
      })
    }
    mapping[field] = col
    this.setData({ mapping })
    this.syncMappingView()
    this.rebuild()
  },

  // ---------------- 预览与统计 ----------------

  /** 按当前列映射重新生成词列表；同步去重标记 */
  rebuild() {
    const res = this.parsed
    if (!res || !this.grid) return
    const out = sheet._internals.gridToWords(this.grid, {
      mapping: this.data.mapping,
      hasHeader: this.data.hasHeader,
    })
    const keys = this.libraryKeys || { inLibrary: {}, elsewhere: {} }
    this.allRows = out.words.map((w, i) => {
      const key = w.word.toLowerCase()
      const dup = !!keys.inLibrary[key]
      return {
        key: nextKey(),
        seq: i + 1,
        word: w.word,
        phonetic: w.phonetic,
        pos: w.pos,
        meaning_zh: w.meaning_zh,
        example_fr: w.example_fr,
        example_zh: w.example_zh,
        dup,
        elsewhere: !!keys.elsewhere[key],
        include: !dup,
      }
    })
    this.setData({ skipped: out.skipped })
    if (!this.allRows.length) {
      this.setData({ error: REASON_TEXT.no_word, previewRows: [] })
    } else if (this.data.error === REASON_TEXT.no_word) {
      this.setData({ error: '' })
    }
    this.syncPreview()
    this.syncCounts()
  },

  syncPreview() {
    const rows = this.allRows || []
    this.setData({
      previewRows: rows.slice(0, PREVIEW_LIMIT),
      totalParsed: rows.length,
      hiddenCount: Math.max(0, rows.length - PREVIEW_LIMIT),
    })
  },

  syncCounts() {
    const rows = this.allRows || []
    let importCount = 0
    let dupCount = 0
    let elsewhereCount = 0
    let missingMeaning = 0
    rows.forEach((r) => {
      if (r.dup) {
        dupCount += 1
        return
      }
      if (r.include) {
        importCount += 1
        if (!r.meaning_zh) missingMeaning += 1
        if (r.elsewhere) elsewhereCount += 1
      }
    })
    this.setData({
      importCount,
      dupCount,
      elsewhereCount,
      missingMeaning,
    })
  },

  toggleInclude(e) {
    const i = Number(e.currentTarget.dataset.i)
    const row = this.allRows[i]
    if (!row || row.dup) return
    row.include = !row.include
    this.setData({ ['previewRows[' + i + '].include']: row.include })
    this.syncCounts()
  },

  onRowField(e) {
    const i = Number(e.currentTarget.dataset.i)
    const field = e.currentTarget.dataset.field
    const value = e.detail.value
    const row = this.allRows[i]
    if (!row || FIELD_KEYS.indexOf(field) < 0) return
    row[field] = value
    this.setData({ ['previewRows[' + i + '].' + field]: value })
    if (field === 'meaning_zh') this.syncCounts()
  },

  removeRow(e) {
    const i = Number(e.currentTarget.dataset.i)
    if (!this.allRows[i]) return
    this.allRows.splice(i, 1)
    this.syncPreview()
    this.syncCounts()
  },

  // ---------------- AI 补全 ----------------

  async aiFill(e) {
    const i = Number(e.currentTarget.dataset.i)
    const row = this.allRows[i]
    if (!row) return
    const key = row.key
    this.setData({ aiBusyKey: key })
    try {
      const res = await llm.completeWord(row.word)
      row.meaning_zh = row.meaning_zh || res.meaning_zh || ''
      row.phonetic = row.phonetic || res.phonetic || ''
      row.pos = row.pos || res.pos || ''
      row.example_fr = row.example_fr || res.example_fr || ''
      row.example_zh = row.example_zh || res.example_zh || ''
      await this.patchPreviewRow(i)
      this.setData({ aiBusyKey: '' })
      this.syncCounts()
    } catch (err) {
      this.setData({ aiBusyKey: '' })
      wx.showToast({ title: friendlyError(err), icon: 'none' })
    }
  },

  /** 把 this.allRows[i] 的可编辑字段回写到视图（只动一行，避免整表重渲染） */
  async patchPreviewRow(i) {
    const row = this.allRows[i]
    if (!row || i >= PREVIEW_LIMIT) return
    this.setData({
      ['previewRows[' + i + '].word']: row.word,
      ['previewRows[' + i + '].meaning_zh']: row.meaning_zh,
      ['previewRows[' + i + '].phonetic']: row.phonetic,
      ['previewRows[' + i + '].pos']: row.pos,
      ['previewRows[' + i + '].example_fr']: row.example_fr,
      ['previewRows[' + i + '].example_zh']: row.example_zh,
    })
  },

  /** 批量补全「有词没释义」的条目。上限 AI_BULK_LIMIT，超出部分让用户分批来。 */
  async aiBulk() {
    if (this.data.aiBulkBusy) return
    const targets = []
    for (let i = 0; i < this.allRows.length && targets.length < AI_BULK_LIMIT; i++) {
      const r = this.allRows[i]
      if (!r.dup && r.include && r.word && !r.meaning_zh) targets.push(i)
    }
    if (!targets.length) {
      wx.showToast({ title: '没有需要补全的条目', icon: 'none' })
      return
    }
    this.setData({ aiBulkBusy: true, aiBulkDone: 0, aiBulkTotal: targets.length })
    let ok = 0
    try {
      for (let n = 0; n < targets.length; n++) {
        const i = targets[n]
        const row = this.allRows[i]
        try {
          const res = await llm.completeWord(row.word)
          if (!row.meaning_zh && res.meaning_zh) row.meaning_zh = res.meaning_zh
          if (!row.phonetic && res.phonetic) row.phonetic = res.phonetic
          if (!row.pos && res.pos) row.pos = res.pos
          ok += 1
        } catch (err) {
          // 单条失败不该中断整批，继续下一条
        }
        this.setData({ aiBulkDone: n + 1 })
        if (i < PREVIEW_LIMIT) await this.patchPreviewRow(i)
      }
      this.syncCounts()
      wx.showToast({ title: '已补全 ' + ok + '/' + targets.length + ' 条', icon: 'none' })
    } finally {
      this.setData({ aiBulkBusy: false })
    }
  },

  // ---------------- 保存 ----------------

  back() {
    this.setData({ step: 'pick', rawPreview: [], warnings: [], error: '' })
  },

  backToStart() {
    this.grid = null
    this.parsed = null
    this.allRows = []
    this.setData({
      step: 'pick',
      previewRows: [],
      totalParsed: 0,
      importCount: 0,
      dupCount: 0,
      elsewhereCount: 0,
      missingMeaning: 0,
      rawPreview: [],
      warnings: [],
      truncated: false,
      fileName: '',
      fileSize: '',
      error: '',
    })
  },

  async save() {
    const rows = (this.allRows || []).filter((r) => !r.dup && r.include && String(r.word || '').trim())
    if (!rows.length) {
      wx.showToast({ title: '没有可导入的新词', icon: 'none' })
      return
    }
    if (!this.ensureLibraryName()) return
    this.setData({ saving: true, error: '' })
    try {
      let libraryId = this.data.targetLibraryId
      if (!libraryId) {
        const lib = await api.createLibrary({
          name: this.data.newLibraryName.trim(),
          level: this.data.newLibraryLevel,
        })
        if (!lib || !lib.id) throw new Error('词库创建失败')
        libraryId = lib.id
      }
      const payload = rows.map((r) => ({
        library_id: libraryId,
        word: String(r.word).trim(),
        phonetic: r.phonetic || '',
        pos: r.pos || '',
        meaning_zh: r.meaning_zh || '',
        example_fr: r.example_fr || '',
        example_zh: r.example_zh || '',
        source: 'import',
      }))
      // 分片写入：一次几百条容易顶到请求体上限，失败了还不好定位
      for (let i = 0; i < payload.length; i += WRITE_CHUNK) {
        await api.createWords(payload.slice(i, i + WRITE_CHUNK))
      }
      getApp().markDirty()
      wx.showToast({ title: '已导入 ' + payload.length + ' 个词', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 700)
    } catch (e) {
      this.setData({ saving: false, error: friendlyError(e) })
    }
  },
})
