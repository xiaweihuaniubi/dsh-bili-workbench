/**
 * build.mjs —— 一条命令把一期片子从头做到尾（**不发布**）
 *
 *   node build.mjs --theme "本周AI圈新鲜事" [--count 5] [--tone 语气] [--burn] [--skip-gen]
 *   node build.mjs --run runs/2026-10-23-xxx            # 拿现成的 script.json 接着做
 *
 * 步骤：生成脚本 → 配音+时间轴 → Remotion 渲染 → 合音轨 → 烧字幕(可选) → 封面 → status.json
 * 产物全在 run 目录里；最后**停在这里等人审**（对应方案里的 G2 闸门）。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { makeCover } from './cover.mjs'
import { pickSfxes } from './sfx.mjs'
import { materializeScript } from '../engine/media-clips.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 渲染用的浏览器：优先 BILI_OP_CHROME，其次按「Chrome → Edge」顺序探测本机实际有的那个。
 * （Remotion 只要有 Chromium 内核就行；A 机是 Chrome，这台是 Edge，两边都不用改代码。）
 */
function detectBrowser() {
  const explicit = process.env.BILI_OP_CHROME
  if (explicit) return explicit
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ]
  for (const p of candidates) if (existsSync(p)) return p
  return candidates[0]
}
const CHROME = detectBrowser()

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt
}
const flag = (name) => process.argv.includes('--' + name)
const now = () => Date.now()
const log = (m) => console.log(m)
const mb = (f) => (existsSync(f) ? (statSync(f).size / 1024 / 1024).toFixed(1) + ' MB' : '-')

function sh(bin, args, opts = {}) {
  const capture = opts.stdio === 'ignore'
  const r = spawnSync(bin, args, { stdio: 'inherit', windowsHide: true, ...opts, ...(capture ? { stdio: 'pipe', encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 } : {}) })
  if (r.error) throw new Error(`${bin} 起不来：${r.error.message}`)
  if (r.status !== 0) {
    const detail = String(r.stderr || r.stdout || '').trim().slice(-2500)
    throw new Error(`${bin} 退出码 ${r.status}${detail ? '\n' + detail : ''}`)
  }
}

/**
 * 跑 Remotion：**不要用 npx**。
 * Node 22 在 Windows 上拒绝 spawn `.cmd`（安全策略），`spawnSync('npx')` 会直接失败（status=null）。
 * 所以直接用 node 跑 @remotion/cli 的入口 JS。
 */
function renderRemotion({ renderDir, propsPath, out }) {
  // 本地开发时依赖在 render/node_modules；插件方式安装时依赖在包根 node_modules。
  // 用 createRequire 按 Node 的解析规则找，不要写死目录。
  let bin = ''
  try {
    const req = createRequire(join(renderDir, 'package.json'))
    const cliPkgPath = req.resolve('@remotion/cli/package.json')
    const cliPkg = JSON.parse(readFileSync(cliPkgPath, 'utf8'))
    bin = join(dirname(cliPkgPath), cliPkg.bin?.remotion || 'remotion-cli.js')
  } catch {
    bin = resolve(renderDir, 'node_modules', '@remotion', 'cli', 'remotion-cli.js')
  }
  if (!existsSync(bin)) throw new Error('找不到 Remotion CLI：' + bin + '（先 npm install）')
  sh(process.execPath, [
    bin, 'render', 'src/index.tsx', 'News', out,
    `--props=${propsPath}`,
    `--browser-executable=${CHROME}`,
    '--concurrency=4',
    '--bundle-cache=false',
  ], { cwd: renderDir })
}

/**
 * BGM 选曲：从 assets-src/bgm/index.json 里按主题情绪挑一首。
 * 挑不到情绪匹配就按标题散列确定性挑一首（同一期片子永远同一首，不会每次重渲换曲）。
 * 库不在（如插件安装布局）返回 null，调用方退回纯人声。
 */
/** 字幕样式库：clean=现状；bold=大黑描边；pop=描边+底杠强调色 */
const SUBTITLE_STYLES = {
  clean: 'FontName=Microsoft YaHei,FontSize=13,PrimaryColour=&H00FFFFFF,OutlineColour=&HCC000000,BorderStyle=1,Outline=2,Shadow=0.6,MarginV=26',
  bold: 'FontName=Microsoft YaHei,FontSize=14,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=3,Shadow=1,MarginV=26,Bold=1',
  pop: 'FontName=Microsoft YaHei,FontSize=13,PrimaryColour=&H0000D7FF,OutlineColour=&H00202020,BorderStyle=1,Outline=3,Shadow=0,MarginV=28',
}

function pickBgm(script, runDir) {
  const roots = [
    process.env.BILI_OP_BGM_DIR,
    join(HERE, '..', 'assets-src', 'bgm'),        // 项目根布局：bili-op/../assets-src
    join(HERE, '..', '..', 'assets-src', 'bgm'),  // 插件布局：workbench/bili-op/../../..
  ].filter(Boolean)
  let idx = null
  let dir = ''
  for (const r of roots) {
    const f = join(r, 'index.json')
    if (existsSync(f)) {
      try { idx = JSON.parse(readFileSync(f, 'utf8')); dir = r } catch { /* 下一个 */ }
      if (idx) break
    }
  }
  if (!Array.isArray(idx) || !idx.length) return null
  const usable = idx.filter((x) => x?.file && existsSync(join(dir, x.file)) && (x.duration_seconds || 0) >= 30)
  if (!usable.length) return null

  // 主题 → 情绪关键词（盘点/热血类要激昂或轻快；悲伤叙事要舒缓/忧伤……）
  const text = `${script.theme || ''} ${script.title || ''} ${script.subtitle || ''}`
  const MOODS = ['轻快', '史诗', '紧张', '舒缓', '温馨', '忧伤', '激昂', '梦幻']
  const RE = {
    激昂: /热血|燃|战|激|逆袭|爆发|震撼/, 史诗: /史诗|宏大|大戏|时代|传奇/,
    紧张: /悬|惊|险|对决|争议|翻车|塌/, 轻快: /日常|搞笑|乐|梗|趣味|轻松|盘点/,
    温馨: /温|治愈|萌|家|朋友/, 忧伤: /别|离|遗憾|泪|怀念/, 舒缓: /慢|静|回忆|淡/,
    梦幻: /梦|幻|童话|星/,
  }
  let want = ''
  for (const m of MOODS) if (new RegExp(RE[m]).test(text)) { want = m; break }
  const pool = want ? usable.filter((x) => String(x.mood || '').includes(want)) : []
  const list = pool.length ? pool : usable
  // 确定性散列：同一标题稳定选同一首；不同期自然分散
  const key = `${script.title || ''}#${list.length}`
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  const pick = list[h % list.length]
  const abs = join(dir, pick.file)
  if (!existsSync(abs)) return null
  // 落一份出处进 run 目录，审核时能查来源
  try {
    writeFileSync(join(runDir, 'bgm.json'), JSON.stringify({ ...pick, pickedMood: want || '(按标题散列)', used: false }, null, 2), 'utf8')
  } catch { /* 记录失败不影响出片 */ }
  return { file: abs, title: pick.title || pick.file, mood: pick.mood, license: pick.license || '?' }
}

/** BGM 实际混进成片后，把 bgm.json 的 used 改为 true（留痕不再撒谎） */
function markBgmUsed(runDir) {
  try {
    const f = join(runDir, 'bgm.json')
    if (existsSync(f)) {
      const j = JSON.parse(readFileSync(f, 'utf8'))
      j.used = true
      writeFileSync(f, JSON.stringify(j, null, 2), 'utf8')
    }
  } catch { /* 记录失败不影响出片 */ }
}

async function main() {
  const started = now()
  let runDir = arg('run', '')
  const theme = arg('theme', '')

  // ① 生成脚本
  if (runDir) {
    runDir = resolve(runDir)
    if (!existsSync(join(runDir, 'script.json'))) throw new Error('这个 run 目录里没有 script.json')
    log(`① 用现成脚本：${runDir}`)
  } else {
    if (!theme) throw new Error('要么给 --theme "主题"，要么给 --run <目录>')
    log(`① 生成脚本：${theme}`)
    const args = [join(HERE, 'gen.mjs'), theme, '--count', String(arg('count', 5))]
    if (arg('tone', '')) args.push('--tone', arg('tone', ''))
    const out = execFileSync(process.execPath, args, { encoding: 'utf8' })
    process.stdout.write(out)
    const m = /已写入 (.+script\.json)/.exec(out)
    if (!m) throw new Error('没找到生成结果目录')
    runDir = dirname(m[1].trim())
  }

  const script = materializeScript(runDir, join(HERE, 'render', 'public'))

  // ② 配音 + 时间轴
  log('\n② 配音 + 时间轴')
  const ttsArgs = [join(HERE, 'tts.mjs'), runDir]
  if (arg('voice', '')) ttsArgs.push('--voice', arg('voice', ''))
  sh(process.execPath, ttsArgs)

  // ③ Remotion 渲染（只出视频，音轨后面合）
  log('\n③ 渲染画面')
  const t3 = now()
  const propsPath = join(runDir, 'props.json')
  const videoRaw = join(runDir, 'video-silent.mp4')
  const reuse = flag('skip-render') && existsSync(join(runDir, 'video.mp4'))
  if (reuse) {
    log(`   复用已有画面：${join(runDir, 'video.mp4')}`)
    sh('ffmpeg', ['-y', '-i', join(runDir, 'video.mp4'), '-c', 'copy', videoRaw], { stdio: 'ignore' })
  } else {
    renderRemotion({ renderDir: join(HERE, 'render'), propsPath, out: videoRaw })
    log(`   渲染耗时 ${((now() - t3) / 60000).toFixed(1)} 分钟 · ${mb(videoRaw)}`)
  }

  // ④ 合音轨（可选 BGM：从素材库按主题选曲，人声进来时自动压低；转场音效自动叠加）
  // 视频侧实际比音频长一个 GAP，不能再用 -shortest（会裁掉片尾淡出）；用画面时长截断
  const totalSec = JSON.parse(readFileSync(propsPath, 'utf8')).totalSeconds
  log('\n④ 合入旁白')
  const videoOut = join(runDir, 'final.mp4')
  const bgm = script.style === 'B' ? null : pickBgm(script, runDir)
  const sfxes = flag('no-sfx') || script.style === 'B' ? [] : pickSfxes(JSON.parse(readFileSync(propsPath, 'utf8')))
  log(`   音效：${sfxes.length} 处`)
  if (bgm && !flag('no-bgm') && sfxes.length) {
    // sidechaincompress：人声当触发器，BGM 被压低（人声停了 BGM 自动回弹）；音效经 adelay 对齐后一起 amix
    const sfxInputs = []
    const sfxFilters = []
    sfxes.forEach((s, i) => {
      sfxInputs.push('-i', s.file)
      const n = 3 + i
      sfxFilters.push(`[${n}:a]volume=0.8,adelay=${Math.round(s.atSec * 1000)}:all=1[s${i}]`)
    })
    const sfxLabels = sfxes.map((_, i) => `[s${i}]`).join('')
    sh('ffmpeg', [
      '-y', '-i', videoRaw, '-i', join(runDir, 'voice.mp3'),
      '-stream_loop', '-1', '-i', bgm.file,
      ...sfxInputs,
      '-filter_complex',
      '[2:a]volume=0.22[bg];[bg][1:a]sidechaincompress=threshold=0.02:ratio=8:attack=8:release=350[bga];' +
      sfxFilters.join(';') + ';' +
      `[1:a][bga]${sfxLabels}amix=inputs=${2 + sfxes.length}:duration=first:dropout_transition=2:normalize=0[amx];[amx]alimiter=limit=0.95:level=false[aout]`,
      '-map', '0:v', '-map', '[aout]',
      '-t', String(totalSec), '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', videoOut,
    ], { stdio: 'ignore' })
    markBgmUsed(runDir)
    log(`   BGM：${bgm.title}（${bgm.mood || '?'} · ${bgm.license}）`)
  } else if (bgm && !flag('no-bgm')) {
    // sidechaincompress：人声当触发器，BGM 被压低（人声停了 BGM 自动回弹）
    sh('ffmpeg', [
      '-y', '-i', videoRaw, '-i', join(runDir, 'voice.mp3'),
      '-stream_loop', '-1', '-i', bgm.file,
      '-filter_complex',
      '[2:a]volume=0.22[bg];[bg][1:a]sidechaincompress=threshold=0.02:ratio=8:attack=8:release=350[bga];' +
      '[1:a][bga]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[amx];[amx]alimiter=limit=0.95:level=false[aout]',
      '-map', '0:v', '-map', '[aout]',
      '-t', String(totalSec), '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', videoOut,
    ], { stdio: 'ignore' })
    markBgmUsed(runDir)
    log(`   BGM：${bgm.title}（${bgm.mood || '?'} · ${bgm.license}）`)
  } else if (sfxes.length) {
    // 无 BGM 但有音效：人声 + 音效 amix
    const sfxInputs = []
    const sfxFilters = []
    sfxes.forEach((s, i) => {
      sfxInputs.push('-i', s.file)
      const n = 2 + i
      sfxFilters.push(`[${n}:a]volume=0.8,adelay=${Math.round(s.atSec * 1000)}:all=1[s${i}]`)
    })
    const sfxLabels = sfxes.map((_, i) => `[s${i}]`).join('')
    sh('ffmpeg', [
      '-y', '-i', videoRaw, '-i', join(runDir, 'voice.mp3'),
      ...sfxInputs,
      '-filter_complex',
      sfxFilters.join(';') + ';' +
      `[1:a]${sfxLabels}amix=inputs=${1 + sfxes.length}:duration=first:dropout_transition=2:normalize=0[amx];[amx]alimiter=limit=0.95:level=false[aout]`,
      '-map', '0:v', '-map', '[aout]',
      '-t', String(totalSec), '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', videoOut,
    ], { stdio: 'ignore' })
  } else {
    if (flag('no-bgm')) log('   （--no-bgm：不加 BGM）')
    else if (bgm === null) log('   （BGM 库不可用，纯人声。设 BILI_OP_BGM_DIR 指向 assets-src/bgm 可启用）')
    sh('ffmpeg', ['-y', '-i', videoRaw, '-i', join(runDir, 'voice.mp3'),
      '-t', String(totalSec), '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', videoOut], { stdio: 'ignore' })
  }
  log(`   ${mb(videoOut)}`)

  // ⑤ 烧字幕（可选）—— B站 上传用烧死的最保险
  let burned = ''
  if (flag('burn') && readFileSync(join(runDir, 'subtitles.srt'), 'utf8').trim()) {
    log('\n⑤ 烧字幕')
    burned = join(runDir, 'final-subbed.mp4')
    const srt = join(runDir, 'subtitles.srt').replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:')
    const styleKey = ['clean', 'bold', 'pop'].includes(arg('sub-style', '')) ? arg('sub-style') : (SUBTITLE_STYLES[script.subtitleStyle] ? script.subtitleStyle : 'clean')
    log(`   字幕样式：${styleKey}`)
    sh('ffmpeg', ['-y', '-i', videoOut,
      // ⚠️ libass 默认按 384×288 的 PlayRes 缩放 ⇒ FontSize/MarginV 都是"相对单位"，
      //    给 22/46 会渲成 80px 的大字。13/26 换算到 1080p 约 49px / 98px，正好。
      '-vf', `subtitles='${srt}':force_style='${SUBTITLE_STYLES[styleKey]}'`,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'copy', burned], { stdio: 'ignore' })
    log(`   ${mb(burned)}`)
  }

  // ⑥ 封面
  log('\n⑥ 封面')
  const cover = join(runDir, 'cover.png')
  await makeCover({ title: script.title, subtitle: script.subtitle || '', out: cover })
  log(`   ${cover}`)

  // ⑦ 状态文件（人工闸门就守在这里）
  //    工作台在开跑前先写了一份 status（带 projectId / 真实帧数），这里要保留这些字段
  let prevStatus = {}
  try { prevStatus = JSON.parse(readFileSync(join(runDir, 'status.json'), 'utf8')) } catch { prevStatus = {} }
  const status = {
    ...prevStatus,
    stage: 'rendered',                 // drafted → rendered → approved → published
    theme: script.theme || prevStatus.theme || '',
    title: script.title,
    subtitle: script.subtitle || '',
    model: script.model || '',
    shots: script.stats?.shotCount || 0,
    narrationChars: script.stats?.narrationChars || 0,
    seconds: JSON.parse(readFileSync(propsPath, 'utf8')).totalSeconds,
    frames: JSON.parse(readFileSync(propsPath, 'utf8')).totalFrames,
    realFrames: Number(prevStatus.realFrames) || 0,
    projectId: prevStatus.projectId || script.projectId || '',
    projectVersion: prevStatus.projectVersion || script.projectVersion || 0,
    files: {
      video: videoOut,
      videoBurned: burned || '',
      cover,
      subtitles: join(runDir, 'subtitles.srt'),
      voice: join(runDir, 'voice.mp3'),
      script: join(runDir, 'script.json'),
      props: propsPath,
    },
    needReview: true,
    builtAt: new Date().toISOString(),
    costYuan: 0,
  }
  writeFileSync(join(runDir, 'status.json'), JSON.stringify(status, null, 2), 'utf8')

  log(`\n✅ 出片完成（${((now() - started) / 60000).toFixed(1)} 分钟，0 元）`)
  log(`   成片：${videoOut}`)
  if (burned) log(`   带字幕：${burned}`)
  log(`   封面：${cover}`)
  log(`   状态：${join(runDir, 'status.json')}（stage=rendered，等你审）`)
}

mkdirSync(join(HERE, 'runs'), { recursive: true })
main().catch((e) => { console.error('\n失败：' + (e?.message ?? e)); process.exit(1) })

