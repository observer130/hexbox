/**
 * 文档对账（CI 可跑，不需要游戏/桌面/数据）
 *
 * 为什么需要它：本文档集里的**写死数字**已经漂过好几轮（测试数 1034 → 1059 →
 * 1077 → 1084 → 1100 → 1133，每次都要人工改三个文件；"数据集规模"整张表停留在
 * 2026-10-04）。人工对账的失败模式很固定：**只改了其中一个文件**、或者
 * 改了代码没改文档。所以把这几类能机器判定的性质钉在 CI 上：
 *
 *   1. 本地 markdown 链接必须存在（改名/删文档后最容易漏）；
 *      文档集 = 根 README/AGENTS + docs/*.md + **所有存在的 apps/*\/README.md**（自动收集）
 *   2. AGENTS / README / ROADMAP 的"测试数"必须**彼此一致**，并且 AGENTS 里那行
 *      分项（core 60 / vision 710 / …）之和必须等于总数（不追求等于真实数，
 *      真实数以 `pnpm test` 为准；这里只拦"改了 A 没改 B"）
 *   3. 文档里引用的 `scripts/*.mts` 等必须存在
 *   4. 文档里引用的 `pnpm a:b`（带冒号）与 `pnpm a`（不带冒号）形式的脚本名
 *      必须在某个 package.json 里；pnpm 内建命令（install/exec/…）在白名单里。
 *      不带冒号的写法只在**代码块 / 行内代码**里校验 —— 正文里 "pnpm workspace"
 *      之类的英文句子不是命令
 *   5. 版本与运行环境：根 version == apps/overlay version，且
 *      `docs/RELEASE-NOTES-v<version>.md` 必须存在；README / AGENTS 写的 Node
 *      版本必须与根 engines.node 的主版本一致
 *
 * 用法：`pnpm check:docs`（CI 在 typecheck 之前跑）
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 只收集**真实存在**的文档：apps/*\/README.md 自动发现，避免下次再漏（如 overlay）。 */
const DOC_FILES = [
  'README.md',
  'AGENTS.md',
  ...readdirSync(join(ROOT, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => `docs/${f}`),
  ...readdirSync(join(ROOT, 'apps'))
    .sort()
    .map((d) => `apps/${d}/README.md`)
    .filter((rel) => existsSync(join(ROOT, rel))),
];

const problems: string[] = [];
const fail = (msg: string): void => {
  problems.push(msg);
};

const text = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

type PackageJson = {
  version?: string;
  engines?: { node?: string };
  scripts?: Record<string, string>;
};

const readPkg = (rel: string): PackageJson => {
  try {
    return JSON.parse(readFileSync(join(ROOT, rel), 'utf8')) as PackageJson;
  } catch (error) {
    fail(`${rel}: 读不到或不是合法 JSON（${String(error)}）`);
    return {};
  }
};

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

/* ---- 2. 测试数三处一致 + AGENTS 分项求和 ---- */
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

/** AGENTS 那行分项（`core 60 / vision 710 / …`）之和必须等于它自己写的总数。 */
let breakdownSum: number | undefined;
const breakdown = /Current:\s*\*\*(\d+)\*\*\s*(?:—|–|-)\s*([\s\S]*?)\(/.exec(text('AGENTS.md'));
if (breakdown?.[1] === undefined || breakdown[2] === undefined) {
  fail(
    'AGENTS.md: 找不到测试数分项（形如「Current: **1133** — core 60 / vision 710 / …」）' +
      '—— 文案结构变了就更新本脚本',
  );
} else {
  const total = Number(breakdown[1]);
  const items = breakdown[2]
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (items.length === 0) {
    fail('AGENTS.md: 测试数分项为空（期望「core 60 / vision 710 / …」）—— 文案结构变了就更新本脚本');
  }
  let sum = 0;
  for (const item of items) {
    const itemMatch = /^([a-z][\w-]*)\s+(\d+)$/.exec(item);
    if (itemMatch?.[2] === undefined) {
      fail(`AGENTS.md: 测试数分项解析不了 → 「${item}」（期望「名字 数字」）`);
      continue;
    }
    sum += Number(itemMatch[2]);
  }
  if (items.length > 0) {
    breakdownSum = sum;
    if (sum !== total) {
      fail(`AGENTS.md: 分项测试数之和 ${sum} ≠ 该行总数 ${total}（改了分项没改总数，或反过来）`);
    }
  }
}

/* ---- 3. 引用的 scripts/* 文件存在 ---- */
for (const file of DOC_FILES) {
  for (const m of text(file).matchAll(/((?:apps\/overlay\/)?scripts\/[\w./-]+\.(?:mts|ts|ps1|mjs))/g)) {
    const p = m[1];
    if (p !== undefined && !existsSync(join(ROOT, p))) fail(`${file}: 引用的脚本不存在 → ${p}`);
  }
}

/* ---- 4. 引用的 pnpm 脚本名存在（带冒号 + 不带冒号） ---- */
const scriptNames = new Set<string>();
const packageFiles = [
  'package.json',
  ...readdirSync(join(ROOT, 'apps'))
    .sort()
    .map((d) => `apps/${d}/package.json`),
  ...readdirSync(join(ROOT, 'packages'))
    .sort()
    .map((d) => `packages/${d}/package.json`),
].filter((rel) => existsSync(join(ROOT, rel)));
for (const rel of packageFiles) {
  for (const name of Object.keys(readPkg(rel).scripts ?? {})) scriptNames.add(name);
}

// pnpm 的内建命令不是 package.json 脚本，文档里出现是合法的（白名单避免误报）。
const PNPM_BUILTINS = new Set([
  'add', 'audit', 'bin', 'config', 'create', 'dedupe', 'deploy', 'dlx', 'doctor', 'env',
  'exec', 'fetch', 'i', 'import', 'init', 'install', 'install-test', 'it', 'licenses',
  'link', 'list', 'ln', 'ls', 'outdated', 'pack', 'patch', 'patch-commit', 'patch-remove',
  'prune', 'publish', 'rb', 'rebuild', 'recursive', 'remove', 'rm', 'root', 'run', 'server',
  'setup', 'store', 'un', 'uninstall', 'unlink', 'unpublish', 'up', 'update', 'upgrade', 'why',
]);

/**
 * 标出 markdown 的代码区间（围栏代码块 + 行内代码；引用块里的围栏 "> ```" 也算）。
 * 无冒号的 `pnpm xxx` 只在这些区间里校验：正文里的 "pnpm workspace" /
 * "pnpm monorepo" / "pnpm is not vendored" 是英文句子，不是命令引用。
 */
const codeMask = (body: string): Uint8Array => {
  const mask = new Uint8Array(body.length);
  let offset = 0;
  let inFence = false;
  for (const line of body.split('\n')) {
    const content = line.replace(/^(\s*>\s*)*/, '').trimStart();
    const isFence = content.startsWith('```') || content.startsWith('~~~');
    if (isFence) inFence = !inFence;
    if (isFence || inFence) {
      mask.fill(1, offset, offset + line.length);
    } else {
      for (const m of line.matchAll(/`[^`]*`/g)) {
        const start = offset + (m.index ?? 0);
        mask.fill(1, start, start + m[0].length);
      }
    }
    offset += line.length + 1;
  }
  return mask;
};

for (const file of DOC_FILES) {
  const body = text(file);
  for (const m of body.matchAll(/pnpm (?:--filter \S+ )?([a-z][\w-]*:[\w:-]+)/g)) {
    const name = m[1];
    if (name !== undefined && !scriptNames.has(name)) {
      fail(`${file}: 引用了不存在的 pnpm 脚本 → ${name}`);
    }
  }
  const mask = codeMask(body);
  for (const m of body.matchAll(/pnpm (?:--filter \S+ )?([a-z][\w-]*)/g)) {
    const name = m[1];
    if (name === undefined) continue;
    const start = (m.index ?? 0) + m[0].length - name.length;
    if (mask[start] !== 1) continue; // 正文英文句子不是命令
    if (body[start + name.length] === ':') continue; // 带冒号的已由上面那条正则负责
    if (scriptNames.has(name) || PNPM_BUILTINS.has(name)) continue;
    fail(`${file}: 引用了不存在的 pnpm 脚本 → ${name}`);
  }
}

/* ---- 5. 版本一致 + 发布说明 + Node 要求 ---- */
const rootPkg = readPkg('package.json');
const overlayPkg = readPkg('apps/overlay/package.json');
const version = rootPkg.version;
if (version === undefined) {
  fail('package.json: 缺少 version 字段');
} else {
  const overlayVersion = overlayPkg.version;
  if (overlayVersion === undefined) {
    fail('apps/overlay/package.json: 缺少 version 字段');
  } else if (overlayVersion !== version) {
    fail(
      `版本不一致：根 package.json=${version} / apps/overlay/package.json=${overlayVersion}` +
        '（发版必须同步这两个版本号）',
    );
  }
  const notes = `docs/RELEASE-NOTES-v${version}.md`;
  if (!existsSync(join(ROOT, notes))) {
    fail(`缺少发布说明 ${notes}（根 version=${version}）—— 每个版本必须有 RELEASE-NOTES`);
  }
}

const nodeRange = rootPkg.engines?.node;
const nodeMajor = nodeRange === undefined ? undefined : /(\d+)/.exec(nodeRange)?.[1];
if (nodeRange === undefined || nodeMajor === undefined) {
  fail('package.json: 读不到 engines.node 主版本（期望形如 ">=24"）');
} else {
  for (const file of ['README.md', 'AGENTS.md']) {
    const documented = /Node\s*(?:≥|>=)\s*(\d+)/.exec(text(file))?.[1];
    if (documented === undefined) {
      fail(
        `${file}: 找不到 Node 版本要求（形如「Node ≥ ${nodeMajor}」）—— 文案结构变了就更新本脚本`,
      );
    } else if (documented !== nodeMajor) {
      fail(
        `${file}: Node 要求 ≥${documented}，与根 engines.node「${nodeRange}」` +
          `（主版本 ${nodeMajor}）不一致`,
      );
    }
  }
}

/* ---- 结果 ---- */
const testTotal = [...distinct][0] ?? '-';
const versionLabel = version ?? '-';
const nodeLabel = nodeMajor ?? '-';
if (problems.length > 0) {
  console.error(`✗ 文档对账失败（${problems.length} 处）：`);
  for (const p of problems) console.error(`  · ${p}`);
  process.exitCode = 1;
} else {
  console.log(
    `✓ 文档对账通过：${DOC_FILES.length} 个文档；链接 / 测试数 / 版本 / Node / pnpm 脚本引用一致` +
      `（测试数 ${testTotal}，分项和 ${breakdownSum ?? '-'}；版本 v${versionLabel}；Node ≥ ${nodeLabel}）`,
  );
}
