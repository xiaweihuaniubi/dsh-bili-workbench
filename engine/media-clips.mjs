/** 真实短片段缓存；下载发生在渲染子进程，不阻塞工作台HTTP。 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { STORE } from './store.mjs'
import { safeId, writeJsonAtomic } from './file-utils.mjs'
import { completeMomentBounds } from './moment-context.mjs'

export const clipsDir = () => join(STORE, '..', 'assets-src', 'clips')
const read = (file, fallback) => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback } }
export function listClips() {
  const dir = clipsDir()
  const legacy = read(join(dir, 'index.json'), [])
  const records = Array.isArray(legacy) ? legacy : []
  if (existsSync(dir)) for (const file of readdirSync(dir)) {
    if (file.endsWith('.meta.json')) records.push(read(join(dir, file), null))
  }
  return [...new Map(records.filter(r => r && safeId(r.file) && existsSync(join(dir, r.file))).map(r => [r.file, r])).values()]
}

function run(bin, args, timeout = 300000) {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true })
  if (r.error || r.status !== 0) throw new Error(`${bin}执行失败：${String(r.error?.message || r.stderr || r.stdout || r.status).slice(-1800)}`)
  return r.stdout
}

export function ensureClip(request) {
  const { bv } = request
  const at = Number(request.at)
  const duration = Number(request.duration)
  if (!/^BV[a-zA-Z0-9]{10}$/.test(bv) || !Number.isFinite(at) || at < 0 || !Number.isFinite(duration) || duration < 0.5 || duration > 180) throw new Error('原片请求的BV、时间或时长无效')
  const dir = clipsDir()
  mkdirSync(dir, { recursive: true })
  const name = `${bv}-${Math.round(at * 1000)}-${Math.round(duration * 1000)}.mp4`
  const hit = listClips().find(c => c.file === name && c.seconds + 0.15 >= duration)
  if (hit) return hit
  const exe = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
  const candidates = [process.env.BILI_YTDLP_BIN, join(STORE, '..', 'tools', 'bin', exe), join(homedir(), '.local', 'bin', exe)].filter(Boolean)
  const bin = candidates.find(existsSync) || 'yt-dlp'
  const temp = join(dir, '.tmp-' + randomUUID())
  mkdirSync(temp)
  try {
    console.log(`准备原片：${bv} @${at}s，${duration}s`)
    run(bin, ['--no-playlist', '--no-progress', '--socket-timeout', '30', '--retries', '2',
      '-f', 'bv*[height<=720]+ba/b[height<=720]', '--download-sections', `*${at}-${at + duration}`,
      '--force-keyframes-at-cuts', '--merge-output-format', 'mp4', '-o', join(temp, 'source.%(ext)s'),
      `https://www.bilibili.com/video/${bv}`])
    const video = readdirSync(temp).find(f => /^source\.(mp4|mkv|webm|flv|mov)$/.test(f))
    if (!video) throw new Error('原片下载完成但没有视频文件')
    const output = join(temp, 'normalized.mp4')
    run('ffmpeg', ['-y', '-i', join(temp, video), '-t', String(duration), '-map', '0:v:0', '-map', '0:a:0',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '21', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '24000', '-ac', '1', output])
    const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', output]))
    const seconds = Number(probe.format?.duration)
    if (!Number.isFinite(seconds) || seconds + 0.15 < duration) throw new Error('下载的原片长度不足，请调整名场面时间')
    const meta = { file: name, bv, at, dur: duration, seconds, url: `https://www.bilibili.com/video/${bv}`, fetchedAt: new Date().toISOString() }
    renameSync(output, join(dir, name))
    writeJsonAtomic(join(dir, name + '.meta.json'), meta)
    return meta
  } finally { rmSync(temp, { recursive: true, force: true }) }
}

export function materializeScript(runDir, publicDir) {
  const file = join(runDir, 'script.json')
  const script = read(file, null)
  if (!script) throw new Error('无法读取出片脚本')
  for (const shot of script.shots || []) {
    if (!shot.clipRequest) continue
    const request = script.style === 'B' ? completeMomentBounds(shot.clipRequest.bv, shot.clipRequest.at, shot.clipRequest.duration) : shot.clipRequest
    const clip = ensureClip(request)
    shot.duration = request.duration
    if (shot.source) shot.source = { ...shot.source, t: request.at }
    const dest = join(publicDir, 'clips')
    mkdirSync(dest, { recursive: true })
    copyFileSync(join(clipsDir(), clip.file), join(dest, clip.file))
    shot.footage = { file: `clips/${clip.file}`, clip: clip.file, offset: 0 }
    delete shot.clipRequest
  }
  writeJsonAtomic(file, script)
  return script
}
