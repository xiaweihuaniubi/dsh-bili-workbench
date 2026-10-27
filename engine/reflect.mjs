/**
 * reflect.mjs —— 任务后复盘（M2）：从经验事件流里提炼「跨次有效」的偏好/事实，
 * 自动写进 USER.md / MEMORY.md（只允许 add；去重、注入扫描、字符预算沿用 memory.mjs）。
 *
 *   node reflect.mjs --run          # 跑一次复盘（CLI 调试用）
 *   index.js 里：渲染完成 / 审核决定 / 真投稿后自动触发（30 分钟节流），面板可手动触发
 *
 * 防污染规则（写进模型提示 + 代码双重保障）：
 *   · 只记跨次有效的偏好和事实，一次性指令不记
 *   · 咕嘎人设/角色设定永不入记忆（企鹅、饼干、Doro……）
 *   · 普通用户的话不入记忆（事件流里只有主人指令和自己的行为）
 *   · 最多 3 条，每条 ≤60 字；没有值得记的就输出空数组
 */
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { STORE } from './store.mjs'
import { loadLLM } from './llmpath.mjs'
import * as memory from './memory.mjs'

const { chatJSON } = await loadLLM()
const REFLECT_MIN_GAP_MS = 30 * 60_000
const readJson = (f, dflt) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return dflt } }

const SYSTEM = `你是账号主人的记忆管家。你会看到这位账号主人最近的操作经历（事件流）和已有的长期记忆。
你的任务：从里面提炼「跨次有效」的偏好或事实，作为长期记忆的新条目。

必须遵守：
- 只记会反复生效的东西：主人的口味、纠正（"标题太长""换个风格"）、重复出现的习惯、任务失败的教训
- 一次性的指令不记（"这次用横屏"不记；"以后都用横屏"才记）
- 账号的角色设定/人设（比如企鹅、咕嘎、Doro 这类形象设定）永远不进记忆
- 密钥、UID、配置数字、路径不进记忆
- 已有记忆里已有的内容不要重复记
- 每条 ≤60 字，说人话；最多 3 条；没有值得记的就给空数组
- target 只能是 "user"（主人画像）或 "memory"（工作台事实）

只输出 JSON，不要解释，不要代码块围栏。`

function eventsToDigest(evs) {
  if (!evs.length) return '（还没有任何经历）'
  return evs.map((e) => `- ${(e.at || '').slice(0, 10)} ${String(e.text || '').slice(0, 80)}`).join('\n')
}

function entriesToDigest(entries) {
  if (!entries.length) return '（空）'
  return entries.map((e) => `- ${e}`).join('\n')
}

/* 进程内互斥：方案完成和渲染完成可能毫秒级先后触发两次复盘，
 * check-then-act 的节流拦不住并发，会双跑模型写重复条目（审查 BUG-4） */
let reflectInFlight = false

export async function runReflect({ force = false, source = 'reflect' } = {}) {
  const cfg = readJson(join(STORE, 'config.json'), {})
  if (cfg.memoryEnabled === false) return { ok: false, skipped: 'memoryEnabled 已关闭' }
  if (cfg.reflectEnabled === false && !force) return { ok: false, skipped: 'reflectEnabled 已关闭' }
  if (reflectInFlight) return { ok: false, skipped: '复盘正在进行中' }
  // 进程内调用也吃配置里的模型链（llm.mjs 每次调用动态读 env）
  if (Array.isArray(cfg.modelChain) && cfg.modelChain.length) {
    process.env.BILI_OP_MODELS = cfg.modelChain.join(',')
  }

  const state = memory.loadReflectState()
  if (!force && state.lastAt && Date.now() - Date.parse(state.lastAt) < REFLECT_MIN_GAP_MS) {
    return { ok: false, skipped: '距上次复盘不到 30 分钟' }
  }
  reflectInFlight = true
  try {
    return await runReflectInner(state, source)
  } finally {
    reflectInFlight = false
  }
}

async function runReflectInner(state, source) {
  const events = memory.listEvents({ limit: 40 })
  if (!events.length) return { ok: false, skipped: '还没有经历可复盘' }
  // 拿到执行权先占坑写 lastAt（跨进程 CLI 场景的乐观锁）
  memory.saveReflectState({ ...state, lastAt: new Date().toISOString() })

  const snap = memory.snapshot()

  const userDigest = `【主人画像（已有）】\n${entriesToDigest((snap.user?.entries || []).map((e) => e.text))}`
  const memDigest = `【工作台事实（已有）】\n${entriesToDigest((snap.memory?.entries || []).map((e) => e.text))}`
  const evDigest = `【最近的经历（新→旧）】\n${eventsToDigest(events)}`

  let json = null
  let model = ''
  try {
    const r = await chatJSON([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `${userDigest}\n\n${memDigest}\n\n${evDigest}\n\n请输出：\n{ "memories": [ { "target": "user" | "memory", "content": "≤60字的一条记忆" } ] }` },
    ], { maxTokens: 800, temperature: 0.2 })
    json = r.json
    model = r.model || ''
  } catch (e) {
    return { ok: false, error: `复盘模型失败：${String(e?.message ?? e).split('\n')[0]}` }
  }

  const list = Array.isArray(json?.memories) ? json.memories.slice(0, 3) : []
  const results = []
  for (const m of list) {
    const target = m?.target === 'user' ? 'user' : 'memory'
    const content = String(m?.content || '').trim().slice(0, 60)
    if (!content) continue
    // 角色设定兜底：提到咕嘎人设词的一律不写（模型偶尔不听话）
    if (/咕嘎|企鹅|小饼干|饼干|Doro|doro/.test(content)) { results.push({ content, skipped: '疑似角色设定' }); continue }
    const r = await memory.apply({ target, action: 'add', content }, { unattended: true, source })
    results.push({ content, target, ok: r.ok, deduped: !!r.deduped, error: r.error || '' })
  }

  const added = results.filter((r) => r.ok && !r.deduped).length
  memory.saveReflectState({
    lastAt: new Date().toISOString(),
    runs: (state.runs || 0) + 1,
    added: (state.added || 0) + added,
    lastModel: model,
    lastResult: results,
  })
  return { ok: true, model, added, results }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv.includes('--run')) {
  runReflect({ force: true })
    .then((r) => { console.log(JSON.stringify(r)); process.exit(r.ok || r.skipped ? 0 : 1) })
    .catch((e) => { console.error('复盘失败：' + (e?.message ?? e)); process.exit(1) })
}
