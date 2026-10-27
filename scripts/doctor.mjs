#!/usr/bin/env node
/**
 * 环境自检：node / dsh / bili / ffmpeg / edge-tts / Remotion / sharp / 浏览器
 *
 *   node scripts/doctor.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const win = process.platform === 'win32'

const run = (cmd, args = []) => {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
    shell: win,
  })
  return {
    ok: r.status === 0,
    out: `${r.stdout || ''}${r.stderr || ''}`.trim(),
    error: r.error?.message || '',
  }
}

const rows = []
const add = (name, ok, detail, critical = false) => {
  rows.push({ name, ok, detail, critical })
}

// Node
const major = Number(process.versions.node.split('.')[0])
add('Node.js', major >= 22, `${process.versions.node}${major >= 22 ? '' : '（需要 >= 22）'}`, true)

// dsh
{
  const r = run('dsh', ['--version'])
  add('dsh', r.ok, r.ok ? r.out.split('\n')[0] : '没找到 dsh 命令', true)
}

// bili
{
  const cmd = win ? 'bili.exe' : 'bili'
  const r = run(cmd, ['--version'])
  add('bili-cli', r.ok, r.ok ? r.out.slice(0, 120) : '没找到 bili；先 uv tool install bili-agent', true)
  if (r.ok) {
    const a = run(cmd, ['auth', 'status'])
    let logged = false
    try {
      const j = JSON.parse(a.out)
      logged = Boolean(j?.data?.user?.mid || j?.data?.loggedIn)
    } catch { /* ignore */ }
    add('B站登录', logged, logged ? '已登录' : '未登录；运行 bili auth login')
  }
}

// ffmpeg
{
  const r = run(win ? 'ffmpeg.exe' : 'ffmpeg', ['-version'])
  add('ffmpeg', r.ok, r.ok ? r.out.split('\n')[0] : '没找到 ffmpeg（需要带 libass）', true)
}

// edge-tts
{
  const r = run(win ? 'edge-tts.exe' : 'edge-tts', ['--version'])
  add('edge-tts', r.ok, r.ok ? r.out.split('\n')[0] : '没找到 edge-tts；uv tool install edge-tts')
}

// Remotion / sharp
for (const [name, base, spec] of [
  ['Remotion CLI', join(ROOT, 'bili-op', 'render'), '@remotion/cli/package.json'],
  ['sharp', join(ROOT, 'bili-op'), 'sharp'],
]) {
  try {
    const req = createRequire(join(base, 'package.json'))
    req.resolve(spec)
    add(name, true, '已安装')
  } catch {
    add(name, false, '未安装；在仓库根目录执行 npm install')
  }
}

// 浏览器
const browsers = win
  ? [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ]
  : process.platform === 'darwin'
    ? [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ]
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge']
const browser = browsers.find(existsSync)
add('Chrome / Edge', Boolean(browser), browser || '没找到；设置 BILI_OP_CHROME 指向浏览器可执行文件')

// 输出
console.log('\nB站工作台 · 环境自检\n' + '='.repeat(48))
for (const r of rows) {
  const mark = r.ok ? '✓' : (r.critical ? '✗' : '!')
  console.log(`${mark} ${r.name.padEnd(14)} ${r.detail}`)
}
console.log('='.repeat(48))

const criticalFail = rows.some((r) => r.critical && !r.ok)
const warn = rows.some((r) => !r.ok)
if (criticalFail) {
  console.log('\n有必需项没通过，先按上面的提示补齐。')
  process.exit(1)
}
if (warn) {
  console.log('\n核心项已通过；带 ! 的项只影响出片/配音，可稍后再补。')
} else {
  console.log('\n全部通过。打开 dsh →「B站工作台」开始用。')
}
