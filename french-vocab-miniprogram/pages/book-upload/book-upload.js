const api = require('../../utils/api')
const llm = require('../../utils/llm')
const pdf = require('../../utils/pdf')
const docx = require('../../utils/docx')
const { friendlyError } = require('../../utils/cloud')
const storage = require('../../utils/storage')

// 端上解析的建议上限：超过只做风险提示，用户确认后仍可强制尝试（forceReadDoc）。
// 之所以是「建议」而不是硬上限：小程序的 readFile 会把整份文件读进 JS 内存，
// 25MB 是经验上的舒适区，但 26MB 并不比 25MB 更危险，一刀切地禁止会平白断掉一条路。
const DOC_PARSE_LIMIT = 25 * 1024 * 1024

const DOC_REASON = {
  no_text_layer: '这是扫描版 PDF（整页是图片，没有文字层），无法直接读取文字。',
  encrypted: '该 PDF 带有加密保护（权限或打开口令），无法直接读取文字。',
  low_quality: '该 PDF 的字体编码无法解析，读出来的文字是乱码，已放弃直接识别。',
  no_pages: '没有从该 PDF 中读到页面内容。',
  parse_failed: '该 PDF 结构异常，无法解析。',
  empty: '文档内容为空。',
  read_failed: '读取文档失败，文件可能已损坏或无法访问。可改用截图识别或粘贴文本。',
  oom: '解析中断：文件较大，手机内存不足。建议先用工具压缩 PDF，或改用截图识别 / 粘贴文本。',
  not_docx: '这是旧版 .doc 格式，无法直接读取文字。请在 Word 里另存为 .docx 再上传，或改用截图/粘贴文本。',
  no_document: '这个 Word 文件里没有找到正文（可能是 .doc 改名或文件损坏）。',
  unzip_failed: 'Word 文件解压失败，可能已损坏。',
  bad_zip: 'Word 文件结构异常，无法解析。',
}

// 扫描版 PDF 最多送多少页去 AI 识别：每页是一次多模态请求，
// 页数太多既慢又贵，先给前几页让用户确认效果，够用再加。
const MAX_SCANNED_PAGES = 8
// 抽出来的页面图总量上限（字节），防止个别超大扫描页把内存顶爆
const MAX_SCANNED_BYTES = 6 * 1024 * 1024

let uid = 0
function nextKey(prefix) {
  uid += 1
  return prefix + '-' + Date.now() + '-' + uid
}

function toEditableUnits(parsedUnits, existingKeys) {
  return (parsedUnits || []).map((unit) => ({
    key: nextKey('u'),
    title: unit.title || '未命名单元',
    summary: unit.summary || '',
    words: (unit.words || []).map((w) => {
      const key = String(w.word || '').trim().toLowerCase()
      return {
        key: nextKey('w'),
        word: w.word || '',
        phonetic: w.phonetic || '',
        pos: w.pos || '',
        meaning_zh: w.meaning_zh || '',
        dup: !!(existingKeys && key && existingKeys[key]),
        include: true,
      }
    }),
  }))
}

Page({
  data: {
    step: 'choose',
    levels: ['A1', 'A2', 'B1', 'B2'],
    level: 'A1',
    title: '',
    showTextInput: false,
    textInput: '',
    parsing: false,
    progressText: '',
    units: [],
    totalWords: 0,
    saving: false,
    error: '',
    docHint: false,
    docName: '',
    docPath: '',
    docSize: '',
    docHeadline: '',
    // 超过上传上限时，改为「不上传、仅本地识别」
    oversize: false,
    localOnly: false,
    sourceType: 'text',
    uploading: false,
    uploadPercent: 0,
    maxSizeMB: storage.MAX_SIZE_MB,
    parseLimitMB: Math.round(DOC_PARSE_LIMIT / 1024 / 1024),
    // '' | 'reading' | 'ok' | 'fail' | 'large' | 'converting' | 'scanned'
    //   large      = 超过建议上限，待用户确认
    //   converting = 正在把 PDF 每页渲染成图片
    //   scanned    = 已转成整页图片，等待 / 正在交给 AI 识别
    pdfState: '',
    pdfInfo: '',
    docKindLabel: 'PDF',
    // 当前文档是否为 PDF —— 只有 PDF 支持「转成图片识别」
    isPdf: false,
    // 是否已经试过转图片且没抽到可用整页图，避免反复给出同一个无效入口
    imageTried: false,
    // 已转出的页面图数量（按钮文案用）
    scannedCount: 0,
  },

  onTitle(e) {
    this.setData({ title: e.detail.value })
  },
  onLevel(e) {
    this.setData({ level: e.currentTarget.dataset.level })
  },
  onTextInput(e) {
    this.setData({ textInput: e.detail.value })
  },
  openTextInput() {
    this.setData({ showTextInput: true })
  },
  backToChoose() {
    this.docText = ''
    this.pendingDoc = null
    this.scannedPages = null
    this.setData({
      step: 'choose',
      error: '',
      progressText: '',
      parsing: false,
      oversize: false,
      localOnly: false,
      docHint: false,
      docHeadline: '',
      pdfState: '',
      pdfInfo: '',
      isPdf: false,
      imageTried: false,
      scannedCount: 0,
    })
  },

  // ---------- 图片通道 ----------
  chooseImage() {
    wx.chooseMedia({
      count: 9,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
      success: (res) => {
        const paths = (res.tempFiles || []).map((f) => f.tempFilePath).filter(Boolean)
        if (paths.length) this.parseImages(paths)
      },
      fail: () => {},
    })
  },

  async parseImages(paths) {
    if (!this.data.title.trim()) {
      this.setData({ title: '图片教材 ' + this.dateFormat() })
    }
    this.setData({ step: 'parsing', error: '', progressText: 'AI 识别中 0/' + paths.length + ' 页' })
    try {
      const images = []
      for (let i = 0; i < paths.length; i++) {
        const base64 = await storage.readAsBase64(paths[i])
        images.push({ base64, mime: 'image/jpeg' })
      }
      const units = await llm.parseTextbookImages(images, (done, total) => {
        this.setData({ progressText: 'AI 识别中 ' + done + '/' + total + ' 页' })
      })
      // 已上传 PDF/Word 原件时保留其来源类型，避免被图片通道覆盖
      this.enterReview(units, this.data.docPath ? this.data.sourceType : 'image')
    } catch (e) {
      this.setData({ step: 'choose', error: friendlyError(e) })
    }
  },

  // ---------- 文档通道（PDF/Word） ----------
  chooseDoc() {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: storage.ALLOWED_DOC_EXT,
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0]
        if (!file) return
        const size = Number(file.size) || storage.fileSizeOf(file.path)
        const ext = storage.extOf(file.name)
        this.pendingDoc = { path: file.path, name: file.name, size, ext }
        // 超过上传上限：不直接拒绝，改为「不上传、直接在手机上识别文字」
        if (size > storage.MAX_SIZE) {
          this.setData({
            oversize: true,
            localOnly: true,
            docHint: false,
            docName: file.name,
            docSize: storage.formatSize(size),
            docPath: '',
            pdfState: '',
            pdfInfo: '',
            isPdf: ext === 'pdf',
            imageTried: false,
            scannedCount: 0,
            error: '',
          })
          return
        }
        this.doUploadDoc(file, size)
      },
      fail: () => {},
    })
  },

  /** 超大文件（> 50MB）走不了云端，但在本机读文字层不需要上传 */
  async parseLocalOnly() {
    const pending = this.pendingDoc
    if (!pending || !pending.path) {
      wx.showToast({ title: '请重新选择文件', icon: 'none' })
      return
    }
    if (pending.ext === 'doc') {
      this.setData({
        oversize: false,
        docHint: true,
        localOnly: true,
        docHeadline: '《' + pending.name + '》' + storage.formatSize(pending.size) + ' · 未上传，仅本地识别',
        sourceType: 'word',
        pdfState: 'fail',
        pdfInfo: DOC_REASON.not_docx,
      })
      return
    }
    this.setData({
      oversize: false,
      docHint: true,
      localOnly: true,
      docName: pending.name,
      docSize: storage.formatSize(pending.size),
      docHeadline: '《' + pending.name + '》' + storage.formatSize(pending.size) + ' · 未上传，仅本地识别',
      docPath: '',
      sourceType: pending.ext === 'pdf' ? 'pdf' : 'word',
      isPdf: pending.ext === 'pdf',
      imageTried: false,
      scannedCount: 0,
      error: '',
      pdfState: '',
      pdfInfo: '',
    })
    wx.showToast({ title: '未上传，直接在手机上识别', icon: 'none' })
    await this.readDocText(pending.path, pending.size, pending.ext, { force: true })
  },

  async doUploadDoc(file, size) {
    const ext = storage.extOf(file.name)
    // 换文件时先清掉上一次的正文，避免失败后误用旧内容
    this.docText = ''
    this.pendingDoc = { path: file.path, name: file.name, size, ext }
    this.setData({
      uploading: true,
      uploadPercent: 0,
      docName: file.name,
      docSize: storage.formatSize(size),
      docHeadline: '《' + file.name + '》已上传到教材库（' + storage.formatSize(size) + '）',
      oversize: false,
      localOnly: false,
      isPdf: ext === 'pdf',
      imageTried: false,
      scannedCount: 0,
      pdfState: '',
      pdfInfo: '',
      error: '',
    })
    try {
      const uploaded = await storage.uploadBookFile(file.path, file.name, (percent) => {
        this.setData({ uploadPercent: percent })
      })
      this.setData({ uploading: false, uploadPercent: 100, docSize: storage.formatSize(uploaded.size) })
      if (ext === 'txt') {
        const text = await storage.readAsText(file.path, storage.TXT_READ_LIMIT)
        this.setData({
          docPath: uploaded.path,
          docName: file.name,
          sourceType: 'text',
          showTextInput: true,
          textInput: text,
        })
        if (size > storage.TXT_READ_LIMIT) {
          wx.showToast({ title: '文本较长，已载入前 120KB', icon: 'none' })
        }
        return
      }
      this.setData({
        docHint: true,
        docName: file.name,
        docPath: uploaded.path,
        docSize: storage.formatSize(uploaded.size),
        docHeadline: '《' + file.name + '》已上传到教材库（' + storage.formatSize(uploaded.size) + '）',
        sourceType: ext === 'pdf' ? 'pdf' : 'word',
      })
      wx.showToast({ title: '已上传 ' + storage.formatSize(uploaded.size), icon: 'success' })
      if (ext === 'pdf' || ext === 'docx' || ext === 'doc') {
        await this.readDocText(file.path, size, ext)
      }
    } catch (e) {
      this.setData({ uploading: false, uploadPercent: 0, error: friendlyError(e) })
    }
  },

  /**
   * 读取文档文字层：能读到就把正文留在 this.docText（不进 setData，避免大字符串过视图层），
   * 读不到就按原因给出替代路径。扫描版 PDF、旧版 .doc 没有可读文字层，只能走截图/拍照识别。
   *
   * 超过 DOC_PARSE_LIMIT 时不直接拒绝：先停在 'large' 状态给风险提示，
   * 用户点「仍要尝试」后带 { force: true } 再进这里真正解析。
   */
  async readDocText(filePath, size, ext, opts) {
    const force = !!(opts && opts.force)
    this.docText = ''
    // 记住当前文档，供「仍要尝试」「转图片」和降级路径复用
    this.pendingDoc = { path: filePath, name: this.data.docName, size, ext }
    // 每换一次解析目标就重置「转图片」的尝试标记
    this.setData({ isPdf: ext === 'pdf', imageTried: false, scannedCount: 0 })
    if (ext === 'doc') {
      this.setData({ pdfState: 'fail', pdfInfo: DOC_REASON.not_docx })
      return
    }
    if (size > DOC_PARSE_LIMIT && !force) {
      this.setData({
        pdfState: 'large',
        pdfInfo:
          '文件 ' +
          storage.formatSize(size) +
          '，超过端上解析建议上限 ' +
          Math.round(DOC_PARSE_LIMIT / 1024 / 1024) +
          'MB，解析时会把整份文件读进手机内存，可能较慢或中途失败。',
      })
      return
    }
    this.setData({ pdfState: 'reading', pdfInfo: '' })
    let bytes = null
    try {
      bytes = await storage.readAsArrayBuffer(filePath)
      const res =
        ext === 'pdf'
          ? pdf.extractPdfText(bytes, { maxPages: force ? 80 : 60, maxChars: 60000 })
          : docx.extractDocxText(bytes)
      const ok = ext === 'pdf' ? res.hasTextLayer : res.hasText
      if (ok) {
        this.docText = res.text
        const clipped = res.text.length > llm.MAX_PARSE_CHARS
        const head =
          ext === 'pdf'
            ? '已读取 ' + res.pageCount + ' 页共 ' + res.charCount + ' 个字符'
            : '已读取正文 ' + res.charCount + ' 个字符'
        this.setData({
          pdfState: 'ok',
          pdfInfo: head + (clipped ? '（超出部分不会解析）' : ''),
          docKindLabel: ext === 'pdf' ? 'PDF' : 'Word',
        })
      } else {
        this.setData({ pdfState: 'fail', pdfInfo: DOC_REASON[res.reason] || DOC_REASON.no_text_layer })
        // 扫描版 PDF 还有救：把内嵌的整页图抽出来交给多模态模型识别
        if (ext === 'pdf' && res.reason === 'no_text_layer') {
          await this.extractScannedPages(bytes, { auto: true })
        }
      }
    } catch (e) {
      const msg = String((e && (e.message || e.errMsg)) || '')
      // 大文件最容易翻车的不是「读不到」，而是直接把内存打爆，这里单独给一句能对症的提示
      const oom = /memory|out of|allocation|too large|RangeError|maximum/i.test(msg)
      this.setData({ pdfState: 'fail', pdfInfo: oom ? DOC_REASON.oom : DOC_REASON.read_failed })
    } finally {
      // 及时断开对大缓冲区的引用，让引擎有机会回收
      bytes = null
    }
  },

  /** 用户确认「仍要尝试」后，按当前文档强制解析 */
  async forceReadDoc() {
    const pending = this.pendingDoc
    if (!pending || !pending.path) {
      wx.showToast({ title: '请重新选择文件', icon: 'none' })
      return
    }
    wx.showToast({ title: '正在解析，请保持前台', icon: 'none' })
    await this.readDocText(pending.path, pending.size, pending.ext, { force: true })
  },

  /**
   * 主动把 PDF 每页转成图片再识别。
   * 适用：文字层是乱码 / 公式·表格·图片多 / 想按原版式识别 / 超大的扫描件。
   * 转换只在本机完成（不上传、不耗流量），转完停在确认状态，由用户决定何时开始识别。
   */
  async convertPdfToImages() {
    const pending = this.pendingDoc
    if (!pending || !pending.path) {
      wx.showToast({ title: '请重新选择文件', icon: 'none' })
      return
    }
    if (pending.ext !== 'pdf') {
      wx.showToast({ title: '仅 PDF 支持转图片', icon: 'none' })
      return
    }
    // 从「超过上传上限」的分支进来时，顺带把引导卡片切到文档面板
    const patch = {
      pdfState: 'converting',
      pdfInfo: '正在把 PDF 每页转成图片…（页数多时会慢一些，请保持前台）',
      oversize: false,
      docHint: true,
    }
    if (!this.data.docHint) {
      patch.localOnly = true
      patch.docPath = ''
      patch.sourceType = 'pdf'
      patch.docHeadline =
        '《' + pending.name + '》' + storage.formatSize(pending.size) + ' · 未上传，仅本地转图片'
    }
    this.setData(patch)
    wx.showToast({ title: '正在转换，请保持前台', icon: 'none' })

    let bytes = null
    try {
      bytes = await storage.readAsArrayBuffer(pending.path)
      await this.extractScannedPages(bytes, { auto: false })
    } catch (e) {
      const msg = String((e && (e.message || e.errMsg)) || '')
      // 大文件最常见的翻车方式是内存被顶爆，单独给一句对症的提示
      const oom = /memory|out of|allocation|too large|RangeError|maximum/i.test(msg)
      this.setData({
        pdfState: 'fail',
        pdfInfo: oom ? DOC_REASON.oom : '转换为图片失败：' + friendlyError(e),
      })
    } finally {
      bytes = null
    }
  },

  /**
   * 把 PDF 每页转成图片，走多模态识别。
   * - auto=true ：无文字层时的自动兜底，转完直接开始识别；
   * - auto=false：用户在「直接识别文字」之外主动选择转图片，转完停在确认状态。
   * 只保留覆盖面积够大（整页扫描）的图，按页码排序，超出上限的页直接舍弃并如实告知。
   */
  async extractScannedPages(bytes, opts) {
    const auto = !(opts && opts.auto === false)
    this.scannedPages = null
    // 无论成败都记一笔：失败后不再反复给同一个无效入口
    this.setData({ imageTried: true, scannedCount: 0 })

    let res = null
    try {
      res = pdf.extractPdfImages(bytes, { maxPages: 60, maxImages: 24, minCoverage: 0.25 })
    } catch (e) {
      res = null
    }
    if (!res || !res.images.length) {
      this.afterNoScanImage(auto)
      return
    }

    // 按页码取前 N 页，并控制总字节
    const picked = []
    let total = 0
    let truncated = false
    const sorted = res.images.slice().sort((a, b) => a.pageIndex - b.pageIndex)
    for (const im of sorted) {
      if (picked.length >= MAX_SCANNED_PAGES || total + im.byteLength > MAX_SCANNED_BYTES) {
        truncated = true
        break
      }
      picked.push(im)
      total += im.byteLength
    }
    if (!picked.length) {
      this.afterNoScanImage(auto)
      return
    }

    const rotated = picked.filter((im) => im.rotation % 4 !== 0).length
    this.scannedPages = picked.map((im) => ({
      bytes: im.bytes,
      mime: im.format === 'jpeg' ? 'image/jpeg' : 'image/png',
      pageIndex: im.pageIndex,
    }))
    const parts = []
    parts.push(auto ? '这是扫描版 PDF，已自动转成 ' : '已把 PDF 转成 ')
    parts.push(picked.length + ' 页图片')
    if (truncated) parts.push('（文档更长，本次仅识别前 ' + picked.length + ' 页）')
    if (rotated) parts.push('，其中 ' + rotated + ' 页方向不正，识别效果会打折扣')
    parts.push(auto ? '。正在交给 AI 识别…' : '，点下方按钮开始识别。')
    this.setData({ pdfState: 'scanned', pdfInfo: parts.join(''), scannedCount: picked.length })
    if (auto) await this.parseScannedPages()
  },

  /** 抽不到可用整页图时的收尾：自动兜底就说明原因，主动转换则退回原来的状态 */
  afterNoScanImage(auto) {
    const msg = '这份 PDF 里没有找到可用的整页图片（可能是纯文字页或矢量排版），无法按图片识别。'
    if (auto) {
      this.setData({ pdfState: 'fail', pdfInfo: msg + '可改用截图识别或粘贴文本。' })
    } else {
      this.setData({
        pdfState: this.docText ? 'ok' : 'fail',
        pdfInfo: msg + (this.docText ? '仍可直接识别文字。' : '可改用截图识别或粘贴文本。'),
      })
    }
  },

  /** 把抽出的扫描页交给多模态模型，与「拍照识别」共用同一条链路 */
  async parseScannedPages() {
    const pages = this.scannedPages || []
    if (!pages.length) {
      wx.showToast({ title: '没有可识别的扫描页', icon: 'none' })
      return
    }
    this.setData({
      step: 'parsing',
      parsing: true,
      error: '',
      progressText: 'AI 识别扫描页 0/' + pages.length + ' 页',
    })
    try {
      const images = pages.map((p) => ({ base64: storage.bytesToBase64(p.bytes), mime: p.mime }))
      const units = await llm.parseTextbookImages(images, (done, total) => {
        this.setData({ progressText: 'AI 识别扫描页 ' + done + '/' + total + ' 页' })
      })
      this.scannedPages = null
      this.setData({ parsing: false })
      this.enterReview(units, this.data.sourceType || 'pdf')
    } catch (e) {
      this.scannedPages = null
      // 回到选择页并给出原因，让用户可以改走截图 / 粘贴
      this.setData({
        step: 'choose',
        parsing: false,
        pdfState: 'fail',
        pdfInfo: '扫描页识别失败：' + friendlyError(e),
      })
    }
  },

  /** 用 AI 把文档正文按单元切分成生词表 */
  async parseDocText() {
    const text = this.docText || ''
    if (!text) {
      wx.showToast({ title: '没有可解析的文字', icon: 'none' })
      return
    }
    const clipped = text.slice(0, llm.MAX_PARSE_CHARS)
    const truncated = text.length > clipped.length
    this.setData({ parsing: true, step: 'parsing', error: '', progressText: 'AI 解析准备中…' })
    try {
      const units = await llm.parseTextbookText(clipped, (done, total) => {
        this.setData({ progressText: 'AI 解析中 ' + done + '/' + total + ' 段' })
      })
      this.setData({ parsing: false })
      if (truncated) wx.showToast({ title: '文档较长，本次仅解析前 3 万字', icon: 'none' })
      this.enterReview(units, this.data.sourceType)
    } catch (e) {
      this.setData({ step: 'choose', parsing: false, error: friendlyError(e) })
    }
  },

  // ---------- 文本通道 ----------
  async parseText() {
    const raw = this.data.textInput.trim()
    if (!raw) {
      wx.showToast({ title: '请先粘贴文本', icon: 'none' })
      return
    }
    const text = raw.slice(0, llm.MAX_PARSE_CHARS)
    const truncated = raw.length > text.length
    this.setData({ parsing: true, step: 'parsing', error: '', progressText: 'AI 解析准备中…' })
    try {
      const units = await llm.parseTextbookText(text, (done, total) => {
        this.setData({ progressText: 'AI 解析中 ' + done + '/' + total + ' 段' })
      })
      this.setData({ parsing: false })
      if (truncated) {
        wx.showToast({ title: '文本较长，本次仅解析前 3 万字', icon: 'none' })
      }
      this.enterReview(units, 'text')
    } catch (e) {
      this.setData({ step: 'choose', parsing: false, error: friendlyError(e) })
    }
  },

  async enterReview(parsedUnits, sourceType) {
    let existingKeys = {}
    try {
      existingKeys = await api.listExistingWordKeys()
    } catch (e) {
      existingKeys = {}
    }
    const units = toEditableUnits(parsedUnits, existingKeys)
    if (!units.length) {
      this.setData({ step: 'choose', error: '没有解析到生词，请换一页清晰的图片或粘贴文本再试' })
      return
    }
    const totalWords = units.reduce((s, u) => s + u.words.length, 0)
    this.setData({ step: 'review', units, totalWords, sourceType, error: '' })
  },

  // ---------- 校正交互 ----------
  findUnit(uIndex) {
    return this.data.units[Number(uIndex)]
  },

  onUnitTitle(e) {
    const i = Number(e.currentTarget.dataset.uindex)
    const key = 'units[' + i + '].title'
    this.setData({ [key]: e.detail.value })
  },
  onWordField(e) {
    const i = Number(e.currentTarget.dataset.uindex)
    const j = Number(e.currentTarget.dataset.windex)
    const field = e.currentTarget.dataset.field
    this.setData({ ['units[' + i + '].words[' + j + '].' + field]: e.detail.value })
  },
  toggleWord(e) {
    const i = Number(e.currentTarget.dataset.uindex)
    const j = Number(e.currentTarget.dataset.windex)
    const cur = this.data.units[i].words[j].include
    this.setData({ ['units[' + i + '].words[' + j + '].include']: !cur })
  },
  removeWord(e) {
    const i = Number(e.currentTarget.dataset.uindex)
    const j = Number(e.currentTarget.dataset.windex)
    const words = this.data.units[i].words.slice()
    words.splice(j, 1)
    this.setData({ ['units[' + i + '].words']: words })
    this.recount()
  },
  addWord(e) {
    const i = Number(e.currentTarget.dataset.uindex)
    const words = this.data.units[i].words.concat([
      { key: nextKey('w'), word: '', phonetic: '', pos: '', meaning_zh: '', dup: false, include: true },
    ])
    this.setData({ ['units[' + i + '].words']: words })
    this.recount()
  },
  removeUnit(e) {
    const i = Number(e.currentTarget.dataset.uindex)
    const units = this.data.units.slice()
    units.splice(i, 1)
    this.setData({ units })
    this.recount()
  },
  addUnit() {
    const units = this.data.units.concat([
      { key: nextKey('u'), title: '新单元', summary: '', words: [] },
    ])
    this.setData({ units })
    this.recount()
  },
  recount() {
    const total = this.data.units.reduce(
      (s, u) => s + u.words.filter((w) => w.include && w.word.trim()).length,
      0,
    )
    this.setData({ totalWords: total })
  },

  // ---------- 保存 ----------
  async save() {
    const units = this.data.units
      .map((u) => ({
        title: u.title.trim() || '未命名单元',
        summary: u.summary || '',
        words: u.words.filter((w) => w.include && w.word.trim()),
      }))
      .filter((u) => u.words.length > 0)
    if (!units.length) {
      wx.showToast({ title: '没有可保存的生词', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    try {
      const title =
        this.data.title.trim() ||
        '教材 ' + this.dateFormat()
      const book = await api.createBook({
        title,
        level: this.data.level,
        source_type: this.data.sourceType,
        source_path: this.data.docPath || null,
        status: 'ready',
      })
      const savedUnits = await api.createUnits(
        book.id,
        units.map((u, i) => ({ seq: i + 1, title: u.title, summary: u.summary })),
      )
      const wordRows = []
      units.forEach((u, i) => {
        u.words.forEach((w) => {
          wordRows.push({
            book_id: book.id,
            unit_id: savedUnits[i] ? savedUnits[i].id : null,
            word: w.word.trim(),
            phonetic: w.phonetic || '',
            pos: w.pos || '',
            meaning_zh: w.meaning_zh || '',
            source: 'book',
          })
        })
      })
      await api.createWords(wordRows)
      getApp().markDirty()
      wx.redirectTo({ url: '/pages/book-detail/book-detail?id=' + book.id })
    } catch (e) {
      this.setData({ saving: false, error: friendlyError(e) })
    }
  },

  dateFormat() {
    const d = new Date()
    const p = (n) => (n < 10 ? '0' + n : '' + n)
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
  },
})
