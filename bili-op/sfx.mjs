/**
 * sfx.mjs —— 转场音效选配
 *
 * 从本地 Kenney 音效库（CC0）里为每个镜头的转场挑一个短音效。
 * 映射写死；音效文件缺失就跳过该项，绝不抛错。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

// 音效库根目录（项目根布局：bili-op/../assets-src）
const SFX_ROOT = join(HERE, '..', 'assets-src', 'sfx', 'kenney')

/** 转场 → 音效文件（相对 SFX_ROOT 的绝对定位）。fade 不配音效。 */
const SFX_MAP = {
  slide:   join(SFX_ROOT, 'casino-audio', 'Audio', 'card-slide-1.ogg'),      // 滑动 → 卡牌滑动
  blinds:  join(SFX_ROOT, 'jingle-audio', 'OGG', 'jingles_HIT', 'jingles_HIT00.ogg'), // 百叶窗 → 拍击音（均值高、峰值有余量）
  wipe:    join(SFX_ROOT, 'interface-sounds', 'Audio', 'scratch_001.ogg'),   // 擦除 → 刮擦
  zoom:    join(SFX_ROOT, 'sci-fi-sounds', 'Audio', 'laserLarge_000.ogg'),   // 缩放 → 冲刺
  dissolve: join(SFX_ROOT, 'interface-sounds', 'Audio', 'glass_001.ogg'),    // 溶解 → 玻璃轻响
}

/**
 * pickSfxes(props) → [{ file, atSec }]
 * props: { shots: [{ transition, from }], fps: 30 }
 */
export function pickSfxes(props) {
  const fps = Number(props?.fps) || 30
  const shots = Array.isArray(props?.shots) ? props.shots : []
  const out = []
  for (const shot of shots) {
    const t = shot?.transition
    if (!t || t === 'fade') continue
    const file = SFX_MAP[t]
    if (!file || !existsSync(file)) continue
    const from = Number(shot?.from)
    if (!Number.isFinite(from)) continue
    out.push({ file, atSec: from / fps })
  }
  return out
}
