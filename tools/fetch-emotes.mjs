// 下载 B 站官方表情包全集到 assets-src/memes/bili-emotes/
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'assets-src', 'memes', 'bili-emotes');

// 1. 获取表情 JSON（先解析 bili 可执行文件：优先 BILI_BIN，其次 ~/.local/bin，找不到再靠 PATH）
const bili = process.env.BILI_BIN || (() => {
  const p = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'bili.exe' : 'bili');
  return existsSync(p) ? p : 'bili';
})();
const res = spawnSync(bili, ['comment', 'emotes', '--raw'], {
  encoding: 'utf8',
  windowsHide: true,
  env: { ...process.env, NO_PROXY: process.env.NO_PROXY || 'localhost,127.0.0.1,::1' },
});
if (res.error) {
  console.error(`bili 起不来（${bili}）：${res.error.message}`);
  process.exit(1);
}
const raw = (res.stdout || '') + (res.stderr || '');
const start = raw.indexOf('{');
if (start === -1) {
  console.error('未找到 JSON 输出。stdout 前缀:', raw.slice(0, 300));
  process.exit(1);
}
let json;
try {
  json = JSON.parse(raw.slice(start));
} catch (e) {
  console.error('JSON 解析失败:', e.message, '\n前缀:', raw.slice(start, start + 300));
  process.exit(1);
}
const packages = json?.data?.packages || [];
console.log(`获取到 ${packages.length} 个表情包`);

mkdirSync(outDir, { recursive: true });

const safeName = (s) =>
  (s || '').replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^[._]+|[._]+$/g, '') || '';

const index = [];
let ok = 0, fail = 0, skip = 0;
const failures = [];

async function download(url, file) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  writeFileSync(file, buf);
}

for (let pi = 0; pi < packages.length; pi++) {
  const pkg = packages[pi];
  const pkgName = safeName(pkg.text) || `pkg-${pkg.id ?? pi}`;
  const pkgDir = join(outDir, pkgName);
  mkdirSync(pkgDir, { recursive: true });
  const emotes = pkg.emote || [];
  for (let ei = 0; ei < emotes.length; ei++) {
    const em = emotes[ei];
    if (!em.url || !/^https?:\/\//i.test(em.url)) continue;
    const base = safeName((em.text || '').replace(/[\[\]【】]/g, '')) || `emote-${ei}`;
    const ext = (em.url.match(/\.(png|gif|jpe?g|webp)(?:\?|$)/i)?.[1] || 'png').toLowerCase();
    const file = join(pkgDir, `${base}.${ext}`);
    const rel = join('bili-emotes', pkgName, `${base}.${ext}`);
    index.push({ package: pkg.text || pkgName, text: em.text, url: em.url, file: rel.replace(/\\/g, '/') });
    if (existsSync(file) && statSync(file).size > 0) { skip++; continue; }
    try {
      await download(em.url, file);
      ok++;
    } catch (e) {
      fail++;
      failures.push(`${pkgName}/${base}: ${e.message}`);
      console.error(`下载失败 ${pkgName}/${base}: ${e.message}`);
    }
  }
}

writeFileSync(join(outDir, 'index.json'), JSON.stringify(index, null, 2), 'utf8');
console.log(`\n统计: 包数=${packages.length} 成功下载=${ok} 跳过(已存在)=${skip} 失败=${fail}`);
console.log(`index.json 条目: ${index.length}`);
if (failures.length) console.log('失败列表:\n' + failures.join('\n'));
