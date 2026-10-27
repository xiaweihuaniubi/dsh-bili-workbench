/**
 * gen.mjs —— 生成一期「资讯盘点」的脚本与分镜（只产出 JSON，不出视频）
 *
 * 用法：
 *   node gen.mjs "本周AI圈新鲜事" --count 5 --tone "轻松但不油腻"
 *   node gen.mjs --health          # 只看模型端点通不通
 *
 * 产物：runs/<日期>-<slug>/script.json  （title/subtitle/shots，含每镜旁白）
 * 下一步：tts.mjs 配音 + render 出片
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chatJSON, health, models, chat } from './llm.mjs'
import { SYSTEM, userPrompt } from './prompts.mjs'
import { hotTitles } from './bili.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const KINDS = new Set(['title', 'item', 'data', 'outro'])

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt
}
const flag = (name) => process.argv.includes('--' + name)

const cn = (s) => String(s || '').replace(/\s/g, '').length
const slug = (s) => String(s || 'topic').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'topic'
const today = () => new Date().toLocaleDateString('sv-SE')     // YYYY-MM-DD

/** 校验 + 归一化：宁可在这里报错，也别让下游渲染拿到脏数据 */
function normalize(json, { count }) {
  if (!json || !Array.isArray(json.shots) || json.shots.length < 3) throw new Error('shots 少于 3 镜，不合格')

  const shots = []
  for (const [i, s] of json.shots.entries()) {
    const kind = String(s.kind || '').trim()
    if (!KINDS.has(kind)) throw new Error(`第 ${i + 1} 镜 kind="${kind}" 不认识`)
    const narration = String(s.narration || '').replace(/\s+/g, ' ').trim()
    if (cn(narration) < 8) throw new Error(`第 ${i + 1} 镜旁白太短：${narration}`)

    const shot = { kind, narration }
    if (kind === 'title' || kind === 'outro') {
      shot.headline = String(s.headline || '').trim().slice(0, 24)
      shot.sub = String(s.sub || '').trim().slice(0, 30)
      if (!shot.headline) throw new Error(`第 ${i + 1} 镜缺 headline`)
    } else if (kind === 'item') {
      shot.headline = String(s.headline || '').trim().slice(0, 22)
      shot.body = String(s.body || '').trim().slice(0, 48)
      shot.badge = String(s.badge || '').trim().slice(0, 6)
      if (!shot.headline) throw new Error(`第 ${i + 1} 镜缺 headline`)
    } else if (kind === 'data') {
      shot.headline = String(s.headline || '').trim().slice(0, 22)
      const stats = Array.isArray(s.stats) ? s.stats.slice(0, 4) : []
      shot.stats = stats
        .map((x) => ({ label: String(x?.label || '').trim().slice(0, 8), value: String(x?.value || '').trim().slice(0, 12) }))
        .filter((x) => x.label && x.value)
      if (!shot.stats.length) throw new Error('data 镜没有有效 stats')
    }
    shots.push(shot)
  }

  // 结构：第一镜必须是 title，最后一镜必须是 outro
  if (shots[0].kind !== 'title') throw new Error('第 1 镜必须是 title')
  if (shots[shots.length - 1].kind !== 'outro') throw new Error('最后一镜必须是 outro')
  const items = shots.filter((s) => s.kind === 'item')
  if (items.length < 2) throw new Error('item 镜少于 2 条')
  items.forEach((s, i) => { s.index = i + 1 })

  const total = shots.reduce((n, s) => n + cn(s.narration), 0)
  if (total < 160) throw new Error(`旁白总字数只有 ${total}，太短（目标 250–380）`)
  if (total > 520) throw new Error(`旁白总字数 ${total}，太长（目标 250–380）`)

  return {
    title: String(json.title || '').trim().slice(0, 24) || shots[0].headline,
    subtitle: String(json.subtitle || '').trim().slice(0, 30),
    shots,
    stats: { shotCount: shots.length, itemCount: items.length, narrationChars: total, estSeconds: Math.round(total / 4.5) },
  }
}

async function main() {
  if (flag('health')) {
    const h = await health()
    console.log(JSON.stringify(h, null, 2))
    return
  }

  let theme = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : ''
  const count = Math.max(2, Math.min(Number(arg('count', 5)) || 5, 7))
  const tone = arg('tone', '')

  // --auto：先看 B站 热门里有什么，再让它自己定一个能串起来的题
  if (flag('auto') && !theme) {
    console.log('拉 B站 热门…')
    const hot = hotTitles(24)
    if (!hot.length) throw new Error('热门拉不到（看看 bili 是否可跑）')
    console.log(`拿到 ${hot.length} 条热门，让模型挑一个能串起来的题`)
    try {
      const pick = await chat([
        { role: 'system', content: '你是 B站 资讯盘点的选题编辑。只输出一句话，不要解释。' },
        {
          role: 'user',
          content: `下面是 B站 当前热门（标题 | 推荐理由）：\n${hot.slice(0, 24).map((x) => `- ${x.title} | ${x.reason}`).join('\n')}\n\n`
            + `请挑出**能串成一期资讯盘点**的一个主题（要具体、能覆盖其中 4–6 条），`
            + `只输出主题本身，20 字以内，不要引号、不要解释。`,
        },
      ], { maxTokens: 1500, temperature: 0.5 })
      theme = String(pick.text || '').trim().replace(/^["「『]|["」』]$/g, '').split('\n')[0].slice(0, 40)
      console.log(`自动选题：${theme}`)
    } catch (e) {
      // ⭐ 模型不可用（限流/额度）时别把整条流水线卡死：退回"用最热的那条当主题"
      console.log('模型选题失败（' + String(e?.message ?? e).split('\n')[0] + '）⇒ 降级为用当前最热的一条')
      theme = String(hot[0].title || '').slice(0, 30) || '本周热门盘点'
      console.log(`降级选题：${theme}`)
    }
  }

  if (!theme) {
    console.error('用法: node gen.mjs "主题" [--count 5] [--tone 语气]\n      node gen.mjs --auto [--count 5]\n      node gen.mjs --health')
    process.exit(2)
  }

  console.log(`主题：${theme}`)
  console.log(`模型：${models().join(' → ')}（失败自动换下一个）`)
  const t0 = Date.now()
  const { json, model, usage } = await chatJSON(
    [{ role: 'system', content: SYSTEM }, { role: 'user', content: userPrompt({ theme, date: today(), tone, count }) }],
    { maxTokens: 3500, temperature: 0.6 },
  )
  const ms = Date.now() - t0
  const script = normalize(json, { count })
  script.theme = theme
  script.generatedAt = new Date().toISOString()
  script.model = model

  const dir = join(HERE, 'runs', `${today()}-${slug(theme)}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'script.json'), JSON.stringify(script, null, 2), 'utf8')

  console.log(`\n模型：${model}（${ms} ms，tokens=${usage?.total_tokens ?? '?'}）`)
  console.log(`标题：${script.title}`)
  console.log(`镜头：${script.stats.shotCount} 个（item ${script.stats.itemCount} 条），旁白 ${script.stats.narrationChars} 字 ≈ ${script.stats.estSeconds} 秒`)
  for (const s of script.shots) console.log(`  [${s.kind}${s.index ? ' ' + s.index : ''}] ${s.headline} · ${cn(s.narration)}字`)
  console.log(`\n已写入 ${join(dir, 'script.json')}`)
}

main().catch((e) => { console.error('失败：' + (e?.message ?? e)); process.exit(1) })
