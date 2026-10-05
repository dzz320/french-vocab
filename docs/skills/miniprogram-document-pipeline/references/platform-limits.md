# 平台硬边界与接口细节

## 1. 云存储：SDK 二进制上传不可用（实测）

| 项 | 值 |
|---|---|
| 报错 | `StorageUnknownError: createMiniProgramFetch: 暂不支持非字符串 body（ArrayBuffer/FormData 待补）` |
| 触发 | `cloud.storage.upload(path, arrayBuffer, { contentType })`；`uploadToSignedUrl` 同理 |
| 版本 | `@tencent-ai/workbuddy-cloud-sdk` 的 `dev`（0.1.3-dev.c090db7.202610050023）与 `latest`（0.1.3）**均未实现** |
| 结论 | 文档里「小程序传 ArrayBuffer」的写法当前不可用，必须自己发请求 |

复现方式（Node 下用假 `wx` 加载真实 SDK）：

```js
// package.json 是 "type":"module"，需先把 miniprogram_dist/miniprogram.js 复制成 .cjs
const wxStub = { getStorageSync: () => '', setStorageSync() {}, removeStorageSync() {}, request(o) { /* 记录 */ } }
globalThis.wx = wxStub
const mod = require('<复制的>/probe-sdk.cjs')
const cloud = mod.createMiniProgramWorkBuddyCloud({ endpoint, publishableKey: 'wbpk_xxx', wx: wxStub })
const res = await cloud.storage.upload('users/u1/books/a.pdf', new ArrayBuffer(16), { contentType: 'application/pdf' })
console.log(res.error && res.error.message) // 暂不支持非字符串 body
```

## 2. 云存储：可用的直传通道

```
POST {endpoint}/.cloud/storage/object/runtime/<users|shared>/<uid>/<相对路径>
```

服务端与 SDK 内部一致（`CLOUD_MODULE_PATHS.storage = /.cloud/storage`，桶固定 `runtime`，路径来自
`cloud.storage.userPath(uid, rel)`，返回 `users/<uid>/<rel>`）。

请求头：

```
x-wb-webapp-access-key: <publishableKey>          // SDK 里叫 PUBLISHABLE_KEY_HEADER
Authorization: Bearer <cloud.auth.getAccessToken()>
x-upsert: false                                    // 仅 POST 覆盖时需要，一般不用
```

- **通道 A**：`wx.uploadFile({ url, filePath, name: 'file', header, formData: { cacheControl: '3600' } })`
  → multipart/form-data，从磁盘流式发送，内存占用极小；`name` 用 `file` 即可，
  supabase 风格的服务端取第一个文件部分，不看字段名。
- **通道 B**：`wx.request({ url, method: 'POST', header: { ...header, 'content-type': MIME, 'cache-control': 'max-age=3600' }, data: arrayBuffer })`
  → 字节与 MIME 精确，但要把整份文件读进内存。
- 下载：`cloud.storage.download()/blob()/arrayBuffer()` 在小程序同样不可用（响应侧无二进制）；
  用 `cloud.storage.createSignedUrl(path, 600)` 拿短期链接，或 `wx.downloadFile` 自行下载后 `wx.openDocument`。

错误码文案建议：413 → 超出云端大小限制；401/403 → 登录失效；409 → 同名冲突。

## 3. 大模型接口的内容块

```ts
interface ChatCompletionTextContentPart { type: 'text'; text: string }
interface ChatCompletionImageContentPart {
  type: 'image_url'
  image_url: { url: string }   // 图片用 data URL 传 base64
}
type ChatCompletionContentPart = ChatCompletionTextContentPart | ChatCompletionImageContentPart
```

**没有** `file` / `document` / `input_file` 之类的块；模型元数据里也只有 `supportsImages`
（没有 supportsDocuments / supportsPdf）。因此 PDF/Word 必须先端上转成文本再喂模型。

调用要求：`stream: true`（不支持非流式）、`messages[0]` 必须是 system 消息、模型 id 先
`cloud.llm.models.list()` 取。

## 4. 其他小程序侧要点

- WXML 表达式**不支持方法调用**（`indexOf` / `slice` / `toFixed` 等），派生值在 JS 里算好再 setData。
- 大字符串（几十 KB 以上）不要放进 `data`，放页面实例属性以免过视图层。
- `app.json` 的 `networkTimeout`：`uploadFile` 默认 60s，大文件必须调大。
- `wx.chooseMessageFile` 的 `tempFiles[].size` 可直接用于上传前预检。
- `FileSystemManager.readFile` 支持 `position`/`length`，读大文本可只读开头若干字节。
- `FileSystemManager.readFile`（不传 encoding）**一次性返回整份文件的 ArrayBuffer，没有流式读**，
  所以端上解析大文件的真正瓶颈是这一步的内存，而非解析耗时（实测 30MB PDF 解析约 150ms）。
  体积门槛据此设为「软门槛 + 用户确认后可继续」，而不是硬性拒绝。
