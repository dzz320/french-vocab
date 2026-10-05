// 文件存储辅助：教材原件上传 / 读取（图片转 base64、文本只读前若干字节）
//
// 关于上传通道（重要）：
// 小程序版云 SDK 的 fetch 适配层目前只支持字符串 body，官方
// cloud.storage.upload(path, ArrayBuffer) 在小程序运行时会直接返回
// “暂不支持非字符串 body”，因此这里改用小程序原生能力直传同一数据面地址：
//   https://<endpoint>/.cloud/storage/object/runtime/<userPath>
// 请求头与 SDK 保持一致（x-wb-webapp-access-key + Bearer 令牌）。
// 两条通道：
//   A. wx.uploadFile  —— 从磁盘流式发送，内存占用极小，大文件（≤50MB）首选
//   B. wx.request     —— 整块 ArrayBuffer 上传，字节与 MIME 精确
// 先按文件大小选主通道，失败自动切换另一条。
const { cloud, getUserId } = require('./cloud')
const CONFIG = require('./config')

// 单文件上限：50MB
const MAX_SIZE = 50 * 1024 * 1024
const MAX_SIZE_MB = 50
// 超过此大小优先走流式通道（避免把整份文件读进 JS 内存）
const STREAM_THRESHOLD = 8 * 1024 * 1024
// 文本只读取前 120KB（AI 解析本身也有 3 万字上限，读全量没有意义且吃内存）
const TXT_READ_LIMIT = 120 * 1024

const ALLOWED_DOC_EXT = ['pdf', 'doc', 'docx', 'txt']

// 词表文件只在端上解析、不上传，所以单独一组扩展名，别混进「教材」的选择器里
const ALLOWED_SHEET_EXT = ['csv', 'xlsx', 'xlsm', 'xls']
// 词表文件不需要很大；超过这个体积多半是选错了文件
const SHEET_MAX_SIZE = 20 * 1024 * 1024

const CONTENT_TYPES = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  csv: 'text/csv',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
}

function extOf(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/)
  return m ? m[1] : ''
}

function contentTypeOf(name) {
  return CONTENT_TYPES[extOf(name)] || 'application/octet-stream'
}

/** 只保留安全字符，避免非 ASCII 文件名进对象键（中文名退化为 file.<ext>，不丢扩展名） */
function safeName(name) {
  const raw = String(name || 'file')
  const ext = extOf(raw).replace(/[^a-z0-9]/g, '')
  const base = raw
    .replace(/\.[^.]*$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 60)
  return (base || 'file') + (ext ? '.' + ext : '')
}

/** 读取本地文件大小（字节）；取不到时返回 0，交由上传结果判定 */
function fileSizeOf(filePath) {
  try {
    const stat = wx.getFileSystemManager().statSync(filePath)
    return (stat && Number(stat.size)) || 0
  } catch (e) {
    return 0
  }
}

/** 体积展示：<1MB 显示 KB */
function formatSize(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + 'KB'
  return Math.round((n / 1024 / 1024) * 10) / 10 + 'MB'
}

/** 对象键 -> 数据面对象地址，与 SDK 内部拼装方式一致 */
function objectUrl(objectKey) {
  const segs = String(objectKey)
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/')
  return CONFIG.endpoint + '/.cloud/storage/object/runtime/' + segs
}

/** 与 SDK 相同的鉴权头：可分发密钥 + 当前登录令牌 */
async function storageHeaders() {
  const headers = {
    'x-wb-webapp-access-key': CONFIG.publishableKey,
    'X-Client-Info': 'storage-js/miniprogram',
  }
  try {
    const token = await cloud.auth.getAccessToken()
    if (token) headers.Authorization = 'Bearer ' + token
  } catch (e) {
    /* 无令牌时仍尝试请求，由服务端返回 401 */
  }
  return headers
}

function describeHttp(statusCode) {
  if (statusCode === 413) return '文件超出云端大小限制，请压缩后再上传'
  if (statusCode === 401 || statusCode === 403) return '登录状态已失效，请在「我的」重新登录'
  if (statusCode === 409) return '同名文件已存在，请重命名后再上传'
  return '上传失败（HTTP ' + statusCode + '）'
}

function readAsArrayBuffer(tempFilePath) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath: tempFilePath,
      success: (res) => resolve(res.data),
      fail: (err) => reject(new Error((err && err.errMsg) || '读取文件失败')),
    })
  })
}

function readAsBase64(tempFilePath) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath: tempFilePath,
      encoding: 'base64',
      success: (res) => resolve(res.data),
      fail: (err) => reject(new Error((err && err.errMsg) || '读取图片失败')),
    })
  })
}

/** 读取文本；maxBytes > 0 时只读文件开头部分（position/length 基础库不支持时自动退化为全文） */
function readAsText(tempFilePath, maxBytes) {
  return new Promise((resolve, reject) => {
    const options = {
      filePath: tempFilePath,
      encoding: 'utf8',
      success: (res) => resolve(res.data),
      fail: (err) => reject(new Error((err && err.errMsg) || '读取文本失败')),
    }
    if (maxBytes > 0) {
      options.position = 0
      options.length = maxBytes
    }
    wx.getFileSystemManager().readFile(options)
  })
}

/** 通道 A：wx.uploadFile 流式上传（不把整份文件读进内存） */
function uploadStream(url, filePath, headers, onProgress) {
  return new Promise((resolve, reject) => {
    const task = wx.uploadFile({
      url,
      filePath,
      name: 'file',
      header: headers,
      formData: { cacheControl: '3600' },
      success(res) {
        const code = Number(res.statusCode) || 0
        if (code >= 200 && code < 300) resolve()
        else reject(new Error(describeHttp(code)))
      },
      fail(err) {
        reject(new Error((err && err.errMsg) || '上传失败'))
      },
    })
    if (task && typeof task.onProgressUpdate === 'function' && typeof onProgress === 'function') {
      task.onProgressUpdate((p) => {
        onProgress(Math.max(0, Math.min(100, Math.round(Number(p.progress) || 0))))
      })
    }
  })
}

/** 通道 B：整块 ArrayBuffer 上传（字节精确、MIME 正确） */
async function uploadBuffer(url, filePath, headers, contentType) {
  const data = await readAsArrayBuffer(filePath)
  return new Promise((resolve, reject) => {
    wx.request({
      url,
      method: 'POST',
      header: Object.assign({}, headers, {
        'content-type': contentType,
        'cache-control': 'max-age=3600',
      }),
      data,
      timeout: 300000,
      success(res) {
        const code = Number(res.statusCode) || 0
        if (code >= 200 && code < 300) resolve()
        else reject(new Error(describeHttp(code)))
      },
      fail(err) {
        reject(new Error((err && err.errMsg) || '上传失败'))
      },
    })
  })
}

/**
 * 上传教材原件到用户私有目录。
 * @param {string} tempFilePath 本地临时文件路径
 * @param {string} fileName 原始文件名（用于取扩展名与对象键）
 * @param {(percent:number)=>void} [onProgress] 仅流式通道会上报进度
 * @returns {Promise<{path:string,size:number,ext:string}>}
 */
async function uploadBookFile(tempFilePath, fileName, onProgress) {
  const ext = extOf(fileName)
  if (ALLOWED_DOC_EXT.indexOf(ext) < 0) {
    throw new Error('仅支持 PDF / Word / txt 文件')
  }
  const size = fileSizeOf(tempFilePath)
  if (size > MAX_SIZE) {
    throw new Error('文件过大（' + formatSize(size) + '，上限 ' + MAX_SIZE_MB + 'MB）')
  }
  const uid = await getUserId()
  const objectKey = cloud.storage.userPath(
    uid,
    'books/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '-' + safeName(fileName),
  )
  const url = objectUrl(objectKey)
  const headers = await storageHeaders()
  const contentType = contentTypeOf(fileName)

  // 小文件优先整块上传（字节/MIME 最准），大文件优先流式（内存安全）；失败互相兜底
  const modes = size > STREAM_THRESHOLD ? ['stream', 'buffer'] : ['buffer', 'stream']
  let lastError = null
  for (let i = 0; i < modes.length; i++) {
    try {
      if (modes[i] === 'stream') {
        await uploadStream(url, tempFilePath, headers, onProgress)
      } else {
        await uploadBuffer(url, tempFilePath, headers, contentType)
      }
      return { path: objectKey, size, ext }
    } catch (e) {
      lastError = e
    }
  }
  throw lastError || new Error('上传失败')
}

/** 生成短期签名下载链接，用于在应用外查看教材原件 */
async function createBookFileUrl(path) {
  const res = await cloud.storage.createSignedUrl(path, 600)
  if (res.error) throw new Error(res.error.message || '获取文件链接失败')
  return res.data
}

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * 内存里的字节转 base64（不走 wx.arrayBufferToBase64，已废弃且部分基础库不可用）。
 * 分块处理避免 String.fromCharCode.apply 因参数过多而栈溢出。
 */
function bytesToBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const out = []
  const chunk = 0x8000
  for (let i = 0; i < u8.length; i += chunk) {
    const end = Math.min(i + chunk, u8.length)
    let s = ''
    for (let j = i; j < end; j++) s += String.fromCharCode(u8[j])
    out.push(s)
  }
  const bin = out.join('')
  let r = ''
  for (let i = 0; i < bin.length; i += 3) {
    const a = bin.charCodeAt(i)
    const b = i + 1 < bin.length ? bin.charCodeAt(i + 1) : 0
    const c = i + 2 < bin.length ? bin.charCodeAt(i + 2) : 0
    r += B64_CHARS[a >> 2]
    r += B64_CHARS[((a & 3) << 4) | (b >> 4)]
    r += i + 1 < bin.length ? B64_CHARS[((b & 15) << 2) | (c >> 6)] : '='
    r += i + 2 < bin.length ? B64_CHARS[c & 63] : '='
  }
  return r
}

module.exports = {
  MAX_SIZE,
  MAX_SIZE_MB,
  TXT_READ_LIMIT,
  SHEET_MAX_SIZE,
  ALLOWED_SHEET_EXT,
  extOf,
  contentTypeOf,
  safeName,
  fileSizeOf,
  formatSize,
  readAsArrayBuffer,
  readAsBase64,
  bytesToBase64,
  readAsText,
  uploadBookFile,
  createBookFileUrl,
  ALLOWED_DOC_EXT,
}
