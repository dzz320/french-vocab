/**
 * 小程序页面「无 headless 运行」测试模板（可选使用，按需改桩）。
 *
 * 用途：不依赖微信开发者工具，直接在 Node 里跑真实的页面文件，断言 data 状态机与流程分支。
 * 关键技巧是拦 Module._load 替换外部依赖，而不是复制/改写页面源码 —— 测的就是上线那份代码。
 *
 * 用法：
 *   node page_harness.cjs <项目根目录> <页面 js 相对路径>
 *   node page_harness.cjs C:/path/to/app pages/book-upload/book-upload.js
 *
 * 替换 dependencies：在 Module._load 钩子里按需返回你自己的桩。
 */
const fs = require('fs')
const path = require('path')
const Module = require('module')

const PROJ = (process.argv[2] || process.cwd()).replace(/\\/g, '/')
const PAGE_REL = process.argv[3] || 'pages/index/index.js'

let pass = 0
let fail = 0
function ck(cond, label, extra) {
  if (cond) {
    pass++
    console.log('  OK   ' + label)
  } else {
    fail++
    console.log('  FAIL ' + label + (extra !== undefined ? '  → ' + extra : ''))
  }
}

// ---------------- 桩：按你的项目替换 ----------------
const cloudStub = {
  friendlyError: (e) => (e && (e.message || e.errMsg)) || '未知错误',
  CLOUD_ENDPOINT: 'https://example.invalid',
  CLOUD_PUBLISHABLE_KEY: 'pk_test',
}
const configStub = { CLOUD_ENDPOINT: 'https://example.invalid', CLOUD_PUBLISHABLE_KEY: 'pk_test' }
const apiStub = {
  listExistingWordKeys: async () => ({}),
  createBook: async () => ({ id: 1 }),
  createUnits: async () => [{ id: 1 }],
  createWords: async () => {},
}
const llmCalls = []
const llmStub = {
  MAX_PARSE_CHARS: 30000,
  parseTextbookText: async () => [],
  parseTextbookImages: async (images, onProgress) => {
    llmCalls.push(images.map((i) => i.mime))
    if (onProgress) onProgress(images.length, images.length)
    return [{ title: 'Unit 1', summary: '', words: [{ word: 'mot', meaning_zh: '词' }] }]
  },
}

const origLoad = Module._load
Module._load = function (request) {
  if (/workbuddy-cloud-sdk/.test(request)) return { createMiniProgramWorkBuddyCloud: () => ({}) }
  if (/(^|\/)cloud$/.test(request)) return cloudStub
  if (/(^|\/)config$/.test(request)) return configStub
  if (/utils[\\/]api$/.test(request)) return apiStub
  if (/utils[\\/]llm$/.test(request)) return llmStub
  return origLoad.apply(this, arguments)
}

// ---------------- 假的宿主环境 ----------------
const toasts = []
global.wx = {
  showToast: (o) => toasts.push(o && o.title),
  chooseMessageFile: () => {},
  chooseMedia: () => {},
  redirectTo: () => {},
  navigateTo: () => {},
}
global.getApp = () => ({ markDirty: () => {} })

let pageConfig = null
global.Page = (cfg) => {
  pageConfig = cfg
}
global.Component = () => {}

// ---------------- 加载真实页面 ----------------
const storage = require(path.join(PROJ, 'utils/storage.js'))
// 真 storage 读盘走 wx.getFileSystemManager；这里换成直接读磁盘，便于喂样本
storage.readAsArrayBuffer = async (p) => {
  const b = fs.readFileSync(p)
  const out = new Uint8Array(b.length)
  out.set(b)
  return out
}
storage.readAsText = async (p) => fs.readFileSync(p, 'utf8')

require(path.join(PROJ, PAGE_REL))
if (!pageConfig) {
  console.error('未能捕获 Page({}) 配置，检查路径与页面文件')
  process.exit(1)
}

// ---------------- 迷你 setData（支持 'a[0].b' 路径） ----------------
function setPath(obj, key, val) {
  const m = key.match(/^([^.[]+)(?:\[(\d+)\])?\.?(.*)$/)
  if (!m) return
  const [, head, idx, rest] = m
  if (!idx && !rest) obj[head] = val
  else if (idx && !rest) obj[head][Number(idx)] = val
  else if (idx) setPath(obj[head][Number(idx)], rest, val)
  else setPath(obj[head], rest, val)
}

function makePage() {
  const inst = Object.create(pageConfig)
  inst.data = JSON.parse(JSON.stringify(pageConfig.data))
  inst.setData = function (patch) {
    for (const k of Object.keys(patch)) setPath(inst.data, k, patch[k])
  }
  return inst
}

// ---------------- 断言你的流程 ----------------
async function main() {
  console.log('\n[示例] 状态机骨架 —— 按项目替换成真实用例')
  const inst = makePage()
  ck(!!inst.data, '页面 data 可初始化')
  ck(typeof inst.setData === 'function', 'setData 已挂载')

  // 例：await inst.someAsyncMethod(samplePath)
  //     ck(inst.data.someState === 'expected', '说明', inst.data.someState)

  console.log('\n结果：' + pass + '/' + (pass + fail) + ' 通过')
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('运行异常：', e)
  process.exit(1)
})
