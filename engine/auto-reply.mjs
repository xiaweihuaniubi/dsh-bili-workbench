/**
 * auto-reply.mjs —— 有人回复/评论时，AI 自动写回复并发送
 *
 *   node auto-reply.mjs --limit 5 [--dry-run]
 *
 * 规则：
 *   · 只回 24 小时内的消息，且 rpid 没回过（interactions.json 账本）
 *   · 普通用户：只回 is_new；问统计/配置/权限或让机器人代操作时，回一句礼貌拒绝（不沉默、不给数据）
 *   · 主人（config.ownerUid）：即使消息已被界面标记已读也会处理；可以问“今天逛了多少 / 时段”
 *   · 主人也不能在评论里改配置、投稿、删除、私信；这类指令只回复“去工作台手动改”
 *   · 不回复自己账号产生的普通消息；会跳过自己刚发出的回复文本，避免自问自答循环
 *   · 默认真的发；--dry-run 只打印命令
 *   · 风控/限流立刻停，不自动重发
 */
import { runBili } from './bili.mjs'
import * as interact from './interact.mjs'
import { composeText } from './compose-lib.mjs'
import { ownerInfo, answerOwnerCommandDetailed, auditMessage, refusalText, todayStats } from './owner.mjs'
import { voiceOwnerStats } from './owner-voice.mjs'
import * as canon from './canon.mjs'
import { rememberIntent, apply as memoryApply, addEvent, renderRecallBlock } from './memory.mjs'

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt
}
const flag = (n) => process.argv.includes('--' + n)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (s) => console.log(s)

function selfMid() {
  try {
    const r = runBili(['auth', 'status'], { timeoutMs: 20000 })
    return String(r.data?.user?.mid || '')
  } catch { return '' }
}

function ensureCall(text, call) {
  const t = String(text || '').trim()
  if (!t || !call || t.includes(call)) return t
  return `${call}，${t}`.slice(0, 120)
}

async function main() {
  const dryRun = flag('dry-run')
  const limit = Math.max(1, Math.min(Number(arg('limit', 5)) || 5, 20))
  const persona = String(process.env.BILI_OP_PERSONA || '')
  const myMid = selfMid()
  const owner = ownerInfo()

  const r = runBili(['feed', 'replies', '--limit', String(Math.max(limit * 4, 30))], { timeoutMs: 45000 })
  if (!r.ok) { log('拉回复失败：' + (r.error?.message || r.error?.code || '')); return }
  const items = (r.data?.items || [])
  const db = interact.load()
  const botTexts = new Set(
    [...Object.values(db.replied || {}), ...Object.values(db.commented || {})]
      .map((x) => String(x?.text || '').trim())
      .filter(Boolean),
  )

  const isOwner = (m) => Boolean(owner.uid && m.user?.mid && String(m.user.mid) === owner.uid)
  const isSelf = (m) => Boolean(myMid && m.user?.mid && String(m.user.mid) === myMid)
  const recent = (m) => {
    const t = Date.parse(m?.time || '')
    return Number.isFinite(t) && Date.now() - t < 24 * 3600 * 1000
  }

  const targets = items.filter((m) => {
    if (!m?.rpid || !m.on?.bvid || !m.content) return false
    if (db.replied[String(m.rpid)]) return false
    if (botTexts.has(String(m.content).trim())) return false
    const own = isOwner(m)
    if (isSelf(m) && !own) return false
    if (!own && !m.is_new) return false
    if (!recent(m)) return false
    return true
  }).slice(0, limit)

  if (!targets.length) { log('没有需要回复的新消息'); return }
  log(`待回复 ${targets.length} 条${dryRun ? '（dry-run）' : ''}${owner.uid ? ` · 主人 UID ${owner.uid}` : ''}`)

  let ok = 0, fail = 0
  for (const m of targets) {
    const own = isOwner(m)
    const audit = auditMessage(m.content, { isOwner: own })
    let text = ''

    if (!audit.allow) {
      if (own && audit.reason === 'owner-dangerous') {
        text = `${owner.call}，这个操作得去工作台「刷B站设置」手动改，我在评论里不执行配置或发布操作。`
      } else if (!own && /^non-owner-/.test(audit.reason)) {
        // 普通人问数据/让机器人代操作：回一句礼貌拒绝，不沉默
        text = refusalText(m.content, audit.reason)
      } else {
        log(`  ⏭  ${m.rpid} 跳过（${audit.reason}）`)
        continue
      }
    } else if (own) {
      // 主人说「记住…」：写进长期记忆 USER.md（仍过注入扫描；重复会自动去重）
      const remember = rememberIntent(m.content)
      if (remember) {
        const r = await memoryApply({ target: 'user', action: 'add', content: remember }, { source: 'owner-comment' })
        if (r.ok && !r.deduped) addEvent('remember', { text: `主人让我记住：${remember.slice(0, 50)}` })
        text = r.ok
          ? `${owner.call}，${r.deduped ? '这条已经记住过啦' : '记住了'}：${remember.slice(0, 40)}`
          : `${owner.call}，这条没记住（${String(r.error || '').split('\n')[0].slice(0, 40)}）`
      } else {
      const cmd = answerOwnerCommandDetailed(m.content)
      if (cmd) {
        // 数据由本地脚本算好，再按人设改写；数字对不上会自动退回原句
        text = cmd.kind === 'refuse'
          ? cmd.text
          : await voiceOwnerStats(cmd.text, { persona, ownerCall: owner.call })
      } else {
        try {
          const s = todayStats()
          const stats = `今天已逛 ${s.todayVideos} 条，目标 ${s.target} 条；评论 ${s.comments} 条，回复 ${s.replies} 条；时段 ${s.ranges}，每天上限 ${s.perDay} 条`
          const c = await composeText('owner', {
            message: m.content || '', stats, ownerCall: owner.call,
            selfVideos: canon.renderBlock(m.content || '', { picks: 2 }),
          }, persona)
          text = ensureCall(c.text, owner.call)
        } catch (e) {
          log(`  ✗ ${m.rpid} 生成失败：${String(e?.message ?? e).split('\n')[0]}`)
          fail++
          continue
        }
      }
      }
    } else {
      try {
        const c = await composeText('reply', {
          message: m.content || '',
          replyingTo: m.replying_to || '',
          video: m.on?.title || '',
          selfVideos: canon.renderBlock(m.content || m.on?.title || '', { picks: 2 }),
          memoryRecall: renderRecallBlock(m.on?.title || m.content || '', { k: 3 }),
        }, persona)
        text = c.text
      } catch (e) {
        log(`  ✗ ${m.rpid} 生成失败：${String(e?.message ?? e).split('\n')[0]}`)
        fail++
        continue
      }
    }

    if (!text) { log(`  ✗ ${m.rpid} 生成为空`); fail++; continue }

    const args = []
    if (dryRun) args.push('--dry-run')
    args.push('comment', 'reply', m.on.bvid, String(m.rpid))
    if (text.startsWith('-')) args.push('--') // 防止以 - 开头的文本被 argparse 当作选项
    args.push(text)
    if (m.root) args.push('--root', String(m.root))
    const res = runBili(args, { timeoutMs: 60000 })
    if (res.ok) {
      if (!dryRun) {
        await interact.markReply(m.rpid, { text })
        addEvent('reply', { bv: m.on?.bvid || '', rpid: m.rpid, text: `回复了《${String(m.on?.title || '').slice(0, 26)}》下的评论：${text.slice(0, 46)}` })
      }
      ok++
      log(`  ✓ ${m.rpid} ${dryRun ? 'dry-run' : '已回复'}${own ? '（主人）' : ''}：${text}`)
    } else {
      fail++
      const msg = res.error?.message || res.error?.code || '未知错误'
      log(`  ✗ ${m.rpid} 发送失败：${msg}`)
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
