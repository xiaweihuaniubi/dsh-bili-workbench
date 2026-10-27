import { safeId, writeJsonAtomic } from './file-utils.mjs'
/**
 * taskstore.mjs —— 长任务账本（素材不够就自己去 B站找）
 *
 *   <STORE>/tasks.json
 *
 * 一条任务：
 *   { id, brief, topic, kind, keywords[], queries[], queryIdx,
 *     status, needed, matched, matchedBvs[], projectId, planTitle,
 *     attempts, createdAt, updatedAt, deadline, nextRunAt,
 *     intervalMinutes, maxDays, lastError, log[] }
 *
 * 状态：queued / checking / collecting / short / planning / ready / failed / paused
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { STORE } from './store.mjs'
import { creativeOptions } from './creative.mjs'

const MAX_TASKS = 40
const MAX_LOG = 24

export const taskFile = () => join(STORE, 'tasks.json')

function readAll() {
  try {
    const j = JSON.parse(readFileSync(taskFile(), 'utf8'))
    return Array.isArray(j?.tasks) ? j.tasks : []
  } catch { return [] }
}

function writeAll(tasks) {
  mkdirSync(dirname(taskFile()), { recursive: true })
  writeJsonAtomic(taskFile(), { version: 1, tasks: tasks.slice(0, MAX_TASKS) })
}

export function list() {
  const tasks = readAll()
  tasks.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
  return tasks
}

export function get(id) {
  return readAll().find((t) => t.id === String(id)) || null
}

export const newId = () => `t-${new Date().toISOString().replace(/[:.]/g, '-')}`

export function create({ brief, maxDays = 5, intervalMinutes = 180, needed = 1, style = 'A', customStyle = '' } = {}) {
  const now = new Date()
  const task = {
    id: newId(),
    ...creativeOptions({ style, customStyle }),
    brief: String(brief || '').trim().slice(0, 300),
    topic: '',
    kind: '',
    keywords: [],
    queries: [],
    queryIdx: 0,
    status: 'queued',
    needed: Math.max(1, Math.min(Number(needed) || 1, 6)),
    matched: 0,
    matchedBvs: [],
    projectId: '',
    planTitle: '',
    attempts: 0,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    deadline: new Date(now.getTime() + Math.max(1, Number(maxDays) || 5) * 86400_000).toISOString(),
    nextRunAt: now.toISOString(),
    intervalMinutes: Math.max(15, Math.min(Number(intervalMinutes) || 180, 1440)),
    maxDays: Math.max(1, Number(maxDays) || 5),
    lastError: '',
    log: [],
  }
  const tasks = readAll()
  tasks.unshift(task)
  writeAll(tasks)
  return task
}

export function update(id, patch = {}) {
  const tasks = readAll()
  const i = tasks.findIndex((t) => t.id === String(id))
  if (i < 0) return null
  const next = { ...tasks[i], ...patch, updatedAt: new Date().toISOString() }
  tasks[i] = next
  writeAll(tasks)
  return next
}

export function addLog(id, text) {
  const tasks = readAll()
  const i = tasks.findIndex((t) => t.id === String(id))
  if (i < 0) return null
  const line = { at: new Date().toISOString(), text: String(text || '').slice(0, 240) }
  const log = [...(tasks[i].log || []), line].slice(-MAX_LOG)
  tasks[i] = { ...tasks[i], log, updatedAt: line.at }
  writeAll(tasks)
  return tasks[i]
}

export function remove(id) {
  const tasks = readAll()
  const next = tasks.filter((t) => t.id !== String(id))
  if (next.length === tasks.length) return false
  writeAll(next)
  return true
}

/** 未结束的任务（含 paused，便于 UI 显示） */
export function active() {
  return list().filter((t) => !['ready', 'failed'].includes(t.status))
}

/** 现在该跑的任务：到点、未结束、未暂停 */
export function due(now = Date.now()) {
  return list()
    .filter((t) => ['queued', 'checking', 'collecting', 'short'].includes(t.status))
    .filter((t) => {
      const at = Date.parse(t.nextRunAt || t.createdAt || '')
      return !Number.isFinite(at) || at <= now
    })
    .sort((a, b) => String(a.nextRunAt || '').localeCompare(String(b.nextRunAt || '')))
}
