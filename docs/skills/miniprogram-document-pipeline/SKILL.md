---
name: miniprogram-document-pipeline
description: 微信小程序端的「文件上传 + 文档取文 + 表格解析」方案。用于小程序要把用户选中的文件传到 WorkBuddy 云存储、在端上直接解析 PDF/docx 取出文字、或解析 CSV/Excel 表格（云 SDK 二进制上传不可用、大模型不支持直传文档时）。包含纯 JS 的 PDF 文字层抽取器、docx 抽取器、**PDF 转页面图抽取器**（CCITT G4/JPEG/Flate 位图 + 自研 PNG 编码器，供多模态识别；含「无文字层自动兜底」与「用户主动转图」双入口设计，以及纯矢量 PDF 转不了的边界）、**CSV/XLSX 表格解析器**（BOM/分隔符嗅探/RFC4180 引号/sharedStrings 与 inlineStr/重音折叠表头识别/列映射），以及小程序云存储直传通道（wx.uploadFile/wx.request + 数据面地址与鉴权头）。
agent_created: true
---

# 小程序文档流水线（上传 + 端上取文）

## 何时使用

出现以下任一情况时加载本技能：

- 小程序要把用户从聊天/相册选中的文件（PDF、Word、txt、图片）上传到 WorkBuddy 云存储；
- 需要在小程序里「直接读取 PDF / Word 里的文字」（抽词、摘要、翻译、检索等）；
- 需要在小程序里解析 **CSV / Excel 表格**（批量导入词表、名单、台账）→ 工作流四；
- 遇到 `createMiniProgramFetch: 暂不支持非字符串 body（ArrayBuffer/FormData 待补）` 这类报错；
- 想给大模型喂 PDF/Word 内容，却发现接口只接受 text / image_url。

## 三条必须先记住的平台事实

1. **小程序版云 SDK 不能上传二进制**：其 fetch 适配层只接受字符串 body，
   `cloud.storage.upload(path, ArrayBuffer|Blob)` 在 `dev` 与 `latest`（0.1.3 系）均返回
   `暂不支持非字符串 body（ArrayBuffer/FormData 待补）`。文件上传必须自己发请求。
2. **大模型接口只支持 `text` 与 `image_url` 两种内容块**，不能直传 PDF/文档；
   云端也没有可执行的服务端做解析。要「读 PDF 里的字」，只能在端上抽文字层。
3. **小程序不保证有 `TextDecoder` / `Buffer`**，UTF-8 必须自己解码；大字符串不要进 `setData`。

接口参数、URL 拼装、请求头与错误码见 `references/platform-limits.md`。

## 工作流一：上传文件到云存储

1. 用 `wx.chooseMessageFile`（文档）或 `wx.chooseMedia`（图片）拿临时文件路径与 `size`。
2. **先按大小预检**（`wx.getFileSystemManager().statSync(path).size`），超限直接提示，不发请求。
3. 拼数据面地址：`POST {endpoint}/.cloud/storage/object/runtime/<users|shared>/<uid>/<相对路径>`，
   每段用 `encodeURIComponent`。
4. 带鉴权头：`x-wb-webapp-access-key: <publishableKey>` + `Authorization: Bearer <cloud.auth.getAccessToken()>`
   （`getAccessToken` 在 auth 客户端上是公开方法）。
5. 选通道，失败互相兜底：
   - `wx.uploadFile`（multipart，`name: 'file'`，`formData: { cacheControl: '3600' }`）：
     **从磁盘流式发送，内存占用极小，大文件首选**，可用 `onProgressUpdate` 报进度；
   - `wx.request`（`data` 传 ArrayBuffer + 正确 `content-type`）：字节与 MIME 精确，小文件首选。
6. 在 `app.json` 加 `networkTimeout.uploadFile`（大文件建议 300000ms），否则 60s 会中断。
7. 对象键用「时间戳 + 随机串 + ASCII 安全文件名」；中文名要回退成 `file.<ext>`，
   避免出现 `.pdf` 这类畸形键。

可参考项目实现：`utils/storage.js` 的 `uploadBookFile/uploadStream/uploadBuffer`。

## 工作流二：端上抽取文档文字

1. 复制 `assets/pdf-text-extractor.js`、`assets/docx-text-extractor.js` 到项目 `utils/`，
   **按项目约定重命名**为 `utils/pdf.js` / `utils/docx.js`（assets 里的 require 路径是按这个布局写的；
   解析器内部用 try/catch 兼容了两种命名，直接放在 assets 目录里也能被 `scripts/*_probe.cjs` 驱动）。
   两者纯 JS、无第三方依赖、不需要打包器。
2. 用 `wx.getFileSystemManager().readFile({ filePath })` 取 `ArrayBuffer`，按扩展名分派：
   - `.pdf` → `extractPdfText(bytes, { maxPages, maxChars })`，看 `hasTextLayer`；
   - `.docx` → `extractDocxText(bytes)`，看 `hasText`；
   - `.doc`（旧版二进制）→ 无法解析，直接引导用户另存为 .docx 或改用截图。
3. **按 `reason` 降级**，不要笼统报「解析失败」：
   - `no_text_layer` → 扫描版（整页图片）→ **走工作流三自动转图片识别**，不要只让用户去截图；
   - `encrypted` → 说明有加密保护；
   - `low_quality`（字母占比 < 0.35，说明编码没映射对）→ 放弃直读；
   - `not_docx` → 旧版 .doc。
4. 抽出的正文交给已有的分块文本解析流程（例如每 3000 字一批喂大模型），
   并设总字数上限（否则超长文档会触发成百上千次模型调用）。
5. 正文存在页面实例属性上（`this.docText`），**不要放进 `data`**。

抽取器能力边界（回复用户时要如实说明）：

- 支持：带文字层的电子版 PDF（含 PDF 1.5+ 对象流、子集字体 + ToUnicode CMap、
  Identity-H CID 字体与中文、Form XObject 内嵌文字）、.docx。
- **扫描版 PDF（无文字层）→ 工作流三**（端上抽内嵌整页图，交给多模态模型），不再是死路。
- 不支持：加密 PDF、旧版 .doc。
- 体积护栏：端上解析建议 ≤ 25MB、≤ 60 页、≤ 6 万字符；解压总量与单流均设上限，防解压炸弹。

**体积门槛要设成软门槛，不要硬拦**（实测 30MB 真实 PDF 解析仅 ~150ms，慢的是 `readFile`
把整份文件读进内存，而不是解析本身；26MB 并不比 25MB 更危险，一刀切会平白断掉一条路）：

| 情况 | 做法 |
|---|---|
| 超过端上解析建议值（如 25MB） | 停在「风险提示」状态，说明「要把整份文件读进手机内存，可能较慢或失败」，给一个**「仍要尝试直接识别」**按钮，确认后再带 `force: true` 真正解析 |
| 超过上传上限（如 50MB） | 不要只报错就结束：给**「不上传，直接识别文字」**——读文字层在本机完成、本来就不需要上传；落库时 `source_path` 置空（字段可空，详情页据此隐藏「原件链接」按钮） |
| 大文件解析抛出异常 | 单独识别内存类错误（`/memory\|out of\|allocation\|RangeError/`）并给可对症的文案，不要和「读不到文字层」混为一谈 |

解析结束后把持有大缓冲区的局部变量置空（`finally { bytes = null }`），给引擎回收机会。

## 工作流三：PDF 转图片识别（自动兜底 + 手动选项，两条入口）

扫描版 PDF 整页就是一张图，抽不到文字层。用 `assets/pdf-image-extractor.js`
（是 `pdf-text-extractor.js` 的**超集**，文字层 + 页面图都在里面，二选一即可）：

```js
const res = pdf.extractPdfImages(bytes, { maxPages: 60, maxImages: 24, minCoverage: 0.25 })
// res.images[i] = { bytes, format:'jpeg'|'png', width, height, pageIndex,
//                   coverage, rotation, ctm, dispW, dispH, byteLength }
```

**一定要给两个入口，只做自动兜底是不够的**：

- **自动入口**（无文字层时）：`extractPdfText` 判 `no_text_layer` → 抽图 → 转完直接开始识别。
- **手动入口**（用户主动选）：`convertPdfToImages()`。有文字层但读出来是乱码、公式/表格/图多、想按原版式识别、
  或超大扫描件时，用户需要自己能选。**手动入口转完要停在「等待确认」状态**（`auto:false`，不要自动发起识别）——
  每页是一次多模态请求，让用户看到页数再决定，别默默烧钱。
- 入口显隐用一对标志位控制（`isPdf && !imageTried`）：`imageTried` 在**每次抽取结束**都置位，
  这样「抽过但没有整页图」的 PDF 不会再反复给出同一个无效按钮。
- 文案要区分两条入口：自动 → 「…正在交给 AI 识别…」；手动 → 「…点下方按钮开始识别。」
  按钮上带页数（「开始 AI 识别这 N 页图片」）比「重新识别」清楚得多。

步骤：

1. **按需触发**：自动入口只在 `no_text_layer` 时跑；手动入口随时可跑，但**抽图前先筛**——
   `coverage >= 0.25` 能滤掉 arXiv 这类文字版 PDF 里的插图，只留整页扫描图。
2. **按页码排序后限量**：每页是一次多模态请求，页数多既慢又贵。建议前 8 页 + 总量 ≤ 6MB，
   超出的页要如实告知用户「本次仅识别前 N 页」，不要静默丢弃。
3. 转 base64 用**自己实现的分块编码器**（`String.fromCharCode` 每 32768 字节一段再 join），
   `wx.arrayBufferToBase64` 已废弃且部分基础库不可用，`String.fromCharCode.apply` 直接传大数组会栈溢出。
4. `bytes` + `mime` 拼成 `data:<mime>;base64,<...>` 塞进 `image_url` 内容块，走现成的多模态解析。
5. 失败兜底要留着：识别失败回到「拍照/截图识别 + 粘贴文本」，别让用户卡死。
6. `rotation !== 0` 的页方向不正，识别效果会打折——如实提示即可（JPEG 是原始流，无法端上无损旋转）。

### 一个必须如实告知的能力边界：纯矢量 PDF 转不了

**无文字层 ≠ 有栅格图**。有些 PDF 是矢量排版导出的（CAD / Illustrator / 报表工具，页面由 `re`/`c`/`f`
这类填充路径构成），既没有文字层、也没有内嵌图像 —— 这种 PDF 端上**无从转换**，`extractPdfImages`
会返回 `no_page_image`。不要假装成功、也不要让用户反复点，直接说明「没有找到可用的整页图片（可能是纯文字页或矢量排版）」
并引导截图 / 粘贴文本。

判断方法：造样本时 `fpdf2` 的 `pdf.rect(...)` / `pdf.ellipse(...)` 画出来的就是这类（`scanned.pdf` 即此），
而真正的扫描件是整页塞一张大图。**两种样本都要测**，否则很容易把「矢量无文字层」错当「扫描件」。

### PDF 图像方向的四个坑（全部经 PDFium 渲染逐像素实测，写错一个就整页翻色/翻面）

| 坑 | 正确做法 |
|---|---|
| **PNG 的 zlib 包装** | `adler32` 必须算在**未压缩数据**上。算在压缩流上会得到结构完好、能解压、但校验失败的 PNG（报 `incorrect data check`），极易误判成 deflate 本身有 bug |
| **CCITT 极性** | `invert = (!BlackIs1) XOR (/Decode 为 [1 0])`。**不要**用「黑像素占比高就整体反色」的启发式——会把本就深色的页判错。另外 G4 的白/黑/模式码必须是**三棵独立的哈夫曼树**（黑码 `11` 是白码 `1100` 的前缀，合成一棵树全乱） |
| **CTM 合成顺序** | `cm` 是 **CTM' = 新矩阵 × 旧 CTM**，不是反过来。顺序写反时 Form XObject 里的图平移量会爆到几万 pt（表现为 coverage 异常 / 区域映射全错） |
| **图像旋转方向** | 要还原渲染效果，光栅需顺时针转 `-atan2(ctm[1], ctm[0])`（设备坐标 y 向下，用户空间的逆时针角在屏幕上看是反的） |

### 验证方法（图像抽取必须对拍，不能只看能不能解出图）

1. 用 Pillow 造样本：`img.save(tiff, compression='group4')` 取出 CCITT 流（标签 273/279/262）塞进 PDF；
   另造 Flate 灰度/RGB/预测器、JPEG、Indexed 8/4bit、`/Rotate 90`、加密、真实 arXiv PDF。
2. **方向样本要「内容不对称」**：图里画顶部横条 + 左侧竖条，任何翻转或 90° 旋转都能被检出
   （用大面积白底的图做对比，所有朝向的黑白占比都一样，判定不出来）。
3. 与 **PDFium**（`pypdfium2` 渲染）逐像素对拍：按 CTM 裁出渲染区域 → 缩放到抽取图尺寸 → 比二值一致率，
   合格线 ≥ 99%。同时测 4 种镜像组合确认「不翻转」最优。
4. 自实现 DEFLATE 用 `zlib.inflateRawSync` 逐字节对拍 + 随机模糊（多尺寸、多形态：全 0/随机/稀疏/周期/渐变）。

## 工作流四：端上解析 CSV / Excel（表格批量导入）

用户要「导入一张表」时，别让他先转成 txt。CSV 与 .xlsx 都能纯端上解析，且**不要上传**
（词表就几十 KB，上传没有收益；解析结果走「预览 → 去重 → 确认」就行）。

用 `assets/sheet-parser.js`（纯 JS，依赖 docx 抽取器的 ZIP 三个函数）：

```js
const sheet = require('./sheet')
const res = sheet.extractWords(bytes, { ext: 'csv' })   // 或 'xlsx' / 'xlsm'
// res = { words, grid, hasHeader, headerRowIndex, titleRow, headers, mapping,
//         encoding, warnings, truncated, skipped, reason }
const res2 = sheet.extractWordsFromText(pastedText)     // 粘贴文本走同一套规则
sheet.columnLabels(res, width)                          // 表头名或「第 N 列」，给列映射下拉用
```

**按 `reason` 分流**（不要笼统报「解析失败」）：`ok` / `empty` / `no_word`（列映射选错了）/
`bad_input` / `legacy_xls`（旧版 .xls，给「另存为 .xlsx」的指引）/ `bad_zip` / `no_sheet` / `unzip_failed`。

### 表格解析的六个坑（全部实测踩过）

| 坑 | 正确做法 |
|---|---|
| **表头带重音** | 法语/西语表头是 `phonétique` / `catégorie` / `définition`，**匹配前必须折叠变音符号**（`àáâãäå→a`、`ç→c`、`èéêë→e`、`œ→oe`…），否则一条都对不上。这是最隐蔽的一个——中文表头全过，一换法语表头全错 |
| **列认领顺序** | 「例句翻译 / 例句中文 / 译文」必须在「中文 / 意思 / 释义」**之前**被认领，否则释义会把例句翻译列截胡。认领顺序建议 `example_zh → example_fr → phonetic → pos → word → meaning_zh`，每类只认领一次、每列只被认领一次，两轮（先精确、后包含） |
| **xlsx 两种单元格写法** | `t="s"` 是 sharedStrings 的**下标**（要去 `xl/sharedStrings.xml` 查表，一个 `<si>` 里可能有多个 `<r><t>` 富文本片段，要拼接）；`t="inlineStr"` 直接内联在 `<is><t>` 里。openpyxl 写出来的是 inlineStr、xlsxwriter 写的是 sharedStrings —— **两种生成器的样本都要测**，只测一种必然漏 |
| **稀疏列** | 空单元格会被**整个省略**，不能按出现顺序数格子。必须解析 `r="BC12"` 里的列字母（A=0 的 26 进制）反推真实列号 |
| **旧版 `.xls` 不是 ZIP** | 它是 OLE 复合文档（magic `D0 CF 11 E0`），结构完全不同。**如实报 `legacy_xls` 并给另存为 `.xlsx` 的指引**，不要返回空表让用户猜 |
| **GBK 只告警不硬猜** | 解不出 UTF-8 时（U+FFFD 占比 > 2% 且个数 ≥ 4）只**提示用户另存为 UTF-8**，不要自己按 GBK 硬解出一堆乱码塞进业务数据。BOM 要正确识别 UTF-8 / UTF-16LE / UTF-16BE |

另外：**整行标题**（首行只有一个非空单元格、次行有 ≥2 个）要先跳过再判断表头，否则要么丢一行、要么多一个假词；
**行数上限**只作为内存保护（如 2000 行），判定「是否截断」要用**过滤空行后的原始行数**，
而且**表头行不该占用额度**（「最多 2000 个词」对用户才是字面意思）。

### 导入 UI 的通用形态

`pick | preview` 两步状态机 + **全量行留在页面实例属性**（`this.allRows`），只有前 100 条进 `setData` 渲染 ——
2000 行全塞进 `data` 会把视图层拖垮。去重分两档：**目标容器内已有 → 硬跳过（默认不勾选）**，
**别处出现过 → 只提示仍可导入**（同一个词同时属于多个集合是常见且合理的用法，不该被拦）。
大批量写入按 200 条分片（单次请求体过大时失败还不好定位）。

### 要「交付一份用户直接导入就能用的词表」时的四条规矩

解析器是既成事实，**要交付的表格得反过来迁就它**，而不是让用户去点六个 picker：

1. **表头名直接抄解析器 `HEADER_HINTS` 里的词**（本项目的六列是 `mot / 中文释义 / 音标 / 词性 / 例句 / 例句翻译`），
   这样六列全部走「精确匹配」一次对位，用户看到的就是「已经对好了」。凭感觉写「法语单词 / 中文意思 / 发音」
   也能中，但会走到「包含匹配」那一轮，多一层不确定性。
2. **跨文件零重词**。跨集合重词在逻辑上只提示不拦，但用户在导入时看到一串「这个词已在别的库里出现过」
   会以为出了问题 —— 交付多份配套词表时，先做一遍全局去重。
3. **枚举列先查已有文件的实际取值域**，别自己发明。本项目 `词性` 只有 12 个合法值
   （`n.m. n.f. v. adj. adv. prép. conj. pron. det. num. interj. loc.`），**没有 `n.m.pl.` 这类复数标记**；
   同理 `等级` 只有 `A1 A2 B1 B2`。写新的一批之前先 `grep` 一遍老文件，比事后返工便宜。
4. **格式细节**：`utf-8-sig`（带 BOM，中文 Windows 上 Excel 直接双击打开不乱码）+ **每个字段都用双引号包起来**
   （例句里的逗号就不会串列）。**注意：Write 这类文件工具在 Windows 上通常已经写出 UTF-8 with BOM**，
   再补一次会变成双 BOM —— 补之前先读前三字节确认（`efbbbf` 后直接跟 `22` 即正常），
   没有才用脚本补（`open(p,'wb')` 前置 `b"\xef\xbb\xbf"`）。

配套的交付前自检：拿真解析器逐份跑一遍，断言 `reason==='ok'`、`mapping` 与期望完全相等、
每行六个字段都非空、词性落在取值域内、表内无重复、`truncated===false`；
再走一次真实导入页，把「同一份重复导入不写任何行」（幂等）和
**多词/特殊字符词条**（含空格、含撇号 `en l'occurrence`、连字符 + 合字 `chef-d'œuvre`）都断言一遍，
最后确认分片写入后首末条顺序没被打乱。

**规矩 2「跨文件零重词」有个例外**：按 CEFR 等级切分时，A1 与 B2 出现同一个词形是**正确**的——
法语词典按 **(词, 词性)** 定级，`pouvoir` 的动词义是 A1、名词义（权力）是 B1，两个都该收。
此时重词要**有意保留**并在 README 里说明，而不是当重复去掉。
这类「几千条、带音标、按等级」的词表不要手搓，用 **`cefr-wordlist-pipeline`** skill 从
FLELex + Lexique383 合成（含 latin-1 编码、Lexique 自有音标表、词形级/词根级频率等实测坑位）。

## 验证方式（务必做，不能只靠读代码）

1. `scripts/pdf_probe.cjs <文件>` 直接打印抽取结果、页数、字符数与判定原因——先跑通样本再改代码。
   表格用 `scripts/sheet_probe.cjs <文件>`（也支持 `node sheet_probe.cjs - "粘贴的文本"`）：
   打印编码 / 表头判定 / 列名 / 列映射 / 告警 / 截断情况 / 前 10 条词，一眼就能看出列映射错在哪。
2. 至少准备这几类样本：TTF 子集（含中文/重音）、核心字体（WinAnsi）、Identity-H 中文、
   扫描版（无文字层）、加密 PDF、旧版 .doc，以及**一个真实出版物 PDF**（`curl` 从 arXiv 取即可）。
   表格样本要覆盖：带表头 / 无表头 / 分号分隔 / 引号内含逗号与换行 / UTF-8 BOM / GBK / UTF-16+Tab /
   单列 / 空文件 / 2500 行（验截断）/ 脏数据（空行、孤儿释义、文件内重复）/ 富文本片段 / 稀疏列 /
   整行标题 / 旧版 .xls。
   **`openpyxl` 与 `xlsxwriter` 两个生成器都要用**：前者写 `t="inlineStr"`、后者写 `t="s"`+sharedStrings，
   只测一种必然漏掉另一种的解析分支。
   注意 `xlsxwriter` 的 `write_rich_string` 至少要 3 个片段，传 2 个会告警并**静默忽略输入**（样本会变成空的，
   很容易误判成解析器 bug）。
3. 压缩正确性用 Node 的 `zlib.inflateSync` 对拍自实现的 inflate（逐字节比较）。
4. 页面逻辑用「桩 wx + 桩模块 + 捕获 `Page({})` 配置对象」驱动，
   验证全链路，而不是只看语法通过。可直接用现成模板 `scripts/page_harness.cjs`：
   它已经把 `Module._load` 挂钩、假 `wx`/`Page`/`getApp`、支持 `'a[0].b'` 路径的迷你 `setData`
   都搭好了，改桩与断言即可跑。**推荐用 `Module._load` 挂钩做桩**，这样能直接跑真实的页面文件
   （不用复制/改写源码），只替换外部依赖：

   ```js
   const Module = require('module')
   const origLoad = Module._load
   Module._load = function (request) {
     if (/workbuddy-cloud-sdk/.test(request)) return { createMiniProgramWorkBuddyCloud: () => ({}) }
     if (/(^|\/)cloud$/.test(request)) return cloudStub      // friendlyError 等
     if (/(^|\/)config$/.test(request)) return configStub
     if (/utils[\\/]api$/.test(request)) return apiStub
     if (/utils[\\/]llm$/.test(request)) return llmStub      // 记下 calls，返回假单元
     return origLoad.apply(this, arguments)
   }
   global.wx = { showToast: (o) => toasts.push(o.title), /* … */ }
   global.getApp = () => ({ markDirty() {} })
   let cfg = null
   global.Page = (c) => { cfg = c }
   require('<项目>/pages/xxx/xxx.js')
   // 造实例：Object.create(cfg) + data 深拷贝 + 自己实现支持 'a[0].b' 的 setData
   ```

   真实 `storage.js` 里的 `readAsArrayBuffer` 直接替换成 `fs.readFileSync` 就能读磁盘样本。
   这样能把状态机（`ok`/`large`/`fail`/`scanned`/`converting` 的迁移、按钮显隐标志位）**全部断言一遍**，
   比人工点一遍可靠得多。

   **要连数据层一起测**（推荐）：别把 `utils/api` 也桩掉，而是给云 SDK 换一个
   **内存版 supabase 查询构建器**——直接用现成的 `scripts/cloud_db_mock.cjs`：

   ```js
   const { makeCloudStub } = require('./cloud_db_mock.cjs')
   const tables = { fr_words: [/* … */], fr_libraries: [/* … */] }   // 就地读写，断言直接看它
   const cloudStub = makeCloudStub(tables)
   // Module._load 里： if (/(^|\/)cloud$/.test(request)) return cloudStub
   ```

   这样跑的是真实的 `api.js`（已验证：它能正确驱动 `listWords` 的 `''`/`'none'`/数字三条分支、
   `libraryStats` 端上聚合、`createLibrary` 的 trim、`updateLibrary` 的 updated_at、
   以及「update/delete 命中 0 行 → 抛错」这个 RLS 契约）。要点：
   - 链式方法全部 `return this`（`select/eq/is/not/lte/gte/or/order/limit/range/maybeSingle/insert/update/delete`）；
   - 实现 `then(resolve, reject)` 让它**可被 `await`**（`await q.order().range(a,b)` 才不会挂）；
   - `select(cols, { count:'exact' })` 要返回**未切片的** `count`，`range()`/`limit()` 只影响 `data`；
   - `update/delete` 返回受影响行，空数组要能被 `api.js` 判成「RLS 拦下了」（这是真实契约，必须保留）；
   - **`insert` 必须回填自增 `id`**。真页面常见「先 `createLibrary()` 拿 id，再用它当外键批量写子表」，
     不回填 id 的话拿到的是 `undefined` 外键，整条链路在测试里直接断掉；
     而且**初次自增前要先扫一遍表里已有的 id**（预置数据常从 11、12 开始，从 1 自增会撞主键）。
     `cloud_db_mock.cjs` 已经实现好这一点，改这个文件时别把 `nextId()` 去掉。

   桩不用了记得 `delete require.cache[...]` 再重新 `require`，否则拿到的是上一次的模块实例。
   这类测试往往能直接逼出**历史遗留 bug**——本次就靠它发现一个 `if (this.isNew)` 从未被赋值的真 bug（见下）。
5. 样本可用 fpdf2 生成（`pip install fpdf2`，`add_font` 传系统 TTF：
   `C:/Windows/Fonts/arial.ttf`、`simhei.ttf`；`set_encryption` 造加密样本）。
   注意 `multi_cell` 需显式传 `new_x="LMARGIN"`，否则第二行会因 x 停在右边界而报错。
6. **调试卡住时先做隔离实验再怀疑组件**：这次 PNG 全挂，最后定位到是 adler32 用错了输入，
   而 deflate 本身 240 例模糊测试全过——把「压缩 / 校验 / 组装 / 落盘」逐段切开各测各的，
   比盯着一段代码猜快得多。
7. **写测试时先抽样确认样本的真实内容，再写断言**：本轮多次把样本表头记错（以为是「单词/音标/词性/例句」，
   实际是「单词/音标/词性/释义」），结果断言错了而代码是对的，白白多跑几轮。
   凡是「我猜这个字段应该是 X」的断言，先 `head`/`iconv` 看一眼原始字节。

## 交付前检查

- 新模块里不出现 `TextDecoder` / `Buffer` / `process` / `document` / `window` / `fetch`。
- `data` 里没有大字符串；WXML 表达式里没有方法调用（小程序不支持 `indexOf` 等）。
- 所有失败分支都有用户能看懂的原因与替代路径。
- **实例标志位 ≠ `data`**：`Page` 里 `setData({ isNew: false })` 只写 `data.isNew`，
  读 `this.isNew` 永远是 `undefined`。判断「新增还是编辑」一律以不可变主键（如 `this.wordId`）为准。
  这个坑真实存在过：`save()` 里 `if (this.isNew)` 永远为假 → 新增走 `updateWord(null)` → 新增根本存不进去。
- **页面模板里引用的类名要真有样式**（顺手做一次机械检查）：扫所有 `class="..."`（含 `{{}}` 三元分支里的字符串字面量，
  排除比较运算符右侧的判断值），与 `app.wxss` + 同页 `.wxss` 的规则集求差。真实项目里常能揪出几个死类名。
- 静态校验三件套都要跑：`node --check` 全量 JS、全量 JSON `JSON.parse`、
  以及「WXML 绑定的事件处理函数在 JS 里存在 / 绑定表达式无方法调用 / `usingComponents` 与 `app.json` 页面文件齐备」。
