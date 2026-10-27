/**
 * canon.mjs —— 「自己的视频」：把 B站 合集里的日常短片拉下来缓存，
 * 生成一段可注入 prompt 的自述素材，并支持按话题挑几条。
 *
 *   node canon.mjs --refresh            # 强制刷新缓存
 *   node canon.mjs --status             # 看缓存状态
 *   node canon.mjs --block "甜品"        # 打印会注入的文本（调试用）
 *
 * 数据来源：`bili video info <BV> --raw` 里的 ugc_season，一次就能拿到整个合集的
 * 集数与标题，不需要遍历 75 个视频。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { runBili } from './bili.mjs'
import { STORE } from './store.mjs'

const DIR = join(STORE, 'canon')
const readJson = (f, d = null) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return d } }
const cfg = () => readJson(join(STORE, 'config.json'), {}) || {}

/** 从链接 / mid/seasonId 解析出合集与 UP */
export function parseSeason(input) {
  const s = String(input || '').trim()
  let seasonId = (s.match(/\/lists\/(\d+)/) || [])[1]
    || (s.match(/[?&]season_id=(\d+)/) || [])[1]
    || (s.match(/^(\d{5,})$/) || [])[1]
    || ''
  let mid = (s.match(/space\.bilibili\.com\/(\d+)/) || [])[1] || ''
  const pair = s.match(/^(\d{5,})\/(\d{5,})$/)
  if (pair) { mid = mid || pair[1]; seasonId = seasonId || pair[2] }
  return { seasonId, mid }
}

const cacheFile = (seasonId) => join(DIR, `season-${seasonId}.json`)

/** 没配 URL 时用最近刷新过的那个合集，保证刚拉过就能用 */
function latestCache() {
  try {
    const files = readdirSync(DIR).filter((f) => /^season-\d+\.json$/.test(f))
    let best = null
    for (const f of files) {
      const c = readJson(join(DIR, f), null)
      if (!c?.fetchedAt) continue
      if (!best || Date.parse(c.fetchedAt) > Date.parse(best.fetchedAt)) best = c
    }
    return best && Array.isArray(best.episodes) ? best : null
  } catch { return null }
}

export function load(input) {
  const { seasonId } = parseSeason(input || cfg().selfVideosUrl)
  if (!seasonId) return latestCache()
  const c = readJson(cacheFile(seasonId), null)
  return c && Array.isArray(c.episodes) ? c : latestCache()
}

export function status(input) {
  const conf = cfg()
  const url = input || conf.selfVideosUrl || ''
  const { seasonId, mid } = parseSeason(url)
  const c = load(seasonId ? url : '')
  const hours = Number(conf.selfVideosRefreshHours) || 24
  const age = c?.fetchedAt ? (Date.now() - Date.parse(c.fetchedAt)) / 3600_000 : Infinity
  return {
    ok: Boolean(c),
    enabled: conf.selfVideosEnabled !== false,
    url,
    seasonId: seasonId || c?.seasonId || '',
    mid: mid || c?.mid || '',
    title: c?.title || '',
    epCount: c?.episodes?.length || 0,
    fetchedAt: c?.fetchedAt || '',
    stale: !c || age > hours,
    refreshHours: hours,
  }
}

/** 找一条属于该合集的视频，再从它的 raw 信息里取整个 ugc_season */
function fetchSeason(seasonId, mid) {
  if (!mid) return { ok: false, error: '链接里没有 UP 的 UID，无法定位合集' }
  const uploads = []
  for (let page = 1; page <= 3; page++) {
    const r = runBili(['user', 'videos', mid, '--size', '50', '--page', String(page)], { timeoutMs: 40000 })
    if (!r.ok) return { ok: false, error: r.error?.message || r.error?.code || '拉投稿列表失败' }
    const items = r.data?.items || []
    uploads.push(...items)
    if (items.length < 50) break
  }
  if (!uploads.length) return { ok: false, error: '这个 UP 没有可用的投稿列表' }

  for (const it of uploads.slice(0, 12)) {
    const r = runBili(['video', 'info', it.bvid, '--raw'], { timeoutMs: 30000 })
    if (!r.ok) continue
    const d = r.data || {}
    const se = d.ugc_season
    if (!se || String(se.id) !== String(seasonId)) continue
    const seen = new Set()
    const episodes = []
    for (const sec of se.sections || []) {
      for (const ep of sec.episodes || []) {
        const bvid = String(ep.bvid || '')
        if (!bvid || seen.has(bvid)) continue
        seen.add(bvid)
        episodes.push({
          bvid,
          title: String(ep.title || ep.arc?.title || '').trim(),
          duration: Number(ep.arc?.duration) || 0,
          pubdate: Number(ep.arc?.pubdate) || 0,
        })
      }
    }
    episodes.sort((a, b) => (a.pubdate || 0) - (b.pubdate || 0))
    return {
      ok: true,
      data: {
        seasonId: String(se.id),
        mid: String(se.mid || mid),
        title: String(se.title || ''),
        intro: String(se.intro || ''),
        epCount: Number(se.ep_count) || episodes.length,
        episodes,
        fetchedAt: new Date().toISOString(),
      },
    }
  }
  return { ok: false, error: `在最近 ${Math.min(12, uploads.length)} 条投稿里没找到合集 ${seasonId}` }
}

export function refresh(input, { force = false } = {}) {
  const conf = cfg()
  const url = input || conf.selfVideosUrl || ''
  const { seasonId, mid } = parseSeason(url)
  if (!seasonId) return { ok: false, error: '链接里没找到合集 ID（应包含 /lists/<id>）' }
  const cached = load(url)
  // load() 在缺文件时会退回「最近刷新过的合集」，这里必须确认是同一个合集。
  const old = cached && String(cached.seasonId) === String(seasonId) ? cached : null
  const hours = Number(conf.selfVideosRefreshHours) || 24
  const age = old?.fetchedAt ? (Date.now() - Date.parse(old.fetchedAt)) / 3600_000 : Infinity
  if (!force && old && age <= hours) return { ok: true, cached: true, data: old }

  const r = fetchSeason(seasonId, mid || String(old?.mid || ''))
  if (!r.ok) return r
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true })
    const f = cacheFile(seasonId)
    const tmp = f + '.tmp'
    writeFileSync(tmp, JSON.stringify(r.data, null, 2), 'utf8')
    renameSync(tmp, f)
  } catch (e) {
    return { ok: false, error: '写缓存失败：' + String(e?.message ?? e) }
  }
  return { ok: true, cached: false, data: r.data }
}

/** 缓存过期就后台刷一次；失败只记日志，不影响主流程 */
export async function ensureFresh() {
  const conf = cfg()
  if (conf.selfVideosEnabled === false) return status()
  const st = status()
  if (!st.url || !st.seasonId) return st
  if (!st.stale) return st
  try { refresh(st.url) } catch { /* 离线/风控时用旧缓存 */ }
  return status()
}

/* ───────────── 生成注入文本 ───────────── */

const STOP = /[，。！？、,.!?：:；;（）()「」《》\s~～\-—]/g
const norm = (s) => String(s || '').replace(STOP, '')
/** 最长公共子串长度：中文按字比对，比关键词包含更适合短标题 */
function lcsLen(a, b) {
  if (!a || !b) return 0
  const [s, t] = a.length <= b.length ? [a, b] : [b, a]
  let best = 0
  const prev = new Array(t.length + 1).fill(0)
  for (let i = 1; i <= s.length; i++) {
    let diag = 0
    for (let j = 1; j <= t.length; j++) {
      const tmp = prev[j]
      prev[j] = s[i - 1] === t[j - 1] ? diag + 1 : 0
      if (prev[j] > best) best = prev[j]
      diag = tmp
    }
  }
  return best
}

/** 按话题给自己拍过的片子打分（最长公共子串 ≥2 字） */
export function pickForTopic(topic, n = 3, input) {
  const c = load(input)
  const t = norm(topic)
  if (!c || t.length < 2) return []
  const scored = c.episodes
    .map((e) => ({ ...e, score: lcsLen(t, norm(e.title)) }))
    .filter((e) => e.score >= 2)
  scored.sort((a, b) => b.score - a.score || (b.pubdate || 0) - (a.pubdate || 0))
  return scored.slice(0, n)
}

const ymd = (sec) => {
  if (!sec) return ''
  try { return new Date(sec * 1000).toLocaleDateString('sv-SE') } catch { return '' }
}
const one = (e) => `${e.title}${e.pubdate ? `（${ymd(e.pubdate)}）` : ''}`

/**
 * 生成注入 prompt 的「自己的视频」块。
 * topic 给了就优先列出相关集；始终带最近几集，让角色知道自己在更新什么。
 */
export function renderBlock(topic = '', { picks = 3, recent = 6, input } = {}) {
  const conf = cfg()
  if (conf.selfVideosEnabled === false) return ''
  const c = load(input)
  if (!c || !c.episodes.length) return ''

  const picked = pickForTopic(topic, picks, c.seasonId ? String(c.seasonId) : undefined)
    .filter(Boolean)
  const pickedIds = new Set(picked.map((e) => e.bvid))
  const latest = c.episodes
    .filter((e) => !pickedIds.has(e.bvid))
    .slice(-recent)
    .reverse()

  const lines = [
    `【你自己的视频】`,
    `你出镜的日常短片合集《${c.title || '自己的合集'}》共 ${c.episodes.length} 集。可以自然提到自己拍过什么，但不要每句都提，也不要编没拍过的内容。`,
  ]
  if (picked.length) lines.push(`和这次话题有关的：${picked.map((e) => `《${e.title}》`).join('、')}`)
  if (latest.length) lines.push(`最近的：${latest.map(one).join('；')}`)
  const block = lines.join('\n')
  return block.length > 1400 ? block.slice(0, 1400) + '…' : block
}

/* ───────────── CLI（调试用） ───────────── */
if (process.argv[1] && process.argv[1].endsWith('canon.mjs')) {
  const arg = (n, d) => {
    const i = process.argv.indexOf('--' + n)
    return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d
  }
  if (process.argv.includes('--refresh')) console.log(JSON.stringify(refresh(arg('url', ''), { force: true }), null, 2))
  else if (process.argv.includes('--block')) console.log(renderBlock(arg('topic', '')))
  else console.log(JSON.stringify(status(arg('url', '')), null, 2))
}
