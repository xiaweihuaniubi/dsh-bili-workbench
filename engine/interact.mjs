/**
 * interact.mjs —— 互动账本（评论 / 回复 / 私信）
 *
 * 为什么单独记：
 *   · 素材卡上的「已评论」要能跨进程/跨重启显示
 *   · 每日上限必须硬钳，不能靠面板记
 *
 * 文件：<STORE>/interactions.json
 *   {
 *     "daily": { "2026-10-23": { "comments": 1, "replies": 0, "dms": 2 } },
 *     "commented": { "BV…": { "at": "...", "rpid": 123, "text": "..." } },
 *     "replied": { "rpid": { "at": "...", "text": "..." } },
 *     "dm": { "uid": { "at": "...", "text": "..." } }
 *   }
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { STORE } from './store.mjs'
import { withLock } from './memory.mjs'

const file = () => join(STORE, 'interactions.json')
const EMPTY = { daily: {}, commented: {}, replied: {}, dm: {} }

export const today = () => new Date().toLocaleDateString('sv-SE')

export function load() {
  try {
    const j = JSON.parse(readFileSync(file(), 'utf8'))
    return { ...EMPTY, ...j, daily: j.daily || {}, commented: j.commented || {}, replied: j.replied || {}, dm: j.dm || {} }
  } catch { return JSON.parse(JSON.stringify(EMPTY)) }
}

function save(db) {
  mkdirSync(dirname(file()), { recursive: true })
  writeFileSync(file(), JSON.stringify(db, null, 2), 'utf8')
  return db
}

export function dayCounts(day = today()) {
  const db = load()
  return { comments: 0, replies: 0, dms: 0, ...(db.daily[day] || {}) }
}

export const isCommented = (bv) => Boolean(load().commented[String(bv || '')])

export function commentedMap() {
  const db = load()
  return db.commented
}

function bump(db, kind) {
  const day = today()
  db.daily[day] = { comments: 0, replies: 0, dms: 0, ...(db.daily[day] || {}) }
  db.daily[day][kind] = (db.daily[day][kind] || 0) + 1
}

// 写操作全部走 withLock（<store>/memory/.lock 目录锁，跨进程互斥），避免并发 load→改→save 丢更新
export function markComment(bv, { rpid = 0, text = '' } = {}) {
  return withLock(async () => {
    const db = load()
    db.commented[String(bv)] = { at: new Date().toISOString(), rpid, text: String(text).slice(0, 200) }
    bump(db, 'comments')
    return save(db)
  })
}

export function markReply(rpid, { text = '' } = {}) {
  return withLock(async () => {
    const db = load()
    db.replied[String(rpid)] = { at: new Date().toISOString(), text: String(text).slice(0, 200) }
    bump(db, 'replies')
    return save(db)
  })
}

export function markDm(uid, { text = '' } = {}) {
  return withLock(async () => {
    const db = load()
    db.dm[String(uid)] = { at: new Date().toISOString(), text: String(text).slice(0, 200) }
    bump(db, 'dms')
    return save(db)
  })
}

/** 发之前检查上限；返回 null 表示可以发，否则返回原因 */
export function checkCap(kind, cfg) {
  return withLock(async () => {
    const c = dayCounts()
    if (kind === 'comment') {
      const cap = Math.max(0, Number(cfg.perDay) || 0)
      if (cap > 0 && c.comments >= cap) return `今天的评论上限已到（${c.comments}/${cap}）`
    }
    if (kind === 'reply') {
      const cap = Math.max(0, Number(cfg.replyPerDay) || 0)
      if (cap > 0 && c.replies >= cap) return `今天的回复上限已到（${c.replies}/${cap}）`
    }
    if (kind === 'dm') {
      const cap = Math.max(0, Number(cfg.dmReplyPerDay) || 0)
      if (cap > 0 && c.dms >= cap) return `今天的私信上限已到（${c.dms}/${cap}）`
    }
    return null
  })
}
