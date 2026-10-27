/**
 * tts.mjs —— 逐镜配音 + 时间轴 + 合并字幕
 *
 * 输入：runs/<run>/script.json
 * 输出（同一个 run 目录下）：
 *   audio/shot-1.mp3 …        每镜配音
 *   audio/shot-1.srt …        每镜的字级时间戳（edge-tts 自带）
 *   voice.mp3                 带间隔拼接好的整条旁白
 *   subtitles.srt             整片时间轴的字幕（已按镜头起点平移）
 *   props.json                给 Remotion 用：每镜 frames / from / audio 秒数
 *
 * 为什么不用 ASR：配音本来就是从文本生成的，时间戳直接由 TTS 给 ⇒ 零错字、零等待。
 * 间隔 gap 是留给"换气"和转场的，默认 0.35 秒。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const FPS = 30
const GAP = 0.35          // 每镜之间留给换气/转场

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt
}

/** edge-tts 在哪：EDGE_TTS_BIN > ~/.local/bin/edge-tts.exe > PATH */
function edgeTtsBin() {
  const env = process.env.EDGE_TTS_BIN
  if (env && existsSync(env)) return env
  const p = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'edge-tts.exe' : 'edge-tts')
  return existsSync(p) ? p : 'edge-tts'
}
const BIN = edgeTtsBin()

const probeSeconds = (file) => {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' })
  return Number(String(out).trim()) || 0
}

/** 读 srt → [{start,end,text}]，时间换算成秒 */
function parseSrt(text) {
  const cues = []
  for (const block of String(text).replace(/\r/g, '').split('\n\n')) {
    const lines = block.split('\n').filter(Boolean)
    if (lines.length < 2) continue
    const m = /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/.exec(block)
    if (!m) continue
    const toSec = (h, mm, s, ms) => Number(h) * 3600 + Number(mm) * 60 + Number(s) + Number(ms) / 1000
    const start = toSec(m[1], m[2], m[3], m[4])
    const end = toSec(m[5], m[6], m[7], m[8])
    const body = lines.slice(lines.findIndex((l) => l.includes('-->')) + 1).join(' ').trim()
    if (body) cues.push({ start, end, text: body })
  }
  return cues
}

const fmtTime = (sec) => {
  const totalMs = Math.round(Math.max(0, sec) * 1000)
  const s = Math.floor(totalMs / 1000)
  const h = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const ms = totalMs % 1000
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${p(h)}:${p(mm)}:${p(ss)},${p(ms, 3)}`
}

function silenceFile(outDir) {
  const f = join(outDir, '_silence.mp3')
  if (!existsSync(f)) {
    execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', `anullsrc=r=24000:cl=mono`, '-t', String(GAP), '-q:a', '9', f], { stdio: 'ignore' })
  }
  return f
}

async function main() {
  const runArg = arg('run', '')
  const runDir = runArg ? resolve(runArg) : (process.argv[2] && !process.argv[2].startsWith('--') ? resolve(process.argv[2]) : '')
  if (!runDir || !existsSync(join(runDir, 'script.json'))) {
    console.error('用法: node tts.mjs <run目录>   （目录里要有 script.json）')
    process.exit(2)
  }
  const voice = arg('voice', 'zh-CN-YunxiNeural')
  const script = JSON.parse(readFileSync(join(runDir, 'script.json'), 'utf8'))
  if (!Array.isArray(script.shots) || !script.shots.length) throw new Error('script.json 里没有 shots')

  const publicDir = resolve(HERE, 'render', 'public')
  const checkAsset = (file) => {
    const full = resolve(publicDir, file)
    if (!full.startsWith(publicDir + (process.platform === 'win32' ? '\\' : '/')) || !existsSync(full)) {
      throw new Error('渲染素材不存在或路径不合法：' + file)
    }
  }
  const mascotVideo = script.mascotVideo || 'mascot/dafieiyu-anim.mp4'
  const hasMascotVideo = existsSync(join(publicDir, mascotVideo))
  if (script.mascot !== false) {
    if (script.mascotVideo && script.mascotVideo !== false) checkAsset(script.mascotVideo)
    else if (!hasMascotVideo || script.mascotVideo === false) checkAsset(script.mascot || 'mascot/default.png')
  }
  for (const shot of script.shots) {
    if (shot.audioMode !== 'original' && !String(shot.narration || '').trim()) throw new Error('分镜旁白不能为空')
    if (shot.frameImage) checkAsset(shot.frameImage)
    if (shot.footage?.file) checkAsset(shot.footage.file)
    if (shot.kind === 'scene') {
      checkAsset(shot.left || 'mascot/default.png')
      checkAsset(shot.right || 'mascot/partner.png')
    }
  }
  const audioDir = join(runDir, 'audio')
  mkdirSync(audioDir, { recursive: true })

  console.log(`配音：${voice} · ${script.shots.length} 镜 · edge-tts=${BIN}`)
  const cues = []
  let cursor = 0
  let totalFrames = 0
  const props = { title: script.title, subtitle: script.subtitle, style: script.style, shots: [], fps: FPS }

  for (const [i, shot] of script.shots.entries()) {
    const n = i + 1
    const mp3 = join(audioDir, `shot-${n}.mp3`)
    const srt = join(audioDir, `shot-${n}.srt`)
    const t0 = Date.now()
    let sec
    if (shot.audioMode === 'original') {
      const duration = Number(shot.duration)
      if (!shot.footage?.file || !Number.isFinite(duration) || duration < 0.5 || duration > 180) throw new Error('原声镜头缺少有效片段或时长')
      execFileSync('ffmpeg', ['-y', '-ss', String(Number(shot.footage.offset) || 0), '-i', join(publicDir, shot.footage.file),
        '-t', String(duration), '-vn', '-map', '0:a:0', '-ar', '24000', '-ac', '1', '-c:a', 'libmp3lame', '-q:a', '4', mp3], { encoding: 'utf8', windowsHide: true })
      if (probeSeconds(mp3) + 0.15 < duration) throw new Error('原声片段长度不足')
      writeFileSync(srt, '', 'utf8')
      sec = duration
    } else {
      execFileSync(BIN, ['--text', shot.narration, '--voice', voice, '--write-media', mp3, '--write-subtitles', srt], { encoding: 'utf8', windowsHide: true })
      sec = probeSeconds(mp3)
    }
    if (sec <= 0) throw new Error('配音或原声时长无效')
    let timeScale = 1
    if (script.style === 'B' && i === 0 && shot.kind === 'title' && sec > 2.65) {
      timeScale = 2.65 / sec
      const shorter = join(audioDir, 'intro-short.mp3')
      execFileSync('ffmpeg', ['-y', '-i', mp3, '-af', 'atempo=' + (1 / timeScale), '-t', '2.65', '-ar', '24000', '-ac', '1', '-c:a', 'libmp3lame', shorter], { encoding: 'utf8', windowsHide: true })
      copyFileSync(shorter, mp3)
      sec = 2.65
    }
    const gap = shot.audioMode === 'original' ? 0 : GAP

    // 字幕平移：整体挪到这一镜的起点
    for (const c of parseSrt(readFileSync(srt, 'utf8'))) {
      cues.push({ start: cursor + c.start * timeScale, end: cursor + c.end * timeScale, text: c.text })
    }

    const frames = Math.max(1, Math.round((sec + gap) * FPS))
    props.shots.push({
      ...shot,
      indexLabel: shot.kind === 'item' ? String(shot.index || '') : '',
      audio: `audio/shot-${n}.mp3`,
      audioSeconds: Number(sec.toFixed(3)),
      gapAfter: gap,
      from: totalFrames,
      frames,
    })
    totalFrames += frames
    cursor += sec + gap
    console.log(`  ${String(n).padStart(2)} [${shot.kind.padEnd(5)}] ${sec.toFixed(2)}s → ${frames} 帧  (${Date.now() - t0} ms)`)
  }

  props.mascotVideo = script.style === 'B' || script.mascot === false || script.mascotVideo === false || !hasMascotVideo ? undefined : mascotVideo
  props.mascot = script.style === 'B' || script.mascot === false ? undefined : (script.mascot || 'mascot/default.png')
  props.totalFrames = totalFrames
  props.totalSeconds = Number(cursor.toFixed(2))

  // 整条旁白：镜与镜之间插 0.35 秒静音
  const sil = silenceFile(audioDir)
  const listFile = join(audioDir, '_concat.txt')
  const parts = []
  for (const [i] of script.shots.entries()) {
    parts.push(join(audioDir, `shot-${i + 1}.mp3`).replace(/\\/g, '/'))
    if (i < script.shots.length - 1 && props.shots[i].gapAfter > 0) parts.push(sil.replace(/\\/g, '/'))
  }
  writeFileSync(listFile, parts.map((p) => `file '${p}'`).join('\n'), 'utf8')
  execFileSync('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:a', 'libmp3lame', '-q:a', '4', join(runDir, 'voice.mp3')], { stdio: 'ignore' })

  // 合并字幕（重新编号）
  const srtOut = cues.map((c, i) => `${i + 1}\n${fmtTime(c.start)} --> ${fmtTime(c.end)}\n${c.text}\n`).join('\n')
  writeFileSync(join(runDir, 'subtitles.srt'), srtOut, 'utf8')

  writeFileSync(join(runDir, 'props.json'), JSON.stringify(props, undefined, 2), 'utf8')
  try { rmSync(sil, { force: true }) } catch { /* 清不掉就算了 */ }

  console.log(`\n整片：${props.totalSeconds} 秒 · ${totalFrames} 帧 · 字幕 ${cues.length} 条`)
  console.log(`已写入 ${join(runDir, 'props.json')}`)
}

main().catch((e) => { console.error('失败：' + (e?.message ?? e)); process.exit(1) })
