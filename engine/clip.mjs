/**
 * clip.mjs —— 按秒数区间从 B 站分段下载一条视频片段，登记进 clips 索引。
 *
 * 用法：node clip.mjs --bv BV1xxxx --at <秒> [--dur 15]
 */
import { spawnSync } from 'node:child_process'
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { runBili } from './bili.mjs'

const here = dirname(fileURLToPath(import.meta.url))

function die(msg, code = 1) {
  console.error(`[clip] ${msg}`)
  process.exit(code)
}

// ---- 参数解析 ----
const argv = process.argv.slice(2)
function argVal(name) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const bv = argVal('bv')
const at = Number(argVal('at'))
const dur = Number(argVal('dur') ?? 15)
if (!bv || !Number.isFinite(at) || at < 0 || !Number.isFinite(dur) || dur <= 0) {
  die('用法：node clip.mjs --bv BV1xxxx --at <秒> [--dur 15]')
}
if (!/^BV[0-9A-Za-z]{10}$/.test(bv)) die('BV 号格式不对：' + bv)

// ---- 1. 拿标题和 UP 名 ----
const info = runBili(['video', 'info', bv])
if (!info.ok || !info.data) {
  die(`video info 失败：${JSON.stringify(info.error)}`)
}
const title = info.data.title || ''
const up = info.data.up?.name || info.data.owner?.name || ''

// ---- 3. 目标目录（先定位，幂等检查要在下载前做） ----
const assetsRoot = join(here, '..', '..', 'assets-src')
if (!existsSync(assetsRoot)) {
  die('仅项目根布局支持：未找到 assets-src 目录')
}
const clipsDir = join(assetsRoot, 'clips')
mkdirSync(clipsDir, { recursive: true })
const finalName = `${bv}-${at}s.mp4`
const finalPath = join(clipsDir, finalName)
if (existsSync(finalPath)) {
  console.log('已存在，跳过')
  process.exit(0)
}

// ---- 2. yt-dlp 分段下载到临时目录 ----
const tmpBase = join(tmpdir(), `bili-clip-${Date.now()}`)
const outTpl = join(tmpBase, 'clip.%(ext)s')
mkdirSync(tmpBase, { recursive: true })
const end = at + dur
const ytdlpArgs = [
  '--no-playlist',
  '-f', 'bv*[height<=720]+ba/b[height<=720]',
  '--download-sections', `*${at}-${end}`,
  '-o', outTpl,
  `https://www.bilibili.com/video/${bv}`,
]
console.log(`[clip] yt-dlp 下载 ${bv} ${at}s-${end}s ...`)
const yd = spawnSync('yt-dlp', ytdlpArgs, { encoding: 'utf8', windowsHide: true })
if (yd.status !== 0) {
  const tail = String(yd.stderr || yd.stdout || '').trim().split(/\r?\n/).slice(-5).join('\n')
  die(`yt-dlp 失败（退出码 ${yd.status}）：\n${tail}`)
}

// 找到临时目录里的产物（可能 .mp4 / .mkv / .webm）
const produced = readdirSync(tmpBase)
  .filter((f) => f.startsWith('clip.') && extname(f) !== '.part')
  .map((f) => join(tmpBase, f))
if (produced.length === 0) {
  die(`yt-dlp 退出码 0 但临时目录没有产物：${tmpBase}`)
}
copyFileSync(produced[0], finalPath)
rmSync(produced[0], { force: true })

// ---- 4. ffprobe 实测时长 ----
const fp = spawnSync('ffprobe', [
  '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', finalPath,
], { encoding: 'utf8', windowsHide: true })
const seconds = Number(String(fp.stdout || '').trim())
if (!Number.isFinite(seconds) || seconds <= 0) {
  die(`ffprobe 取时长失败：${String(fp.stderr || fp.stdout || '').slice(0, 300)}`)
}

// 追加索引
const indexFile = join(clipsDir, 'index.json')
let records = []
if (existsSync(indexFile)) {
  try { records = JSON.parse(readFileSync(indexFile, 'utf8')) } catch { records = [] }
  if (!Array.isArray(records)) records = []
}
records.push({
  file: finalName,
  bv,
  url: `https://www.bilibili.com/video/${bv}`,
  title,
  up,
  at,
  dur,
  seconds,
  license: 'B站二创引用·发布时标注出处',
  fetchedAt: new Date().toISOString(),
})
writeFileSync(indexFile, JSON.stringify(records, null, 2), 'utf8')

console.log(`[clip] 完成：${finalPath}（实测 ${seconds.toFixed(2)}s），已登记 index.json`)
