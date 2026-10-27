/**
 * collect.mjs —— 采集器：把一个视频的"创作可用料"抓进素材库
 *
 *   node collect.mjs BV16DnN6KEUo BV1FynG6WE5X     # 指定视频
 *   node collect.mjs --hot 6                        # 从 B站 综合热门里取 6 条
 *   node collect.mjs --search "DeepSeek" --size 5
 *   node collect.mjs ... --refresh                  # 忽略新鲜度强制重抓
 *
 * 抓什么：元数据 + 逐字稿（带时间戳）+ 关键帧（默认 6 张）+ 封面
 * 幂等：库里已有且 7 天内 ⇒ 直接跳过（这就是"不重复看"的实现）
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runBili, fetchCover } from './bili.mjs'
import { ensureStore, get, put, putSubtitle, storeFrames, storeCover, isFresh, stats, STORE } from './store.mjs'

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt
}
const flag = (n) => process.argv.includes('--' + n)
const log = (s) => console.log(s)

const normSub = (d) => {
  const items = Array.isArray(d?.items) ? d.items : []
  return {
    lang: d?.lang || '',
    available: (d?.available || []).map((x) => x.lang),
    items: items.map((x) => ({ from: Number(x.from) || 0, to: Number(x.to) || 0, content: String(x.content || '').trim() })).filter((x) => x.content),
    text: items.map((x) => String(x.content || '').trim()).filter(Boolean).join(''),
  }
}

/** 热评：按点赞取前 8 条 */
function fetchHotComments(bv) {
  const r = runBili(['comment', 'list', bv, '--sort', 'hot', '--page', '1'], { timeoutMs: 30000 })
  if (!r.ok) return []
  return (r.data?.items || [])
    .slice(0, 8)
    .map((x) => ({ text: String(x.content || '').trim(), like: Number(x.like) || 0, user: x.user?.name || '', rpid: x.rpid }))
    .filter((x) => x.text)
}

/** 热门弹幕：弹幕没有点赞，按出现频率取前 10 条 */
const DANMAKU_NOISE = new Set(['哈哈', '哈哈哈', '哈哈哈哈', '第一', '前排', '打卡', '来了', '冒泡', '懂你意思', '好', '中中中'])
function fetchHotDanmaku(bv) {
  const r = runBili(['video', 'danmaku', bv, '--limit', '300'], { timeoutMs: 30000 })
  if (!r.ok) return { items: [], total: 0 }
  const all = r.data?.items || []
  const counter = new Map()
  for (const x of all) {
    const t = String(x.text || '').trim()
    if (t.length < 2 || DANMAKU_NOISE.has(t)) continue
    counter.set(t, (counter.get(t) || 0) + 1)
  }
  const items = [...counter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([text, count]) => ({ text, count }))
  return { items, total: Number(r.data?.total) || all.length }
}

/** 候选：--hot / --search / 直接给 BV */
function candidates() {
  const list = []
  const hotN = Number(arg('hot', 0))
  if (hotN > 0) {
    const r = runBili(['hot', 'popular', '--size', String(Math.min(50, hotN))], { timeoutMs: 60000 })
    for (const it of (r.data?.items || [])) list.push({ bvid: it.bvid, title: it.title, reason: it.reason || '' })
  }
  const q = arg('search', '')
  if (q) {
    const size = Number(arg('size', 5)) || 5
    const r = runBili(['search', 'video', q, '--size', String(size)], { timeoutMs: 60000 })
    for (const it of (r.data?.items || [])) list.push({ bvid: it.bvid, title: it.title, reason: '' })
  }
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--') || a.startsWith('-')) continue
    if (/^BV[0-9A-Za-z]{10}$/.test(a)) list.push({ bvid: a, title: '', reason: '' })
  }
  // 去重
  const seen = new Set()
  return list.filter((x) => x.bvid && !seen.has(x.bvid) && seen.add(x.bvid))
}

async function collectOne(cand, { refresh }) {
  const bv = cand.bvid
  if (!refresh && isFresh(bv, 7)) {
    const rec = get(bv)
    return { bv, skipped: true, title: rec?.title || cand.title, reason: '库里已有（7 天内）' }
  }

  const t0 = Date.now()
  const info = runBili(['video', 'info', bv], { timeoutMs: 60000 })
  if (!info.ok) return { bv, error: info.error?.code + ' ' + (info.error?.message || ''), title: cand.title }

  const d = info.data || {}
  const rec = {
    bvid: bv,
    title: d.title || cand.title || '',
    up: d.owner ? { mid: d.owner.mid, name: d.owner.name } : null,
    duration: d.duration || 0,
    pubdate: d.pubdate || '',
    zone: d.zone?.name || '',
    stat: d.stat || null,
    url: d.url || `https://www.bilibili.com/video/${bv}`,
    cover: '',
    subtitle: null,
    frames: [],
    aiSummary: '',
    quotes: [],
    judge: null,
    hotComments: [],
    hotDanmaku: [],
    memes: [],
    danmakuTotal: 0,
    reason: cand.reason || '',
    source: ['collect'],
    fetchedAt: new Date().toISOString(),
    fetchedBy: 'collector',
  }

  // 逐字稿
  const sub = runBili(['video', 'subtitle', bv], { timeoutMs: 90000 })
  if (sub.ok) {
    const s = normSub(sub.data)
    if (s.items.length) {
      rec.subtitle = { lang: s.lang, chars: s.text.length, items: s.items.length, text: s.text }
      putSubtitle(bv, { bvid: bv, lang: s.lang, available: s.available, items: s.items, text: s.text })
    }
  } else {
    rec.subtitle = { lang: '', chars: 0, items: 0, text: '', missing: sub.error?.code || 'unavailable' }
  }

  // 关键帧（preview 质量：B站进度条缩略图，快且够用）
  if (!flag('no-frames')) {
    const n = Number(arg('frames', 6)) || 6
    const fr = runBili(['video', 'frames', bv, '--count', String(n), '--quality', 'preview'], { timeoutMs: 120000 })
    if (fr.ok) rec.frames = storeFrames(bv, fr.data?.frames || [])
  }

  // 封面
  try {
    const buf = await fetchCover(bv)
    if (buf) rec.cover = storeCover(bv, buf)
  } catch { /* 没封面也能用 */ }

  // 热评 + 热门弹幕（创作时能直接拿来当"热梗/争议"素材）
  if (!flag('no-hot')) {
    rec.hotComments = fetchHotComments(bv)
    const dm = fetchHotDanmaku(bv)
    rec.hotDanmaku = dm.items
    rec.danmakuTotal = dm.total
  }

  // 已在库的旧判定/引用不能丢（重抓时继承）
  const old = get(bv)
  if (old) {
    rec.judge = old.judge || null
    rec.quotes = old.quotes || []
    rec.memes = old.memes || []
    rec.hotComments = rec.hotComments.length ? rec.hotComments : (old.hotComments || [])
    rec.hotDanmaku = rec.hotDanmaku.length ? rec.hotDanmaku : (old.hotDanmaku || [])
    rec.danmakuTotal = rec.danmakuTotal || old.danmakuTotal || 0
    rec.source = [...new Set([...(old.source || []), 'collect'])]
  }

  put(rec)
  return {
    bv, title: rec.title, ms: Date.now() - t0,
    chars: rec.subtitle?.chars || 0, frames: rec.frames.length,
    cover: Boolean(rec.cover), subtitleLang: rec.subtitle?.lang || '无',
  }
}

async function main() {
  ensureStore()
  const cands = candidates()
  if (!cands.length) {
    console.error('用法: node collect.mjs BV... | --hot N | --search "关键词" [--size N] [--max-new N] [--frames 10] [--refresh] [--no-frames] [--no-hot]')
    process.exit(2)
  }
  const refresh = flag('refresh')
  const maxNew = Math.max(0, Number(arg('max-new', 0)) || 0)
  log(`素材库：${STORE}`)
  log(`候选 ${cands.length} 条${refresh ? '（强制重抓）' : ''}${maxNew ? ` · 最多新采 ${maxNew}` : ''}\n`)

  let ok = 0, skip = 0, fail = 0
  for (const c of cands) {
    if (maxNew && ok >= maxNew) break
    try {
      const r = await collectOne(c, { refresh })
      if (r.skipped) { skip++; log(`  ⏭  ${r.bv}  ${r.reason}`); continue }
      if (r.error) { fail++; log(`  ✗  ${r.bv}  ${r.error}`); continue }
      ok++
      log(`  ✓  ${r.bv}  ${String(r.title).slice(0, 28)}  ${r.chars}字 帧${r.frames} 封面${r.cover ? '有' : '无'}  ${(r.ms / 1000).toFixed(1)}s`)
    } catch (e) {
      fail++
      log(`  ✗  ${c.bvid}  ${e?.message ?? e}`)
    }
  }

  const s = stats()
  log(`\n完成：新采 ${ok} · 跳过 ${skip} · 失败 ${fail}`)
  log(`库里现在有 ${s.videos} 条视频，占 ${s.mb} MB（${s.files} 个文件）`)
}

main().catch((e) => { console.error('失败：' + (e?.message ?? e)); process.exit(1) })
