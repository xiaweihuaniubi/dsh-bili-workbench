/**
 * compose.mjs —— 生成一条评论 / 回复 / 私信草稿（只生成文本，不发送）
 *
 *   node compose.mjs --kind comment --context '{"title":"…","quotes":["…"]}'
 *   node compose.mjs --kind reply --context '{"message":"…","replyingTo":"…"}'
 *   node compose.mjs --kind dm --context '{"message":"…","user":"…"}'
 *
 * 输出一行 JSON：{"ok":true,"text":"…","model":"…"}
 */
import { composeText } from './compose-lib.mjs'

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt
}

const kind = ['comment', 'reply', 'dm'].includes(arg('kind', 'comment')) ? arg('kind', 'comment') : 'comment'
let ctx = {}
try { ctx = JSON.parse(arg('context', '{}')) } catch { ctx = {} }
const persona = String(process.env.BILI_OP_PERSONA || arg('persona', '')).trim()

try {
  const { text, model } = await composeText(kind, ctx, persona)
  console.log(JSON.stringify({ ok: Boolean(text), text, model }))
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e).split('\n')[0] }))
  process.exit(1)
}
