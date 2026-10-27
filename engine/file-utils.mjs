import { mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

/** 单层文件标识，不允许越出所属目录。 */
export const safeId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 200
  && !/[\\/:*?"<>|\x00-\x1f]/.test(id) && !id.includes('..') && !/[. ]$/.test(id)

/** 同目录临时文件替换，避免进程中断留下半个 JSON。 */
export function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = file + '.tmp-' + randomUUID()
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
    renameSync(temp, file)
  } finally {
    try { unlinkSync(temp) } catch { /* 已替换或未创建 */ }
  }
}

/** 单段视频 Range；返回 null 表示无法满足。 */
export function videoRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header))
  if (!m || (!m[1] && !m[2]) || size <= 0) return null
  const a = m[1] ? Number(m[1]) : null
  const b = m[2] ? Number(m[2]) : null
  if ((a !== null && !Number.isSafeInteger(a)) || (b !== null && !Number.isSafeInteger(b))) return null
  const start = a === null ? Math.max(0, size - b) : a
  const end = a === null || b === null ? size - 1 : Math.min(b, size - 1)
  return start >= size || end < start ? null : { start, end }
}
