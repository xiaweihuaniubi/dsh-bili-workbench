/**
 * plan.mjs —— 给一句"我想做什么样的片子"，让它自己从素材库里找料并出方案
 *
 *   node plan.mjs "想做什么" --style A|B|C [--custom-style "自定义要求"] [--limit 40]
 *
 * 做三件事：
 *   ① 把素材库的**索引**（标题/UP/档位/字数/金句时间点）喂给模型
 *   ② 模型挑素材 + 写分镜（每镜旁白），并指明引用哪条素材的哪个时间点
 *   ③ 校验 + 对齐时间戳（把模型给的时间吸附到真实字幕句子上）→ 落盘 plans/
 *
 * 产物：bili-store/plans/<时间戳>.json
 * 注意：**这一步不渲染**。渲染由 index.js 的 /render/start → engine/render.mjs → bili-op/build.mjs 接。
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { creativeOptions, creativeSystem, buildCreativePrompt, normalizeCreativePlan } from './creative.mjs'
import { listClips } from './media-clips.mjs'
import { join, dirname, resolve } from 'node:path'
import { list, STORE, paths } from './store.mjs'
import { loadLLM } from './llmpath.mjs'
import { renderBlock, renderRecallBlock, addEvent } from './memory.mjs'

const { chatJSON, assertKey } = await loadLLM()

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && process.argv[i + 1] !== undefined && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt
}
/* 已裁剪的视频片段索引（assets-src/clips）；插件布局没有该目录时返回空 */
const clipIndex = listClips
const cn = (s) => String(s || '').replace(/\s/g, '').length
const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`

/** 人设（偏好里填的 personaPrompt）：只影响措辞，不影响结构 */
function personaLine() {
  const p = String(process.env.BILI_OP_PERSONA || arg('persona', '')).trim()
  return p ? `\n\n【人设 / 口径】${p}\n写标题、点评和旁白都按这个人设说话。` : ''
}

/** 自己的视频（合集缓存）：可以自然引用，但不影响分镜结构 */
function selfVideosLine() {
  const b = String(process.env.BILI_OP_SELF_VIDEOS || '').trim()
  return b ? `\n\n${b}\n写标题、点评和旁白时可以参考自己拍过的东西，但不要硬提。` : ''
}

/** 长期记忆（主人偏好 / 工作台事实）：标题长度、封面偏好这类纠正要在这里生效 */
function memoryLine() {
  const b = renderBlock()
  return b ? `\n\n${b}\n写标题、点评和旁白时遵守上面的长期记忆。` : ''
}

/** 经历召回（events.jsonl top-k）：前两天看过的剧、做过的方案，按题材想起来 */
function recallLine() {
  const b = renderRecallBlock(process.env.BILI_OP_MEMORY_QUERY || '', { k: 6 })
  return b ? `\n\n${b}\n参考上面的经历挑素材、定角度：经历里正好相关的题材优先用。` : ''
}

/** 把模型给的秒数吸附到真实字幕句子起点（±6 秒内最近的） */
function snapToSubtitle(bv, t) {
  try {
    const f = paths(bv).subs
    if (!existsSync(f)) return { t: Number(t) || 0, text: '', snapped: false }
    const items = JSON.parse(readFileSync(f, 'utf8')).items || []
    if (!items.length) return { t: Number(t) || 0, text: '', snapped: false }
    let best = null
    for (const it of items) {
      const d = Math.abs(Number(it.from) - Number(t))
      if (best === null || d < best.d) best = { d, it }
    }
    if (best && best.d <= 6) return { t: Number(best.it.from), text: best.it.content, snapped: true }
    return { t: Number(t) || 0, text: '', snapped: false }
  } catch { return { t: Number(t) || 0, text: '', snapped: false } }
}

async function main() {
  assertKey()
  const reviseFile = arg('revise', '')
  const instruction = arg('instruction', '')
  const brief = reviseFile
    ? String(instruction || '').trim()
    : (process.argv[2] && !process.argv[2].startsWith('--') ? String(process.argv[2]) : '')
  if (!brief) { console.error('用法: node plan.mjs "想做一期什么样的片子" [--limit 40] [--out file]\n      node plan.mjs --revise <上一版.json> --instruction "第 5 条换个素材" [--out file]'); process.exit(2) }
  const limit = Math.max(5, Math.min(Number(arg('limit', 40)) || 40, 120))

  let prev = null
  if (reviseFile) {
    if (!existsSync(reviseFile)) { console.error('上一版方案不存在：' + reviseFile); process.exit(2) }
    prev = JSON.parse(readFileSync(reviseFile, 'utf8'))
  }

  const creative = creativeOptions({ style: arg('style', prev?.style || 'A'), customStyle: arg('custom-style', prev?.customStyle || '') })
  const rows0 = list({ limit: 2000 }).filter((r) => (r.subtitle?.chars || 0) > 0 || (r.quotes || []).length)
  // 长任务会用它圈定“只准用这些相关素材”
  const onlyBvs = new Set(String(arg('bvs', '')).split(',').map((s) => s.trim()).filter(Boolean))
  const rows = onlyBvs.size ? rows0.filter((r) => onlyBvs.has(r.bvid)) : rows0
  if (!rows.length) { console.error(onlyBvs.size ? '指定的素材里没有可用素材（需要字幕或片段）' : '素材库里还没有可用素材（需要字幕或可用片段）'); process.exit(3) }

  console.log(reviseFile ? `改一版：${brief}` : `新方案：${brief}`)
  console.log(`素材候选 ${rows.length} 条（带字幕/片段），喂给模型前 ${Math.min(rows.length, limit)} 条`)
  const t0 = Date.now()
  const messages = [{ role: 'system', content: creativeSystem(creative) + personaLine() + memoryLine() + recallLine() + selfVideosLine() },
    { role: 'user', content: buildCreativePrompt(brief, rows, limit, prev, creative, clipIndex()) }]
  const modelOptions = { maxTokens: 6000, temperature: creative.style === 'B' ? 0.65 : 0.8 }
  let generated
  try {
    generated = await chatJSON(messages, modelOptions)
  } catch (e) {
    if (!/截断|max.?tokens|length limit/i.test(String(e?.message || e))) throw e
    console.log('模型输出超长，保留创作要求并精简字段重试一次…')
    generated = await chatJSON([...messages, {
      role: 'user', content: '上次输出超过长度限制。请直接输出完整精简JSON：保留主题、用户时长和风格、必要分镜及真实来源，省略无用的可选字段，缩短重复说明，不重复素材上下文；不要输出推理。不要通过截断台词、破坏完整包袱或插解说来缩短。',
    }], { ...modelOptions, maxTokens: 10000 })
  }
  let plan
  try {
    plan = normalizeCreativePlan(generated.json, rows, { ...creative, clips: clipIndex(), snap: snapToSubtitle })
  } catch (e) {
    console.log('方案校验未通过，自动修正一次：' + e.message)
    generated = await chatJSON([...messages,
      { role: 'assistant', content: JSON.stringify(generated.json) },
      { role: 'user', content: '保持主题及选择的风格，只修复以下校验问题并输出完整JSON：' + e.message + (creative.style === 'B' ? '。只允许首镜title片头（最多10字、实际≤3秒）和末镜outro片尾，正文必须全是broll+original且没有旁白，至少2个完整原声包袱；按提供的完整台词起止点剪辑。' : '') },
    ], modelOptions)
    plan = normalizeCreativePlan(generated.json, rows, { ...creative, clips: clipIndex(), snap: snapToSubtitle })
  }
  const model = generated.model
  plan.brief = prev?.brief || brief
  plan.instruction = reviseFile ? brief : ''
  plan.model = model
  plan.createdAt = new Date().toISOString()
  if (reviseFile && !plan.changed) plan.changed = '按指令改了这一版'

  if (!process.argv.includes('--preview')) addEvent(reviseFile ? 'plan-revise' : 'plan', {
    brief: String(brief).slice(0, 80),
    title: plan.title,
    bvs: plan.picks.map((p) => p.bv),
    text: `${reviseFile ? '按「' + String(brief).slice(0, 20) + '」改了方案' : '为「' + String(brief).slice(0, 30) + '」出了方案'}《${plan.title}》`,
  })

  const out = arg('out', '')
  let file
  if (out) {
    const abs = resolve(out)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, JSON.stringify(plan, null, 2), 'utf8')
    file = abs
  } else {
    const dir = join(STORE, 'plans')
    mkdirSync(dir, { recursive: true })
    file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    writeFileSync(file, JSON.stringify(plan, null, 2), 'utf8')
  }

  console.log(`\n模型：${model}（${((Date.now() - t0) / 1000).toFixed(1)}s）`)
  console.log(`标题：${plan.title}`)
  console.log(`角度：${plan.angle}`)
  console.log(`选料 ${plan.picks.length} 条：`)
  for (const p of plan.picks) console.log(`  · ${p.bv}（${p.use}）${p.why}`)
  console.log(`分镜 ${plan.stats.shotCount} 镜 · 旁白 ${plan.stats.narrationChars} 字 ≈ ${plan.stats.estSeconds} 秒 · 绑定素材 ${plan.stats.withSource} 镜（吸附字幕 ${plan.stats.snapped}）`)
  for (const s of plan.shots) {
    const src = s.source ? ` ← ${s.source.bv} @ ${mmss(s.source.t)}${s.source.quote ? '「' + s.source.quote.slice(0, 14) + '」' : ''}` : ''
    console.log(`  [${s.kind}] ${s.headline || ''} · ${cn(s.narration)}字${src}`)
  }
  console.log(`\nPLAN_FILE=${file}`)
}

main().catch((e) => { console.error('失败：' + (e?.message ?? e)); process.exit(1) })
