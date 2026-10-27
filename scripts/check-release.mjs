import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let checked = 0
function walk(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'runs', 'public'].includes(ent.name)) continue
    const file = join(dir, ent.name)
    if (ent.isDirectory()) walk(file)
    else if (/\.(mjs|js)$/.test(ent.name)) {
      const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
      if (r.status !== 0) throw new Error(r.stderr || '语法检查失败')
      checked++
    }
  }
}
walk(root)
if (!/llmKey:\s*''/.test(readFileSync(join(root, 'index.js'), 'utf8'))) throw new Error('发布版默认密钥必须留空')
for (const file of ['bili-op/render/src/index.tsx', 'bili-op/render/public/mascot/default.png', 'bili-op/render/public/mascot/partner.png']) {
  if (!existsSync(join(root, file))) throw new Error('缺少发布必需文件：' + file)
}
console.log('语法与发布文件核对通过，共 ' + checked + ' 个 JS 文件；不代表账号或出片业务验证。')
