import { safeId, writeJsonAtomic } from './file-utils.mjs'
/**
 * planstore.mjs —— 创作方案的项目化与版本化
 *
 * 目录（新格式）：
 *   <STORE>/plans/<projectId>/project.json   项目元数据（当前版本、渲染状态、审核状态）
 *   <STORE>/plans/<projectId>/v1.json        第 1 版方案（原始 plan JSON）
 *   <STORE>/plans/<projectId>/v2.json        第 2 版…
 *
 * 兼容旧格式：plans/<时间戳>.json 当成只有 v1 的只读项目，id = 文件名（不含 .json）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { STORE } from './store.mjs'

export const plansDir = () => join(STORE, 'plans')

const readJson = (f, dflt = null) => {
  try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return dflt }
}
const writeJson = (f, obj) => {
  mkdirSync(dirname(f), { recursive: true })
  writeJsonAtomic(f, obj)
}

export const projectDir = (id) => {
  if (!safeId(id)) throw new Error('项目标识不合法')
  return join(plansDir(), id)
}

const newId = () => `p-${new Date().toISOString().replace(/[:.]/g, '-')}`

export function planFile(id, v) {
  return join(projectDir(id), `v${Number(v) || 1}.json`)
}

export function getVersion(id, v) {
  if (!safeId(id)) return null
  // 旧格式：id 本身就是 plans 下的文件名
  if (!existsSync(projectDir(id))) {
    const legacy = join(plansDir(), `${id}.json`)
    if (existsSync(legacy)) return readJson(legacy)
    return null
  }
  return readJson(planFile(id, v))
}

export function getProject(id) {
  if (!safeId(id)) return null
  const dir = projectDir(id)
  if (!existsSync(dir)) {
    const legacy = join(plansDir(), `${id}.json`)
    if (!existsSync(legacy)) return null
    const plan = readJson(legacy)
    if (!plan) return null
    return {
      id, legacy: true, title: plan.title || '', brief: plan.brief || '',
      createdAt: plan.createdAt || '', updatedAt: plan.createdAt || '',
      currentVersion: 1, versions: [{ v: 1, createdAt: plan.createdAt || '', title: plan.title || '', instruction: '', changed: '初版', stats: plan.stats || {} }],
      stage: 'draft', runDir: '', review: null,
    }
  }
  const p = readJson(join(dir, 'project.json'))
  return p || null
}

export function saveProject(p) {
  p.updatedAt = new Date().toISOString()
  writeJson(join(projectDir(p.id), 'project.json'), p)
  return p
}

/** 新项目：v1 + project.json */
export function createProject(plan, { brief } = {}) {
  mkdirSync(plansDir(), { recursive: true })
  const id = newId()
  const now = new Date().toISOString()
  const project = {
    id,
    title: plan.title || '未命名',
    brief: brief || plan.brief || '',
    style: plan.style,
    customStyle: plan.customStyle || '',
    createdAt: now,
    updatedAt: now,
    currentVersion: 1,
    versions: [{
      v: 1,
      createdAt: now,
      title: plan.title || '',
      instruction: '',
      changed: '初版',
      stats: plan.stats || {},
    }],
    stage: 'draft',          // draft | rendering | rendered | approved | rejected | published
    runDir: '',
    review: null,
  }
  writeJson(planFile(id, 1), plan)
  saveProject(project)
  return project
}

/** 追加一版（改一版）：vN + 更新 currentVersion */
export function addVersion(id, plan, { instruction = '' } = {}) {
  const project = getProject(id)
  if (!project) throw new Error('项目不存在')
  if (project.legacy) throw new Error('旧格式方案不能改版（先复制成新项目）')
  const v = Math.max(...project.versions.map((x) => Number(x.v) || 0)) + 1
  const now = new Date().toISOString()
  writeJson(planFile(id, v), plan)
  project.versions.push({
    v,
    createdAt: now,
    title: plan.title || '',
    instruction: String(instruction || '').slice(0, 200),
    changed: String(plan.changed || '').slice(0, 120) || `按指令改了第 ${v} 版`,
    stats: plan.stats || {},
  })
  project.style = plan.style
  project.customStyle = plan.customStyle || ''
  project.currentVersion = v
  project.title = plan.title || project.title
  project.stage = 'draft'
  project.review = null
  saveProject(project)
  return project
}

/** 删除项目：新格式删整个项目目录；旧格式删 plans/<id>.json */
export function deleteProject(id) {
  const p = getProject(id)
  if (!p) return false
  if (p.legacy) {
    const f = join(plansDir(), `${id}.json`)
    if (existsSync(f)) unlinkSync(f)
    return true
  }
  rmSync(projectDir(id), { recursive: true, force: true })
  return true
}

/** 给「在对话里接着聊」用的提示词：当前选题/大纲/选料一次打包 */
export function promptFor(id, v) {
  const p = getProject(id)
  if (!p) throw new Error('项目不存在')
  const plan = getVersion(id, v || p.currentVersion)
  if (!plan) throw new Error('方案不存在')
  const shots = (plan.shots || []).map((s, i) => {
    const src = s.source ? `｜引用 ${s.source.bv} @${Math.round(s.source.t)}s${s.source.quote ? `「${s.source.quote}」` : ''}` : ''
    return `${i + 1}. [${s.kind}] ${s.headline || ''}${s.body ? ` — ${s.body}` : ''}${src}\n   旁白：${s.narration || ''}`
  }).join('\n')
  const picks = (plan.picks || []).map((x) => `- ${x.bv}（${x.use}）${x.why}`).join('\n')
  return `接着聊这期片子（素材库项目 ${id} 的 v${v || p.currentVersion}）。\n\n`
    + `标题：${plan.title || ''}\n副标题：${plan.subtitle || ''}\n角度：${plan.angle || ''}\n需求：${plan.brief || ''}\n\n`
    + `选料：\n${picks || '（无）'}\n\n分镜：\n${shots}\n\n`
    + `接着改：`
}

/** 列表：新格式 + 旧格式，按更新时间倒序 */
export function listProjects() {
  if (!existsSync(plansDir())) return []
  const out = []
  for (const name of readdirSync(plansDir())) {
    if (name.startsWith('.tmp-')) continue // 原子写的临时文件，不是项目
    const p = join(plansDir(), name)
    if (statSync(p).isDirectory()) {
      const project = getProject(name)
      if (project) out.push({ ...project, legacy: false })
    } else if (name.endsWith('.json')) {
      const id = name.replace(/\.json$/, '')
      const project = getProject(id)
      if (project) out.push(project)
    }
  }
  out.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
  return out
}
