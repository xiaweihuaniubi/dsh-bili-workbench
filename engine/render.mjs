import { safeId, writeJsonAtomic } from './file-utils.mjs'
import { validateMontage } from './moment-context.mjs'
/**
 * render.mjs —— 把素材库里的方案变成 bili-op 能跑的 run，并管理成片
 *
 * 关键点：
 *   · 方案（plans/<项目>/vN.json）和 bili-op 的 script.json 结构本来就很像，
 *     这里只做三件事：补 item 序号、把方案引用的真实帧拷进 Remotion 的 public、写 status 元数据
 *   · 渲染本身仍走 bili-op/build.mjs（配音→Remotion→合音轨→烧字幕→封面），不重复造轮子
 *   · 进度从子进程日志里推（阶段权重），前端轮询 /render/status
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, copyFileSync, cpSync, rmSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { paths as storePaths, STORE } from './store.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const BILI_OP_BUNDLED = join(HERE, '..', 'bili-op')
const BILI_OP_SIBLING = join(HERE, '..', '..', 'bili-op')
export const BILI_OP = process.env.BILI_OP_DIR
  || (existsSync(join(BILI_OP_BUNDLED, 'build.mjs')) ? BILI_OP_BUNDLED : BILI_OP_SIBLING)
// 成片必须跟着素材库走：插件升级会重装 node_modules，放在 bili-op/runs 会被清掉
export const runsDir = () => process.env.BILI_OP_RUNS || join(STORE, 'renders')
const LEGACY_RUNS = join(BILI_OP, 'runs')
const PUBLIC_PLANS = join(BILI_OP, 'render', 'public', 'plans')

/** 新目录优先；老版本留在 bili-op/runs 的成片继续可读 */
export function findRunDir(runId) {
  if (!safeId(runId)) return ''
  for (const d of [join(runsDir(), runId), join(LEGACY_RUNS, runId)]) {
    if (existsSync(d)) return d
  }
  return ''
}

/** 插件内置布局的旧成片迁到素材库，避免下次升级再被清掉 */
export function migrateLegacyRuns() {
  if (BILI_OP !== BILI_OP_BUNDLED || !existsSync(LEGACY_RUNS)) return 0
  mkdirSync(runsDir(), { recursive: true })
  let n = 0
  for (const name of readdirSync(LEGACY_RUNS)) {
    const src = join(LEGACY_RUNS, name)
    const dst = join(runsDir(), name)
    if (existsSync(dst)) continue
    try { cpSync(src, dst, { recursive: true }); n++ } catch { /* 单个失败不影响其它 */ }
  }
  return n
}

const readJson = (f, dflt = null) => {
  try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return dflt }
}
const writeJson = (f, obj) => {
  mkdirSync(dirname(f), { recursive: true })
  writeJsonAtomic(f, obj)
}
const slug = (s) => String(s || 'topic').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'topic'
const today = () => new Date().toLocaleDateString('sv-SE')
const cn = (s) => String(s || '').replace(/\s/g, '').length

/** 从 frames/<BV>/fNN-XXXXs.jpg 里挑离目标秒数最近的一帧 */
function nearestFrame(bv, t) {
  const dir = storePaths(bv).framesDir
  if (!existsSync(dir)) return ''
  let best = null
  for (const f of readdirSync(dir)) {
    const m = /-(\d+)s\.jpg$/i.exec(f)
    if (!m) continue
    const d = Math.abs(Number(m[1]) - Number(t || 0))
    if (!best || d < best.d) best = { d, f }
  }
  return best ? best.f : ''
}

/** 把一版方案写成一个 run（script.json + 真实帧），返回 runId/runDir */
export function prepareRun(proj, plan, version) {
  if (!plan || !Array.isArray(plan.shots) || !plan.shots.length) throw new Error('方案里没有分镜')

  if (plan.style === 'B') validateMontage(plan.shots)
  const v = Number(version) || Number(proj.currentVersion) || 1
  const base = `${today()}-${slug(plan.title)}-v${v}`
  let runId = base
  for (let n = 2; findRunDir(runId); n++) runId = `${base}-${n}`
  const runDir = join(runsDir(), runId)
  mkdirSync(runDir, { recursive: true })

  // 真实帧：有 source 的镜头，把库里最近的一帧拷到 render/public
  const pubDir = join(PUBLIC_PLANS, runId)
  let frameCount = 0
  const shots = plan.shots.map((s, i) => {
    const out = { ...s }
    if (plan.style === 'B' && s.kind === 'broll' && s.source) {
      out.clipRequest = { bv: s.source.bv, at: s.source.t, duration: s.duration }
      delete out.footage
    }
    if (s.source?.bv) {
      const file = nearestFrame(s.source.bv, s.source.t)
      if (file) {
        mkdirSync(pubDir, { recursive: true })
        const dest = join(pubDir, `${String(i + 1).padStart(2, '0')}-${file}`)
        try {
          copyFileSync(join(storePaths(s.source.bv).framesDir, file), dest)
          out.frameImage = `plans/${runId}/${basename(dest)}`
          out.frameFrom = { bv: s.source.bv, t: s.source.t, file }
          frameCount++
        } catch { /* 拷不过去就不带图 */ }
      }
    }
    if (s.footage?.clip && !out.clipRequest) {
      if (!safeId(s.footage.clip)) throw new Error('片段文件名不合法')
      const src = join(STORE, '..', 'assets-src', 'clips', s.footage.clip)
      if (existsSync(src)) {
        const clipsPub = join(PUBLIC_PLANS, '..', 'clips')
        mkdirSync(clipsPub, { recursive: true })
        copyFileSync(src, join(clipsPub, s.footage.clip))
        out.footage = { file: `clips/${s.footage.clip}`, offset: Number(s.footage.offset) || 0 }
      } else if (s.kind === 'broll') {
        throw new Error('broll 镜引用的片段文件不存在：' + s.footage.clip + '（clips/index.json 过期，先跑 engine/clip.mjs 重下）')
      } else {
        delete out.footage
      }
    }
    return out
  })

  // item 序号（01、02…），只算 item
  let itemNo = 0
  for (const s of shots) if (s.kind === 'item') s.index = String(++itemNo).padStart(2, '0')

  const chars = shots.reduce((n, s) => n + cn(s.narration), 0)
  const script = {
    title: plan.title || '',
    subtitle: plan.subtitle || '',
    theme: plan.brief || proj.brief || '',
    angle: plan.angle || '',
    subtitleStyle: plan.subtitleStyle || '',
    style: plan.style,
    customStyle: plan.customStyle || '',
    mascot: plan.mascot,
    mascotVideo: plan.mascotVideo,
    shots,
    stats: {
      shotCount: shots.length,
      itemCount: itemNo,
      narrationChars: chars,
      estSeconds: Math.round(chars / 4.5),
      realFrames: frameCount,
    },
    model: plan.model || '',
    generatedAt: new Date().toISOString(),
    projectId: proj.id,
    projectVersion: v,
  }
  writeJson(join(runDir, 'script.json'), script)

  // 渲染期间也能看到"在做什么"
  writeJson(join(runDir, 'status.json'), {
    stage: 'scripted',
    style: plan.style,
    customStyle: plan.customStyle || '',
    title: script.title,
    subtitle: script.subtitle,
    theme: script.theme,
    model: script.model,
    shots: script.stats.shotCount,
    narrationChars: chars,
    seconds: script.stats.estSeconds,
    frames: 0,
    realFrames: frameCount,
    files: {},
    needReview: false,
    builtAt: '',
    createdAt: new Date().toISOString(),
    projectId: proj.id,
    projectVersion: v,
  })

  return { runId, runDir, frameCount }
}

/** 读一个 run 的 status.json（兼容只有 script.json 的旧 run） */
export function readStatus(runId) {
  const dir = findRunDir(runId)
  if (!dir) return null
  const st = readJson(join(dir, 'status.json'), null)
  if (st) return st
  const sc = readJson(join(dir, 'script.json'), null)
  if (!sc) return null
  return { stage: 'unknown', title: sc.title, subtitle: sc.subtitle, theme: sc.theme, shots: sc.shots?.length, seconds: sc.stats?.estSeconds, files: {}, needReview: false }
}

export function listRuns() {
  const out = []
  const seen = new Set()
  for (const root of [runsDir(), LEGACY_RUNS]) {
    if (!existsSync(root)) continue
    for (const name of readdirSync(root)) {
      if (seen.has(name)) continue
      const dir = join(root, name)
      let isDir = false
      try { isDir = statSync(dir).isDirectory() } catch { isDir = false }
      if (!isDir) continue
      const st = readStatus(name)
      if (!st) continue
      seen.add(name)
      const realDir = findRunDir(name) || dir
      const cover = join(realDir, 'cover.png')
      const video = join(realDir, 'final-subbed.mp4')
      const videoPlain = join(realDir, 'final.mp4')
      out.push({
        runId: name,
        ...st,
        hasCover: existsSync(cover),
        hasVideo: existsSync(video) || existsSync(videoPlain),
        videoFile: existsSync(video) ? 'final-subbed.mp4' : (existsSync(videoPlain) ? 'final.mp4' : ''),
        updatedAt: st.builtAt || st.createdAt || '',
      })
    }
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  return out
}

const statusFile = (runId) => {
  if (!safeId(runId)) throw new Error('成片标识不合法')
  const dir = findRunDir(runId) || join(runsDir(), runId)
  mkdirSync(dir, { recursive: true })
  return join(dir, 'status.json')
}

export function setStage(runId, stage, patch = {}) {
  const f = statusFile(runId)
  const st = readJson(f, {}) || {}
  const next = { ...st, ...patch, stage }
  writeJson(f, next)
  return next
}

export function setReview(runId, state, note = '') {
  const f = statusFile(runId)
  const st = readJson(f, {}) || {}
  st.review = { state, at: new Date().toISOString(), note: String(note || '').slice(0, 300) }
  if (state === 'approved') st.stage = 'approved'
  if (state === 'rejected') st.stage = 'rejected'
  writeJson(f, st)
  return st
}

export function markPublished(runId, { bvid = '', title = '' } = {}) {
  const f = statusFile(runId)
  const st = readJson(f, {}) || {}
  st.review = { ...(st.review || {}), state: 'published', at: new Date().toISOString(), bvid, title }
  st.stage = 'published'
  st.bvid = bvid
  writeJson(f, st)
  return st
}

export function mediaPath(runId, kind) {
  const dir = findRunDir(runId)
  if (!dir) return ''
  if (kind === 'cover') return join(dir, 'cover.png')
  if (kind === 'video') {
    const subbed = join(dir, 'final-subbed.mp4')
    return existsSync(subbed) ? subbed : join(dir, 'final.mp4')
  }
  return ''
}

/** 删除本地成片：只动素材库 renders/ 或旧 bili-op/runs，不会碰 B站 已发布内容 */
export function deleteRun(runId) {
  const dir = findRunDir(runId)
  if (!dir) return false
  const norm = dir.replace(/\//g, '\\').toLowerCase()
  if (!norm.includes('\\renders\\') && !norm.includes('\\runs\\')) return false
  rmSync(dir, { recursive: true, force: true })
  try { rmSync(join(PUBLIC_PLANS, runId), { recursive: true, force: true }) } catch { /* 可选清理 */ }
  return true
}
