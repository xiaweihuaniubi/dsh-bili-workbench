/**
 * judge.mjs —— 判定 + 抽"可引用片段"（创作真正需要的粒度）
 *
 *   node judge.mjs                # 判定库里还没判过的
 *   node judge.mjs --refresh      # 全部重判
 *   node judge.mjs BV16DnN6KEUo
 *
 * 产出（写回 videos/<BV>.json）：
 *   judge:  { worth, tier, why, at, model }
 *   quotes: [{ t, text, kind }]   ← 带时间戳，能直接拿来当标题/金句/画面锚点
 *
 * 模型只做"判断"，不做工具调用 —— 便宜、快、不可能误发。
 */
import { readFileSync, existsSync } from 'node:fs'
import { get, put, list, paths } from './store.mjs'
import { loadLLM } from './llmpath.mjs'
import { addEvent } from './memory.mjs'

const { chatJSON, assertKey } = await loadLLM()

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt
}
const flag = (n) => process.argv.includes('--' + n)
const log = (s) => console.log(s)

const SYSTEM = `你是 B站 内容编辑。你的任务是判断一条视频"值不值得做成视频素材"，并从它的字幕里挑出"可以直接引用"的片段。
只输出 JSON，不要解释，不要代码块围栏。`

/** 人设只影响 why / quotes 的措辞，不影响判定标准 */
const persona = () => {
  const p = String(process.env.BILI_OP_PERSONA || '').trim()
  return p ? `\n\n【人设 / 口径】${p}\n点评和挑句都按这个人设说话。` : ''
}

function buildPrompt(rec) {
  const dur = Number(rec.duration) || 0
  // ⚠️ record 里只存了 items 的**条数**；逐字稿本体在 subs/<BV>.json，得单独读
  let items = []
  try {
    const f = paths(rec.bvid).subs
    if (existsSync(f)) items = JSON.parse(readFileSync(f, 'utf8')).items || []
  } catch { items = [] }
  const lines = items.slice(0, 400).map((x) => `[${Math.round(x.from)}] ${x.content}`).join('\n').slice(0, 7000)
  const danmaku = (rec.hotDanmaku || []).slice(0, 10).map((x) => `- ${x.text}（${x.count || 1} 次）`).join('\n')
  const comments = (rec.hotComments || []).slice(0, 6).map((x) => `- ${x.text}（${x.like || 0} 赞）`).join('\n')
  return `视频：${rec.title}
UP：${rec.up?.name || '?'}   时长：${Math.round(dur / 60)} 分 ${dur % 60} 秒
${rec.stat ? `播放 ${rec.stat.view} · 点赞 ${rec.stat.like} · 评论 ${rec.stat.reply}` : ''}
${rec.reason ? `平台推荐理由：${rec.reason}` : ''}

字幕（每行前面是起始秒数）：
${lines || '（这条视频没有字幕）'}

热门弹幕（按出现频率，可能包含最新梗）：
${danmaku || '（没有弹幕）'}

热评（按点赞）：
${comments || '（没有热评）'}

请判断并输出：
{
  "worth": true/false,                     // 值得拿来当素材吗（有信息量/有看点，不是纯娱乐水视频）
  "tier": "值得看" | "可以看" | "跳过",
  "why": "一句话说清为什么（20 字内、说人话）",
  "quotes": [                              // 2–4 条能直接用的片段；没有字幕就空数组
    { "t": 42, "text": "字幕里的原文，30 字内，一字不改", "kind": "金句" | "数据" | "转折" | "争议" }
  ],
  "memes": ["从弹幕/热评里提炼的热梗或高频说法，2–4 个；没有就空数组"]
}`
}

async function judgeOne(rec) {
  const { json, model } = await chatJSON(
    [{ role: 'system', content: SYSTEM + persona() }, { role: 'user', content: buildPrompt(rec) }],
    { maxTokens: 2000, temperature: 0.3 },
  )
  const dur = Number(rec.duration) || 0
  const quotes = (Array.isArray(json.quotes) ? json.quotes : [])
    .map((q) => ({
      t: Math.max(0, Math.min(Number(q.t) || 0, dur || 1e6)),
      text: String(q.text || '').trim().slice(0, 60),
      kind: String(q.kind || '').slice(0, 6),
    }))
    .filter((q) => q.text)

  rec.judge = {
    worth: json.worth !== false,
    tier: ['值得看', '可以看', '跳过'].includes(json.tier) ? json.tier : (json.worth === false ? '跳过' : '可以看'),
    why: String(json.why || '').slice(0, 60),
    at: new Date().toISOString(),
    model,
  }
  rec.quotes = quotes
  rec.memes = (Array.isArray(json.memes) ? json.memes : [])
    .map((m) => String(typeof m === 'string' ? m : (m?.text || '')).trim())
    .filter(Boolean)
    .slice(0, 4)
    .map((s) => s.slice(0, 20))
  put(rec)
  addEvent('watched', {
    bv: rec.bvid,
    text: `看过《${String(rec.title).slice(0, 30)}》（${rec.up?.name || '?'}）：${rec.judge.tier}，${rec.judge.why}${quotes.length ? `，可用片段 ${quotes.length} 条` : ''}`,
  })
  return rec
}

async function main() {
  assertKey()
  const refresh = flag('refresh')
  const only = process.argv.slice(2).filter((a) => /^BV[0-9A-Za-z]{10}$/.test(a))

  let targets = only.length
    ? only.map((bv) => get(bv)).filter(Boolean)
    : list({ limit: 100 })
  if (!refresh) targets = targets.filter((r) => !r.judge)

  if (!targets.length) { log('没有需要判定的（都判过了，用 --refresh 重判）'); return }
  log(`待判定 ${targets.length} 条\n`)

  for (const rec of targets) {
    const t0 = Date.now()
    try {
      const done = await judgeOne(rec)
      const q = done.quotes.map((x) => `${x.t}s「${x.text.slice(0, 18)}」`).join(' / ') || '无'
      log(`  ✓ ${done.bvid} [${done.judge.tier}] ${done.judge.why}`)
      log(`     金句：${q}   (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
      log(`     热梗：${(done.memes || []).join(' / ') || '无'}`)
    } catch (e) {
      log(`  ✗ ${rec.bvid} ${String(e?.message ?? e).split('\n')[0]}`)
    }
  }
}

main().catch((e) => { console.error('失败：' + (e?.message ?? e)); process.exit(1) })
