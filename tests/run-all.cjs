#!/usr/bin/env node
/**
 * 一键跑全部回归测试。
 *
 *   node tests/run-all.cjs            跑全部
 *   node tests/run-all.cjs audio      只跑名字里含 audio 的
 *
 * 每个用例都是独立的子进程，输出里出现 FAIL 或进程非 0 退出即判失败。
 * 注意：别用「输出里有没有 fail 字样」判失败 —— 有断言本身就在验「状态是 fail」。
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const DIR = __dirname

const SUITES = [
  { file: 'test-sheet.cjs', name: '表格解析（CSV/XLSX/XLS 对拍）', note: 'utils/sheet.js' },
  { file: 'test-pages.cjs', name: '词库 / 词表导入页', note: 'pages/import · libraries · words' },
  { file: 'e2e-page.cjs', name: '教材上传状态机', note: 'pages/book-upload' },
  { file: 'verify-mock.cjs', name: '云接口封装', note: 'utils/api.js 的库与分桶' },
  { file: 'verify-words.cjs', name: '分级词表导入（含幂等）', note: 'word-lists/*.csv' },
  { file: 'test-audio.cjs', name: '发音模块', note: 'utils/audio.js' },
  { file: 'test-audio-sources.cjs', name: '音源降级链', note: '主音源挂了自动切备用' },
  { file: 'test-audio-pages.cjs', name: '发音页面联调', note: '四个页面的喇叭接线' },
  { file: 'test-example-link.cjs', name: '例句点词跳词条', note: 'utils/fr-text.js 切词' },
]

const filter = process.argv[2] || ''
const picked = SUITES.filter((s) => s.file.indexOf(filter) >= 0)

if (!picked.length) {
  console.error('没有匹配的测试：' + filter)
  process.exit(2)
}

const rows = []
let failed = 0
let spawnBlocked = null

for (const s of picked) {
  const abs = path.join(DIR, s.file)
  if (!fs.existsSync(abs)) {
    rows.push({ ...s, result: '缺失', ok: false, last: '' })
    failed++
    continue
  }
  process.stdout.write('跑 ' + s.file + ' … ')
  const r = spawnSync(process.execPath, [abs], { cwd: DIR, encoding: 'utf8' })
  // 某些受限环境（沙箱 / 安全策略）会禁止一切子进程创建，报 EBUSY/EPERM。
  // 这时必须明说「跑不了」，不能把「启动失败」报成「测试失败」。
  if (r.error) {
    spawnBlocked = r.error.code || r.error.message
    break
  }
  const out = (r.stdout || '') + (r.stderr || '')
  const lines = out.split(/\r?\n/).filter((l) => l.trim())
  // 只看「行首就是 FAIL」（脚本的失败标记格式），不看行中间出现的 fail 字样
  const hasFail = lines.some((l) => /^\s*FAIL\b/.test(l))
  const ok = r.status === 0 && !hasFail
  if (!ok) failed++
  rows.push({ ...s, ok, last: lines[lines.length - 1] || '(无输出)', detail: out })
  console.log(ok ? '通过' : '失败')
}

if (spawnBlocked) {
  console.error('')
  console.error('无法启动子进程（' + spawnBlocked + '）—— 当前环境禁止创建进程，测试没有真正执行。')
  console.error('这不是测试失败。请在本机终端里重试，或用 shell 循环逐套跑：')
  console.error('')
  console.error('  cd tests')
  console.error('  for t in test-sheet test-pages e2e-page verify-mock verify-words \\')
  console.error('           test-audio test-audio-sources test-audio-pages test-example-link; do')
  console.error('    echo "---- $t"; node "$t.cjs" | tail -1')
  console.error('  done')
  process.exit(2)
}

console.log('')
console.log('='.repeat(72))
for (const r of rows) {
  console.log((r.ok ? '  OK  ' : ' FAIL ') + r.name.padEnd(26, ' ') + '  ' + r.last)
}
console.log('='.repeat(72))
console.log(failed ? failed + ' 套失败' : '全部 ' + rows.length + ' 套通过')

if (failed) {
  console.log('\n---- 失败明细 ----')
  rows.filter((r) => !r.ok).forEach((r) => {
    console.log('\n### ' + r.file)
    console.log(r.detail.slice(-3000))
  })
  process.exit(1)
}
