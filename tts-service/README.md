# 法语发音服务（tts-service）

给小程序提供**任意法语文本**的发音，替代不能用的第三方 dictvoice 接口。

## 为什么需要它

小程序的发音原先直接取 `https://dict.youdao.com/dictvoice?le=fr&audio=<text>`。
这个接口只对它自己**已经缓存过**的文本发声：

| 文本 | 结果 |
|---|---|
| `bonjour` `merci` `eau` `livre` `maison` `ami` | ✅ 200 |
| `abbaye` `haut` `gêner` `thème` `parler` | ❌ HTTP 500，永远 500 |

不是限流（隔几秒重试、83 秒内 20 次全 500，同期 `bonjour` 稳定 200），
也不是参数问题（`type`、参数顺序、`Referer`、`le=fr_FR` 都试过）。
B1 词表 1717 个真实词的**前 600 个命中 0**。

表现就是用户最困惑的那种：**有的词能读，有的词怎么点都没声。**

## 它做什么

用 edge-tts（微软 Edge 的神经语音，免费、无需 key）合成：

```
GET /tts?t=<法语文本>&v=<音色>   ->  audio/mpeg
GET /health                        ->  {"ok":true,"cached":N,...}
GET /                              ->  试听页（浏览器里直接听）
```

- 默认音色 `fr-FR-DeniseNeural`，另有 Henri / Eloise / Vivienne / Remy；
- 单词 ~9KB、整句 ~19KB，同步合成 1.5–2.5s，缓存命中 ~3ms；
- 服务端按 `sha1(voice + text)` 落盘到 `cache/`，同一文本全网只合成一次；
- 小程序端还有一层本地缓存 + 进卡预热，正常每个片段只请求一次。

## 本地跑

```bash
pip install -r requirements.txt
PORT=3971 python app.py

curl --get --data-urlencode "t=abbaye" http://127.0.0.1:3971/tts -o a.mp3
curl --get --data-urlencode "t=Il faut absolument que tu voies cette abbaye." http://127.0.0.1:3971/tts -o b.mp3
```

浏览器打开 `http://127.0.0.1:3971/` 有试听页。

## 发布

用 WorkBuddy 的 `sites` 能力发布这个目录即可（单端口 HTTP 服务，监听 `$PORT`、绑 `0.0.0.0`）。
发布后把域名回填到小程序的 `utils/config.js`：

```js
const TTS_SERVICE = 'https://<发布后的域名>'
```

**还要在小程序后台加白名单**（漏配的表现是模拟器有声、真机没声）：

> mp.weixin.qq.com → 开发管理 → 开发设置 → 服务器域名
> 把该域名**同时**加进「request 合法域名」和「downloadFile 合法域名」

## 注意

- edge-tts 走的是微软 Edge 朗读的公开接口，适合个人自用；服务端做了缓存，同一文本只请求一次，
  别把它当成面向公网的高并发 TTS 网关。
- `cache/` 目录可以随时删，删了只是重算。
- 沙箱里没有数据库/缓存服务，所以缓存用文件实现；重新发布会丢缓存（不影响功能，只是第一次慢一点）。
