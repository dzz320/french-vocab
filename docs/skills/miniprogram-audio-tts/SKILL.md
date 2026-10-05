---
name: miniprogram-audio-tts
description: 给微信小程序加**单词/句子朗读（发音、TTS、听力）**：多音源降级 + 预热 + 用户目录本地缓存的可复用实现，含单实例播放器、播放态高亮、发音偏好、静音键策略。当用户说「加上发音」「点击朗读」「听发音」「TTS」「听力」「点例句读一下」，或反馈「有的词能读有的词读不出来」时使用。内含七个实测坑：第三方 dictvoice 接口不是通用 TTS（覆盖极低）、obeyMuteSwitch 实例属性已失效、不能用异步 onStop 清播放态、播放态 emit 必须去重、喇叭按钮必须 catchtap、真机域名白名单只在真机生效（errCode 10002）、预热后测试脚本要能反查本地缓存路径。
agent_created: true
---

# 微信小程序发音（TTS）

## 何时使用

- 用户说「加上发音 / 音标发音 / 点击朗读 / 点例句朗读 / 听力 / 跟读」；
- 用户反馈**「不是每一个单词都能发声」「有的词点了没声音」** —— 先跳到下面「最大的一坑」；
- 背单词、语言学习、儿童绘本、客服话术练习类小程序需要「点一下就出声」；
- 需要在下面这些位置放喇叭：卡片正面（单词）、卡片背面（例句）、列表行、编辑表单。

小程序**没有内置 TTS**，官方「同声传译插件」(WechatSI) 只支持 `zh_CN` / `en_US`，**法语等小语种走不通**。
WorkBuddy 云服务的模型目录里也**只有文本/多模态模型，没有语音合成**。

## ⚠️ 最大的一坑：第三方 dictvoice 接口不是通用 TTS

`https://dict.youdao.com/dictvoice?le=fr&audio=<text>` **看起来能用，其实只能读它自己已经缓存过的文本。**

2026-10 实测（同一台机器、同一分钟）：

| 文本 | 结果 |
|---|---|
| `bonjour` `merci` `eau` `livre` `maison` `ami` `bouger` | ✅ 200 / `audio/mpeg` |
| `abbaye` `haut` `gêner` `thème` `parler` | ❌ **HTTP 500，永远 500** |

- **不是限流**：间隔提到 2～3 秒重试、`abbaye` 连续 20 次请求跨 83 秒，**仍然全 500**，而同期 `bonjour` 稳定 200；
- **不是参数问题**：`type=1/2`、参数顺序、加 `Referer`、`le=fr_FR`、加句点/空格/引号 —— 全都一样；
- **没有补齐机制**：失败请求不会让该词慢慢变好；
- **整表命中率极低**：B1 词表（1717 个真实 B 级词）**前 600 个 0 命中**。

于是产品表现就是用户最困惑的那种：**「有的词能读，有的词怎么点都没声」**。

其它免费接口同样不可用：`fanyi.baidu.com/gettts` 403；`tts.baidu.com/text2audio` 返回 JSON 错误；
`tts.iciba.com/<word>.mp3` 404；`tts.youdao.com/fanyivoice` 688。

### 结论：小众语种必须自己控音源

用 **edge-tts（微软 Edge 的神经语音，免费、无需 key）** 自建一个发音服务，脚本见
`assets/tts-service/app.py`，可直接用 `sites` skill 发布成单端口 HTTP 服务。

```bash
# 本地验证
pip install edge-tts
PORT=3971 python app.py
curl --get --data-urlencode "t=abbaye" http://127.0.0.1:3971/tts -o a.mp3
# 接口：GET /tts?t=<文本>&v=<音色>  /health  /（试听页）
```

- 法语音色：`fr-FR-DeniseNeural`（女，默认）/ `fr-FR-HenriNeural`（男）/ `fr-FR-EloiseNeural` /
  `fr-FR-VivienneMultilingualNeural` / `fr-FR-RemyMultilingualNeural`；
- **任意文本 100% 可读**，含 `abbaye`/`gêner`/`thème`、`chef-d'œuvre`、整句例句；
- 单词 ~9KB、整句 ~19KB；同步合成 ~1.5–2.5s，缓存命中 ~3ms；
- 服务端按 `sha1(voice + text)` 落盘缓存；客户端再缓存一层 → 每个片段全网只合成一次。

**先量覆盖率再决定用哪个音源**：拿真实词表取样打一遍，别用 `bonjour` 这种超高频词试，
它会给你「接口没问题」的假象。

## 音源要设计成「按顺序降级的列表」

别把音源地址写死成一个常量。`config.tts.sources` 是数组，`{text}` 占位符，前一路失败自动切下一路：

```js
tts: {
  enabled: true,
  lang: 'fr',
  sources: [
    { label: '法语发音服务', url: 'https://<域名>/tts?t={text}' },
    { label: '有道词典（兜底，覆盖不全）', url: 'https://dict.youdao.com/dictvoice?le=fr&audio={text}' },
  ],
}
```

- 空 `url` 的条目直接跳过（域名还没发布时留空，不报错）；
- 播放失败时**静默切下一路**，全部失败才提示用户；`stop()` 之后迟到的 `onError` 不该再弹东西；
- 缓存按「实际使用的地址」算 hash，别按文本算 —— 否则换音源后会读错缓存。

## 第一步：五个必踩的坑

### ① `obeyMuteSwitch` 实例属性已失效

文档还写着 `InnerAudioContext.obeyMuteSwitch`，但**从基础库 2.3.0 起这个属性不再生效**。
不换成全局设置，iPhone 拨到静音时点喇叭**一点声音都没有** —— 最难自查的一类问题（用户会说「没反应」）。

```js
wx.setInnerAudioOption({ obeyMuteSwitch: !ignoreMute, mixWithOther: true })
```
偏好变化时要**重新调用**它。语言学习类应用建议默认「静音键下也发声」（用户是主动点喇叭，说明他就想听）。

### ② 别用异步的 `onStop` 清播放态

`play()` 内部要先停掉上一段，但 **`onStop` 是异步到达的**。于是序列变成：
新播放点亮 → 旧播放的 onStop 姗姗来迟 → 把新播放的标志抹掉。表现是「喇叭闪一下就不亮了」。

正确做法：
- **不注册 `onStop`**；
- `stop()` 自己**同步**清 `activeKey` 并广播；
- 系统中断（来电等）另注册 `wx.onAudioInterruptionBegin` 清状态。

### ③ 播放态广播必须按状态去重

`onPlay` 会广播一次，你为了「不等 onPlay 再点亮」还会主动广播一次 —— 同一个 key 推两遍，页面 `setData` 翻倍。
在广播函数里存一个 `lastEmitted`，**值没变就不推**。这同时让「重复播放同一个词」不会产生多余渲染。

### ④ 喇叭按钮必须 `catchtap`

卡片/列表行的父层通常是 `bindtap="flip"` 或 `bindtap="openWord"`。
用 `bindtap` 点喇叭会**顺带翻卡 / 顺带跳详情**。一律 `catchtap`。
反过来，「整句例句都可点朗读」这种设计，要在例句块上用 `catchtap` 才能吃掉冒泡（此时卡片已翻开，不冲突）。

### ⑤ 真机域名白名单只在真机生效

网络音频的域名必须在小程序后台配好：
**mp.weixin.qq.com → 开发管理 → 开发设置 → 服务器域名**，
把域名**同时**加进 **request 合法域名**和 **downloadFile 合法域名**。

- 开发者工具勾「不校验合法域名、web-view、TLS 版本…」→ **只对模拟器有效**；
- 真机（体验版 / 正式版）照样失败，`errCode 10002`。

所以捕获到 10002 时要弹 `wx.showModal`，**把出错的那个 host 和操作路径写清楚**，
并按 host 去重（别每次点都弹）。不这么做，用户只能看到「发音加载失败」，查半天。

> 这条漏配的表现恰好也是「有的词能读、有的词读不出来」：主音源整条挂了，只有兜底里那几个
> 超高频词还能响。**所以提示里一定要指名是哪个域名**，否则用户会把配置问题当成词的问题。

错误码含义：`10001` 内部错误（重建实例）、`10002` 网络错误（**先查白名单**）、`10003` 解码错误（格式/防盗链）、`10004` 资源不存在。

## 第二步：预热（prefetch）—— 自建音源的延时补偿

自建服务同步合成要 1.5–2.5s，用户点一下等两秒会以为坏了。做法是**进卡就先下**：

```js
// 卡片出现时预热单词；翻面时预热例句。失败静默 —— 预热只是优化
audio.prefetch(card.word)
flip() { audio.prefetch(card.example_fr); this.setData({ flipped: true }) }
```

预热走 `wx.downloadFile` 落进 `USER_DATA_PATH/tts/`，之后 `play()` 直接读本地文件（~0ms）。
列表页**别**批量预热 20 个词：会同时压 4 个合成槽位，反而更慢。

## 第三步：落地结构

拿 `assets/audio.js` 直接用（`require('./config')` 读 `config.tts`，没有就回退默认值）。
公开接口：

```js
audio.play(key, text)             // key 是页面自己定的播放标识，页面用它高亮对应喇叭
audio.prefetch(text)              // 预热（下进本地缓存），失败静默
audio.stop()
audio.bindPage(page, 'playingKey')// onLoad 里调；自动把播放态写进 data，并在 onUnload 解绑 + 停播
audio.playWithGuard(key, text, '请先输入法语单词')  // 空内容给提示、不发声
audio.getPrefs() / audio.setPrefs({ autoPlay, ignoreMute })
audio.isEnabled()
audio.getState()                  // { key, url, source, sourceIndex, sourceCount } 排查用
```

页面接入（**四步，缺一不可**）：

```js
const audio = require('../../utils/audio')
Page({
  data: { playingKey: '' },          // ① 必须在 data 里声明，否则 WXML 取到 undefined、样式永远不亮
  onLoad() { audio.bindPage(this) }, // ②
  speakWord() { audio.play('word', this.data.card.word) },     // ③
  onUnload() { audio.stop() },       // ④（bindPage 已包一层，显式写更清楚）
})
```
```xml
<view class="speak-btn speak-btn-sm {{playingKey === 'word' ? 'speaking' : ''}}"
      catchtap="speakWord">🔊</view>
```

**自动发音默认关**。第一张卡片出现在 `onLoad` 之后，不在用户手势里，iOS/微信可能直接拦掉播放，
静默失败看起来就像 bug。要做成开关放在「我的 → 发音设置」，并给一个「试听」按钮让用户当场验证链路 ——
**试听句里一定要放几个「兜底音源读不出来」的词**（如 `abbaye, thème, gêner`），
否则试听从兜底音源出声，用户会以为已经好了。

**编辑表单里的喇叭读「输入框现值」**，不要读已保存的值 —— 改完还没保存就能听，是这类页面最爽的细节。

## 第四步：离线验证（不依赖真机）

小程序没有测试框架，但发音的全部逻辑（除了「有没有真的出声」）都能用假 `wx` 跑：

- `assets/test-audio.cjs`：只喂假 `wx`，把**真 `utils/audio.js`** 跑起来。断言地址拼接/编码、文本折叠与截断、
  缓存命中不重复下载、连点不出现空态闪烁、错误码分支、偏好持久化、`bindPage` 的解绑与 `onUnload` 包装。
- `assets/test-audio-sources.cjs`：**造一个带双音源的 fixture 工程**（临时目录里放 `utils/audio.js` 副本 +
  自写的 `utils/config.js`），断言降级链：主音源失败静默切备用、备用也失败才提示、10002 指名域名且按域名去重、
  `stop()` 之后迟到的错误不打扰用户、`prefetch` 不重复下载。
- `assets/test-audio-pages.cjs`：`Module._load` 只替换 `utils/api`、`utils/llm`、`utils/cloud`、SDK，
  **真页面 + 真 `audio.js`** 一起跑，从假 `InnerAudioContext` 记录的 `src` 里解出文本 ——
  直接断言「**真正发到 TTS 的文本**是哪个词/哪句话」。

抄测试时的两个易错点：

1. 假 `downloadFile` 要**同步调 success**，模拟缓存写入；
2. **要处理「src 是本地缓存路径」的情况**：预热生效后，点播放的 `src` 不再是远程地址，
   只解析 `audio=` 参数的写法会把「缓存命中」误判成「没发声」。
   两个办法：在假 `downloadFile` 里顺手记一张 `cachePathFor(url) -> 文本` 的反查表（推荐），
   或者每次断言前清掉 `/udata/tts/` 下的缓存文件（会顺带把预热验没了）。
3. 同时兼容两路音源的参数名：自建服务用 `?t=`，有道用 `?audio=`。

## 不要用这条路线的情况

- 需要**离线可用**（飞机上、无网场景）：在线接口不成立。此时唯一方案是**预生成 mp3** 并放进
  已配好白名单的域名（小程序自己的云存储 / 一个静态站点），再用清单或固定路径播 ——
  但只能覆盖已知词表，用户自己导入的词仍要在线接口兜底。
- 音频总时长较长（听力材料、有声书）：该用 `getBackgroundAudioManager` + `requiredBackgroundModes`，
  短单词卡片用 `InnerAudioContext` 更轻。
- 需要**录音评分/跟读打分**：那是 ASR + 打分，另起一条链路。
