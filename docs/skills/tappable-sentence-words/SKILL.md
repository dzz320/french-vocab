---
name: tappable-sentence-words
description: 让**例句/文章里的每个单词可点**（点词查词、跳词条、跳词典页），含法语句子的正确切词规则与小程序端落地方式。当用户说「例句的单词能点击跳转」「点词查词」「点单词跳详情/词典」「句子里的词做成可点的」「点睛查词」时使用。核心资产 assets/fr-text.js 是可直接复用的法语切词器（词首成分 l'/d'/qu'、连字符复合词 est-ce、合字 œuvre 都处理对了），SKILL 里记了三条真踩过的坑：把 quelqu'un 的本词判成 un 会误跳、把 aujourd'hui 判成 hui 会乱跳、WXML 逐片渲染时插入空白会把例句排版搞坏。
agent_created: true
---

# 句子里「点词查词 / 跳词条」

## 何时使用

- 用户说「例句的单词能点击跳转到该单词页面」「点词查词」「句子里的词可点」；
- 阅读类 / 背单词类页面要在句子上做「点睛查词」（tap-to-lookup）；
- 想把一句话渲染成**逐词可点**，同时标点、空格原样保留。

## 整体形状（四步，缺一不可）

1. **切词**：把句子切成 `{ t, w }` 片段（`w=true` 表示可点单词），**拼回去必须逐字符等于原文**。
2. **候选词形**：点到的词往往是变位/复数/带词首成分的形式，按「整词 → 去词首成分 → 连字符各段」依次查库。
3. **命中 → 跳已有词条页；未命中 → 带着词形跳新增页**（不要静默失败，否则用户以为点了没反应）。
4. **防连点 + 结果缓存**：查库一次往返，连点会开出多个页面。

## 三个真踩过的坑

### ① 别把「撇号后的部分」一律当本词

法语有两种撇号词，规则相反：

| 类型 | 例 | 本词 | 若一律取撇号后段 |
|---|---|---|---|
| 词首成分（elision） | `l'école` `qu'il` `d'ailleurs` | `école` `il` `ailleurs` ✅ | 正确 |
| 词汇化撇号词 | `quelqu'un` `aujourd'hui` | 整词 ✅ | `un` / `hui` ❌ |

`quelqu'un` 判成 `un` **不是形式问题而是会跳到错的词条**（库里真有 `un`）。
所以只对**白名单词首成分**（`l d j m n s t c qu jusqu lorsqu presqu puisqu quoiqu`）+ 撇号才剥，其余原样。
见 `assets/fr-text.js` 的 `CLITICS` / `elide()` / `headWord()`。

### ② 连字符复合词不能只取第一段

`est-ce` → `est`（对，动词倒装）；但 `chef-d'œuvre` → `chef`（错，中心词是 `œuvre`）。
做法：对每个连字符段**再套一次词首成分剥除**，并把剥好的排在被剥的前面，命中就少发一次查询：

```
chef-d'œuvre → [chef-d'œuvre, chef, œuvre, d'œuvre]
l'école      → [l'école, école]
est-ce       → [est-ce, est, ce]
```

单字母（`l d à y`）不进候选，否则库里全是噪音命中。

### ③ WXML 逐片渲染时，标签间的换行会变成例句里的空格

```
❌ <block wx:for> 换行 <text>… </text> 换行 </block>     ← 例句里凭空多出空格
✅ 整段写成一行：<view class="fc-example-fr"><block wx:for="{{parts}}" wx:key="i"><text wx:if="{{item.w}}" …>…
```

另外两个小点：
- 可点单词用 `catchtap`，**必须**能阻止冒泡到外层「点整句朗读」的 `catchtap`；
- 片段要带 `i` 字段做 `wx:key`；`wx:for` 里 `wx:key="i"` 指的是 item 的属性名。
- 行内 `<text>` 上做「可点」提示：用**极淡底色 + 圆角**最稳，`border-bottom` / `text-decoration-style: dotted` 在小程序里渲染不稳。

## 库侧查询必须是**精确**匹配

```
.ilike('word', w)          // ✅ 不带通配符 = 大小写不敏感 + 精确
.ilike('word', '%' + w + '%')  // ❌ 变成模糊搜索：点 «Il» 会随机命中某个含 il 的词
```

`ILIKE` 不带 `%` / `_` 时就是纯精确（已在真库验证：`ILIKE 'Bonjour'` 命中小写行）。
调用方传进来的词形只含字母与词内连接符，不会带通配符；查库时 `order('id') + limit(1)` 取最早一条。

## 未命中的产品决定

库里没有这个词时**不要**只弹一个 toast —— 用户点的是「这个词的页面」，那就带它去新增页：
`/pages/word-detail/word-detail?word=<headWord>`，并在表单上方写一行说明「生词本里还没有「x」」。
接收页要对 query 做**解码容错**（`%` 开头才 `decodeURIComponent`，解不开按原样用）——
不同基础库 / 扫码入口对 query 的解码行为不一致。

## 别忘了量化命中率（会改变结论）

这个功能的表现**完全取决于词库里有什么**。用真代码离线跑一遍例句，算「点词能跳到已有词条的比例」，
再按不同词库规模对比，往往能直接给出「该不该多导几级词表」的答案：

```
node assets/hitrate.cjs      # 见脚本头部注释，改 LIB 文件列表即可
```

实测（1717 条 B1 例句、16926 个词，库 = 对应词表）：

| 库里有 | 点词命中率 | 至少一词可跳的句子 |
|---|---|---|
| 只有 B1 | 18.5% | 94.4% |
| + A1 | 38.0% | 99.6% |
| + A1 + A2 | 43.3% | 99.9% |

结论：例句的骨架是**低级别功能词**（la / le / a / il / ce / est…），只导高级词表时 8 成点击会落到新增页。
这是「词表分级」的必然结果，不是 bug —— 但要在交付说明里讲清楚，否则用户会以为功能坏了。

## 测试（无 headless，跑真页面真模块）

`assets/test-example-link.cjs` 是可直接改用的模板，四组断言：

- **A 切词保真**：多句（含弯撇号、合字、引号、纯数字、空串）断言 `parts.map(t=>t).join('') === 原文`；
- **B 候选与 headWord**：`quelqu'un` 不能变 `un`、`aujourd'hui` 不能变 `hui`、`chef-d'œuvre` 要带出 `œuvre`；
- **C 页面行为**：命中跳 `?id=`、未命中跳 `?word=`、二次点击不再查库、连点只跳一次、
  查库失败给提示且解锁、跳转前停止朗读、空片段不查库；
- **D 接收页**：`?word=` 预填 + 未解码入参兜住 + 带 `id` 时不被预填干扰。

跑法：`node test-example-link.cjs <小程序根目录>`（用假 wx + 假 api 驱动真 `pages/*` 与真 `utils/fr-text.js`）。
这套「假 wx 加载真页面」的脚手架与 `miniprogram-audio-tts` 里那套同源，两个 skill 的控制台输出格式一致，可拼在一起跑。

## 复用清单

- `assets/fr-text.js` → 拷到 `utils/fr-text.js`（纯逻辑、无 wx 依赖，Node 里可直接 require 做批处理）；
- 页面侧：`data.exampleParts = frText.tokenize(card.example_fr)`；点词 → `lookupCandidates` 逐个查 →
  `wx.navigateTo`；`this.lookupCache` 存词形→结果，`this.lookupBusy` 防连点；
- 非法语语种：换掉 `LETTER` 与 `CLITICS` 即可，规则骨架（整词 → 去词首成分 → 连接符各段）通用。
