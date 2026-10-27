/**
 * daily.mjs —— 从素材库生成"今天的素材日报"
 *
 *   node daily.mjs                # 今天的
 *   node daily.mjs --date 2026-10-23
 *
 * 日报只是素材库的一个**视图** —— 同一条数据，报告给人看，引擎拿去剪片。
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { list, STORE } from './store.mjs'

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt
}
const today = () => new Date().toLocaleDateString('sv-SE')
/** ⚠️ fetchedAt 是 UTC ISO（…T16:xx:xxZ），直接 slice 会跟本地日期差一天 ⇒ 先转本地 */
const dayOf = (iso) => {
  try { return new Date(iso).toLocaleDateString('sv-SE') } catch { return String(iso || '').slice(0, 10) }
}

const day = arg('date', today())
const level = ['full', 'brief', 'off'].includes(String(arg('level', 'full'))) ? String(arg('level', 'full')) : 'full'
if (level === 'off') {
  console.log('日报已关闭（reportLevel=off），本轮不写报告')
  process.exit(0)
}
const all = list({ limit: 500 })
const rows = all.filter((r) => dayOf(r.fetchedAt) === day)

const tierOrder = { 值得看: 0, 可以看: 1, 跳过: 2 }
rows.sort((a, b) => (tierOrder[a.judge?.tier] ?? 9) - (tierOrder[b.judge?.tier] ?? 9))

const count = (t) => rows.filter((r) => (r.judge?.tier || '未判定') === t).length
const withSub = rows.filter((r) => (r.subtitle?.chars || 0) > 0).length
const withQuotes = rows.filter((r) => (r.quotes || []).length > 0).length
const totalChars = rows.reduce((n, r) => n + (r.subtitle?.chars || 0), 0)

const line = (r) => {
  const q = (r.quotes || [])[0]
  const bits = [
    `### ${r.bvid}  ${r.title}`,
    `- UP：${r.up?.name || '?'} · 时长 ${Math.floor((r.duration || 0) / 60)}:${String((r.duration || 0) % 60).padStart(2, '0')} · ${r.stat ? `播放 ${r.stat.view} · 点赞 ${r.stat.like}` : ''}`,
    `- 判定：**${r.judge?.tier || '未判定'}** — ${r.judge?.why || '（还没判）'}`,
    r.subtitle?.chars ? `- 逐字稿：${r.subtitle.chars} 字（${r.subtitle.lang || '?'}）${r.frames?.length ? ` · 关键帧 ${r.frames.length} 张` : ''}` : '- 逐字稿：无（这条没法引用）',
    q ? `- 可用片段（${(r.quotes || []).length} 条），例如 \`${Math.round(q.t)}s\`：「${q.text}」` : '',
    (r.memes || []).length ? `- 热梗：${r.memes.join(' / ')}` : '',
    (r.hotComments || []).length ? `- 热评：${r.hotComments.slice(0, 2).map((x) => `「${String(x.text).slice(0, 24)}」${x.like || 0}赞`).join(' / ')}` : '',
    (r.hotDanmaku || []).length ? `- 热门弹幕：${r.hotDanmaku.slice(0, 5).map((x) => x.text).join(' / ')}` : '',
    r.cover ? `- 封面：${r.cover}` : '',
  ].filter(Boolean)
  return bits.join('\n')
}

const brief = `# 素材日报 ${day}（薄版）

| 指标 | 数值 |
|---|---|
| 今天采集 | **${rows.length}** 条 |
| 值得看 / 可以看 / 跳过 | ${count('值得看')} / ${count('可以看')} / ${count('跳过')} |
| 有逐字稿 | ${withSub} 条（共 ${totalChars} 字） |
| 有可用片段 | ${withQuotes} 条 |

## 值得看

${rows.filter((r) => r.judge?.tier === '值得看').map((r) => `- ${r.bvid} ${r.title} — ${r.judge?.why || ''}`).join('\n') || '_（今天没有）_'}

---
_由素材库生成（${STORE}）· 薄版只列值得看_
`

const full = `# 素材日报 ${day}

| 指标 | 数值 |
|---|---|
| 今天采集 | **${rows.length}** 条 |
| 值得看 / 可以看 / 跳过 | ${count('值得看')} / ${count('可以看')} / ${count('跳过')} |
| 有逐字稿 | ${withSub} 条（共 ${totalChars} 字） |
| 有可用片段 | ${withQuotes} 条 |

## 值得看

${rows.filter((r) => r.judge?.tier === '值得看').map(line).join('\n\n') || '_（今天没有）_'}

## 可以看

${rows.filter((r) => r.judge?.tier === '可以看').map(line).join('\n\n') || '_（今天没有）_'}

## 跳过（附理由，避免重复看）

${rows.filter((r) => (r.judge?.tier || '未判定') === '跳过').map((r) => `- ${r.bvid} ${r.title} — ${r.judge?.why || ''}`).join('\n') || '_（今天没有）_'}

---
_由素材库生成（${STORE}）· 同一条数据引擎可直接拿去剪片_
`

const md = level === 'brief' ? brief : full

mkdirSync(join(STORE, 'reports'), { recursive: true })
const out = join(STORE, 'reports', `${day}.md`)
writeFileSync(out, md, 'utf8')
console.log(md)
console.log(`\n已写入 ${out}`)
