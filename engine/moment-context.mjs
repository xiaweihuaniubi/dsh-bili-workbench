/** 给编导提供完整台词上下文，不再只看到被截断的金句。 */
import { readFileSync } from 'node:fs'
import { paths } from './store.mjs'

export function subtitleLines(bv) {
  if (!/^BV[a-zA-Z0-9]{10}$/.test(String(bv))) return []
  try {
    const items = JSON.parse(readFileSync(paths(bv).subs, 'utf8')).items
    return (Array.isArray(items) ? items : []).map(s => ({ from: Number(s.from), to: Number(s.to), text: String(s.content || '') }))
      .filter(s => Number.isFinite(s.from) && Number.isFinite(s.to) && s.to > s.from && s.text)
  } catch { return [] }
}

export function momentContext(row, detailed) {
  const lines = subtitleLines(row.bvid)
  const anchors = (row.quotes || []).slice(0, detailed ? 3 : 1)
  return {
    openingReference: lines.filter(s => s.from < 4).map(s => s.text).join(' ').slice(0, 160),
    moments: anchors.map(q => ({ anchor: q.t, quote: q.text,
      dialogue: lines.filter(s => s.to >= Number(q.t) - 10 && s.from <= Number(q.t) + 55)
        .slice(0, detailed ? 28 : 10).map(s => ({ ...s, text: s.text.slice(0, 80) })),
    })),
  }
}

/** B正文只允许原声；片头片尾包装不夹进正文。 */
export function validateMontage(shots) {
  if (!Array.isArray(shots) || shots[0]?.kind !== 'title' || shots.at(-1)?.kind !== 'outro') {
    throw new Error('混剪需要一个片头和一个片尾；旧方案请先改一版')
  }
  if (String(shots[0].narration || '').replace(/\s/g, '').length > 10) throw new Error('片头旁白最多10字，实际成片必须控制在3秒以内')
  if (!shots[0].narration || !shots.at(-1).narration) throw new Error('片头片尾请提供简短旁白')
  const body = shots.slice(1, -1)
  if (body.length < 2 || body.some(s => s.kind !== 'broll' || s.audioMode !== 'original' || String(s.narration || '').trim())) {
    throw new Error('混剪正文至少2段原片，必须全部original且无解说，title/outro只能在开头和结尾各出现一次')
  }
}

/** 把已选择的场景边界向完整字幕句子的外缘对齐，避免切掉半句话。 */
export function completeMomentBounds(bv, at, duration) {
  const lines = subtitleLines(bv)
  let start = Number(at)
  let end = start + Number(duration)
  const first = lines.find(s => s.from <= start + 0.15 && s.to > start + 0.1)
  if (first && start - first.from <= 5) start = first.from
  const last = lines.find(s => s.from < end - 0.05 && s.to > end + 0.05)
  if (last && last.to - end <= 5) end = last.to
  if (end - start > 180) throw new Error('完整对话超过180秒，请按场景拆分')
  return { bv, at: Number(start.toFixed(3)), duration: Number((end - start).toFixed(3)) }
}
