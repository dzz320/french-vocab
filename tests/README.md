# 测试

小程序没有测试框架，这里用**离线驱动真实代码**的方式覆盖：真页面 + 真 utils + 假的 `wx` / 假云 SDK，
所以不需要开发者工具、不需要联网、不需要登录，`node` 直接跑。

## 怎么跑

```bash
cd tests
node run-all.cjs          # 一键跑全部（9 套，合计 1001 条断言）
node run-all.cjs audio    # 只跑名字含 audio 的
```

单套直接跑也可以，**都不需要传参数**（路径相对脚本自身定位）：

```bash
node test-sheet.cjs
node test-example-link.cjs
```

> 如果 `run-all.cjs` 报 `EBUSY` / `EPERM`，说明当前环境禁止创建子进程（沙箱或安全策略），
> 它不会把「起不来」报成「测试失败」，会直接告诉你怎么改用 shell 循环跑。

## 各套覆盖什么

| 脚本 | 断言 | 覆盖 | 对应源码 |
|---|---|---|---|
| `test-sheet.cjs` | 296 | CSV/XLSX/XLS 解析，与 Python 侧期望值逐字段对拍（含 GBK、UTF-16、带 BOM、富文本、稀疏行） | `utils/sheet.js` |
| `test-pages.cjs` | 250 | 词库三页的端到端：建库 → 分片写词 → 列表筛选 → 去重分桶；含 250 行分片与 30 行单列上限 | `pages/import` `pages/libraries` `pages/words` |
| `e2e-page.cjs` | 35 | 教材上传状态机：读文字层 → 扫描件自动转图 → 识别 → 校正；含纯矢量 PDF 的如实降级 | `pages/book-upload` |
| `verify-mock.cjs` | 10 | 云接口封装：分页、`libraryId` 三分支、去重分桶、建库 trim、无匹配行抛错（RLS 语义）、级联删除 | `utils/api.js` |
| `verify-words.cjs` | 173 | 六份分级词表：解析层字段完整性 + 真导入全链路 + 重复导入幂等 + 跨文件同形词 | `word-lists/*.csv` |
| `test-audio.cjs` | 59 | 发音模块：地址拼接、文本截断、缓存命中不重复下载、连点不闪、错误码分支、偏好持久化、绑定/解绑 | `utils/audio.js` |
| `test-audio-sources.cjs` | 39 | 音源降级链：主音源失败自动切备用，全失败才提示；`{text}` 占位与 URL 编码 | `utils/audio.js` + `utils/config.js` |
| `test-audio-pages.cjs` | 80 | 四个页面的喇叭接线，断言**真正发到 TTS 的是哪段文本**；含预热命中本地缓存 | `pages/study` `words` `word-detail` `mine` |
| `test-example-link.cjs` | 59 | 例句切词保真（拼回原文逐字符相等）、候选顺序（`quelqu'un` 不能判成 `un`）、命中跳详情/未命中跳新增、缓存与防连点、`?word=` 解码容错 | `utils/fr-text.js` `pages/study` `pages/word-detail` |

## 写新测试时的两个坑

1. **判失败别用「输出里有 fail 字样」** —— 有断言本身就在验「状态是 fail」。
   用「行首 `FAIL`」或退出码。
2. **假 `wx` 的 `downloadFile` 要同步回调 `success`**，并且要能处理「`src` 是本地缓存路径」的情况：
   预热生效后点播放直接读本地文件，只解析 `?t=` / `?audio=` 的写法会把「缓存命中」误判成「没发声」。
   正解是在假 `downloadFile` 里记一张 `cachePathFor(url) → 文本` 的反查表。

## fixture

`fixtures/` 下都是小而必要的样本（合计 339K）：

- `sheet-samples/` — 20 份表格样本（CSV 各编码 / XLSX / 旧版 XLS）
- `sheet-expected.json` — Python 侧解析出的期望值，`test-sheet.cjs` 对拍用
- `pdf/` — 4 份教材样本：扫描件（整页图）、纯文字层 PDF、docx
- `cloud_db_mock.cjs` — 内存版云数据库，能当云 SDK 的替身驱动真 `utils/api.js`（含 `insert` 回填自增 `id`）
