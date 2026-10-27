/** 子进程通过仅回环、随机口令的临时通道复用DSH模型，不复制账号密钥。 */
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'

export function nativeModelBridge(ctx) {
  const token = randomBytes(32).toString('hex')
  const controllers = new Set()
  const server = createServer(async (req, res) => {
    const reply = (code, body) => {
      if (res.destroyed) return
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    if (req.headers.authorization !== 'Bearer ' + token) return reply(401, { error: { message: 'unauthorized' } })
    const llm = ctx.get('llm')
    const selected = ctx.get('agentDefaultModel')?.currentSelection()
    if (!llm || !selected) return reply(503, { error: { message: 'DSH模型服务尚未就绪' } })
    if (req.method === 'GET' && req.url === '/v1/models') return reply(200, { data: [{ id: selected.model }] })
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return reply(404, {})
    const ctrl = new AbortController()
    controllers.add(ctrl)
    const timer = setTimeout(() => ctrl.abort(), 180000)
    res.on('close', () => { if (!res.writableEnded) ctrl.abort() })
    try {
      let raw = ''
      for await (const part of req) {
        raw += part.toString('utf8')
        if (raw.length > 1000000) return reply(413, { error: { message: '创作上下文过长' } })
      }
      const body = JSON.parse(raw)
      if (!Array.isArray(body.messages) || body.messages.length > 30) return reply(400, { error: { message: '模型消息格式不合法' } })
      const system = body.messages.filter(m => m.role === 'system').map(m => String(m.content || '')).join('\n\n')
      const text = body.messages.filter(m => m.role !== 'system').map(m => `${m.role === 'assistant' ? '上一版回复' : '用户要求'}：\n${String(m.content || '')}`).join('\n\n')
      let answer = ''
      let usage = null
      for await (const chunk of llm.stream({ provider: selected.provider, model: selected.model,
        system, messages: [{ role: 'user', content: [{ type: 'text', text }] }],
        maxTokens: Math.max(256, Math.min(Number(body.max_tokens) || 6000, 12000)),
        temperature: Math.max(0, Math.min(Number(body.temperature) || 0.7, 1)), signal: ctrl.signal })) {
        if (chunk.type === 'text-delta') answer += chunk.text
        if (chunk.type === 'usage') usage = chunk.usage
        if (chunk.type === 'finish' && ['error', 'aborted', 'max-tokens'].includes(chunk.reason?.kind)) {
          throw new Error(chunk.reason.failure?.message || '模型输出被截断，请缩短内容')
        }
      }
      if (!answer.trim()) throw new Error('DSH模型没有返回正文')
      reply(200, { model: selected.model, choices: [{ message: { role: 'assistant', content: answer } }], usage })
    } catch (e) {
      reply(502, { error: { message: String(e?.message || 'DSH模型调用失败').replaceAll(token, '[hidden]').slice(0, 600) } })
    } finally { clearTimeout(timer); controllers.delete(ctrl) }
  })
  let disposed = false
  const ready = new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      if (disposed) { server.close(); return }
      resolve({ BILI_OP_LLM_BASE: `http://127.0.0.1:${server.address().port}/v1`, BILI_OP_LLM_KEY: token })
    })
  })
  server.unref()
  ctx.effect(() => () => {
    disposed = true
    for (const ctrl of controllers) ctrl.abort()
    server.close()
    server.closeAllConnections?.()
  }, 'bili-workbench: native model bridge')
  return { ready }
}
