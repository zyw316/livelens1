/**
 * cache-bust.mjs —— 给所有相对 import 加上版本号查询串，解决「部署后浏览器仍用旧模块」。
 *
 * 背景：
 *   本项目是零构建的原生 ES Module 站点，模块路径固定（src/main.js、src/ui/xxx.js…）。
 *   静态托管（python -m http.server）只发 Last-Modified，不发 Cache-Control，
 *   浏览器会按启发式规则缓存模块（约为“文件年龄”的 10%，可达数小时）。
 *   于是重新部署后，访问者仍可能拿到旧版模块，表现像是“功能被改坏了”。
 *
 * 用法：
 *   node tools/cache-bust.mjs 20261020c       # 打版本号（改代码后换一个新版本号）
 *   node tools/cache-bust.mjs --check         # 只检查当前是否一致，不写文件
 *
 * 说明：
 *   - 只处理相对路径（./ 或 ../）且以 .js 结尾的静态 import / export ... from。
 *   - 动态 import('...') 只在参数是字符串字面量且为相对路径时处理。
 *   - CDN 等绝对 URL 不处理。
 *   - 幂等：已有 ?v= 的会替换成新版本号，不会叠加。
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url)); // tools/
const PROJECT = dirname(ROOT);
const SRC = join(PROJECT, 'src');
const INDEX = join(PROJECT, 'index.html');

const relSpec = String.raw`(?:\.{1,2}\/[^'"]+\.js)`;
const fromRe = new RegExp(String.raw`(\bfrom\s*['"])(${relSpec})(\?v=[^'"]*)?(['"])`, 'g');
const dynRe = new RegExp(String.raw`(\bimport\s*\(\s*['"])(${relSpec})(\?v=[^'"]*)?(['"]\s*\))`, 'g');

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(p));
    else if (extname(entry.name) === '.js') out.push(p);
  }
  return out;
}

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const version = args.find((a) => !a.startsWith('--'));

if (!checkOnly && !version) {
  console.error('用法: node tools/cache-bust.mjs <版本号>   或   node tools/cache-bust.mjs --check');
  process.exit(1);
}

const files = [...(await walk(SRC)), INDEX];
let changed = 0;
let stale = 0;

for (const file of files) {
  const before = await readFile(file, 'utf8');
  let after = before;

  if (checkOnly) {
    const m = after.match(/\?v=([0-9A-Za-z_.-]+)/);
    if (m) { /* 已带版本号，交给下面统一比对 */ }
    // 检查是否所有相对 import 都带同一个版本号
    const specs = [...after.matchAll(fromRe)].concat([...after.matchAll(dynRe)]);
    const missing = specs.filter((s) => !s[3]);
    if (missing.length) { stale++; continue; }
    const versions = new Set([...after.matchAll(/\?v=([0-9A-Za-z_.-]+)/g)].map((x) => x[1]));
    if (versions.size > 1) { stale++; continue; }
    continue;
  }

  if (file === INDEX) {
    after = after.replace(/(<script\s+type="module"\s+src=")([^"?]+\.js)(\?v=[^"]*)?(")/g,
      (_m, a, b, _old, c) => `${a}${b}?v=${version}${c}`);
  } else {
    after = after
      .replace(fromRe, (_m, a, b, _old, c) => `${a}${b}?v=${version}${c}`)
      .replace(dynRe, (_m, a, b, _old, c) => `${a}${b}?v=${version}${c}`);
  }

  if (after !== before) {
    await writeFile(file, after, 'utf8');
    changed++;
  }
}

if (checkOnly) {
  console.log(stale === 0 ? '✔ 所有相对 import 已带同一版本号' : `✖ ${stale} 个文件版本号不一致或缺失`);
  process.exit(stale === 0 ? 0 : 1);
}

console.log(`✔ 已更新 ${changed} 个文件的版本号 → v=${version}`);
