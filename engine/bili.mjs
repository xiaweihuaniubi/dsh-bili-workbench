/**
 * bili.mjs —— 调本机 `bili` 命令（工作台引擎用）
 * 和面板那半端同一套规矩：强制 UTF-8、失败也解析 stdout 里的 {ok:false,error}。
 */
import { spawnSync, execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * 环境清洗：绕开 bili-cli 的一个 bug。
 *
 * 本机 NO_PROXY 里带 `[::1]`（IPv6 回环的方括号写法）。`bili auth login` 会把它
 * 当成 "host:port" 解析，直接崩：
 *   InvalidURL: Invalid port: ':1]'
 * 复现范围很窄 —— 只有 auth login 这一步，其他命令都正常。但面板的「扫码登录」
 * 正好走它，所以在这里统一把方括号形式摘掉（保留 `::1`，语义不变）。
 *
 * 只动子进程环境，不改用户系统变量；也没必要因为别人的 bug 让整台机器变形。
 */
function cleanEnv() {
  const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
  for (const k of ['NO_PROXY', 'no_proxy']) {
    const v = env[k]
    if (!v || !v.includes('[::1]')) continue
    env[k] = v.split(',')
      .map((s) => s.trim())
      .filter((s) => s && s !== '[::1]')
      .join(',')
  }
  return env
}

export function biliBin() {
  const env = process.env.BILI_BIN
  if (env) return env
  const exe = process.platform === 'win32' ? 'bili.exe' : 'bili'
  const local = join(homedir(), '.local', 'bin', exe)
  return existsSync(local) ? local : 'bili'
}

export function runBili(args, { timeoutMs = 60000 } = {}) {
  const t0 = Date.now()
  const r = spawnSync(biliBin(), args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    env: cleanEnv(),
  })
  const out = String(r.stdout || '').trim()
  let parsed = null
  try { parsed = JSON.parse(out) } catch {
    const lines = out.split(/\r?\n/).filter((l) => l.trim().startsWith('{'))
    for (let i = lines.length - 1; i >= 0 && parsed === null; i--) {
      try { parsed = JSON.parse(lines[i]) } catch { /* 往上继续找 */ }
    }
  }
  const ms = Date.now() - t0
  if (!parsed) {
    return { ok: false, data: null, error: { code: 'no_json', message: (r.stderr || out || 'no output').slice(0, 300) }, ms }
  }
  return { ok: parsed.ok === true, data: parsed.data || null, error: parsed.error || null, ms }
}

/** 宿主查询异步等待CLI，避免阻塞整个工作台的HTTP和渲染进度。 */
export function runBiliAsync(args, { timeoutMs = 60000 } = {}) {
  const started = Date.now()
  return new Promise((resolve) => {
    execFile(biliBin(), args, {
      encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024,
      windowsHide: true, env: cleanEnv(),
    }, (error, stdout, stderr) => {
      const out = String(stdout || '').trim()
      let parsed = null
      try { parsed = JSON.parse(out) } catch {
        for (const line of out.split(/\r?\n/).reverse()) {
          try { parsed = JSON.parse(line); break } catch { /* 下一行 */ }
        }
      }
      const ms = Date.now() - started
      if (error) {
        return resolve({ ok: false, data: parsed?.data || null, error: parsed?.error || {
          code: error.killed ? 'timeout' : 'process_error',
          message: String(stderr || error.message || '命令执行失败').slice(-500),
        }, ms })
      }
      if (!parsed || typeof parsed !== 'object') {
        return resolve({ ok: false, data: null, error: { code: 'no_json', message: String(stderr || out || 'no output').slice(-300) }, ms })
      }
      resolve({ ok: parsed.ok === true, data: parsed.data || null, error: parsed.error || null, ms })
    })
  })
}

/** B站 公开接口拿封面（bili 的 video info 里没有 pic 字段） */
export async function fetchCover(bv) {
  const r = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) bili-workbench',
      referer: 'https://www.bilibili.com/',
    },
  })
  if (!r.ok) return null
  const j = await r.json()
  const pic = j?.data?.pic
  if (!pic) return null
  const img = await fetch(String(pic).replace(/^http:/, 'https:'), {
    headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/' },
  })
  if (!img.ok) return null
  return Buffer.from(await img.arrayBuffer())
}
