/**
 * cover.mjs —— 生成 B站 封面（1146×717，16:9）
 *
 * 做法：拼一张 SVG（渐变底 + 标题大字 + 副标题 + 角标）→ 用 sharp 渲成 PNG。
 * 全本地、零依赖外部服务。字体走系统里的微软雅黑（sharp/libvips 用 fontconfig 找）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import sharp from 'sharp'

const W = 1146
const H = 717

const esc = (s) => String(s || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

/** 每个字符大约占几个 em：中文/全角 1.0，字母数字 0.58，其它 0.5 */
const widthEm = (ch) => (/[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 1 : /[A-Za-z0-9]/.test(ch) ? 0.58 : 0.5)
const textEm = (s) => [...String(s || '')].reduce((n, c) => n + widthEm(c), 0)

/**
 * 标题排版：先算真实 em 宽度决定字号；超过一行还放不下就折成两行（在标点处断）。
 * ⚠️ 第一版按"字数 × 固定系数"估，中文标题直接冲出画布右边 —— 别再用那种估法。
 */
function layoutTitle(text, avail, base) {
  const t = String(text || '').trim() || ' '
  const oneLine = Math.floor(avail / Math.max(1, textEm(t)))
  if (oneLine >= 54 || t.length < 9) {
    return { lines: [t], size: Math.min(base, Math.max(40, oneLine)) }
  }
  // 折两行：找最靠中间的标点断开
  const marks = [...t.matchAll(/[、，,：:·|｜/ ]/g)].map((m) => m.index + 1)
  const mid = t.length / 2
  const cut = marks.length
    ? marks.reduce((best, i) => (Math.abs(i - mid) < Math.abs(best - mid) ? i : best), marks[0])
    : Math.ceil(t.length / 2)
  const lines = [t.slice(0, cut).trim(), t.slice(cut).trim()].filter(Boolean)
  const maxEm = Math.max(...lines.map(textEm), 1)
  return { lines, size: Math.min(base, Math.max(36, Math.floor(avail / maxEm))) }
}

/**
 * @param {{title:string, subtitle?:string, kicker?:string, out:string}} opt
 */
export async function makeCover({ title, subtitle = '', kicker = '', out }) {
  const lay = layoutTitle(title, W - 128, 92)
  const lineHeight = Math.round(lay.size * 1.16)
  // 垂直居中：两行时整体上移一点，给副标题留位置
  const blockH = lay.lines.length * lineHeight
  const titleTop = Math.round(H / 2 - blockH / 2 + (subtitle ? -26 : 6))
  const titleSvg = lay.lines
    .map((line, i) => `<text x="64" y="${titleTop + i * lineHeight}" font-family="Microsoft YaHei, Noto Sans SC, sans-serif"
        font-size="${lay.size}" font-weight="800" fill="#ffffff" letter-spacing="-1">${esc(line)}</text>`)
    .join('\n  ')

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#080c18"/>
      <stop offset="0.55" stop-color="#0b1020"/>
      <stop offset="1" stop-color="#0a0f1e"/>
    </linearGradient>
    <radialGradient id="g1" cx="0.2" cy="0.15" r="0.75">
      <stop offset="0" stop-color="#5B8CFF" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#5B8CFF" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="g2" cx="0.9" cy="0.95" r="0.7">
      <stop offset="0" stop-color="#A78BFA" stop-opacity="0.45"/>
      <stop offset="1" stop-color="#A78BFA" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#g1)"/>
  <rect width="${W}" height="${H}" fill="url(#g2)"/>

  <!-- 角标 -->
  <g display="${kicker ? 'inline' : 'none'}">
  <rect x="64" y="58" rx="16" ry="16" width="${Math.max(140, 34 * kicker.length + 44)}" height="52"
        fill="#5B8CFF" fill-opacity="0.2" stroke="#5B8CFF" stroke-opacity="0.75" stroke-width="1.5"/>
  <text x="${64 + Math.max(140, 34 * kicker.length + 44) / 2}" y="94" text-anchor="middle"
        font-family="Microsoft YaHei, Noto Sans SC, sans-serif" font-size="26" font-weight="700" fill="#cfe0ff">${esc(kicker)}</text>

  </g>
  <!-- 标题（1–2 行，按真实宽度算字号） -->
  ${titleSvg}

  ${subtitle ? `<text x="64" y="${titleTop + blockH + 52}" font-family="Microsoft YaHei, Noto Sans SC, sans-serif"
        font-size="34" fill="rgba(255,255,255,0.68)">${esc(subtitle)}</text>` : ''}

  <!-- 底线 -->
  <rect x="64" y="${H - 96}" width="120" height="6" rx="3" fill="#5B8CFF"/>
  <text x="64" y="${H - 46}" font-family="Microsoft YaHei, Noto Sans SC, sans-serif"
        font-size="24" fill="rgba(255,255,255,0.45)">AI 生成内容</text>
</svg>`

  await sharp(Buffer.from(svg, 'utf8'))
    .resize(W, H)
    .png({ compressionLevel: 9 })
    .toFile(out)
  return out
}

/** 直接跑：node cover.mjs <run目录> */
if (process.argv[1] && process.argv[1].endsWith('cover.mjs')) {
  const dir = resolve(process.argv[2] || '')
  const script = JSON.parse(readFileSync(join(dir, 'script.json'), 'utf8'))
  const out = join(dir, 'cover.png')
  await makeCover({ title: script.title, subtitle: script.subtitle || '', out })
  console.log('封面已生成：' + out)
}
