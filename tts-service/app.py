#!/usr/bin/env python3
"""法语发音服务。

    GET /tts?t=<文本>&v=<音色>   ->  audio/mpeg
    GET /health                  ->  {"ok": true}
    GET /                        ->  试听页（浏览器里可直接听）

为什么要有这个服务：
    小程序的发音原先直接取有道 dictvoice，但那个接口只对它自己已缓存的文本发声，
    任意词表命中率极低（实测 B1 词表前 600 个词 0 命中，稳定 HTTP 500），
    不可控。这里用 edge-tts（微软神经语音）自己合成：任意法语文本都能读，
    音质也好得多。

缓存：
    按 sha1(音色 + 文本) 存到 ./cache/*.mp3。同一个文本全网只合成一次，
    之后直接读盘返回。小程序端还有一层本地缓存，正常只会请求一次。
"""

import asyncio
import hashlib
import json
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

import edge_tts

PORT = int(os.environ.get("PORT") or 3000)
HOST = "0.0.0.0"

DEFAULT_VOICE = os.environ.get("TTS_VOICE", "fr-FR-DeniseNeural")
ALLOWED_VOICES = {
    "fr-FR-DeniseNeural",
    "fr-FR-HenriNeural",
    "fr-FR-EloiseNeural",
    "fr-FR-VivienneMultilingualNeural",
    "fr-FR-RemyMultilingualNeural",
}
# 发音接口对超长文本没意义，也会拖慢响应
MAX_TEXT = 300

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(BASE_DIR, "cache")

POOL = ThreadPoolExecutor(max_workers=4)
_locks = {}
_locks_guard = threading.Lock()


def key_of(voice, text):
    return hashlib.sha1((voice + "\n" + text).encode("utf-8")).hexdigest()


def lock_for(key):
    with _locks_guard:
        lk = _locks.get(key)
        if lk is None:
            lk = _locks[key] = threading.Lock()
        return lk


def clean_text(raw):
    s = re.sub(r"\s+", " ", str(raw or "")).strip()
    return s[:MAX_TEXT]


def normalize_voice(v):
    v = str(v or "").strip()
    if v in ALLOWED_VOICES:
        return v
    # 允许只写 Denise / denise 这种简写
    for name in ALLOWED_VOICES:
        short = name.split("-")[2].replace("MultilingualNeural", "").replace("Neural", "")
        if short.lower() == v.lower():
            return name
    return DEFAULT_VOICE


async def _synth(text, voice, path):
    communicate = edge_tts.Communicate(text, voice)
    await communicate.save(path)


def synthesize(text, voice):
    """返回音频文件路径；命中缓存直接返回，否则合成后落盘。"""
    key = key_of(voice, text)
    path = os.path.join(CACHE_DIR, key + ".mp3")
    if os.path.exists(path) and os.path.getsize(path) > 512:
        return path, True

    with lock_for(key):
        # 等锁期间可能已被别的请求合成好了
        if os.path.exists(path) and os.path.getsize(path) > 512:
            return path, True
        os.makedirs(CACHE_DIR, exist_ok=True)
        tmp = path + ".part"
        deadline = time.time() + 25
        last_err = None
        while time.time() < deadline:
            try:
                asyncio.run(_synth(text, voice, tmp))
                if os.path.getsize(tmp) > 512:
                    os.replace(tmp, path)
                    return path, False
                last_err = "empty audio"
            except Exception as e:  # 网络抖动时快速重试一次
                last_err = "%s: %s" % (type(e).__name__, e)
            time.sleep(0.8)
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass
        raise RuntimeError(str(last_err))


def cache_stats():
    try:
        files = [f for f in os.listdir(CACHE_DIR) if f.endswith(".mp3")]
        total = sum(os.path.getsize(os.path.join(CACHE_DIR, f)) for f in files)
        return len(files), total
    except OSError:
        return 0, 0


INDEX_HTML = """<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>法语发音服务</title><style>
body{font-family:-apple-system,"Segoe UI",sans-serif;max-width:640px;margin:40px auto;padding:0 20px;color:#1f2430}
input,select,button{font-size:16px;padding:10px 12px;border-radius:10px;border:1px solid #ccd3e0}
input{width:100%;box-sizing:border-box;margin-bottom:12px}
button{background:#2a4c9b;color:#fff;border:none;cursor:pointer}
.row{display:flex;gap:12px;align-items:center;margin-top:14px}
code{background:#f2f5fb;padding:2px 6px;border-radius:6px}
</style></head><body>
<h2>法语发音服务</h2>
<p class="faint">输入任意法语单词或句子，直接试听：</p>
<input id="t" value="abbaye" placeholder="法语单词或句子">
<div class="row">
  <select id="v">
    <option>fr-FR-DeniseNeural</option><option>fr-FR-HenriNeural</option>
    <option>fr-FR-EloiseNeural</option><option>fr-FR-VivienneMultilingualNeural</option>
    <option>fr-FR-RemyMultilingualNeural</option>
  </select>
  <button onclick="play()">朗读</button>
</div>
<audio id="a" controls style="width:100%;margin-top:16px"></audio>
<script>
function play(){var a=document.getElementById('a');
a.src='/tts?t='+encodeURIComponent(document.getElementById('t').value)+'&v='+document.getElementById('v').value+'&_='+Date.now();
a.play();}
</script>
<p style="margin-top:28px;color:#6b7280;font-size:14px">
接口：<code>GET /tts?t=文本&amp;v=音色</code> ｜ 状态：<code>GET /health</code></p>
</body></html>"""


class Handler(BaseHTTPRequestHandler):
    server_version = "fr-tts/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print("[tts] " + (fmt % args), flush=True)

    def _send(self, code, body, ctype, extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "public, max-age=604800")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False), "application/json; charset=utf-8")

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        parsed = urlparse(self.path)
        route = parsed.path.rstrip("/") or "/"
        qs = parse_qs(parsed.query, keep_blank_values=True)

        if route == "/":
            return self._send(200, INDEX_HTML, "text/html; charset=utf-8")

        if route == "/health":
            n, size = cache_stats()
            return self._json(200, {"ok": True, "cached": n, "cachedBytes": size,
                                    "voice": DEFAULT_VOICE})

        if route != "/tts":
            return self._json(404, {"error": "not found"})

        raw = (qs.get("t") or qs.get("text") or qs.get("audio") or [""])[0]
        text = clean_text(unquote(raw))
        voice = normalize_voice((qs.get("v") or qs.get("voice") or [""])[0])
        if not text:
            return self._json(400, {"error": "empty text"})

        try:
            path, hit = POOL.submit(synthesize, text, voice).result(timeout=35)
        except Exception as e:
            self.log_message("synthesize failed for %r: %s", text, e)
            return self._json(502, {"error": "synthesize failed", "detail": str(e)[:200]})

        with open(path, "rb") as fh:
            data = fh.read()
        self.log_message("%s %r -> %d bytes%s", "HIT" if hit else "SYN", text, len(data),
                         "" if hit else " (voice=%s)" % voice)
        return self._send(200, data, "audio/mpeg",
                          {"X-Tts-Cache": "hit" if hit else "miss",
                           "X-Tts-Voice": voice})


def main():
    os.makedirs(CACHE_DIR, exist_ok=True)
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    n, size = cache_stats()
    print("fr-tts listening on %s:%d  voice=%s  cache=%d files / %d bytes"
          % (HOST, PORT, DEFAULT_VOICE, n, size), flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
