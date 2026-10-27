/**
 * bili.mjs —— 调本机 `bili` 命令的小封装（给引擎用，不经过面板）
 *
 * 和面板那半端同一套规矩：
 *  · Windows 上 Python 往管道写会按 GBK ⇒ 塞 PYTHONUTF8=1 / PYTHONIOENCODING=utf-8
 *  · `bili` 失败时退出码非 0，但 stdout 里仍有 {ok:false,error:{code,hint}} ⇒ 照样解析
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export function biliBin() {
  const env = process.env.BILI_BIN
  if (env) return env
  const exe = process.platform === 'win32' ? 'bili.exe' : 'bili'
  const local = join(homedir(), '.local', 'bin', exe)
  return existsSync(local) ? local : 'bili'
}

/** 跑一条 bili 命令，返回 {ok, data, error, raw} */
export function runBili(args, { timeoutMs = 40000 } = {}) {
  const r = spawnSync(biliBin(), args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  })
  const out = String(r.stdout || '').trim()
  let parsed = null
  try { parsed = JSON.parse(out) } catch {
    const lines = out.split(/\r?\n/).filter((l) => l.trim().startsWith('{'))
    for (let i = lines.length - 1; i >= 0 && parsed === null; i--) {
      try { parsed = JSON.parse(lines[i]) } catch { /* 继续往上找 */ }
    }
  }
  if (!parsed) {
    return { ok: false, data: null, error: { code: 'no_json', message: (r.stderr || out || 'no output').slice(0, 300) }, raw: out }
  }
  return { ok: parsed.ok === true, data: parsed.data || null, error: parsed.error || null, raw: out }
}

/** 热门标题 + 推荐理由，给"自动选题"用 */
export function hotTitles(size = 24) {
  const r = runBili(['hot', 'popular', '--size', String(size), '--unseen'])
  const items = (r.data && r.data.items) || []
  return items.map((x) => ({
    title: String(x.title || ''),
    up: x.author && (x.author.name || x.author.mid),
    reason: String(x.reason || ''),
    views: x.stat && x.stat.view,
    bvid: x.bvid,
  }))
}
