/**
 * dsh-bili-workbench —— 宿主半端
 * ============================================================================
 * 一个插件 = 素材库 + 刷B站 + 出片 + 审核发布 + 互动。
 * 这一层只做三件事：调 bili 命令、读写素材库、把采集/判定/日报/出片当成子进程编排。
 *
 * 为什么子进程：采集要跑几条 bili 命令、判定要调模型、出片要几分钟 CPU —— 都在
 * 独立进程里做，卡住/崩了都不会带走 dsh 宿主。
 * ============================================================================
 */
import { spawn, spawnSync } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { writeJsonAtomic, videoRange } from './engine/file-utils.mjs'
import { creativeOptions } from './engine/creative.mjs'
import { createPublisher, isCurrentRun, submittedStages, displayPublicationStage } from './engine/publication.mjs'
import { nativeModelBridge } from './engine/native-model.mjs'
import {
  existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, statSync,
  createReadStream, unlinkSync, cpSync,
} from 'node:fs'
import { join, dirname, resolve, sep, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { runBili, runBiliAsync, fetchCover } from './engine/bili.mjs'
import {
  list as storeList, get as storeGet, stats as storeStats, STORE, paths as storePaths,
  setStoreRoot, defaultStorePath, locationFile,
} from './engine/store.mjs'
import * as plans from './engine/planstore.mjs'
import * as renders from './engine/render.mjs'
import * as interact from './engine/interact.mjs'
import * as tasks from './engine/taskstore.mjs'
import { answerOwnerCommandDetailed, auditMessage, refusalText, mentionTargets, callNames } from './engine/owner.mjs'
import { voiceOwnerStats } from './engine/owner-voice.mjs'
import * as canon from './engine/canon.mjs'
import * as memory from './engine/memory.mjs'
import { runReflect } from './engine/reflect.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENGINE = join(HERE, 'engine')
const BILI_OP = process.env.BILI_OP_DIR
  || (existsSync(join(HERE, 'bili-op', 'build.mjs')) ? join(HERE, 'bili-op') : join(HERE, '..', 'bili-op'))
const configFile = () => join(STORE, 'config.json')
const scheduleFile = () => join(STORE, 'schedule.json')
const logFile = () => join(STORE, 'duty.log')

export const name = 'bili-workbench'
export const inject = ['webServer']

const BV_RE = /^BV[0-9A-Za-z]{10}$/
const ZONES = new Set(['all', 'anime', 'music', 'dance', 'game', 'knowledge', 'tech', 'sports', 'car',
  'life', 'food', 'animal', 'kichiku', 'fashion', 'ent', 'film', 'original', 'rookie'])
const TIERS = new Set(['值得看', '可以看', '跳过'])
const VOICES = new Set(['zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoyiNeural', 'zh-CN-YunxiaNeural', 'zh-CN-YunxiNeural'])

const DEFAULT_CHAIN = [
  'deepseek-v4.1-flash', 'big-pickle', 'glm-5.3-flash', 'jev-1.13',
  'lobsterai/deepseek-flash', 'loomy/DeepSeek-V4.1-Flash',
]

const DEFAULT_PERSONA = '生在红旗下，长在春风里；相信富强、自由、民主、希望。说话积极、有底气、不阴阳怪气；夸要夸到点上，批评也讲道理。'

const DEFAULTS = {
  enabled: false,
  keywords: [],
  llmKey: '',                    // 模型密钥（留空则读环境变量 OC_API_KEY）
  /* 日常：只按时段 + 每天上限平均分配 */
  scheduleRanges: '00:00-24:00', // 多段：09:00-12:00, 20:00-23:30
  perDay: 48,                    // 每天最多采几条（同时是自动评论的每日上限）
  frameCount: 10,                // 每条最多抽 10 帧（AI 挑）
  /* 偏好 */
  personaPrompt: DEFAULT_PERSONA,
  /* 自己的视频：从 B站 合集缓存「日常短片」，注入评论/回复/方案 */
  selfVideosEnabled: true,
  selfVideosUrl: '',             // 合集链接，如 https://space.bilibili.com/<mid>/lists/<seasonId>
  selfVideosRefreshHours: 24,
  reportLevel: 'full',           // full | brief | off
  /* 记忆（策展式长期记忆）：USER.md 主人偏好 / MEMORY.md 工作台事实 */
  memoryEnabled: true,
  userCharLimit: 1375,
  memoryCharLimit: 2200,
  reflectEnabled: true,          // 任务后自动复盘：从经历里提炼主人习惯写进记忆
  memoryEventsMax: 800,          // 经验事件流保留条数（90 天过期）
  favFolderId: '',               // 判定为「值得看」时自动收藏到哪个收藏夹（留空不收藏）
  /* 互动：默认关；打开后按配置自动执行（本机实例已单独打开） */
  autoComment: false,
  autoReply: false,
  ownerUid: '',                  // 主人 B站 UID；只有这个 UID 的指令会被特殊处理
  ownerCall: '老弟',              // 评论/回复里怎么称呼主人
  mentionName: '',               // 额外 @ 谁；留空=主人 UID / 当前登录账号
  mentions: [],                  // [{ target: UID/昵称, call: 称呼 }]，可多人
  replyPerDay: 20,
  commentImageEvery: 5,          // 自动评论每 N 条带 1 张表情包（0=关）
  /* 主人 @ 任务：看视频 / 看评论 / 要总结 */
  ownerTasksEnabled: true,
  ownerTaskPollMinutes: 3,       // 每几分钟看一次 @
  ownerTaskPerDay: 10,           // 每天最多处理几个
  ownerTaskAllowDm: true,        // 长总结用私信交付
  ownerTaskMaxAgeHours: 72,      // 只处理 72 小时内的 @，避免首次启动把旧消息全跑一遍
  dmWatch: false,
  dmWatchMinutes: 5,
  dmReplyPerDay: 0,              // 0 = 不限条数（仍只回主人/互关）
  dmOwnerUid: '',
  /* 出片 */
  voice: 'zh-CN-YunxiNeural',
  modelChain: DEFAULT_CHAIN,
  concurrency: 4,
  /* 发布 */
  publishEnabled: false,
  defaultTags: ['合集'],
  defaultZone: 0,
}

/* ───────────── 小工具 ───────────── */
const log = (msg) => {
  const line = `${new Date().toISOString()}  ${msg}\n`
  try { mkdirSync(STORE, { recursive: true }); writeFileSync(logFile(), line, { flag: 'a' }) } catch { /* 写不进就算了 */ }
}

const readJson = (f, dflt) => {
  try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return dflt }
}
const writeJson = (f, obj) => {
  try { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(obj, null, 2), 'utf8') } catch { /* ignore */ }
}
const localDay = (iso) => {
  try { return new Date(iso).toLocaleDateString('sv-SE') } catch { return String(iso || '').slice(0, 10) }
}
const today = () => new Date().toLocaleDateString('sv-SE')
const clampNum = (v, min, max, dflt) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(min, Math.min(n, max)) : dflt
}

/** 时段解析：'00:00-24:00'，可多段、可跨零点 */
export function parseRanges(str) {
  return String(str || '').split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(s)
      if (!m) return null
      const toMin = (h, mm) => Math.max(0, Math.min(Number(h) * 60 + Number(mm), 1440))
      return { start: toMin(m[1], m[2]), end: toMin(m[3], m[4]) }
    })
    .filter(Boolean)
}

export function inRanges(str, d = new Date()) {
  const ranges = parseRanges(str)
  if (!ranges.length) return true
  const cur = d.getHours() * 60 + d.getMinutes()
  return ranges.some((r) => (r.start <= r.end ? cur >= r.start && cur < r.end : cur >= r.start || cur < r.end))
}

/** 把跨零点时段拆成两段，方便算"今天已经过多少" */
function rangeSegments(str) {
  const out = []
  for (const r of parseRanges(str)) {
    if (r.start <= r.end) out.push({ start: r.start, end: r.end })
    else { out.push({ start: r.start, end: 1440 }); out.push({ start: 0, end: r.end }) }
  }
  return out
}

/** 当前时段里：总分钟 / 已过分钟 / 是否在时段内 */
export function rangeProgress(str, d = new Date()) {
  const segs = rangeSegments(str)
  const cur = d.getHours() * 60 + d.getMinutes()
  let total = 0, elapsed = 0, inWindow = false
  for (const s of segs) {
    total += Math.max(0, s.end - s.start)
    if (cur < s.start) continue // 没到的段（含跨零点拆出的次日段）不算已过
    elapsed += cur >= s.end ? s.end - s.start : cur - s.start
    if (cur >= s.start && cur < s.end) inWindow = true
  }
  return { total, elapsed, inWindow }
}

/** 按当前时段和每日上限，算出今天"此刻应该已经采了几条" */
function targetToday(cfg, d = new Date()) {
  const p = rangeProgress(cfg.scheduleRanges, d)
  if (!p.inWindow || p.total <= 0) return 0
  return Math.min(cfg.perDay, Math.round(cfg.perDay * p.elapsed / p.total))
}

const collectedToday = () => storeList({ limit: 2000 }).filter((r) => localDay(r.fetchedAt) === today()).length

function normalizeCfg(c) {
  const out = { ...DEFAULTS, ...(c || {}) }
  // 旧字段不再使用，落盘时顺手清掉
  for (const k of ['intervalMinutes', 'perRound', 'mode', 'autoJudge', 'autoDaily',
    'commentPerRound', 'commentPerDay', 'replyToComments', 'replyPerRound',
    'dmMode', 'dmUid', 'interactDryRun']) delete out[k]

  out.enabled = Boolean(out.enabled)
  out.perDay = clampNum(out.perDay, 1, 500, 48)
  out.frameCount = clampNum(out.frameCount, 1, 10, 10)
  out.keywords = (Array.isArray(out.keywords) ? out.keywords : []).map(String).filter(Boolean).slice(0, 20)
  out.llmKey = String(out.llmKey || '').slice(0, 300)
  out.scheduleRanges = parseRanges(out.scheduleRanges).length ? String(out.scheduleRanges) : '00:00-24:00'
  out.personaPrompt = String(out.personaPrompt ?? DEFAULT_PERSONA).slice(0, 1200)
  out.selfVideosEnabled = out.selfVideosEnabled !== false
  out.selfVideosUrl = String(out.selfVideosUrl || '').trim().slice(0, 300)
  out.selfVideosRefreshHours = clampNum(out.selfVideosRefreshHours, 1, 720, 24)
  out.reportLevel = ['full', 'brief', 'off'].includes(out.reportLevel) ? out.reportLevel : 'full'
  out.memoryEnabled = out.memoryEnabled !== false
  out.userCharLimit = clampNum(out.userCharLimit, 200, 6000, 1375)
  out.memoryCharLimit = clampNum(out.memoryCharLimit, 200, 10000, 2200)
  out.reflectEnabled = out.reflectEnabled !== false
  out.memoryEventsMax = clampNum(out.memoryEventsMax, 100, 5000, 800)
  out.favFolderId = String(out.favFolderId || '').slice(0, 60)
  out.autoComment = out.autoComment !== false
  out.autoReply = out.autoReply !== false
  out.ownerUid = String(out.ownerUid || '').trim().slice(0, 20)
  out.ownerCall = String(out.ownerCall || '老弟').trim().slice(0, 10) || '老弟'
  out.mentionName = String(out.mentionName || '').slice(0, 40)
  out.mentions = (Array.isArray(out.mentions) ? out.mentions : [])
    .map((m) => ({ target: String(m?.target || '').trim().slice(0, 60), call: String(m?.call || '').trim().slice(0, 10) }))
    .filter((m) => m.target)
    .slice(0, out.ownerUid ? 2 : 3)
  out.replyPerDay = clampNum(out.replyPerDay, 0, 200, 20)
  out.commentImageEvery = clampNum(out.commentImageEvery, 0, 50, 5)
  out.ownerTasksEnabled = out.ownerTasksEnabled !== false
  out.ownerTaskPollMinutes = clampNum(out.ownerTaskPollMinutes, 1, 60, 3)
  out.ownerTaskPerDay = clampNum(out.ownerTaskPerDay, 1, 50, 10)
  out.ownerTaskAllowDm = out.ownerTaskAllowDm !== false
  out.ownerTaskMaxAgeHours = clampNum(out.ownerTaskMaxAgeHours, 1, 720, 72)
  out.dmWatch = Boolean(out.dmWatch)
  out.dmWatchMinutes = clampNum(out.dmWatchMinutes, 3, 240, 5)
  out.dmReplyPerDay = clampNum(out.dmReplyPerDay, 0, 100, 0)
  out.dmOwnerUid = String(out.dmOwnerUid || '').slice(0, 30)
  out.voice = VOICES.has(out.voice) ? out.voice : 'zh-CN-YunxiNeural'
  out.modelChain = (Array.isArray(out.modelChain) ? out.modelChain : String(out.modelChain || '').split(','))
    .map((s) => String(s).trim()).filter(Boolean).slice(0, 12)
  if (!out.modelChain.length) out.modelChain = [...DEFAULT_CHAIN]
  out.concurrency = clampNum(out.concurrency, 1, 8, 4)
  out.publishEnabled = Boolean(out.publishEnabled)
  out.defaultTags = (Array.isArray(out.defaultTags) ? out.defaultTags : String(out.defaultTags || '').split(','))
    .map((s) => String(s).trim()).filter(Boolean).slice(0, 10)
  if (!out.defaultTags.length) out.defaultTags = ['AI', '资讯', '盘点']
  out.defaultZone = clampNum(out.defaultZone, 0, 9999, 0)
  return out
}

const loadCfg = () => normalizeCfg(readJson(configFile(), {}))
const saveCfg = (patch) => {
  const cfg = normalizeCfg({ ...loadCfg(), ...patch })
  writeJson(configFile(), cfg)
  return cfg
}
const loadSched = () => readJson(scheduleFile(), { lastRunAt: '', lastResult: '' })

/** 跑引擎脚本（子进程），返回输出尾巴 */
const configuredModelBase = process.env.BILI_OP_LLM_BASE
let modelBridgeReady = Promise.resolve({})
async function runEngine(script, args = [], timeoutMs = 20 * 60_000, extraEnv = null) {
  await modelBridgeReady
  return new Promise((resolvePromise) => {
    const cfg = loadCfg()
    const env = {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      BILI_OP_MODELS: cfg.modelChain.join(','),
    }
    if (extraEnv) Object.assign(env, extraEnv)
    if (cfg.personaPrompt) env.BILI_OP_PERSONA = cfg.personaPrompt
    if (!env.BILI_OP_SELF_VIDEOS) env.BILI_OP_SELF_VIDEOS = canon.renderBlock()
    if (cfg.ownerUid) env.BILI_OWNER_UID = cfg.ownerUid
    if (cfg.ownerCall) env.BILI_OWNER_CALL = cfg.ownerCall
    if (!env.OC_API_KEY && cfg.llmKey) {
      env.OC_API_KEY = cfg.llmKey
      delete env.BILI_OP_LLM_KEY
      if (configuredModelBase) env.BILI_OP_LLM_BASE = configuredModelBase
      else delete env.BILI_OP_LLM_BASE
    }
    let out = ''
    let done = false
    const finish = (r) => { if (!done) { done = true; resolvePromise(r) } }
    let child
    try {
      child = spawn(process.execPath, [join(ENGINE, script), ...args], { cwd: ENGINE, env, windowsHide: true })
    } catch (e) {
      return finish({ ok: false, code: null, text: String(e?.message ?? e) })
    }
    const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } finish({ ok: false, code: null, text: out.slice(-3000) + '\n[超时]' }) }, timeoutMs)
    child.stdout?.on('data', (b) => { out += b.toString('utf8') })
    child.stderr?.on('data', (b) => { out += b.toString('utf8') })
    child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, code: null, text: String(e?.message ?? e) }) })
    child.on('exit', (code) => { clearTimeout(timer); finish({ ok: code === 0, code, text: out }) })
  })
}

/** 跑 bili-op 里的脚本（目前只用于 --health） */
function runOp(script, args = [], timeoutMs = 60_000) {
  const cfg = loadCfg()
  const env = { ...process.env, BILI_OP_MODELS: cfg.modelChain.join(',') }
  if (!env.OC_API_KEY && cfg.llmKey) env.OC_API_KEY = cfg.llmKey
  return new Promise((resolvePromise) => {
    const r = spawnSync(process.execPath, [join(BILI_OP, script), ...args], { cwd: BILI_OP, env, encoding: 'utf8', timeout: timeoutMs, windowsHide: true })
    resolvePromise({ ok: r.status === 0, text: `${r.stdout || ''}${r.stderr || ''}`, error: r.error ? String(r.error.message) : '' })
  })
}

let roundRunning = false
let taskRunning = false

/** 后台跑一个长任务（不阻塞 HTTP / 定时器） */
function kickTask(id = '') {
  if (taskRunning || roundRunning) return false
  taskRunning = true
  ;(async () => {
    try {
      const args = ['--tick']
      if (id) args.push('--id', id)
      const r = await runEngine('task.mjs', args, 45 * 60_000)
      if (r.text) log('任务：' + r.text.slice(-1500))
      // 任务自己逛 B站 采到的新视频，也按设置自动评论（额度跟日常采集共用）
      const cfg = loadCfg()
      if (cfg.autoComment && /新采 [1-9]/.test(r.text || '')) {
        const done = interact.dayCounts().comments
        const remain = Math.max(0, cfg.perDay - done)
        if (remain > 0) {
          const aArgs = ['--limit', String(Math.min(remain, 5))]
          aArgs.push('--image-every', String(cfg.commentImageEvery > 0 ? cfg.commentImageEvery : 0))
          const ac = await runEngine('auto-comment.mjs', aArgs, 10 * 60_000)
          if (ac.text) log('任务采集后自动评论：' + ac.text.slice(-400))
        }
      }
    } catch (e) {
      log('任务异常：' + (e?.message ?? e))
    } finally {
      taskRunning = false
    }
  })()
  return true
}

/** 一轮：采集（热门 + 关键词混合）→ 判定/热梗 → 自动评论 → 日报 */
async function runRound(why = 'manual', { count = 1 } = {}) {
  if (roundRunning) return { ok: false, error: '上一轮还在跑' }
  roundRunning = true
  const cfg = loadCfg()
  const n = Math.max(1, Math.min(Number(count) || 1, 5))
  const t0 = Date.now()
  try {
    const before = collectedToday()
    const outs = []
    if (cfg.keywords.length) {
      const sched = loadSched()
      const idx = (Number(sched.kwIdx) || 0) % cfg.keywords.length
      const kw = cfg.keywords[idx]
      // 1 条时轮流用热门/关键词；≥2 条时两边各分一半
      const kwN = n >= 2 ? Math.max(1, Math.floor(n / 2)) : (idx % 2 === 0 ? 1 : 0)
      const hotN = Math.max(0, n - kwN)
      if (hotN > 0) {
        const hot = await runEngine('collect.mjs', [
          '--hot', String(Math.max(hotN * 4, 8)), '--max-new', String(hotN), '--frames', String(cfg.frameCount),
        ])
        outs.push(hot.text)
        if (!hot.ok) log('热门采集失败：' + hot.text.slice(-500))
      }
      if (kwN > 0) {
        const search = await runEngine('collect.mjs', [
          '--search', kw, '--size', String(Math.max(kwN * 4, 6)), '--max-new', String(kwN), '--frames', String(cfg.frameCount),
        ])
        outs.push(search.text)
        if (!search.ok) log('关键词采集失败：' + search.text.slice(-500))
      }
      writeJson(scheduleFile(), { ...sched, kwIdx: (idx + 1) % cfg.keywords.length })
      log(`轮次(${why})：热门 ${hotN} + 关键词「${kw}」${kwN} 条`)
    } else {
      const hot = await runEngine('collect.mjs', [
        '--hot', String(Math.max(n * 5, 12)), '--max-new', String(n), '--frames', String(cfg.frameCount),
      ])
      outs.push(hot.text)
      if (!hot.ok) log('采集失败：' + hot.text.slice(-500))
      log(`轮次(${why})：综合热门 ${n} 条`)
    }
    const collect = { ok: outs.length > 0, text: outs.join('\n') }
    const added = Math.max(0, collectedToday() - before)

    const judge = await runEngine('judge.mjs', [])
    if (!judge.ok) log('判定失败：' + judge.text.slice(-500))

    // 每条采到的视频都留一条评论（带 @，不逐条确认）
    let autoComment = null
    if (collect.ok && cfg.autoComment) {
      const done = interact.dayCounts().comments
      const remain = Math.max(0, cfg.perDay - done)
      if (remain > 0) {
        const aArgs = ['--limit', String(Math.min(remain, 5))]
        aArgs.push('--image-every', String(cfg.commentImageEvery > 0 ? cfg.commentImageEvery : 0))
        // @ 谁和称呼由 auto-comment.mjs 直接读配置（支持多人）
        autoComment = await runEngine('auto-comment.mjs', aArgs, 10 * 60_000)
        log('自动评论：' + autoComment.text.slice(-400))
      } else {
        log('今天的自动评论额度已用完（按 perDay 计算）')
      }
    }

    const daily = await runEngine('daily.mjs', ['--level', cfg.reportLevel])
    if (!daily.ok) log('日报失败：' + daily.text.slice(-300))

    await applyAutoFavorite(cfg)

    const sec = Math.round((Date.now() - t0) / 1000)
    writeJson(scheduleFile(), {
      ...loadSched(),
      lastRunAt: new Date().toISOString(),
      lastWhy: why,
      lastResult: `完成（${sec}s）`,
      lastAdded: added,
    })
    log(`轮次(${why})完成，${sec}s，新采 ${added} 条`)
    return {
      ok: true, seconds: sec, added,
      collect: collect.text.slice(-1200),
      judge: judge.text.slice(-1200),
      autoComment: (autoComment?.text || '').slice(-1200),
      stats: storeStats(),
      counts: interact.dayCounts(),
      todayCount: collectedToday(),
    }
  } catch (e) {
    log('轮次异常：' + (e?.message ?? e))
    return { ok: false, error: String(e?.message ?? e) }
  } finally {
    roundRunning = false
  }
}

/** 偏好里的「自动收藏到收藏夹」：只收藏最新判定为值得看、且还没记过的 */
async function applyAutoFavorite(cfg) {
  if (!cfg.favFolderId) return
  const marked = loadCfg().favMarked || {}
  const targets = storeList({ limit: 30 }).filter((r) =>
    r.judge?.tier === '值得看' && !marked[r.bvid] && localDay(r.judge?.at) === today())
  for (const r of targets.slice(0, 5)) {
    const res = runBili(['video', 'fav', r.bvid, '--folder', cfg.favFolderId], { timeoutMs: 30000 })
    if (res.ok) {
      marked[r.bvid] = new Date().toISOString()
      writeJson(configFile(), { ...loadCfg(), favMarked: marked })
      log(`已收藏 ${r.bvid} → ${cfg.favFolderId}`)
    } else {
      log(`收藏失败 ${r.bvid}：${res.error?.message || res.error?.code || ''}`)
      break
    }
  }
}

/* ───────────── 渲染任务（内存） ───────────── */
const publisher = createPublisher({ onEvent: (kind, event) => {
  if (kind === 'submit') {
    memory.addEvent('publish', { ...event, text: '已提交投稿《' + event.title + '》，等待平台状态确认' })
    log('投稿已提交 ' + event.runId + ' → ' + event.bvid)
  }
} })
const jobs = new Map()

function pctFromLine(line, job) {
  if (/①/.test(line)) return 6
  if (/②\s*配音/.test(line)) return 14
  const tts = /^\s*(\d+)\s+\[(title|item|data|outro|scene|broll)/.exec(line)
  if (tts) {
    const n = Number(tts[1]) || 1
    return Math.min(44, 14 + Math.round((n / Math.max(1, job.totalShots || 8)) * 30))
  }
  if (/③\s*渲染画面/.test(line)) return 48
  // Remotion 用 \r 刷进度；有百分比或 已渲/总数 时映射到 48–73%
  if (/render|frame|encoded/i.test(line)) {
    const pct = /(\d{1,3})\s*%/.exec(line)
    if (pct) return Math.min(73, 48 + Math.round((Number(pct[1]) / 100) * 25))
    const frac = /(\d+)\s*\/\s*(\d+)/.exec(line)
    if (frac) return Math.min(73, 48 + Math.round((Number(frac[1]) / Math.max(1, Number(frac[2]))) * 25))
  }
  if (/渲染耗时/.test(line)) return 74
  if (/④\s*合入旁白/.test(line)) return 82
  if (/⑤\s*烧字幕/.test(line)) return 89
  if (/⑥\s*封面/.test(line)) return 95
  if (/✅\s*出片完成/.test(line)) return 100
  return null
}

function startRender(project, plan, version, voice) {
  const cfg = loadCfg()
  const renderVoice = voice ? String(voice) : cfg.voice
  if (!VOICES.has(renderVoice)) throw new Error('不支持的配音音色')
  const { runId, runDir, frameCount } = renders.prepareRun(project, plan, version)
  const job = {
    runId, runDir, projectId: project.id, version: Number(version) || project.currentVersion,
    stage: 'running', pct: 3, log: '', error: '', startedAt: new Date().toISOString(), endedAt: '',
    totalShots: (plan.shots || []).length, frameCount,
  }
  const saveJob = () => {
    try { writeJsonAtomic(join(runDir, 'render-job.json'), { ...job }) }
    catch (e) { log('保存渲染日志失败：' + String(e?.message ?? e)) }
  }
  const checkpoint = setInterval(saveJob, 2000)
  checkpoint.unref()
  jobs.set(runId, job)
  saveJob()

  project.stage = 'rendering'
  project.runDir = runDir
  project.renderVersion = Number(version) || project.currentVersion
  project.renderVoice = renderVoice
  plans.saveProject(project)

  const env = {
    ...process.env,
    PYTHONUTF8: '1',
    BILI_OP_MODELS: cfg.modelChain.join(','),
  }
  if (!env.OC_API_KEY && cfg.llmKey) env.OC_API_KEY = cfg.llmKey

  const child = spawn(process.execPath, [
    join(BILI_OP, 'build.mjs'), '--run', runDir, '--burn', '--voice', renderVoice,
  ], { cwd: BILI_OP, env, windowsHide: true })

  let buf = ''
  const onData = (text) => {
    buf += text.replace(/\x1b\[[0-9;]*m/g, '')
    const lines = buf.split(/[\r\n]+/)
    buf = lines.pop() || ''
    for (const line of lines) {
      job.log = (job.log + line + '\n').slice(-12000)
      const p = pctFromLine(line, job)
      if (p !== null) job.pct = Math.max(job.pct, p)
    }
  }
  for (const stream of [child.stdout, child.stderr]) {
    const decoder = new StringDecoder('utf8')
    stream?.on('data', (b) => onData(decoder.write(b)))
    stream?.on('end', () => onData(decoder.end()))
  }
  child.on('error', (e) => {
    job.stage = 'failed'
    job.error = String(e?.message ?? e)
    job.endedAt = new Date().toISOString()
    saveJob()
    log(`出片失败 ${runId}：${job.error}`)
  })
  child.on('close', (code) => {
    clearInterval(checkpoint)
    if (buf.trim()) job.log = (job.log + buf + '\n').slice(-12000)
    job.endedAt = new Date().toISOString()
    if (code === 0) {
      job.stage = 'done'
      job.pct = 100
      const st = renders.readStatus(runId)
      // 取最新项目再 patch：渲染期间主人可能改过版，不能用闭包里的旧 project 整体覆盖
      const fresh = plans.getProject(project.id) || project
      fresh.stage = 'rendered'
      fresh.runDir = runDir
      fresh.renderVersion = job.version
      fresh.review = null
      plans.saveProject(fresh)
      memory.addEvent('render', { runId, projectId: project.id, text: `渲染《${plan.title || project.id}》成功，${st?.seconds || '?'} 秒成片已出` })
      log(`出片完成 ${runId}（${st?.seconds || '?'} 秒，真实帧 ${frameCount}）`)
      runReflect()
        .then((r) => { if (r && !r.ok && !r.skipped) log('复盘失败：' + String(r.error || '').split('\n')[0]) })
        .catch((e) => { log('复盘异常：' + String(e?.message ?? e).split('\n')[0]) })
    } else {
      job.stage = 'failed'
      job.error = job.error || job.log.slice(-1200) || ('退出码 ' + code)
      const fresh = plans.getProject(project.id) || project
      fresh.stage = 'draft'
      plans.saveProject(fresh)
      memory.addEvent('render', { runId, projectId: project.id, ok: false, text: `渲染《${plan.title || project.id}》失败：${job.error.slice(0, 60)}` })
      log(`出片失败 ${runId}（退出码 ${code}）`)
      runReflect()
        .then((r) => { if (r && !r.ok && !r.skipped) log('复盘失败：' + String(r.error || '').split('\n')[0]) })
        .catch((e) => { log('复盘异常：' + String(e?.message ?? e).split('\n')[0]) })
    }
    saveJob()
  })
  return job
}

const jobView = (j) => j ? ({
  runId: j.runId, runDir: j.runDir, projectId: j.projectId, version: j.version, stage: j.stage, pct: j.pct,
  error: j.error, startedAt: j.startedAt, endedAt: j.endedAt, totalShots: j.totalShots,
  frameCount: j.frameCount, log: String(j.log || '').slice(-3000),
}) : null

const activeJob = (projectId) => {
  for (const j of jobs.values()) {
    if (j.projectId === projectId && j.stage === 'running') return j
  }
  return null
}

/* ───────────── HTTP ───────────── */
export function apply(ctx) {
  const initialCfg = loadCfg()
  if (!initialCfg.llmKey && !process.env.OC_API_KEY && !process.env.BILI_OP_LLM_KEY) {
    const bridge = nativeModelBridge(ctx)
    const previousBase = process.env.BILI_OP_LLM_BASE
    modelBridgeReady = bridge.ready.then((env) => {
      Object.assign(process.env, env)
      return env
    }).catch((e) => { log('DSH模型通道启动失败：' + String(e?.message || e)); return {} })
    ctx.effect(() => () => {
      modelBridgeReady.then((env) => {
        if (process.env.BILI_OP_LLM_KEY === env.BILI_OP_LLM_KEY) {
          delete process.env.BILI_OP_LLM_KEY
          if (previousBase === undefined) delete process.env.BILI_OP_LLM_BASE
          else process.env.BILI_OP_LLM_BASE = previousBase
        }
      })
    }, 'bili-workbench: native model environment')
  }
  const sendJson = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(obj))
  }
  const readBody = (req) => new Promise((resolvePromise) => {
    let data = ''
    let done = false
    const finish = (v) => { if (!done) { done = true; resolvePromise(v) } }
    req.on('data', (c) => { data += c; if (data.length > 2_000_000) { finish({}); req.destroy() } })
    req.on('end', () => { try { finish(JSON.parse(data || '{}')) } catch { finish({}) } })
    req.on('error', () => finish({}))
  })

  let lastQrImage = ''

  const coverFor = async (bv) => {
    const buf = await fetchCover(bv)
    return buf ? { buf, type: 'image/jpeg' } : null
  }

  const handle = async (req, res, url) => {
    const path = url.pathname.replace(/^\/api\/bili-wb/, '') || '/'
    const q = url.searchParams

    /* ══════════ 账号：登录 / 状态 ══════════ */
    if (req.method === 'GET' && path === '/status') {
      const r = await runBiliAsync(['auth', 'status'], { timeoutMs: 20000 })
      const d = r.data || {}
      return sendJson(res, 200, {
        ok: true, loggedIn: Boolean(d.logged_in), user: d.user || null,
        status: d.status || '', code: r.error?.code || '', hint: r.error?.hint || '',
      })
    }
    if (req.method === 'POST' && path === '/login/start') {
      const r = await runBili(['auth', 'login'], { timeoutMs: 40000 })
      const d = r.data || {}
      if (d.qr_image) lastQrImage = String(d.qr_image)
      return sendJson(res, 200, {
        ok: r.ok && Boolean(d.qr_url || d.qr_image), status: d.status || '',
        qrUrl: d.qr_url || '', hasImage: Boolean(d.qr_image), expiresIn: Number(d.expires_in) || 180,
        error: r.error || null,
      })
    }
    if (req.method === 'GET' && path === '/qr.png') {
      if (!lastQrImage || !existsSync(lastQrImage)) { res.writeHead(404); return res.end('no qr') }
      try {
        const buf = readFileSync(lastQrImage)
        const isJpeg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8
        const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50
        res.writeHead(200, { 'content-type': isJpeg ? 'image/jpeg' : isPng ? 'image/png' : 'application/octet-stream', 'cache-control': 'no-store' })
        return res.end(buf)
      } catch (e) { res.writeHead(500); return res.end(String(e?.message ?? e)) }
    }
    if (req.method === 'POST' && path === '/logout') {
      const r = await runBili(['auth', 'logout'], { timeoutMs: 20000 })
      lastQrImage = ''
      return sendJson(res, 200, { ok: r.ok, error: r.error || null })
    }

    /* ══════════ 刷B站：热门 / 搜索 / 看懂 / 消息 / 数据 ══════════ */
    if (req.method === 'GET' && path === '/hot') {
      const kind = q.get('kind') === 'rank' ? 'rank' : 'popular'
      const size = Math.max(1, Math.min(Number(q.get('size')) || 20, 50))
      const zoneRaw = String(q.get('zone') || 'all')
      const zone = ZONES.has(zoneRaw) ? zoneRaw : 'all'
      const args = kind === 'rank'
        ? ['hot', 'rank', '--zone', zone, '--limit', String(size)]
        : ['hot', 'popular', '--size', String(size)]
      const r = await runBili(args, { timeoutMs: 40000 })
      return sendJson(res, 200, { ok: r.ok, kind, zone, items: r.data?.items || [], error: r.error || null })
    }
    if (req.method === 'GET' && path === '/search') {
      const kw = String(q.get('q') || '').trim().slice(0, 60)
      if (!kw) return sendJson(res, 200, { ok: true, items: [], keyword: '' })
      const size = Math.max(1, Math.min(Number(q.get('size')) || 20, 50))
      const order = ['default', 'views', 'new', 'danmaku', 'favorites', 'comments'].includes(String(q.get('order'))) ? String(q.get('order')) : 'default'
      const r = await runBiliAsync(['search', 'video', kw, '--order', order, '--size', String(size)], { timeoutMs: 45000 })
      return sendJson(res, 200, { ok: r.ok, keyword: kw, total: r.data?.total || 0, items: r.data?.items || [], error: r.error || null })
    }
    if (req.method === 'GET' && path === '/video') {
      const bv = String(q.get('bv') || '').trim()
      if (!BV_RE.test(bv)) return sendJson(res, 200, { ok: false, hint: 'BV 号不对' })
      const chars = Math.max(300, Math.min(Number(q.get('chars')) || 3000, 20000))
      const r = await runBiliAsync(['video', 'watch', bv, '--max-chars', String(chars)], { timeoutMs: 120000 })
      if (r.ok) {
        runEngine('collect.mjs', [bv, '--frames', '10']).then((x) => { if (!x.ok) log('顺手落库失败：' + x.text.slice(-200)) })
      }
      return sendJson(res, 200, { ok: r.ok, data: r.data || null, error: r.error || null })
    }
    if (req.method === 'GET' && path === '/stats') {
      const r = await runBiliAsync(['me', 'stats'], { timeoutMs: 40000 })
      return sendJson(res, 200, { ok: r.ok, data: r.data || null, error: r.error || null })
    }

    /* 封面代理：热门/搜索卡片用 */
    if (req.method === 'GET' && path === '/cover') {
      const bv = String(q.get('bv') || '').trim()
      if (!BV_RE.test(bv)) { res.writeHead(400); return res.end('bad bv') }
      const got = await coverFor(bv)
      if (!got) { res.writeHead(404); return res.end('no cover') }
      res.writeHead(200, { 'content-type': got.type, 'cache-control': 'max-age=1800' })
      return res.end(got.buf)
    }
    if (req.method === 'GET' && path === '/inbox') {
      const [inbox, replies] = await Promise.all([
        runBiliAsync(['feed', 'inbox'], { timeoutMs: 30000 }),
        runBiliAsync(['feed', 'replies', '--limit', '12'], { timeoutMs: 30000 }),
      ])
      return sendJson(res, 200, {
        ok: true, counts: inbox.data?.unread || null, note: inbox.data?.note || '',
        items: replies.data?.items || [], error: inbox.error || replies.error || null,
      })
    }

    /* ══════════ 素材库 ══════════ */
    if (req.method === 'GET' && path === '/store/list') {
      const tier = String(q.get('tier') || '')
      const kw = String(q.get('q') || '').trim()
      const limit = Math.max(1, Math.min(Number(q.get('limit')) || 100, 500))
      let rows = storeList({ limit: 2000 })
      if (TIERS.has(tier)) rows = rows.filter((r) => (r.judge?.tier || '未判定') === tier)
      if (kw) {
        const k = kw.toLowerCase()
        rows = rows.filter((r) => String(r.title || '').toLowerCase().includes(k)
          || String(r.up?.name || '').toLowerCase().includes(k)
          || String(r.judge?.why || '').toLowerCase().includes(k)
          || (r.quotes || []).some((x) => String(x.text || '').toLowerCase().includes(k)))
      }
      rows = rows.slice(0, limit)
      const slim = rows.map(({ subtitle, ...rest }) => ({
        ...rest,
        commented: interact.isCommented(rest.bvid),
        subtitle: subtitle ? { lang: subtitle.lang, chars: subtitle.chars, items: subtitle.items, missing: subtitle.missing || '' } : null,
      }))
      return sendJson(res, 200, { ok: true, rows: slim, total: rows.length, stats: storeStats(), ranges: parseRanges(loadCfg().scheduleRanges).length })
    }
    if (req.method === 'GET' && path === '/store/item') {
      const bv = String(q.get('bv') || '')
      if (!BV_RE.test(bv)) return sendJson(res, 200, { ok: false, error: 'bad bv' })
      const rec = storeGet(bv)
      if (!rec) return sendJson(res, 200, { ok: false, error: '库里没有这条' })
      const { subtitle, ...rest } = rec
      let sub = null
      try {
        const f = storePaths(bv).subs
        if (existsSync(f)) {
          const j = JSON.parse(readFileSync(f, 'utf8'))
          sub = { lang: j.lang, items: (j.items || []).slice(0, 200), total: (j.items || []).length }
        }
      } catch { /* 没字幕就算了 */ }
      return sendJson(res, 200, {
        ok: true,
        record: { ...rest, commented: interact.isCommented(bv), subtitle: subtitle ? { lang: subtitle.lang, chars: subtitle.chars, items: subtitle.items, missing: subtitle.missing || '' } : null },
        subtitles: sub,
      })
    }
    if (req.method === 'GET' && path === '/store/media') {
      const bv = String(q.get('bv') || '')
      const kind = String(q.get('kind') || 'cover')
      if (!BV_RE.test(bv)) { res.writeHead(400); return res.end('bad bv') }
      const p = storePaths(bv)
      if (kind === 'cover') {
        if (!existsSync(p.cover)) { res.writeHead(404); return res.end('no cover') }
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=3600' })
        return res.end(readFileSync(p.cover))
      }
      const name = String(q.get('name') || '')
      if (!/^[\w.\-]+\.jpg$/.test(name)) { res.writeHead(400); return res.end('bad name') }
      const file = join(p.framesDir, name)
      if (!existsSync(file)) { res.writeHead(404); return res.end('no frame') }
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=3600' })
      return res.end(readFileSync(file))
    }
    if (req.method === 'GET' && path === '/store/report') {
      const day = String(q.get('day') || new Date().toLocaleDateString('sv-SE')).replace(/[^0-9-]/g, '')
      const file = join(STORE, 'reports', `${day}.md`)
      if (!existsSync(file)) return sendJson(res, 200, { ok: true, day, exists: false, text: '' })
      return sendJson(res, 200, { ok: true, day, exists: true, text: readFileSync(file, 'utf8') })
    }
    if (req.method === 'POST' && path === '/store/collect') {
      const body = await readBody(req)
      const args = []
      const bvs = Array.isArray(body.bvs) ? body.bvs.filter((x) => BV_RE.test(String(x))) : []
      if (bvs.length) args.push(...bvs)
      else if (body.mode === 'search' && body.q) args.push('--search', String(body.q).slice(0, 60), '--size', String(Math.min(Number(body.size) || 5, 20)))
      else args.push('--hot', String(Math.min(Number(body.size) || 6, 50)))
      if (body.refresh) args.push('--refresh')
      args.push('--frames', String(Math.min(Number(body.frames) || 10, 10)))
      const r = await runEngine('collect.mjs', args)
      return sendJson(res, 200, { ok: r.ok, text: r.text.slice(-2000), stats: storeStats() })
    }
    if (req.method === 'POST' && path === '/store/judge') {
      const body = await readBody(req)
      const r = await runEngine('judge.mjs', body.refresh ? ['--refresh'] : [])
      return sendJson(res, 200, { ok: r.ok, text: r.text.slice(-2000) })
    }
    if (req.method === 'POST' && path === '/store/daily') {
      const r = await runEngine('daily.mjs', ['--level', loadCfg().reportLevel])
      return sendJson(res, 200, { ok: r.ok, text: r.text.slice(-2000) })
    }
    if (req.method === 'POST' && path === '/store/relocate') {
      if (roundRunning || taskRunning) return sendJson(res, 200, { ok: false, error: '采集轮次正在跑，等它结束再切' })
      if (publisher.anyBusy() || [...jobs.values()].some((j) => j.stage === 'running')) {
        return sendJson(res, 200, { ok: false, error: '有渲染任务正在跑，等它结束再切' })
      }
      const body = await readBody(req)
      const raw = String(body.path || '').trim()
      if (!raw) return sendJson(res, 200, { ok: false, error: '先填一个素材库目录' })
      const target = resolve(raw.replace(/^~(?=$|[\\/])/, homedir()))
      const old = STORE
      const lc = (s) => s.replace(/[\\/]+$/, '').toLowerCase()
      if (lc(target) === lc(old)) {
        return sendJson(res, 200, { ok: true, path: old, copied: false, store: storeStats() })
      }
      if (lc(target).startsWith(lc(old) + sep) || lc(old).startsWith(lc(target) + sep)) {
        return sendJson(res, 200, { ok: false, error: '不能选当前素材库的子目录或上级目录' })
      }
      try {
        if (existsSync(target) && !statSync(target).isDirectory()) {
          return sendJson(res, 200, { ok: false, error: '这个路径是一个文件，不是目录' })
        }
        mkdirSync(target, { recursive: true })
        const videosDir = join(target, 'videos')
        const hasData = existsSync(join(target, 'config.json'))
          || (existsSync(videosDir) && readdirSync(videosDir).some((f) => f.endsWith('.json')))
        let copied = false
        if (body.copy !== false && !hasData) {
          cpSync(old, target, { recursive: true, force: false, errorOnExist: false })
          copied = true
        }
        const p = setStoreRoot(target)
        log(`素材库位置切换：${old} → ${p}${copied ? '（已复制现有素材）' : ''}`)
        return sendJson(res, 200, {
          ok: true, path: p, copied, store: storeStats(),
          defaultPath: defaultStorePath(), locationFile: locationFile(),
        })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) })
      }
    }

    /* ══════════ 创作：方案（项目 + 版本） ══════════ */
    if (req.method === 'GET' && path === '/create/plans') {
      const list = plans.listProjects().slice(0, 40).map((p) => {
        const plan = plans.getVersion(p.id, p.currentVersion)
        let job = activeJob(p.id) || [...jobs.values()].reverse().find((j) => j.projectId === p.id && j.runDir === p.runDir && j.version === p.currentVersion)
        if (!job && p.runDir && p.renderVersion === p.currentVersion) {
          const runId = String(p.runDir).split(/[\\/]/).pop()
          const dir = renders.findRunDir(runId)
          try { job = dir ? JSON.parse(readFileSync(join(dir, 'render-job.json'), 'utf8')) : null } catch { /* 尚无持久化任务 */ }
          if (job?.stage === 'running') {
            job = { ...job, stage: 'failed', error: '上次渲染被中断，请重新渲染' }
          }
        }
        return {
          ...p,
          plan: plan ? {
            title: plan.title, subtitle: plan.subtitle, angle: plan.angle, brief: plan.brief, style: plan.style, customStyle: plan.customStyle,
            picks: plan.picks || [], shots: plan.shots || [], stats: plan.stats || {}, model: plan.model,
          } : null,
          job: jobView(job),
          hasVideo: Boolean(p.runDir && existsSync(renders.mediaPath(String(p.runDir).split(/[\\/]/).pop(), 'video') || '')),
          stage: (() => {
            if (job?.stage === 'running') return 'rendering'
            const runId = String(p.runDir || '').split(/[\\/]/).pop()
            const status = runId ? renders.readStatus(runId) : null
            if (!status || !isCurrentRun(p, runId, status)) return p.renderVersion && Number(p.renderVersion) !== Number(p.currentVersion) ? 'draft' : p.stage
            return status.stage === 'uploading' && !publisher.isBusy(runId) ? 'upload_unknown' : ['rendered', 'approved', 'rejected', ...submittedStages].includes(status.stage) ? displayPublicationStage(status) : p.stage
          })(),
        }
      })
      return sendJson(res, 200, { ok: true, projects: list })
    }
    if (req.method === 'GET' && path === '/create/plan') {
      const id = String(q.get('id') || '')
      const v = Number(q.get('v')) || 0
      const project = plans.getProject(id)
      if (!project) return sendJson(res, 200, { ok: false, error: '项目不存在' })
      const plan = plans.getVersion(id, v || project.currentVersion)
      return sendJson(res, 200, { ok: true, project, plan })
    }
    // 风格预览不创建项目、不写长期记忆，便于审稿后再正式生成。
    if (req.method === 'POST' && path === '/create/preview') {
      const body = await readBody(req)
      const brief = String(body.brief || '').trim().slice(0, 300)
      if (!brief) return sendJson(res, 200, { ok: false, error: '先填写创作需求' })
      const creative = creativeOptions(body)
      const tmp = join(STORE, 'tmp', '.tmp-preview-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.json')
      mkdirSync(dirname(tmp), { recursive: true })
      const args = [brief, '--preview', '--out', tmp, '--style', creative.style, '--custom-style', creative.customStyle]
      if (Array.isArray(body.bvs)) {
        const bvs = body.bvs.filter(bv => BV_RE.test(String(bv))).slice(0, 40)
        if (bvs.length) args.push('--bvs', bvs.join(','))
      }
      try {
        const result = await runEngine('plan.mjs', args, 5 * 60_000)
        const plan = readJson(tmp, null)
        return sendJson(res, 200, result.ok && plan ? { ok: true, plan } : { ok: false, error: result.text.slice(-1800) || '预览生成失败' })
      } finally { try { unlinkSync(tmp) } catch { /* 未生成文件 */ } }
    }
    if (req.method === 'POST' && path === '/create/plan') {
      const body = await readBody(req)
      const brief = String(body.brief || '').trim().slice(0, 300)
      if (!brief) return sendJson(res, 200, { ok: false, error: '先写一句你想做什么样的片子' })
      let tmp = join(STORE, 'tmp', `.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
      mkdirSync(join(STORE, 'tmp'), { recursive: true })
      const creative = creativeOptions(body)
      const args = [brief, '--out', tmp, '--style', creative.style, '--custom-style', creative.customStyle]
      if (body.limit) args.push('--limit', String(Math.min(Number(body.limit) || 40, 120)))
      const r = await runEngine('plan.mjs', args, 10 * 60_000, {
        BILI_OP_SELF_VIDEOS: canon.renderBlock(brief),
        BILI_OP_MEMORY_QUERY: brief,
      })
      let plan = null
      try { plan = JSON.parse(readFileSync(tmp, 'utf8')) } catch { plan = null }
      try { unlinkSync(tmp) } catch { /* 已删 */ }
      if (!r.ok || !plan) {
        return sendJson(res, 200, { ok: false, error: r.ok ? '没拿到方案（看日志）' : '生成失败（看日志）', log: (r.text || '').slice(-2500) })
      }
      const project = plans.createProject(plan, { brief })
      log(`新方案 ${project.id}：${plan.title}`)
      // 方案完成后复盘一次（节流在 reflect.mjs 里）：主人的指令是提炼习惯的重要来源
      runReflect()
        .then((r) => { if (r && !r.ok && !r.skipped) log('复盘失败：' + String(r.error || '').split('\n')[0]) })
        .catch((e) => { log('复盘异常：' + String(e?.message ?? e).split('\n')[0]) })
      return sendJson(res, 200, { ok: true, project, plan, log: (r.text || '').slice(-2500) })
    }
    if (req.method === 'POST' && path === '/create/revise') {
      const body = await readBody(req)
      const id = String(body.id || '')
      const instruction = String(body.instruction || '').trim().slice(0, 300)
      if (!instruction) return sendJson(res, 200, { ok: false, error: '先说一句要改什么' })
      const project = plans.getProject(id)
      if (!project) return sendJson(res, 200, { ok: false, error: '项目不存在' })
      if (activeJob(id)) return sendJson(res, 200, { ok: false, error: '这个项目正在渲染，等渲染完再改版' })
      const prevPlan = plans.getVersion(id, project.currentVersion)
      if (!prevPlan) return sendJson(res, 200, { ok: false, error: '当前版本读不到' })
      // 旧格式（plans/<时间>.json）没有项目目录：先复制成一个新项目再改版
      let workProject = project
      let prevFile = plans.planFile(id, project.currentVersion)
      if (project.legacy) {
        workProject = plans.createProject(prevPlan, { brief: prevPlan.brief || '' })
        prevFile = plans.planFile(workProject.id, 1)
      } else if (!existsSync(prevFile)) {
        writeJson(prevFile, prevPlan)
      }
      const tmp = join(STORE, 'tmp', `.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
      mkdirSync(join(STORE, 'tmp'), { recursive: true })
      const creative = creativeOptions(body, prevPlan)
      const r = await runEngine('plan.mjs', ['--revise', prevFile, '--instruction', instruction, '--out', tmp, '--style', creative.style, '--custom-style', creative.customStyle], 10 * 60_000, {
        BILI_OP_SELF_VIDEOS: canon.renderBlock(instruction),
        BILI_OP_MEMORY_QUERY: instruction,
      })
      let plan = null
      try { plan = JSON.parse(readFileSync(tmp, 'utf8')) } catch { plan = null }
      try { unlinkSync(tmp) } catch { /* 已删 */ }
      if (!r.ok || !plan) {
        return sendJson(res, 200, { ok: false, error: r.ok ? '没拿到改版方案（看日志）' : '改版失败（看日志）', log: (r.text || '').slice(-2500) })
      }
      const next = plans.addVersion(workProject.id, plan, { instruction })
      log(`改一版 ${workProject.id} → v${next.currentVersion}：${plan.title}`)
      return sendJson(res, 200, { ok: true, project: next, plan, log: (r.text || '').slice(-2500) })
    }
    if (req.method === 'GET' && path === '/create/prompt') {
      const id = String(q.get('id') || '')
      const v = Number(q.get('v')) || 0
      try { return sendJson(res, 200, { ok: true, prompt: plans.promptFor(id, v) }) } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) })
      }
    }
    if (req.method === 'POST' && path === '/create/delete') {
      const body = await readBody(req)
      const id = String(body.id || '')
      const p = plans.getProject(id)
      if (!p) return sendJson(res, 200, { ok: false, error: '项目不存在' })
      if (activeJob(p.id)) return sendJson(res, 200, { ok: false, error: '这个项目正在渲染，等渲染完再删' })
      let ok
      try { ok = plans.deleteProject(id) } catch (e) {
        return sendJson(res, 200, { ok: false, error: '删除方案失败：' + String(e?.message || e) })
      }
      if (ok) {
        for (const t of tasks.list()) {
          if (t.projectId !== id) continue
          tasks.update(t.id, { projectId: '', planTitle: '', status: 'paused' })
          tasks.addLog(t.id, '关联方案已删除，任务暂停')
        }
      }
      // 成片是独立产物：留在「审核/发布」，要删请在那里单独删
      log(`删除方案 ${id}（成片保留在审核/发布）`)
      return sendJson(res, 200, { ok })
    }

    /* ══════════ 长任务：素材不够就自己去 B站 找 ══════════ */
    if (req.method === 'GET' && path === '/task/list') {
      const rows = tasks.list()
      return sendJson(res, 200, {
        ok: true,
        tasks: rows,
        active: rows.filter((t) => !['ready', 'failed'].includes(t.status)).length,
        running: taskRunning,
      })
    }
    if (req.method === 'POST' && path === '/task/create') {
      const body = await readBody(req)
      const brief = String(body.brief || '').trim().slice(0, 300)
      if (!brief) return sendJson(res, 200, { ok: false, error: '先写一句你想做什么样的片子' })
      const task = tasks.create({
        brief,
        ...creativeOptions(body),
        maxDays: Number(body.maxDays) || 5,
        intervalMinutes: Number(body.intervalMinutes) || 180,
        needed: Number(body.needed) || 1,
      })
      memory.addEvent('task', { id: task.id, text: `接到创作指令「${brief.slice(0, 40)}」` })
      log(`新任务 ${task.id}：${brief}`)
      const t = setTimeout(() => { kickTask(task.id) }, 800)
      t.unref?.()
      return sendJson(res, 200, { ok: true, task })
    }
    if (req.method === 'POST' && path === '/task/tick') {
      const body = await readBody(req)
      const id = String(body.id || '')
      if (id && !tasks.get(id)) return sendJson(res, 200, { ok: false, error: '任务不存在' })
      if (taskRunning) return sendJson(res, 200, { ok: false, error: '已经有一个任务在跑，等它跑完' })
      if (roundRunning) return sendJson(res, 200, { ok: false, error: '日常采集正在跑，稍后再试' })
      const started = kickTask(id)
      return sendJson(res, 200, { ok: started, started, error: started ? '' : '任务已在跑' })
    }
    if (req.method === 'POST' && path === '/task/pause') {
      const body = await readBody(req)
      const id = String(body.id || '')
      const t = tasks.update(id, { status: 'paused' })
      if (!t) return sendJson(res, 200, { ok: false, error: '任务不存在' })
      tasks.addLog(id, '已暂停')
      return sendJson(res, 200, { ok: true, task: t })
    }
    if (req.method === 'POST' && path === '/task/resume') {
      const body = await readBody(req)
      const id = String(body.id || '')
      const t = tasks.update(id, { status: 'queued', nextRunAt: new Date().toISOString(), lastError: '' })
      if (!t) return sendJson(res, 200, { ok: false, error: '任务不存在' })
      tasks.addLog(id, '已继续')
      const tm = setTimeout(() => { kickTask(id) }, 800)
      tm.unref?.()
      return sendJson(res, 200, { ok: true, task: t })
    }
    if (req.method === 'POST' && path === '/task/retry') {
      const body = await readBody(req)
      const id = String(body.id || '')
      const cur = tasks.get(id)
      if (!cur) return sendJson(res, 200, { ok: false, error: '任务不存在' })
      // 已经过期的任务，手动重试就从现在起再给一个完整期限
      const expired = Date.parse(cur.deadline || '') < Date.now()
      const deadline = expired ? new Date(Date.now() + (cur.maxDays || 5) * 86400_000).toISOString() : cur.deadline
      const t = tasks.update(id, {
        status: 'queued', nextRunAt: new Date().toISOString(), lastError: '', deadline,
      })
      tasks.addLog(id, expired ? `手动重试，期限顺延到 ${String(deadline).slice(0, 10)}` : '手动重试')
      const tm = setTimeout(() => { kickTask(id) }, 500)
      tm.unref?.()
      return sendJson(res, 200, { ok: true, task: t })
    }
    if (req.method === 'POST' && path === '/task/delete') {
      const body = await readBody(req)
      const id = String(body.id || '')
      const ok = tasks.remove(id)
      return sendJson(res, 200, ok ? { ok: true } : { ok: false, error: '任务不存在' })
    }

    /* ══════════ 出片：方案 → 真实素材渲染 ══════════ */
    if (req.method === 'POST' && path === '/render/start') {
      const body = await readBody(req)
      const id = String(body.id || '')
      let project = plans.getProject(id)
      if (!project) return sendJson(res, 200, { ok: false, error: '项目不存在' })
      let v = Number(body.version) || project.currentVersion
      let plan = plans.getVersion(id, v)
      if (!plan) return sendJson(res, 200, { ok: false, error: '这一版方案读不到' })
      // 旧格式：复制成一个新项目再渲染（不破坏原来的只读方案）
      if (project.legacy) {
        const copied = plans.createProject(plan, { brief: plan.brief || '' })
        project = copied
        v = 1
        plan = plans.getVersion(project.id, 1)
      }
      if (activeJob(project.id)) return sendJson(res, 200, { ok: false, error: '这个项目正在渲染' })
      try {
        const job = startRender(project, plan, v, body.voice)
        return sendJson(res, 200, { ok: true, job: jobView(job) })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) })
      }
    }
    if (req.method === 'GET' && path === '/render/status') {
      const runId = String(q.get('runId') || '')
      let job = jobs.get(runId)
      if (!job) {
        const dir = renders.findRunDir(runId)
        try { job = dir ? JSON.parse(readFileSync(join(dir, 'render-job.json'), 'utf8')) : null } catch { /* 尚无任务 */ }
        if (job?.stage === 'running') job = { ...job, stage: 'failed', error: '上次渲染被中断，请重新渲染' }
      }
      return sendJson(res, 200, { ok: true, job: jobView(job), status: runId ? renders.readStatus(runId) : null })
    }
    if (req.method === 'GET' && path === '/render/runs') {
      return sendJson(res, 200, { ok: true, runs: renders.listRuns() })
    }

    /* ══════════ 审核 / 发布 ══════════ */
    if (req.method === 'GET' && path === '/review/list') {
      const runs = renders.listRuns()
        .filter((r) => r.hasVideo || ['rendered', 'approved', 'rejected', ...submittedStages].includes(r.stage))
        .map((r) => ({ ...r, stage: r.stage === 'uploading' && !publisher.isBusy(r.runId) ? 'upload_unknown' : displayPublicationStage(r), project: r.projectId ? plans.getProject(r.projectId) : null }))
      return sendJson(res, 200, { ok: true, runs, publishEnabled: loadCfg().publishEnabled })
    }
    if (req.method === 'GET' && path === '/review/media') {
      const runId = String(q.get('runId') || '')
      const kind = String(q.get('kind') || 'cover')
      const file = renders.mediaPath(runId, kind)
      if (!file || !existsSync(file)) { res.writeHead(404); return res.end('not found') }
      const st = statSync(file)
      const type = kind === 'cover' ? 'image/png' : 'video/mp4'
      const range = req.headers.range
      const sendFile = (options) => {
        const stream = createReadStream(file, options)
        stream.on('error', () => res.destroy())
        res.on('close', () => stream.destroy())
        return stream.pipe(res)
      }
      if (kind === 'video' && range) {
        const part = videoRange(range, st.size)
        if (!part) {
          res.writeHead(416, { 'content-range': `bytes */${st.size}` })
          return res.end()
        }
        const { start, end } = part
        res.writeHead(206, {
          'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'no-store',
          'content-range': `bytes ${start}-${end}/${st.size}`,
          'content-length': end - start + 1,
        })
        return sendFile({ start, end })
      }
      res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'accept-ranges': 'bytes', 'cache-control': 'no-store' })
      return sendFile()
    }
    if (req.method === 'POST' && path === '/review/delete') {
      const body = await readBody(req)
      const runId = String(body.runId || '')
      const st = renders.readStatus(runId)
      if (!st) return sendJson(res, 200, { ok: false, error: '成片不存在' })
      if (publisher.isBusy(runId)) return sendJson(res, 200, { ok: false, error: '投稿或同步中，请结束后再删除' })
      const live = jobs.get(runId)
      if (live?.stage === 'running') return sendJson(res, 200, { ok: false, error: '正在渲染，等渲染完再删' })
      const ok = renders.deleteRun(runId)
      if (!ok) return sendJson(res, 200, { ok: false, error: '删除失败（文件不在素材库目录）' })
      if (st.projectId) {
        const p = plans.getProject(st.projectId)
        const curRun = p?.runDir ? String(p.runDir).split(/[\\/]/).filter(Boolean).pop() : ''
        if (p && curRun === runId) {
          p.stage = 'draft'
          p.runDir = ''
          p.review = null
          plans.saveProject(p)
        }
      }
      jobs.delete(runId)
      log(`删除成片 ${runId}（只删本地，不动 B站 已发布内容）`)
      return sendJson(res, 200, { ok: true })
    }
    if (req.method === 'POST' && path === '/review/decision') {
      const body = await readBody(req)
      const runId = String(body.runId || '')
      const state = body.state
      if (!['approved', 'rejected'].includes(state)) return sendJson(res, 200, { ok: false, error: '审核状态不合法' })
      const st = renders.readStatus(runId)
      if (!st) return sendJson(res, 200, { ok: false, error: '成片不存在' })
      if (publisher.isBusy(runId) || submittedStages.has(st.stage) || st.bvid) return sendJson(res, 200, { ok: false, error: '作品已提交或结果待确认，请同步平台状态' })
      const video = renders.mediaPath(runId, 'video')
      if (!video || !existsSync(video) || statSync(video).size === 0 || jobs.get(runId)?.stage === 'running') return sendJson(res, 200, { ok: false, error: '尚无完整成片，不能审核' })
      if (st.review?.state === state) return sendJson(res, 200, { ok: true, status: st })
      renders.setReview(runId, state, body.note)
      memory.addEvent('review', { runId, state, text: `审核《${st.title || runId}》：${state === 'approved' ? '通过' : '打回'}${body.note ? `，备注：${String(body.note).slice(0, 40)}` : ''}` })
      if (st.projectId) {
        const p = plans.getProject(st.projectId)
        if (p && isCurrentRun(p, runId, st)) {
          p.stage = state === 'approved' ? 'approved' : 'rejected'
          p.review = { state, at: new Date().toISOString(), note: String(body.note || '') }
          plans.saveProject(p)
        }
      }
      log(`审核 ${runId}：${state}`)
      // 打回原因 / 通过偏好是复盘的重要素材，审完跑一次（节流在 reflect.mjs）
      runReflect()
        .then((r) => { if (r && !r.ok && !r.skipped) log('复盘失败：' + String(r.error || '').split('\n')[0]) })
        .catch((e) => { log('复盘异常：' + String(e?.message ?? e).split('\n')[0]) })
      return sendJson(res, 200, { ok: true, status: renders.readStatus(runId) })
    }
    if (req.method === 'GET' && path === '/review/stats') {
      const runId = String(q.get('runId') || '')
      const st = renders.readStatus(runId)
      if (!st) return sendJson(res, 200, { ok: false, error: '成片不存在' })
      const bvid = String(st.bvid || st.review?.bvid || '')
      if (!bvid) return sendJson(res, 200, { ok: false, error: '这条还没有 BV 号（没真投稿过）' })
      const r = await runBiliAsync(['upload', 'stats', bvid], { timeoutMs: 60000 })
      return sendJson(res, 200, { ok: r.ok, bvid, data: r.data || null, error: r.error || null })
    }
    if (req.method === 'POST' && path === '/review/upload') {
      const body = await readBody(req)
      if (jobs.get(String(body.runId || ''))?.stage === 'running') return sendJson(res, 200, { ok: false, error: '渲染中不能投稿' })
      return sendJson(res, 200, await publisher.upload(body, loadCfg()))
    }
    if (req.method === 'POST' && path === '/review/sync') {
      return sendJson(res, 200, await publisher.sync(await readBody(req)))
    }
    if (req.method === 'POST' && path === '/review/retry') {
      return sendJson(res, 200, publisher.retry(await readBody(req)))
    }

    /* ══════════ 自己的视频（B站合集） ══════════ */
    if (req.method === 'GET' && path === '/canon/state') {
      return sendJson(res, 200, { ok: true, ...canon.status() })
    }
    if (req.method === 'POST' && path === '/canon/refresh') {
      const body = await readBody(req)
      const url = String(body.url || '').trim()
      if (url) saveCfg({ selfVideosUrl: url })
      const r = canon.refresh(loadCfg().selfVideosUrl, { force: true })
      if (!r.ok) return sendJson(res, 200, r)
      return sendJson(res, 200, { ok: true, refreshed: true, status: canon.status() })
    }

    /* ══════════ 主人 @ 任务（看视频 / 看评论 / 总结） ══════════ */
    if (req.method === 'GET' && path === '/owner/tasks') {
      const f = join(STORE, 'owner', 'tasks.json')
      let tasks = []
      try { tasks = JSON.parse(readFileSync(f, 'utf8'))?.tasks || [] } catch { tasks = [] }
      return sendJson(res, 200, { ok: true, tasks: tasks.slice(0, 30) })
    }
    if (req.method === 'POST' && path === '/owner/check') {
      const r = await runEngine('owner-task.mjs', ['--tick', '--force'], 15 * 60_000)
      return sendJson(res, 200, { ok: r.ok, log: String(r.text || '').slice(-2500) })
    }

    /* ══════════ 互动：预览 / dry-run / 受控发送 ══════════ */
    if (req.method === 'GET' && path === '/interact/state') {
      const cfg = loadCfg()
      return sendJson(res, 200, { ok: true, config: cfg, counts: interact.dayCounts(), commented: interact.commentedMap() })
    }
    if (req.method === 'POST' && path === '/interact/preview') {
      const body = await readBody(req)
      const kind = ['comment', 'reply', 'dm'].includes(body.kind) ? body.kind : 'comment'
      const cfg = loadCfg()
      let text = String(body.text || '').trim()
      let model = ''
      let logText = ''
      if (kind === 'reply') {
        const isOwner = body.owner === true
        const audit = auditMessage(body.message || '', { isOwner })
        if (!audit.allow) {
          if (isOwner && audit.reason === 'owner-dangerous') {
            return sendJson(res, 200, {
              ok: true, kind, model: 'audit-refused', cap: null,
              text: `${cfg.ownerCall || '老弟'}，这个操作得去工作台「刷B站设置」手动改，我在评论里不执行配置或发布操作。`,
            })
          }
          return sendJson(res, 200, {
            ok: true, kind, model: 'audit-refused', cap: null,
            blocked: true, reason: audit.reason,
            text: refusalText(body.message || '', audit.reason),
          })
        }
      }
      if (!text && body.owner && kind === 'reply') {
        const cmd = answerOwnerCommandDetailed(body.message || '', cfg)
        if (cmd) {
          // 数字先由本地脚本算准，再按人设改写；数字对不上就自动退回原句
          let out = cmd.text
          if (cmd.kind !== 'refuse') {
            try { out = await voiceOwnerStats(cmd.text, { persona: cfg.personaPrompt, ownerCall: cfg.ownerCall }) } catch { /* 用原句 */ }
          }
          return sendJson(res, 200, {
            ok: true, text: out, cap: null, kind,
            model: cmd.kind === 'refuse' ? 'owner-command' : 'owner-command+voice',
          })
        }
      }
      if (!text) {
        const ctx = kind === 'comment'
          ? {
            title: body.title || '', up: body.up || '', quotes: body.quotes || [], ownerCall: cfg.ownerCall, calls: callNames(cfg),
            selfVideos: canon.renderBlock(body.title || ''),
            memoryRecall: memory.renderRecallBlock(body.title || '', { k: 3 }),
          }
          : {
            message: body.message || '', replyingTo: body.replyingTo || '', video: body.video || '',
            owner: body.owner === true, ownerCall: cfg.ownerCall,
            selfVideos: canon.renderBlock(body.message || body.video || ''),
            memoryRecall: memory.renderRecallBlock(body.message || body.video || '', { k: 3 }),
          }
        const r = await runEngine('compose.mjs', ['--kind', kind, '--context', JSON.stringify(ctx)], 120_000)
        logText = r.text.slice(-1500)
        try {
          const j = JSON.parse((r.text.match(/\{[\s\S]*\}\s*$/) || ['{}'])[0])
          if (j.ok) { text = String(j.text || ''); model = j.model || '' }
        } catch { /* 下面统一报错 */ }
        if (!text) return sendJson(res, 200, { ok: false, error: '生成失败（看日志）', log: logText })
      }
      const cap = await interact.checkCap(kind, cfg)
      return sendJson(res, 200, { ok: true, text, model, cap, kind })
    }
    if (req.method === 'POST' && path === '/interact/send') {
      const body = await readBody(req)
      const kind = ['comment', 'reply', 'dm'].includes(body.kind) ? body.kind : ''
      if (!kind) return sendJson(res, 200, { ok: false, error: 'kind 不对' })
      const cfg = loadCfg()
      const text = String(body.text || '').trim().slice(0, 500)
      if (!text) return sendJson(res, 200, { ok: false, error: '没有内容' })
      const cap = await interact.checkCap(kind, cfg)
      if (cap) return sendJson(res, 200, { ok: false, error: cap })
      if (body.confirm !== true) return sendJson(res, 200, { ok: false, error: '需要二次确认' })

      const dryRun = body.dryRun === true
      const args = []
      if (dryRun) args.push('--dry-run')
      if (kind === 'comment') {
        const bv = String(body.bv || '').trim()
        if (!BV_RE.test(bv)) return sendJson(res, 200, { ok: false, error: 'BV 号不对' })
        args.push('comment', 'post', bv, text)
        for (const t of mentionTargets(cfg)) args.push('--at', t.target)
      } else if (kind === 'reply') {
        const bv = String(body.bv || '').trim()
        const rpid = String(body.rpid || '').trim()
        if (!BV_RE.test(bv) || !/^\d+$/.test(rpid)) return sendJson(res, 200, { ok: false, error: '回复参数不完整' })
        args.push('comment', 'reply', bv, rpid, text)
        if (body.root) args.push('--root', String(body.root))
        if (cfg.mentionName) args.push('--at', cfg.mentionName)
      } else {
        const uid = String(body.uid || cfg.dmUid || '').trim()
        if (!uid) return sendJson(res, 200, { ok: false, error: '没填私信对象 UID' })
        args.push('dm', 'send', uid, text)
      }

      const r = await runBili(args, { timeoutMs: 60000 })
      if (r.ok && !dryRun) {
        if (kind === 'comment') await interact.markComment(body.bv, { text })
        if (kind === 'reply') await interact.markReply(body.rpid, { text })
        if (kind === 'dm') await interact.markDm(body.uid || cfg.dmUid, { text })
        const what = kind === 'comment' ? '评论了' : kind === 'reply' ? '回复了' : '私信了'
        memory.addEvent(kind === 'dm' ? 'dm' : kind, {
          bv: body.bv || '', text: `${what}《${String(body.title || body.bv || '').slice(0, 26)}》：${text.slice(0, 46)}`,
        })
        log(`互动已发送（${kind}）：${text.slice(0, 40)}`)
      }
      return sendJson(res, 200, {
        ok: r.ok, dryRun, command: [runBiliName(), ...args],
        data: r.data || null, error: r.error || null, text: r.error?.message || '',
      })
    }

    /* ══════════ 调度（刷B站设置） ══════════ */
    if (req.method === 'GET' && path === '/config') {
      const cfg = loadCfg()
      const sched = loadSched()
      const prog = rangeProgress(cfg.scheduleRanges)
      return sendJson(res, 200, {
        ok: true, config: cfg,
        schedule: {
          ...sched, running: roundRunning, todayCount: collectedToday(),
          inWindow: prog.inWindow, target: targetToday(cfg), totalMinutes: prog.total,
          estMinutes: prog.total > 0 ? Math.max(1, Math.round(prog.total / Math.max(1, cfg.perDay))) : 0,
        },
        store: storeStats(),
      })
    }
    if (req.method === 'POST' && path === '/config') {
      const body = await readBody(req)
      const patch = {}
      const copyKeys = [
        'enabled', 'keywords', 'llmKey', 'scheduleRanges', 'perDay',
        'personaPrompt', 'reportLevel', 'favFolderId',
        'memoryEnabled', 'userCharLimit', 'memoryCharLimit', 'reflectEnabled', 'memoryEventsMax',
        'selfVideosEnabled', 'selfVideosUrl', 'selfVideosRefreshHours',
        'autoComment', 'autoReply', 'ownerUid', 'ownerCall', 'mentionName', 'mentions', 'replyPerDay', 'commentImageEvery',
        'ownerTasksEnabled', 'ownerTaskPollMinutes', 'ownerTaskPerDay', 'ownerTaskAllowDm', 'ownerTaskMaxAgeHours',
        'dmWatch', 'dmWatchMinutes', 'dmReplyPerDay', 'dmOwnerUid',
        'voice', 'modelChain', 'concurrency',
        'publishEnabled', 'defaultTags', 'defaultZone',
      ]
      for (const k of copyKeys) if (k in body) patch[k] = body[k]
      const cfg = saveCfg(patch)
      return sendJson(res, 200, { ok: true, config: cfg })
    }
    if (req.method === 'POST' && path === '/run-round') {
      const cfg = loadCfg()
      const done = collectedToday()
      const remain = Math.max(0, cfg.perDay - done)
      if (remain <= 0) return sendJson(res, 200, { ok: false, error: `今天已经到上限（${done}/${cfg.perDay}）` })
      const r = await runRound('manual', { count: Math.min(3, remain) })
      return sendJson(res, 200, r)
    }
    if (req.method === 'GET' && path === '/duty-log') {
      if (!existsSync(logFile())) return sendJson(res, 200, { ok: true, text: '' })
      const t = readFileSync(logFile(), 'utf8')
      return sendJson(res, 200, { ok: true, text: t.slice(-12000) })
    }
    if (req.method === 'POST' && path === '/open-folder') {
      const body = await readBody(req)
      const target = body.what === 'runs' ? renders.RUNS : STORE
      try {
        const child = spawn('explorer.exe', [target], { detached: true, stdio: 'ignore', windowsHide: false })
        child.unref()
        return sendJson(res, 200, { ok: true, path: target })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) })
      }
    }
    if (req.method === 'GET' && path === '/model/health') {
      const r = await runOp('gen.mjs', ['--health'], 30000)
      let data = null
      try { data = JSON.parse((r.text.match(/\{[\s\S]*\}\s*$/) || ['{}'])[0]) } catch { data = null }
      return sendJson(res, 200, { ok: Boolean(data?.reachable), data, error: r.ok ? null : r.text.slice(-500) })
    }

    /* ══════════ 记忆（长期偏好 / 工作台事实） ══════════ */
    if (req.method === 'GET' && path === '/memory') {
      try { return sendJson(res, 200, { ok: true, ...memory.snapshot() }) }
      catch (e) { return sendJson(res, 200, { ok: false, error: e?.message ?? String(e) }) }
    }
    if (req.method === 'POST' && path === '/memory/op') {
      const body = await readBody(req)
      let r
      if (Array.isArray(body.operations)) r = await memory.applyBatch(body.operations, { source: body.source || 'panel' })
      else r = await memory.apply(body, { source: body.source || 'panel' })
      log(`记忆操作：${Array.isArray(body.operations) ? 'batch' : `${body.target}.${body.action}`} → ${r.ok ? 'OK' : String(r.error || '').split('\n')[0]}`)
      return sendJson(res, 200, { ok: r.ok, error: r.error || null, result: r })
    }
    if (req.method === 'POST' && path === '/memory/pending/approve') {
      const body = await readBody(req)
      const r = await memory.approvePending(body.id)
      return sendJson(res, 200, { ok: r.ok, error: r.error || null, result: r })
    }
    if (req.method === 'POST' && path === '/memory/pending/discard') {
      const body = await readBody(req)
      return sendJson(res, 200, memory.discardPending(body.id))
    }
    if (req.method === 'POST' && path === '/memory/reflect') {
      const r = await runReflect({ force: true })
      log(r.ok ? `手动复盘完成：新记 ${r.added} 条` : `复盘未执行：${r.skipped || r.error || ''}`)
      return sendJson(res, 200, r)
    }
    if (req.method === 'GET' && path === '/memory/events') {
      const type = String(q.get('type') || '')
      const limit = Math.max(1, Math.min(Number(q.get('limit')) || 50, 200))
      return sendJson(res, 200, { ok: true, events: memory.listEvents({ type, limit }) })
    }

    return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${path}` })
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/bili-wb',
      handler: async (req, res) => {
        try { await handle(req, res, new URL(req.url, 'http://127.0.0.1')) } catch (e) {
          sendJson(res, 500, { ok: false, error: e?.message ?? String(e) })
        }
      },
    }), 'bili-workbench: /api/bili-wb 路由')
  } catch (e) {
    try { ctx.logger?.warn?.('[bili-workbench] 路由没挂上：' + String(e?.message ?? e)) } catch { /* ignore */ }
  }

  /* ── 自己的视频：启动时补一次缓存，之后每 6 小时看一次是否过期 ── */
  canon.ensureFresh()
    .then((st) => { if (st?.epCount) log(`自己的视频：${st.title} · ${st.epCount} 集`) })
    .catch(() => { /* 离线时用旧缓存 */ })
  try {
    setInterval(() => { canon.ensureFresh().catch(() => { /* 忽略 */ }) }, 6 * 3600_000)
  } catch { /* ignore */ }

  /* ── 主人 @ 任务：每分钟看一眼是否到点（频率可配置） ── */
  let ownerTaskRunning = false
  let ownerTaskLast = 0
  const ownerTick = async () => {
    try {
      const cfg = loadCfg()
      if (!cfg.ownerTasksEnabled || !cfg.ownerUid) return
      const every = Math.max(1, Number(cfg.ownerTaskPollMinutes) || 3) * 60_000
      if (Date.now() - ownerTaskLast < every) return
      if (ownerTaskRunning) return
      ownerTaskRunning = true
      ownerTaskLast = Date.now()
      const r = await runEngine('owner-task.mjs', ['--tick'], 15 * 60_000)
      if (!r.ok) log('主人 @ 任务失败：' + String(r.text || '').slice(-300))
      else {
        const m = /完成：处理 (\d+) 条/.exec(String(r.text || ''))
        if (m && Number(m[1]) > 0) log(`主人 @ 任务：处理 ${m[1]} 条`)
      }
    } catch (e) {
      log('主人 @ 任务异常：' + (e?.message ?? e))
    } finally {
      ownerTaskRunning = false
    }
  }
  setTimeout(ownerTick, 60_000)
  try { setInterval(ownerTick, 60_000) } catch { /* ignore */ }

  /* ── 采集定时器：按时段 + 每日上限平均分配，每分钟看一次 ── */
  try {
    const timer = setInterval(() => {
      try {
        const cfg = loadCfg()
        if (!cfg.enabled) return
        const prog = rangeProgress(cfg.scheduleRanges)
        if (!prog.inWindow || prog.total <= 0) return
        const target = targetToday(cfg)
        const done = collectedToday()
        if (done >= target) return
        if (roundRunning) return
        const sched = loadSched()
        const last = Date.parse(sched.lastRunAt || '') || 0
        // 上一轮一条新的都没采到（热门页重复），10 分钟内别反复打
        if (sched.lastAdded === 0 && Date.now() - last < 10 * 60_000) return
        const n = Math.min(target - done, 3)
        log(`定时器触发（目标 ${target} / 已采 ${done}，本轮 ${n}）`)
        runRound('timer', { count: n }).catch((e) => log('定时轮次异常：' + (e?.message ?? e)))
      } catch (e) {
        log('定时器这一跳出错（已兜住）：' + (e?.message ?? e))
      }
    }, 60_000)
    timer.unref?.()
    ctx.effect(() => () => clearInterval(timer), 'bili-workbench: 采集定时器')
  } catch (e) { log('采集定时器没起来：' + (e?.message ?? e)) }

  /* ── 自动回复：每 3 分钟看一次 feed replies（只回 is_new，账本防重复） ── */
  let replyRunning = false
  const autoReplyTick = async () => {
    try {
      const cfg = loadCfg()
      if (!cfg.autoReply) return
      if (replyRunning) return
      const done = interact.dayCounts().replies
      if (cfg.replyPerDay > 0 && done >= cfg.replyPerDay) return
      replyRunning = true
      const limit = cfg.replyPerDay > 0 ? Math.min(cfg.replyPerDay - done, 5) : 5
      const r = await runEngine('auto-reply.mjs', ['--limit', String(Math.max(1, limit))], 5 * 60_000)
      if (r.text) log('自动回复：' + r.text.slice(-500))
    } catch (e) {
      log('自动回复异常：' + (e?.message ?? e))
    } finally {
      replyRunning = false
    }
  }
  try {
    const kick = setTimeout(() => { autoReplyTick() }, 45_000)
    kick.unref?.()
    const replyTimer = setInterval(() => { autoReplyTick() }, 3 * 60_000)
    replyTimer.unref?.()
    ctx.effect(() => () => { clearTimeout(kick); clearInterval(replyTimer) }, 'bili-workbench: 自动回复定时器')
  } catch (e) { log('自动回复定时器没起来：' + (e?.message ?? e)) }

  /* ── 长任务：每 10 分钟看一次有没有到点的任务（一个任务一轮） ── */
  try {
    // 上次进程在任务中途退出：别让卡片永远卡在“逛B站中”
    for (const t of tasks.list()) {
      if (['checking', 'collecting', 'planning'].includes(t.status)) {
        tasks.update(t.id, { status: 'queued', nextRunAt: new Date().toISOString() })
        tasks.addLog(t.id, '宿主重启，任务已恢复排队')
      }
    }
    const taskKick = setTimeout(() => {
      if (!roundRunning && !taskRunning && tasks.due().length) kickTask()
    }, 20_000)
    taskKick.unref?.()
    const taskTimer = setInterval(() => {
      try {
        if (roundRunning || taskRunning) return
        if (tasks.due().length) kickTask()
      } catch (e) { log('长任务定时器这一跳出错：' + (e?.message ?? e)) }
    }, 10 * 60_000)
    taskTimer.unref?.()
    ctx.effect(() => () => { clearTimeout(taskKick); clearInterval(taskTimer) }, 'bili-workbench: 长任务定时器')
  } catch (e) { log('长任务定时器没起来：' + (e?.message ?? e)) }

  /* ── 重启恢复：上次渲染到一半被重启，项目别永远卡在「渲染中」 ── */
  try {
    // 老版本成片在 bili-op/runs（插件目录里，升级会被清）；先迁到素材库 renders/
    const moved = renders.migrateLegacyRuns()
    if (moved) log(`已迁移 ${moved} 个旧成片到素材库 renders/`)
    for (const p of plans.listProjects()) {
      if (p.legacy) continue
      if (p.stage === 'rendering') {
        const runId = p.runDir ? String(p.runDir).split(/[\\/]/).filter(Boolean).pop() : ''
        const st = runId ? renders.readStatus(runId) : null
        if (st?.stage === 'rendered' || st?.stage === 'approved' || st?.stage === 'published') p.stage = st.stage
        else p.stage = 'draft'
        plans.saveProject(p)
        log(`恢复项目 ${p.id} 状态 → ${p.stage}`)
      } else if (p.stage === 'rendered' && (!p.runDir || !existsSync(p.runDir))) {
        p.stage = 'draft'
        p.runDir = ''
        plans.saveProject(p)
        log(`项目 ${p.id} 的成片文件已不存在，状态改回草稿`)
      }
    }
  } catch (e) { log('项目状态恢复失败：' + (e?.message ?? e)) }

  log(`工作台已挂载（库=${STORE}）`)
  try { ctx.logger?.info?.('[bili-workbench] 已挂载（库=' + STORE + '）') } catch { /* ignore */ }
}

function runBiliName() {
  return process.platform === 'win32' ? 'bili.exe' : 'bili'
}
