/** 投稿协调：接受投稿不等于平台已发布；未知结果不自动重投。 */
import { existsSync, statSync } from 'node:fs'
import * as renders from './render.mjs'
import * as plans from './planstore.mjs'
import { runBiliAsync } from './bili.mjs'

export const submittedStages = new Set(['submitted', 'published', 'platform_rejected', 'uploading', 'upload_unknown'])
const bvPattern = /^BV[a-zA-Z0-9]{10}$/
export function isCurrentRun(project, runId, status) {
  const current = String(project?.runDir || '').split(/[\\/]/).pop()
  return current === runId && Number(project?.currentVersion) === Number(status?.projectVersion || project?.renderVersion)
}
/** CLI在预上传/参数检查阶段明确拒绝，表示没有创建稿件；网络异常仍属未知。 */
export function definiteUploadRefusal(error) {
  const message = typeof error === 'string' ? error : String(error?.message || '')
  return message.startsWith('B 站拒绝了上传：') || ['invalid_argument', 'permission_denied', 'captcha_required'].includes(error?.code)
}
export function displayPublicationStage(status) {
  if (!status.bvid && !status.upload?.bvid && !status.upload?.submittedAt && !status.upload?.checkedAt &&
      ['upload_unknown', 'uploading'].includes(status.stage) && definiteUploadRefusal(status.upload?.error)) {
    return status.review?.state === 'approved' ? 'approved' : 'rendered'
  }
  if (status.stage === 'published' && !status.upload?.checkedAt) return status.bvid ? 'submitted' : 'upload_unknown'
  return status.stage
}
export function platformStage(data) {
  if (Number.isInteger(data.state) && data.state === 0) return 'published'
  if (data.reject_reason) return 'platform_rejected'
  return 'submitted'
}

export function createPublisher({ renderStore = renders, projectStore = plans, execute = runBiliAsync, onEvent = () => {} } = {}) {
  const busy = new Set()
  const update = (runId, status, stage, patch) => {
    const next = renderStore.setStage(runId, stage, patch)
    if (status.projectId) {
      const project = projectStore.getProject(status.projectId)
      if (project && isCurrentRun(project, runId, status)) {
        project.stage = stage
        if (next.bvid) project.publishedBvid = next.bvid
        projectStore.saveProject(project)
      }
    }
    return next
  }
  const check = (runId) => {
    const status = renderStore.readStatus(runId)
    if (!status) throw new Error('成片不存在')
    if (busy.has(runId)) throw new Error('这条成片正在投稿或同步状态，请勿重复操作')
    return { ...status, stage: displayPublicationStage(status) }
  }
  async function upload(body, cfg) {
    const runId = String(body.runId || '')
    let status
    try { status = check(runId) } catch (e) { return { ok: false, error: e.message } }
    const dryRun = body.dryRun !== false
    const video = renderStore.mediaPath(runId, 'video')
    if (!video || !existsSync(video) || statSync(video).size === 0) return { ok: false, error: '没有完整成片文件' }
    if (!dryRun) {
      if (!cfg.publishEnabled || body.confirm !== true) return { ok: false, error: '真投稿需要开启权限并二次确认' }
      if (status.bvid || status.upload?.bvid || submittedStages.has(status.stage)) return { ok: false, error: '已提交或结果待确认，请先同步平台状态，不能重复投稿' }
      if (status.stage !== 'approved' || status.review?.state !== 'approved') return { ok: false, error: '先点「通过」再投稿' }
    }
    const inputTags = Array.isArray(body.tags) ? body.tags : cfg.defaultTags
    const tags = [...new Set((Array.isArray(inputTags) ? inputTags : []).map(String).map(s => s.trim()).filter(Boolean))].slice(0, 10)
    if (!tags.length) return { ok: false, error: '至少一个标签' }
    const title = String(body.title || status.title || '未命名').trim().slice(0, 80)
    const args = dryRun ? ['--dry-run'] : []
    args.push('upload', 'video', video, '--title', title)
    for (const tag of tags) args.push('--tag', tag)
    const desc = String(body.desc || status.subtitle || '').slice(0, 1500)
    if (desc) args.push('--desc', desc)
    const cover = renderStore.mediaPath(runId, 'cover')
    if (cover && existsSync(cover)) args.push('--cover', cover)
    const zone = Number(body.zone || cfg.defaultZone)
    if (zone) {
      if (!Number.isInteger(zone) || zone < 1) return { ok: false, error: '分区ID必须为正整数' }
      args.push('--zone', String(zone))
    }
    busy.add(runId)
    const startedAt = new Date().toISOString()
    try {
      if (!dryRun) status = update(runId, status, 'uploading', { upload: { phase: 'uploading', startedAt, title } })
      const result = await execute(args, { timeoutMs: 15 * 60_000 })
      const response = { ...result, dryRun, command: ['bili', ...args] }
      if (dryRun) {
        if (result.ok && result.data?.dry_run !== true) return { ...response, ok: false, error: 'CLI没有确认dry-run，未修改投稿状态，请人工核对' }
        return response
      }
      if (result.ok && result.data?.dry_run === true) {
        update(runId, status, 'approved', { upload: { phase: 'dry_run', startedAt, endedAt: new Date().toISOString(), title } })
        return { ...response, dryRun: true, text: 'CLI实际执行的是预演，没有投稿' }
      }
      const bvid = String(result.data?.bvid || result.data?.data?.bvid || '')
      if (result.ok && bvPattern.test(bvid)) {
        update(runId, status, 'submitted', { bvid, upload: { phase: 'submitted', bvid, title, startedAt, submittedAt: new Date().toISOString() } })
        try { onEvent('submit', { runId, bvid, title }) } catch { /* 日志失败不能把已接收的投稿改成失败 */ }
        return { ...response, stage: 'submitted', text: '投稿已提交，平台审核及发布状态需同步确认' }
      }
      const detail = result.error?.message || (typeof result.error === 'string' ? result.error : '') || '未获得有效BV号'
      if (!bvid && definiteUploadRefusal(result.error)) {
        update(runId, status, 'approved', { upload: { phase: 'refused', startedAt, title, error: detail, errorCode: result.error?.code || '', endedAt: new Date().toISOString() } })
        return { ...response, ok: false, stage: 'approved', error: '投稿未提交：' + detail }
      }
      update(runId, status, 'upload_unknown', { upload: { phase: 'unknown', startedAt, title, error: detail, endedAt: new Date().toISOString() } })
      return { ...response, ok: false, error: '投稿结果待确认：' + detail + '。请先核对创作中心，避免重复投稿。' }
    } catch (e) {
      if (!dryRun) {
        try { update(runId, status, 'upload_unknown', { upload: { phase: 'unknown', startedAt, title, error: String(e.message), endedAt: new Date().toISOString() } }) } catch { /* 原uploading记录保留，阻止盲目重投 */ }
      }
      return { ok: false, dryRun, error: String(e.message || e) }
    } finally { busy.delete(runId) }
  }
  async function sync(body) {
    const runId = String(body.runId || '')
    let status
    try { status = check(runId) } catch (e) { return { ok: false, error: e.message } }
    const stored = status.bvid || status.upload?.bvid
    const bvid = String(stored || body.bvid || '')
    if (!bvPattern.test(bvid)) return { ok: false, error: '没有有效BV号，请先到创作中心核对' }
    if (!stored && !['upload_unknown', 'uploading'].includes(status.stage)) return { ok: false, error: '此作品尚未提交投稿' }
    busy.add(runId)
    try {
      const result = await execute(['upload', 'status', bvid], { timeoutMs: 60000 })
      if (!result.ok) return result
      if (result.data?.bvid !== bvid || !Number.isInteger(result.data?.state)) return { ok: false, error: '平台状态响应缺少BV或有效状态码，保留原状态' }
      const stage = platformStage(result.data)
      const upload = { ...status.upload, bvid, phase: stage, platformState: result.data.state,
        platformDescription: String(result.data.state_desc || ''), rejectReason: result.data.reject_reason || '',
        private: Boolean(result.data.private), checkedAt: new Date().toISOString() }
      update(runId, status, stage, { bvid, upload })
      return { ok: true, stage, bvid, data: result.data, status: renderStore.readStatus(runId) }
    } catch (e) { return { ok: false, error: String(e.message || e) } }
    finally { busy.delete(runId) }
  }
  function retry(body) {
    const runId = String(body.runId || '')
    try {
      const status = check(runId)
      if (body.confirmNotSubmitted !== true || !['upload_unknown', 'uploading'].includes(status.stage) || status.bvid || status.upload?.bvid) return { ok: false, error: '仅能在人工确认创作中心没有稿件后解除未知状态' }
      update(runId, status, 'approved', { review: { ...status.review, state: 'approved' }, upload: { ...status.upload, phase: 'retry_ready', manuallyConfirmedAt: new Date().toISOString() } })
      return { ok: true }
    } catch (e) { return { ok: false, error: String(e.message || e) } }
  }
  return { upload, sync, retry, isBusy: runId => busy.has(runId), anyBusy: () => busy.size > 0 }
}
