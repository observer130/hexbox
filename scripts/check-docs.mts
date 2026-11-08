/**
 * 文档对账（CI 可跑，不需要游戏/桌面/数据）
 *
 * 为什么需要它：本文档集里的**写死数字**已经漂过好几轮（测试数 1034 → 1059 →
 * 1077 → 1084 → 1100，每次都要人工改三个文件；"数据集规模"整张表停留在
 * 2026-10-04）。人工对账的失败模式很固定：**只改了其中一个文件**、或者
 * 改了代码没改文档。所以把这几类能机器判定的性质钉在 CI 上：
 *
 *   1. 本地 markdown 链接必须存在（改名/删文档后最容易漏）
 *   2. AGENTS / README / ROADMAP 的"测试数"必须**彼此一致**（不追求等于真实数，
 *      真实数以 `pnpm test` 为准；这里只拦"改了 A 没改 B"）
 *   3. 文档里引用的 `scripts/*.mts` 必须存在
 *   4. 文档里引用的 `pnpm a:b` 形式的脚本名必须在某个 package.json 里
 *
 * 用法：`pnpm check:docs`（CI 在 typecheck 之前跑）
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DOC_FILES = [
  'README.md',
  'AGENTS.md',
  ...readdirSync(join(ROOT, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `docs/${f}`),
];

const problems: string[] = [];
const fail = (msg: string): void => {
  problems.push(msg);
};

const text = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

/* ---- 1. 本地链接 ---- */
for (const file of DOC_FILES) {
  const body = text(file);
  for (const m of body.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1];
    if (target === undefined) continue;
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const path = target.split('#')[0];
    if (path === undefined || path === '') continue;
    if (!existsSync(resolve(dirname(join(ROOT, file)), decodeURIComponent(path)))) {
      fail(`${file}: 链接指向不存在的文件 → ${target}`);
    }
  }
}

/* ---- 2. 测试数三处一致 ---- */
const counts: Array<{ file: string; value: string }> = [];
const pick = (file: string, re: RegExp): void => {
  const m = re.exec(text(file));
  if (m?.[1] !== undefined) counts.push({ file, value: m[1] });
  else fail(`${file}: 找不到测试数（正则 ${re.source}）—— 文案结构变了就更新本脚本`);
};
pick('AGENTS.md', /Current:\s*\*\*(\d+)\*\*/);
pick('README.md', /当前\s*(\d+)\s*项/);
pick('docs/ROADMAP.md', /(\d+)\s*项测试/);
const distinct = new Set(counts.map((c) => c.value));
if (distinct.size > 1) {
  fail(
    `测试数三处不一致：${counts.map((c) => `${c.file}=${c.value}`).join(' / ')}` +
      '（跑一遍 pnpm test 按实际输出统一改）',
  );
}

/* ---- 3. 引用的 scripts/* 文件存在 ---- */
for (const file of DOC_FILES) {
  for (const m of text(file).matchAll(/((?:apps\/overlay\/)?scripts\/[\w./-]+\.(?:mts|ts|ps1|mjs))/g)) {
    const p = m[1];
    if (p !== undefined && !existsSync(join(ROOT, p))) fail(`${file}: 引用的脚本不存在 → ${p}`);
  }
}

/* ---- 4. 引用的 pnpm 脚本名存在 ---- */
const scriptNames = new Set<string>();
for (const rel of [
  'package.json',
  'apps/web/package.json',
  'apps/overlay/package.json',
  ...readdirSync(join(ROOT, 'packages')).map((d) => `packages/${d}/package.json`),
]) {
  if (!existsSync(join(ROOT, rel))) continue;
  const pkg = JSON.parse(readFileSync(join(ROOT, rel), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  for (const name of Object.keys(pkg.scripts ?? {})) scriptNames.add(name);
}
for (const file of DOC_FILES) {
  for (const m of text(file).matchAll(/pnpm (?:--filter \S+ )?([a-z][\w-]*:[\w:-]+)/g)) {
    const name = m[1];
    if (name !== undefined && !scriptNames.has(name)) {
      fail(`${file}: 引用了不存在的 pnpm 脚本 → ${name}`);
    }
  }
}

/* ---- 结果 ---- */
if (problems.length > 0) {
  console.error(`✗ 文档对账失败（${problems.length} 处）：`);
  for (const p of problems) console.error(`  · ${p}`);
  process.exitCode = 1;
} else {
  console.log(
    `✓ 文档对账通过：${DOC_FILES.length} 个文档、链接/测试数/脚本引用一致（测试数 ${[...distinct][0] ?? '-'}）`,
  );
}
