/**
 * task.mjs —— 长任务：素材不够就自己去 B站 逛，够料再写方案
 *
 *   node task.mjs --create "找找素材，出一期新三国的名场面的热梗集锦"
 *   node task.mjs --tick                 # 跑一个到点的任务
 *   node task.mjs --tick --id t-xxx      # 指定任务
 *   node task.mjs --create "…" --check   # 只拆词 + 查库，不采集、不写方案
 *   node task.mjs --pause t-xxx | --resume t-xxx | --delete t-xxx | --list
 *
 * 一轮做什么：
 *   ① 把一句话拆成 topic / kind / keywords（模型；失败退化为本地拆词）
 *   ② 在素材库里按关键词找“相关且可用”的视频
 *   ③ 不够 → 逛 B站（collect --search）→ judge → 再查
 *   ④ 够了 → plan.mjs（只喂相关 BV）→ 落成项目，状态变 ready
 *
 * 状态：queued / checking / collecting / short / planning / ready / failed / paused
 * 默认 5 天到期，每 3 小时找一轮；不会自动渲染、不会自动投稿。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { list, STORE } from './store.mjs'
import { createProject } from './planstore.mjs'
import { creativeOptions, STYLE_NAMES } from './creative.mjs'
import * as tasks from './taskstore.mjs'
import { loadLLM } from './llmpath.mjs'
import * as canon from './canon.mjs'
import * as memory from './memory.mjs'

const { chatJSON } = await loadLLM()
const HERE = dirname(fileURLToPath(import.meta.url))
const log = (s) => console.log(s)
const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt
}
const flag = (n) => process.argv.includes('--' + n)
const nowIso = () => new Date().toISOString()
const readJson = (f, dflt) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return dflt } }

function runNode(script, args, timeout = 10 * 60_000) {
  const r = spawnSync(process.execPath, [join(HERE, script), ...args], {
    encoding: 'utf8', timeout, env: process.env, maxBuffer: 20 * 1024 * 1024,
  })
  const text = `${r.stdout || ''}${r.stderr || ''}`.trim()
  return { ok: r.status === 0, status: r.status, text }
}

/* ───────────── ① 一句话 → 选题 / 关键词 ───────────── */

const SPLIT_SYSTEM = `你是 B站 选题助理。用户会说一句想做视频的需求，你要把它拆成可执行的检索条件。
只输出 JSON，不要解释，不要代码块围栏。`

function fallbackKeywords(brief) {
  const cleaned = String(brief || '')
    .replace(/[，。！？、,.!?；;：:“”"'（）()【】\[\]]/g, ' ')
    .replace(/找找|找一下|帮我|给我|能不能|可以|想要|想做|做一期|出一期|来一期|出一期|一期|素材|视频|集锦|合集|盘点|一下|看看|关于|的|了/g, ' ')
  const terms = cleaned.split(/\s+/).filter((x) => x.length >= 2 && x.length <= 12)
  const out = []
  for (const t of terms) if (!out.includes(t)) out.push(t)
  return out.slice(0, 6)
}

async function extractTopic(task) {
  let topic = ''
  let kind = ''
  let keywords = []
  try {
    const { json } = await chatJSON([
      { role: 'system', content: SPLIT_SYSTEM },
      {
        role: 'user',
        content: `创作形式：${STYLE_NAMES[task.style] || "原方案"}；补充要求：${task.customStyle || "无"}
用户需求：${task.brief}

请输出：
{
  "topic": "这期讲什么（≤16字）",
  "kind": "热梗集锦" | "资讯盘点" | "实测" | "解说" | "剧情向" | "其他",
  "keywords": ["用于 B站 搜索的关键词，3–6 个，每个 2–8 字，按重要性排序，不要空格"]
}

要求：keywords 要能搜到具体视频；不要写「素材」「视频」「集锦」这种泛词，除非它就是主题。`,
      },
    ], { maxTokens: 700, temperature: 0.2 })
    topic = String(json?.topic || '').trim().slice(0, 24)
    kind = String(json?.kind || '').trim().slice(0, 12)
    keywords = (Array.isArray(json?.keywords) ? json.keywords : [])
      .map((k) => String(k || '').replace(/\s+/g, '').trim())
      .filter((k) => k.length >= 2 && k.length <= 12)
  } catch (e) {
    log(`拆词模型失败，用本地拆词：${String(e?.message ?? e).split('\n')[0]}`)
  }
  if (!keywords.length) keywords = fallbackKeywords(task.brief)
  const uniq = [...new Set(keywords)].slice(0, 6)
  if (!topic) topic = uniq.slice(0, 2).join('·') || '未命名选题'
  return { topic, kind, keywords: uniq }
}

function buildQueries(task) {
  const qs = []
  const kw = task.keywords || []
  const add = (s) => { const v = String(s || '').replace(/\s+/g, ' ').trim(); if (v && !qs.includes(v)) qs.push(v) }
  if (kw.length) add([kw[0], kw[1], kw[2]].filter(Boolean).join(' '))
  for (const k of kw.slice(0, 4)) add(k)
  if (kw.length >= 2) {
    add(`${kw[0]} ${kw[1]}`)
    add(`${kw[0]} ${task.kind || ''}`)
  }
  add(task.topic)
  return qs.slice(0, 10)
}

/* ───────────── ② 素材库匹配 ───────────── */

/** 关键词拆成核心词：新三国名场面 → 新三国 / 名场面 */
const SPLIT_WORDS = ['名场面', '名梗', '热梗', '玩梗', '台词', '鬼畜', '搞笑', '片段', '集锦', '盘点', '解说', '测评', '实测', '剧情', '人物', '角色', '梗']
function atomsOf(k) {
  const s = String(k || '').replace(/\s+/g, '').trim()
  if (s.length < 2) return []
  const out = new Set([s])
  for (const w of SPLIT_WORDS) {
    if (s === w || !s.includes(w)) continue
    out.add(w)
    const rest = s.split(w).join('').trim()
    if (rest.length >= 2) out.add(rest)
    if (rest.length >= 5) { out.add(rest.slice(0, 3)); out.add(rest.slice(-3)) }
  }
  if (s.length >= 5) { out.add(s.slice(0, 3)); out.add(s.slice(-3)) }
  return [...out].filter((x) => x.length >= 2 && x.length <= 12)
}

function termsOf(task) {
  const out = new Set()
  for (const k of task.keywords || []) {
    for (const a of atomsOf(k)) out.add(a)
  }
  for (const a of atomsOf(task.topic)) out.add(a)
  return [...out]
}

const usable = (r) => (r?.subtitle?.chars || 0) > 0 || (Array.isArray(r?.quotes) && r.quotes.length > 0)

function scoreRecord(rec, terms) {
  const title = String(rec.title || '')
  const quotes = (rec.quotes || []).map((q) => q.text || '').join(' ')
  const memes = [
    ...(rec.memes || []),
    ...((rec.hotComments || []).map((x) => x.text || '')),
    ...((rec.hotDanmaku || []).map((x) => x.text || '')),
  ].join(' ')
  const summary = String(rec.aiSummary || '')
  let score = 0
  for (const t of terms) {
    if (title.includes(t)) score += 4
    if (quotes.includes(t)) score += 2
    if (memes.includes(t)) score += 2
    if (summary.includes(t)) score += 1
  }
  return score
}

function findMaterial(task) {
  const terms = termsOf(task)
  if (!terms.length) return []
  return list({ limit: 2000 })
    .filter(usable)
    .map((r) => ({ rec: r, score: scoreRecord(r, terms) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 40)
}

function snapshot(task, found) {
  return {
    matched: found.length,
    matchedBvs: found.slice(0, 40).map((x) => x.rec.bvid),
  }
}

/* ───────────── ③ 写方案 ───────────── */

function writePlan(task, found) {
  const tmp = join(STORE, 'tmp', `.tmp-task-${task.id}-${Date.now()}.json`)
  mkdirSync(join(STORE, 'tmp'), { recursive: true })
  const bvs = found.slice(0, 40).map((x) => x.rec.bvid).join(',')
  log(`素材够了（${found.length} 条），开始写方案…`)
  process.env.BILI_OP_SELF_VIDEOS = canon.renderBlock(task.brief || task.topic || '', { picks: 3 })
  // 经历召回：把「前两天看过的/做过的」按题材想起来，喂给方案生成
  const recall = memory.renderRecallBlock(`${task.brief || ''} ${task.topic || ''}`, { k: 6 })
  process.env.BILI_OP_MEMORY_QUERY = task.brief || task.topic || ''
  if (recall) {
    const n = recall.split('\n').filter((l) => l.startsWith('- ')).length
    tasks.addLog(task.id, `想起 ${n} 条相关经历，已带给方案生成`)
    log(`想起 ${n} 条相关经历`)
  }
  const creative = creativeOptions(task)
  const r = runNode('plan.mjs', [task.brief, '--out', tmp, '--limit', '40', '--bvs', bvs, '--style', creative.style, '--custom-style', creative.customStyle], 10 * 60_000)
  const plan = readJson(tmp, null)
  try { unlinkSync(tmp) } catch { /* 已删 */ }
  if (!r.ok || !plan) {
    const why = String(r.text || '').split('\n').filter(Boolean).slice(-3).join(' / ').slice(0, 200)
    return { ok: false, error: why || '方案生成失败' }
  }
  const project = createProject(plan, { brief: task.brief })
  return { ok: true, project, plan }
}

/* ───────────── ④ 跑一轮 ───────────── */

async function runTask(task, { checkOnly = false } = {}) {
  if (!task) return
  const cfg = readJson(join(STORE, 'config.json'), {})
  const id = task.id
  // 每次写状态前复检：主人可能刚点了暂停，别把 paused 覆盖掉
  const pausedNow = () => {
    const cur = tasks.get(id)
    if (!cur || cur.status === 'paused') { log('任务已被暂停，停止本轮'); return true }
    return false
  }
  const deadline = Date.parse(task.deadline || '')
  if (Number.isFinite(deadline) && Date.now() > deadline && task.status !== 'ready') {
    tasks.update(id, { status: 'failed', lastError: `${task.maxDays || 5} 天内没凑够素材` })
    tasks.addLog(id, `到期：${task.maxDays || 5} 天内没凑够素材，任务停止`)
    memory.addEvent('task', { id, text: `任务「${String(task.brief).slice(0, 30)}」${task.maxDays || 5} 天没凑够素材，已停止` })
    log(`任务 ${id} 到期，未凑够素材`)
    return
  }

  if (pausedNow()) return
  tasks.update(id, { status: 'checking', attempts: (task.attempts || 0) + 1, lastError: '' })
  tasks.addLog(id, checkOnly ? '检查素材库' : '检查素材库…')
  task = tasks.get(id)

  if (!task.keywords?.length) {
    const meta = await extractTopic(task)
    task = tasks.update(id, { ...meta, queries: buildQueries({ ...task, ...meta }) })
    tasks.addLog(id, `选题「${meta.topic}」· 关键词 ${meta.keywords.join(' / ') || '无'}`)
    log(`拆词：${meta.topic} | ${meta.keywords.join(' / ')}`)
  }

  let found = findMaterial(task)
  tasks.update(id, snapshot(task, found))
  log(`库里相关且可用：${found.length} 条（需要 ${task.needed} 条）`)

  if (found.length >= task.needed) {
    if (pausedNow()) return
    tasks.update(id, { status: 'planning' })
    tasks.addLog(id, `素材够了（${found.length} 条），开始写方案`)
    let r
    try { r = writePlan(task, found) } catch (e) { r = { ok: false, error: String(e?.message ?? e) } }
    if (r.ok) {
      if (pausedNow()) return
      tasks.update(id, {
        status: 'ready', projectId: r.project.id, planTitle: r.plan.title || r.project.title,
        matched: found.length, nextRunAt: '',
      })
      tasks.addLog(id, `方案已生成：${r.plan.title}`)
      log(`✓ 任务 ${id} 方案已生成：${r.project.id} / ${r.plan.title}`)
    } else {
      if (pausedNow()) return
      tasks.update(id, {
        status: 'queued', lastError: r.error,
        nextRunAt: new Date(Date.now() + task.intervalMinutes * 60_000).toISOString(),
      })
      tasks.addLog(id, `写方案失败，稍后重试：${r.error}`)
      log(`✗ 写方案失败：${r.error}`)
    }
    return
  }

  if (checkOnly) {
    if (pausedNow()) return
    tasks.update(id, {
      status: 'short', lastError: '素材不足',
      nextRunAt: new Date(Date.now() + task.intervalMinutes * 60_000).toISOString(),
    })
    tasks.addLog(id, `素材不足（${found.length}/${task.needed}）`)
    return
  }

  // 不够 → 逛 B站
  if (pausedNow()) return
  tasks.update(id, { status: 'collecting' })
  const queries = task.queries?.length ? task.queries : buildQueries(task)
  const rounds = Math.min(2, Math.max(1, queries.length - (task.queryIdx || 0)))
  const frameCount = Math.max(2, Math.min(Number(cfg.frameCount) || 6, 6))
  let qIdx = task.queryIdx || 0

  for (let i = 0; i < rounds; i++) {
    if (pausedNow()) return
    const q = queries[qIdx % queries.length]
    qIdx = (qIdx + 1) % queries.length
    tasks.update(id, { queryIdx: qIdx })
    tasks.addLog(id, `逛B站：搜索「${q}」`)
    log(`逛B站：搜索「${q}」`)
    const c = runNode('collect.mjs', [
      '--search', q, '--size', '6', '--max-new', '3', '--frames', String(frameCount),
    ], 8 * 60_000)
    const tail = String(c.text || '').split('\n').filter(Boolean).slice(-2).join(' / ').slice(0, 200)
    tasks.addLog(id, c.ok ? `搜索完成：${tail}` : `搜索失败：${tail}`)
    if (!c.ok) log(`采集失败：${tail}`)
  }

  log('判定新素材…')
  const j = runNode('judge.mjs', [], 8 * 60_000)
  if (!j.ok) {
    const tail = String(j.text || '').split('\n').filter(Boolean).slice(-2).join(' / ').slice(0, 160)
    tasks.addLog(id, `判定失败：${tail}`)
  }

  found = findMaterial(task)
  if (pausedNow()) return
  const snap = snapshot(task, found)
  const enough = found.length >= task.needed
  tasks.update(id, {
    ...snap,
    status: enough ? 'planning' : 'short',
    lastError: enough ? '' : `素材不足（${found.length}/${task.needed}）`,
    nextRunAt: enough ? nowIso() : new Date(Date.now() + task.intervalMinutes * 60_000).toISOString(),
  })
  tasks.addLog(id, enough ? `找到 ${found.length} 条，准备写方案` : `素材不足（${found.length}/${task.needed}），${Math.round(task.intervalMinutes / 60)} 小时后再找`)
  log(`本轮结束：相关 ${found.length}/${task.needed}`)

  if (enough) {
    const again = tasks.get(id)
    if (again) await runTask(again, { checkOnly: false })
  }
}

/* ───────────── ⑤ CLI ───────────── */

async function main() {
  const createBrief = arg('create', '')
  const id = arg('id', '')
  const pause = arg('pause', '')
  const resume = arg('resume', '')
  const del = arg('delete', '')

  if (flag('list')) {
    const rows = tasks.list()
    if (!rows.length) { log('没有任务'); return }
    for (const t of rows) {
      log(`${t.id}  [${t.status}]  ${t.topic || t.brief}`)
      log(`   素材 ${t.matched}/${t.needed} · 第 ${t.attempts} 轮 · ${t.planTitle ? '方案：' + t.planTitle : (t.lastError || '')}`)
    }
    return
  }
  if (pause) { tasks.update(pause, { status: 'paused' }); tasks.addLog(pause, '已暂停'); log('已暂停'); return }
  if (resume) {
    tasks.update(resume, { status: 'queued', nextRunAt: nowIso(), lastError: '' })
    tasks.addLog(resume, '已继续')
    log('已继续')
    return
  }
  if (del) { log(tasks.remove(del) ? '已删除' : '没找到这个任务'); return }

  if (createBrief) {
    const task = tasks.create({ brief: createBrief, style: arg('style', 'A'), customStyle: arg('custom-style', ''), maxDays: Number(arg('days', 5)) || 5, intervalMinutes: Number(arg('interval', 180)) || 180 })
    log(`新任务 ${task.id}：${task.brief}`)
    if (flag('check')) {
      await runTask(task, { checkOnly: true })
    } else if (!flag('no-run')) {
      await runTask(task)
    }
    return
  }

  if (flag('tick')) {
    let task = id ? tasks.get(id) : tasks.due()[0]
    if (!task) { log('没有到点的任务'); return }
    if (['ready', 'failed', 'paused'].includes(task.status)) { log(`任务 ${task.id} 状态 ${task.status}，跳过`); return }
    await runTask(task, { checkOnly: flag('check') })
    return
  }

  log('用法：node task.mjs --create "…" [--check] [--no-run] | --tick [--id t-xxx] | --list | --pause/--resume/--delete t-xxx')
}

main().catch((e) => { console.error('失败：' + (e?.message ?? e)); process.exit(1) })
