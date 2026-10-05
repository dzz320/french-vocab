// WorkBuddy 云服务公开配置。
// 仅包含可随前端分发的公开值（publishableKey 不携带权限，服务端校验应用身份）。
// 禁止把任何服务端密钥写进这里。

// 自建法语发音服务（见 tts-service/app.py）。
// 留空则跳过这一路音源。发布后把域名回填到这里（不带结尾斜杠）。
const TTS_SERVICE = 'https://french-vocab.app.workbuddy.host'

module.exports = {
  endpoint: 'https://mp-api.app.workbuddy.host',
  publishableKey: 'wbpk_j8GTqsa3MpSgMSKYxhWyK1_ImFri6s6xwPMrSm2KQXdv86vxTNN9CDQ',

  // 法语发音（单词 / 例句朗读）。
  //
  // 音源是「按顺序尝试」的列表：前一个失败会自动降级到下一个。{text} 会被替换成
  // URL 编码后的法语文本。
  //
  // 为什么不用有道当主力：dictvoice 那个接口只对它自己已缓存的文本发声，任意词表
  // 命中率极低 —— 实测 B1 词表前 600 个词 0 命中（稳定 HTTP 500），而 bonjour /
  // merci 这种超高频词正常。表现就是「有的词能读、有的词永远读不出来」。
  // 自建服务用 edge-tts（微软神经语音）合成任意法语文本，覆盖 100%。
  //
  // ⚠️ 真机播放网络音频要求域名进白名单：小程序后台 → 开发管理 → 开发设置 →
  //    服务器域名，把用到的域名同时加到 request 与 downloadFile 合法域名。
  //    漏配的表现是模拟器有声、真机没声（errCode 10002）。
  tts: {
    enabled: true,
    lang: 'fr',
    sources: [
      {
        label: '法语发音服务',
        url: TTS_SERVICE ? TTS_SERVICE + '/tts?t={text}' : '',
      },
      {
        label: '有道词典（兜底，覆盖不全）',
        url: 'https://dict.youdao.com/dictvoice?le=fr&audio={text}',
      },
    ],
  },
}
