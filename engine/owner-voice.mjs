/**
 * owner-voice.mjs —— 把已经算好的「事实答复」改写成账号人设的口吻
 *
 * 数字由本地脚本算好，模型只改语气。改写后逐个核对数字：
 *   · 少一个 / 多一个阿拉伯数字 → 判为不可靠，重试一次，再不行退回原句
 * 这样既有角色语气，又不会把「今天逛了 48 条」说成别的数。
 */
import { loadLLM } from './llmpath.mjs'

const { chat } = await loadLLM()

const numsOf = (s) => String(s || '').match(/\d+(?:\.\d+)?/g) || []

export async function voiceOwnerStats(facts, { persona = '', maxChars = 120, ownerCall = '老弟' } = {}) {
  const text = String(facts || '').trim()
  const p = String(persona || '').trim()
  if (!text || !p) return text
  const call = String(ownerCall || '老弟').trim() || '老弟'

  const need = numsOf(text)
  const needUniq = [...new Set(need)]
  const system = `你的说话身份如下：
${p}

现在把一条已经算好的事实答复改写成符合这个身份的口语回复。
硬性要求：
- 称呼对方用「${call}」（账号设置里的称呼，优先于人设里的默认称呼）。
- 所有数字、时段、单位必须原样保留：${needUniq.length ? needUniq.join('、') : '无'}，一个都不能改、不能省、不能新增。
- 用阿拉伯数字照抄，不要写成汉字数字。
- 不能新增事实，不能夸大或缩小。
- 不超过 ${maxChars} 个汉字。
- 只输出正文，不要引号、不要解释。`

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { text: raw } = await chat([
        { role: 'system', content: system },
        {
          role: 'user',
          content: `事实答复：${text}\n必须原样出现的数字：${needUniq.join('、') || '（无）'}\n`
            + (attempt ? '上一次改写数字对不上，这次只改语气，数字一个都不要动。' : '请改写。'),
        },
      ], { maxTokens: 260, temperature: attempt === 0 ? 0.7 : 0.25 })
      const clean = String(raw || '').trim()
        .replace(/^["'“”「」]+|["'“”「」]+$/g, '')
        .replace(/\s+/g, ' ')
      if (!clean || clean.length > maxChars + 20) continue
      const got = numsOf(clean)
      // “1 条”写成“一条”不算丢事实；真正要防的是把 48/42/3 这类数字说错
      // 多重集严格比对：排序后逐元素全等，防止调换顺序（如 48/42 → 42/48）或重复次数被改
      const byNum = (a, b) => Number(a) - Number(b)
      const strictNeed = need.filter((n) => Number(n) !== 1).sort(byNum)
      const strictGot = got.filter((n) => Number(n) !== 1).sort(byNum)
      const same = strictNeed.length === strictGot.length
        && strictNeed.every((n, i) => strictGot[i] === n)
      if (!same) continue
      return clean
    } catch { /* 失败就退回原句 */ }
  }
  return text
}
