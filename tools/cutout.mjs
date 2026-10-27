#!/usr/bin/env node
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);

function getArg(name) {
  const i = args.indexOf(name);
  if (i === -1 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

const inArg = getArg('--in');
if (!inArg) {
  console.error('[cutout] 错误：缺少必填参数 --in <图片路径>');
  process.exit(1);
}

const inAbs = path.resolve(inArg);
if (!existsSync(inAbs)) {
  console.error(`[cutout] 错误：输入文件不存在：${inAbs}`);
  process.exit(1);
}

const outArg = getArg('--out');
const outAbs = outArg
  ? path.resolve(outArg)
  : path.join(
      path.dirname(inAbs),
      path.basename(inAbs, path.extname(inAbs)) + '.cutout.png'
    );

const res = spawnSync('rembg', ['i', inAbs, outAbs], {
  encoding: 'utf8',
  windowsHide: true,
  timeout: 300000,
});

const failed =
  res.error || res.status !== 0 || !existsSync(outAbs) || statSync(outAbs).size === 0;

if (failed) {
  console.error('[cutout] 失败：rembg 退出码', res.status, res.error ? String(res.error) : '');
  const tail = (res.stderr || res.stdout || '').trim().split(/\r?\n/).slice(-5).join('\n');
  if (tail) console.error('[cutout] stderr 尾部：\n' + tail);
  process.exit(1);
}

console.log(`[cutout] 完成：${outAbs}（${statSync(outAbs).size} 字节）`);
process.exit(0);
