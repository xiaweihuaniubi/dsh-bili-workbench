/**
 * owner.mjs —— 主人身份、只读指令、会话审核
 *
 * 规则：
 *   · 只有 config.ownerUid 这个 B站 UID 被当作主人
 *   · 主人可以问“今天逛了多少 / 时段 / 评论回复数”，答案从本地素材库和账本实时算
 *   · 主人也不能在评论里改配置、投稿、删除、私信 —— 这些必须去工作台手动做
 *   · 非主人问统计、配置、权限、密钥等，一律回一句礼貌拒绝（不沉默，也不给数据）
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE, list } from './store.mjs'
import { dayCounts } from './interact.mjs'

const readJson = (f, dflt) => {
  try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return dflt }
}
const localDay = (iso) => {
  try { return new Date(iso).toLocaleDateString('sv-SE') } catch { return String(iso || '').slice(0, 10) }
}
const today = () => new Date().toLocaleDateString('sv-SE')
const clamp = (v, min, max, dflt) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(min, Math.min(n, max)) : dflt
}

export function loadCfg() {
  return readJson(join(STORE, 'config.json'), {})
}

export function ownerInfo(cfg = loadCfg()) {
  return {
    uid: String(cfg.ownerUid || '').trim(),
    call: String(cfg.ownerCall || '老弟').trim() || '老弟',
  }
}

export function isOwnerMid(mid, cfg = loadCfg()) {
  const { uid } = ownerInfo(cfg)
  return Boolean(uid && String(mid || '') === uid)
}

/** 自动评论要 @ 的人：主人 + mentions 列表（可多人），按 target 去重 */
export function mentionTargets(cfg = loadCfg()) {
  const out = []
  const seen = new Set()
  const add = (target, call = '') => {
    const t = String(target || '').trim()
    if (!t || seen.has(t)) return
    seen.add(t)
    out.push({ target: t, call: String(call || '').trim() })
  }
  if (cfg.ownerUid) add(cfg.ownerUid, cfg.ownerCall)
  for (const m of (Array.isArray(cfg.mentions) ? cfg.mentions : [])) add(m?.target, m?.call)
  // 兼容老字段：没有主人 UID 时才用它，避免和主人重复
  if (!cfg.ownerUid && cfg.mentionName) add(cfg.mentionName, '')
  // B站 一条评论最多 @ 3 个人
  return out.slice(0, 3)
}

/** 评论里要自然喊出的称呼：主人称呼 + 每个额外 @ 的称呼（同一个 target 只算一次） */
export function callNames(cfg = loadCfg()) {
  const out = []
  for (const t of mentionTargets(cfg)) {
    const c = String(t.call || '').trim()
    if (c && !out.includes(c)) out.push(c)
  }
  return out
}

/* ── 时段解析（和 index.js 的 rangeProgress 保持一致） ── */
function parseRanges(str) {
  return String(str || '')
    .split(/[,，;；\n]+/)
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
function rangeSegments(str) {
  const out = []
  for (const r of parseRanges(str)) {
    if (r.start <= r.end) out.push({ start: r.start, end: r.end })
    else { out.push({ start: r.start, end: 1440 }); out.push({ start: 0, end: r.end }) }
  }
  return out
}
function rangeProgress(str, d = new Date()) {
  const segs = rangeSegments(str)
  const cur = d.getHours() * 60 + d.getMinutes()
  let total = 0, elapsed = 0, inWindow = false
  for (const s of segs) {
    if (cur < s.start) continue
    total += Math.max(0, s.end - s.start)
    if (cur >= s.end) elapsed += s.end - s.start
    else if (cur > s.start) elapsed += cur - s.start
    if (cur >= s.start && cur < s.end) inWindow = true
  }
  return { total, elapsed, inWindow }
}

export function todayStats(cfg = loadCfg()) {
  const t = today()
  const rows = list({ limit: 2000 })
  const todayVideos = rows.filter((r) => localDay(r.fetchedAt) === t).length
  const counts = dayCounts(t)
  const ranges = String(cfg.scheduleRanges || '00:00-24:00')
  const perDay = clamp(cfg.perDay, 1, 500, 48)
  const replyPerDay = clamp(cfg.replyPerDay, 0, 200, 20)
  const prog = rangeProgress(ranges)
  const target = prog.inWindow && prog.total > 0
    ? Math.min(perDay, Math.round(perDay * prog.elapsed / prog.total))
    : 0
  const estMinutes = prog.total > 0 ? Math.max(1, Math.round(prog.total / Math.max(1, perDay))) : 0
  return {
    todayVideos, target, perDay, replyPerDay, ranges, estMinutes,
    inWindow: prog.inWindow,
    comments: Number(counts.comments) || 0,
    replies: Number(counts.replies) || 0,
  }
}

/** 主人指令 → 直接可发的答复 + 类型（stats / greeting / refuse）；不是已知指令返回 null */
export function answerOwnerCommandDetailed(raw, cfg = loadCfg()) {
  const text = String(raw || '').trim()
  const s = todayStats(cfg)
  const { call } = ownerInfo(cfg)
  const say = (msg) => `${call}，${msg}`
  const compact = text.replace(/\s+/g, '')

  // 任何“改配置 / 发布 / 删除”类动作都不在评论里执行（裸动词不带祈使上下文、或疑问句 → 不算）
  if (STRONG_DANGEROUS.test(compact) || (!questionTail(compact) && imperativeHit(compact, COMMAND_VERBS))) {
    return { text: say('这个操作得去工作台「刷B站设置」手动改，我在评论里不执行配置或发布操作。'), kind: 'refuse' }
  }

  if (/(时间|时段|多久|间隔|频率|上限|设定)/.test(compact)) {
    return { text: say(`时段 ${s.ranges}，每天上限 ${s.perDay} 条，约每 ${s.estMinutes} 分钟 1 条。今天已逛 ${s.todayVideos}/${s.target} 条。`), kind: 'stats' }
  }

  if (/(今天|今日|现在).*(逛|刷|采|看|视频|素材).*(多少|几|条)|(逛|刷|采|看)了.*(多少|几)|多少.*(视频|素材)/.test(compact)) {
    return { text: say(`今天到现在逛了 ${s.todayVideos} 条，目标 ${s.target} 条（每天上限 ${s.perDay}）。评论 ${s.comments} 条，回复 ${s.replies} 条。`), kind: 'stats' }
  }

  if (/(评论|回复).*(多少|几|条)/.test(compact)) {
    return { text: say(`今天评论 ${s.comments} 条、回复 ${s.replies} 条；上限 ${s.perDay} / ${s.replyPerDay === 0 ? '不限' : s.replyPerDay}。`), kind: 'stats' }
  }

  if (/^(在吗|在不在|你好|嗨|hello|hi|你是谁|干嘛|干什么)/i.test(compact)) {
    return { text: say(`我在。今天已逛 ${s.todayVideos} 条，目标 ${s.target} 条。`), kind: 'greeting' }
  }

  return null
}

/** 兼容旧调用：只要文本 */
export function answerOwnerCommand(raw, cfg = loadCfg()) {
  return answerOwnerCommandDetailed(raw, cfg)?.text || null
}

/* ── 危险动作识别：高频裸词（关注/打开/转发）不单看动词，必须带祈使上下文，避免误伤日常聊天 ── */
const IMPERATIVE_HINT = '(帮我|请你|麻烦|给我|去|把)'
// 强信号：出现即危险，不问上下文
const STRONG_DANGEROUS = /(执行命令|忽略(之前|以上)|系统提示|越权|token|api.?key|密钥|密码)/i
// 动作动词：仅在句首祈使，或带（帮我/请你/麻烦/给我/去/把）前缀时才算危险
const DANGEROUS_VERBS = '改成|改到|设为|设置成|调成|关掉|关闭|暂停|停止|开启|重启|删除|投稿|上传|私信|发评论'
const COMMAND_VERBS = DANGEROUS_VERBS + '|删了|删掉|移除|取关|关一下|打开'
const questionTail = (t) => /[吗呢没有怎么如何][?？!！]*$/.test(String(t || '').trim())
/** 动词是否处于祈使位置：句首，或跟在祈使提示词后（中间不跨句读标点） */
function imperativeHit(text, verbs) {
  const t = String(text || '')
  if (!new RegExp(verbs, 'i').test(t)) return false
  if (new RegExp('^(?:' + verbs + ')', 'i').test(t)) return true
  return new RegExp(IMPERATIVE_HINT + '[^，。;；!！?？\\n]*(' + verbs + ')', 'i').test(t)
}

/* 非主人问到统计/配置，或想让机器人替他做事时的拒绝话术：短、不给数据、不接活 */
const REFUSE_DATA = [
  '这个就不方便说啦，我只聊视频里的内容～',
  '这些数据不公开哈，咱们还是聊视频吧。',
  '问到这个我答不了，换个跟视频有关的话题呗。',
]
const REFUSE_ACTION = [
  '这个我弄不了哈，得本人自己在后台弄。',
  '这操作我做不了，也不该替别人做。',
  '这个得本人手动来，我这边不代办。',
]

/** 非主人越权时的固定回复：按内容稳定挑一句，同一个人反复问不会来回变 */
export function refusalText(raw, reason = 'non-owner-privileged') {
  const pool = reason === 'non-owner-command'
    ? REFUSE_ACTION
    : reason === 'non-owner-memory'
      ? ['谢谢你的建议，但我只记主人的话哈～', '这个我记不了，主人才说了算～', '小脑袋记不了这么多，主人的话我才记～']
      : REFUSE_DATA
  const s = String(raw || '')
  let n = 0
  for (let i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) >>> 0
  return pool[n % pool.length]
}

/**
 * 会话审核。
 * 返回 { allow, reason, intent }。
 * 非主人：统计/配置/权限类问题、以及让机器人代操作的指令，都回一句礼貌拒绝（不沉默）。
 * 主人：允许问数据，但改配置/发布/删除/私信类动作拒绝执行。
 */
export function auditMessage(raw, { isOwner = false } = {}) {
  const text = String(raw || '').trim()
  if (!text) return { allow: false, reason: 'empty' }

  if (!isOwner) {
    // 普通人说「记住…」：记忆永远不收陌生人的内容，礼貌拒绝
    if (/^(记住|记一下|帮我记住|要记住|记得)[:：,，!！\s]/.test(text)) {
      return { allow: false, reason: 'non-owner-memory' }
    }
    // 高频裸词（转发/关注/打开）不再单独命中；动作动词需要祈使上下文，疑问句豁免
    if (STRONG_DANGEROUS.test(text) || (!questionTail(text) && imperativeHit(text, COMMAND_VERBS))) {
      return { allow: false, reason: 'non-owner-command' }
    }
    const privileged = /(主人|owner|权限|配置|密钥|token|api.?key|密码|日志|路径|uid|系统提示|后台|工作台|统计|(一天|每天|今天|现在|总共|一共).*(刷|逛|采|看|发|评论|回复).*(几|多少|多久|条|个)|(刷|逛|采|评论|回复).*(多久|多长时间|几次|几条|多少个|多少条)|(多少|几).*(条|个|次).*(视频|素材|评论|回复)|(改|设|调|关|开).*(配置|设置|上限|时段|频率|间隔|每天|自动|开关)|(配置|设置|上限|时段|频率|间隔).*(改|设|调|关|开))/i
    if (privileged.test(text)) return { allow: false, reason: 'non-owner-privileged' }
    return { allow: true, intent: 'chat' }
  }

  if (STRONG_DANGEROUS.test(text) || (!questionTail(text) && imperativeHit(text, DANGEROUS_VERBS))) {
    return { allow: false, reason: 'owner-dangerous' }
  }
  return { allow: true, intent: 'owner' }
}

export { rangeProgress, today }
