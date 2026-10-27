/**
 * auto-comment.mjs —— 给"今天采到的、还没评论过的视频"自动写评论并发送
 *
 *   node auto-comment.mjs --limit 3 [--mention <UID>] [--dry-run]
 *
 * 规则（按使用者 2026-10-23 的要求）：
 *   · 每天采到的每条视频都留一条评论（评论数由 index.js 按 perDay 剩余额度传 --limit）
 *   · 评论里 @ 主人（--mention 传 UID / 昵称；不传就取当前登录账号的 mid）
 *   · 默认真的发；--dry-run 只打印命令，用于测试
 *   · 生成失败/风控失败都停，不自动重试
 */
import { list } from './store.mjs'
import { runBili } from './bili.mjs'
import * as interact from './interact.mjs'
import { composeText } from './compose-lib.mjs'
import { ownerInfo, mentionTargets, callNames } from './owner.mjs'
import * as canon from './canon.mjs'
import { addEvent, renderRecallBlock } from './memory.mjs'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt
}
const flag = (n) => process.argv.includes('--' + n)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const localDay = (iso) => {
  try { return new Date(iso).toLocaleDateString('sv-SE') } catch { return String(iso || '').slice(0, 10) }
}
const today = () => new Date().toLocaleDateString('sv-SE')
const log = (s) => console.log(s)

/** @ 谁：主人 + 配置里的 mentions；--mention 可再补一个；都没有就用当前登录账号 */
function resolveMentions() {
  const targets = mentionTargets()
  const given = String(arg('mention', '') || '').trim()
  if (given && targets.length < 3 && !targets.some((x) => x.target === given)) {
    targets.push({ target: given, call: '' })
  }
  if (!targets.length) {
    try {
      const r = runBili(['auth', 'status'], { timeoutMs: 20000 })
      const mid = String(r.data?.user?.mid || '')
      if (mid) targets.push({ target: mid, call: '' })
    } catch { /* 没登录就只发评论不 @ */ }
  }
  return targets.slice(0, 3)
}

/** 评论里必须出现配置的称呼；模型没写就补在开头 */
function ensureCalls(text, calls) {
  const t = String(text || '').trim()
  if (!t) return t
  const list = (calls || []).map((c) => String(c || '').trim()).filter(Boolean)
  const missing = list.filter((c) => !t.includes(c))
  if (!missing.length) return t
  return `${missing.join('、')}，${t}`.slice(0, 60)
}

async function main() {
  const dryRun = flag('dry-run')
  const limit = Math.max(1, Math.min(Number(arg('limit', 3)) || 3, 20))
  const owner = ownerInfo()
  const targets = resolveMentions()
  const calls = callNames()
  const persona = String(process.env.BILI_OP_PERSONA || '')

  /** 表情包库：assets-src/memes/bili-emotes（不存在就返回空，功能自动关闭） */
  function memePool() {
    try {
      // index.json 在 bili-emotes/ 下，但 file 字段带 "bili-emotes/" 前缀，实际相对 assets-src/memes/
      const base = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets-src', 'memes')
      const idx = JSON.parse(readFileSync(join(base, 'bili-emotes', 'index.json'), 'utf8'))
      return idx.filter((m) => m?.file && existsSync(join(base, m.file))).map((m) => join(base, m.file))
    } catch { return [] }
  }
  /** 本轮第几条评论带图：每 every 条带 1 张（0=从不），从池里按天种子伪随机选 */
  const imgEvery = Math.max(0, Number(arg('image-every', 5)) || 0)
  const pool = imgEvery > 0 ? memePool() : []
  // 跨批累计：当日已发的评论数参与取模偏移，避免每次跑批都从第 1 条带图
  const dayBase = (() => { try { return interact.dayCounts().comments || 0 } catch { return 0 } })()
  const pickMeme = (i) => (pool.length && imgEvery > 0 && (i + dayBase + 1) % imgEvery === 0
    ? pool[(Number(new Date().toISOString().slice(0, 10).replaceAll('-', '')) + i) % pool.length]
    : '')

  const rows = list({ limit: 2000 })
    .filter((r) => localDay(r.fetchedAt) === today() && !interact.isCommented(r.bvid) && r.title)
    .slice(0, limit)

  if (!rows.length) { log('没有需要评论的新视频'); return }
  log(`待评论 ${rows.length} 条${dryRun ? '（dry-run）' : ''}${targets.length ? ` · @ ${targets.map((x) => x.target).join(', ')}` : ''}${calls.length ? ` · 称呼 ${calls.join(' / ')}` : ''}`)

  let ok = 0, fail = 0
  for (const [ri, rec] of rows.entries()) {
    const ctx = {
      title: rec.title,
      up: rec.up?.name || '',
      quotes: (rec.quotes || []).slice(0, 3).map((x) => x.text),
      memes: (rec.memes || []).slice(0, 3),
      hotComments: (rec.hotComments || []).slice(0, 3).map((x) => x.text),
      ownerCall: owner.call,
      selfVideos: canon.renderBlock(rec.title || '', { picks: 2 }),
      memoryRecall: renderRecallBlock(rec.title || '', { k: 3 }),
      calls,
    }
    let text = ''
    try {
      const c = await composeText('comment', ctx, persona)
      text = ensureCalls(c.text, calls)
    } catch (e) {
      log(`  ✗ ${rec.bvid} 生成失败：${String(e?.message ?? e).split('\n')[0]}`)
      fail++
      continue
    }
    if (!text) { log(`  ✗ ${rec.bvid} 生成为空`); fail++; continue }

    const args = []
    if (dryRun) args.push('--dry-run')
    args.push('comment', 'post', rec.bvid)
    if (text.startsWith('-')) args.push('--') // 防止以 - 开头的文本被 argparse 当作选项
    args.push(text)
    for (const t of targets) args.push('--at', t.target)
    const meme = pickMeme(ri)
    if (meme) args.push('--image', meme)
    const r = runBili(args, { timeoutMs: 60000 })
    if (r.ok) {
      if (!dryRun) {
        await interact.markComment(rec.bvid, { rpid: r.data?.rpid || 0, text })
        addEvent('comment', { bv: rec.bvid, text: `评论了《${String(rec.title).slice(0, 30)}》：${text.slice(0, 50)}` })
      }
      ok++
      log(`  ✓ ${rec.bvid} ${dryRun ? 'dry-run' : '已评论'}${meme ? '·带图' : ''}：${text}`)
    } else {
      fail++
      const msg = r.error?.message || r.error?.code || '未知错误'
      log(`  ✗ ${rec.bvid} 发送失败：${msg}`)
      if (/风控|risk|频繁|限流|稍后|被封|禁止|间隔/i.test(String(msg))) {
        log('  命中风控/限流，停止本轮，不重试')
        break
      }
    }
    if (!dryRun) await sleep(12_000)
  }
  log(`完成：成功 ${ok} · 失败 ${fail}`)
}

main().catch((e) => { console.error('失败：' + (e?.message ?? e)); process.exit(1) })
