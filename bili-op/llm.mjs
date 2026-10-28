/**
 * llm.mjs —— 打我们自己的模型端点（40080，OpenAI 兼容）
 *
 * 规矩：
 *  · key 从环境变量读（OC_API_KEY 或 BILI_OP_LLM_KEY），**不写进源码**
 *  · 模型带失败自动轮换（第一个能用就一直用；报错就换下一个）
 *  · chatJSON 负责把"带 ``` 围栏 / 前后有废话"的输出抠成 JSON
 */

export const LLM_BASE = (process.env.BILI_OP_LLM_BASE || 'http://127.0.0.1:40080/v1').replace(/\/+$/, '')
/** 密钥每次调用动态解析：env 优先，兜底读素材库 config.json 的 llmKey。
 *  之前在 import 时冻结成 const，宿主进程内调用（复盘/语气改写）在「key 只存 config」的常规配置下永远拿不到（审查 BUG-3）。 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
function key() {
  const env = process.env.OC_API_KEY || process.env.BILI_OP_LLM_KEY
  if (env) return env
  const candidates = []
  if (process.env.BILI_STORE) candidates.push(join(process.env.BILI_STORE, 'config.json'))
  try {
    const loc = join(homedir(), '.dsh-bili-workbench', 'location.json')
    if (existsSync(loc)) {
      const saved = JSON.parse(readFileSync(loc, 'utf8'))
      const p = saved.storePath || saved.store
      if (p) candidates.push(join(p, 'config.json'))
    }
  } catch { /* location 坏了就走默认 */ }
  candidates.push(join(homedir(), '.dsh-bili-workbench', 'store', 'config.json'))
  for (const f of candidates) {
    try {
      if (!existsSync(f)) continue
      const k = String(JSON.parse(readFileSync(f, 'utf8')).llmKey || '').trim()
      if (k) return k
    } catch { /* 下一个 */ }
  }
  return ''
}
/** 模型链每次调用时读 env：进程内调用（reflect/语气改写）可能在启动后才设置 BILI_OP_MODELS */
export function models() {
  // 兜底链必须和 index.js 的 DEFAULT_CHAIN 一致（宿主没传 env 时才走这里）
  return (process.env.BILI_OP_MODELS || 'deepseek-v4.1-flash,big-pickle,glm-5.3-flash,jev-1.13,lobsterai/deepseek-flash,loomy/DeepSeek-V4.1-Flash')
    .split(',').map((s) => s.trim()).filter(Boolean)
}
let modelIdx = 0
export const currentModel = () => {
  const m = models()
  return m[((modelIdx % m.length) + m.length) % m.length]
}

export function assertKey() {
  const k = key()
  if (!k) {
    throw new Error(
      '没有模型密钥。设置环境变量 OC_API_KEY，或在工作台「刷B站 → 刷B站设置」里填模型密钥（存到 bili-store/config.json 的 llmKey）。例如：\n' +
      '  $env:OC_API_KEY="..."   # 只在当前终端生效',
    )
  }
}
export const currentKey = () => key()

/**
 * 一次对话。返回纯文本。
 * @param {{role:string,content:string}[]} messages
 */
export async function chat(messages, { maxTokens = 3000, temperature = 0.4, timeoutMs = 180000 } = {}, depth = 0) {
  assertKey()
  const list = models()
  if (!list.length) throw new Error('模型链是空的：在「刷B站 → 设置 → 模型链」里至少填一个模型')
  const KEY = key()
  const tried = []
  const waitMs = Number(process.env.BILI_OP_429_WAIT || 15000)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  for (let attempt = 0; attempt < list.length; attempt++) {
    const model = currentModel()
    // 每个模型最多试 2 次（429 限流时退避一次再试，别立刻放弃）
    for (let inner = 0; inner < 2; inner++) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeoutMs)
      try {
        const res = await fetch(`${process.env.BILI_OP_LLM_BASE || LLM_BASE}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
          body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
          signal: ctrl.signal,
        })
        if (!res.ok) {
          const t = await res.text().catch(() => '')
          const is429 = res.status === 429 || /rate_limit/i.test(t)
          if (is429 && inner === 0) {
            console.log(`  ${model} 限流，${Math.round(waitMs / 1000)} 秒后重试…`)
            clearTimeout(timer)
            await sleep(waitMs)
            continue
          }
          throw new Error(`HTTP ${res.status} ${t.slice(0, 160)}`)
        }
        const j = await res.json()
        const text = j?.choices?.[0]?.message?.content
        // ⚠️ 推理型模型会把 max_tokens 全花在 reasoning 上 ⇒ content 空。
        //    这不是"模型挂了"，是 token 给少了：加倍再试**一次**（depth 守卫：
        //    之前是无深度限制的递归，弱模型持续空回复会无限循环烧钱，审查 BUG-7）。
        if (!text || !String(text).trim()) {
          if (inner === 0 && depth < 1) {
            clearTimeout(timer)
            const bigger = Math.min(Math.max(maxTokens * 2, 6000), 16000)
            console.log(`  ${model} 空回复（reasoning 吃光 token）⇒ 加到 ${bigger} 再试`)
            return await chat(messages, { maxTokens: bigger, temperature, timeoutMs }, depth + 1)
          }
          throw new Error('空回复（可能 max_tokens 被 reasoning 吃光）')
        }
        return { text: String(text), model: j?.model || model, usage: j?.usage || null }
      } catch (e) {
        if (inner === 1 || !/空回复|429|rate_limit/i.test(String(e?.message ?? e))) {
          tried.push(`${model}: ${e?.message ?? e}`)
          modelIdx++
          break
        }
      } finally {
        clearTimeout(timer)
      }
    }
    if (attempt === list.length - 1) {
      throw new Error('所有模型都失败了：\n  ' + tried.join('\n  '))
    }
  }
  throw new Error('unreachable')
}

/** 抠 JSON：去掉 ``` 围栏，从第一个 { 或 [ 开始找配对的结尾 */
export function extractJson(text) {
  let t = String(text || '').trim()
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  const start = t.search(/[[{]/)
  if (start < 0) throw new Error('回复里没有 JSON：' + t.slice(0, 200))
  const openCh = t[start]
  const closeCh = openCh === '{' ? '}' : ']'
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < t.length; i++) {
    const ch = t[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === openCh) depth++
    else if (ch === closeCh) {
      depth--
      if (depth === 0) return JSON.parse(t.slice(start, i + 1))
    }
  }
  throw new Error('JSON 没闭合：' + t.slice(start, start + 200))
}

/** 要 JSON 的对话；解析失败会重试一次（把报错喂回去让它自己修） */
export async function chatJSON(messages, opts = {}) {
  const first = await chat(messages, opts)
  try {
    return { json: extractJson(first.text), model: first.model, raw: first.text, usage: first.usage }
  } catch (e) {
    const retry = await chat([
      ...messages,
      { role: 'assistant', content: first.text.slice(0, 4000) },
      { role: 'user', content: `上面那段不是合法 JSON（${e.message}）。请**只输出**合法 JSON，不要解释、不要代码块围栏。` },
    ], opts)
    return { json: extractJson(retry.text), model: retry.model, raw: retry.text, usage: retry.usage }
  }
}

/** 健康检查：能不能连上、哪些模型可用 */
export async function health() {
  const k = key()
  const out = { base: process.env.BILI_OP_LLM_BASE || LLM_BASE, hasKey: Boolean(k), models: models(), reachable: false, modelList: [] }
  try {
    const r = await fetch(`${process.env.BILI_OP_LLM_BASE || LLM_BASE}/models`, { headers: k ? { authorization: `Bearer ${k}` } : {} })
    out.reachable = r.ok
    if (r.ok) {
      const j = await r.json()
      out.modelList = (j?.data || []).map((m) => m.id)
    }
  } catch (e) { out.error = String(e?.message ?? e) }
  return out
}
