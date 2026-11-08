#!/usr/bin/env node
/**
 * Electron 启动器
 *
 * 为什么需要它：部分终端环境会带 `ELECTRON_RUN_AS_NODE=1`
 * （例如嵌入在其它工具里的 shell），这会让 electron.exe 退化成纯 Node，
 * 表现为 `app.whenReady` 处 `Cannot read properties of undefined`。
 * 这里在 spawn 前显式清掉该变量，并解析 electron.exe 的真实路径。
 *
 * 用法：node run-electron.mjs <entry> [args...]
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const entry = process.argv[2];
if (!entry) {
  console.error('用法: node run-electron.mjs <entry> [args...]');
  process.exit(1);
}

// require('electron') 在 Node 环境返回 electron.exe 路径字符串
const electronPath = require('electron');
const exe =
  typeof electronPath === 'string' && existsSync(electronPath)
    ? electronPath
    : join(here, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!existsSync(exe)) {
  console.error(`✗ 找不到 electron.exe: ${exe}`);
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // 关键：恢复完整的 Electron 运行时

/**
 * 录制产物目录（**两边必须用同一个值**，真机教训 2026-11）。
 *
 * ⚠️ 以前这里写 `join(process.cwd(), 'debug', 'augment', '.stop')`，而
 * `pnpm --filter @hexbox/overlay debug:augment` 的 cwd 是 `apps/overlay`，
 * 录制程序（`dist/debug-augment.cjs`）按 `__dirname` 算出来却是**仓库根**的
 * `debug/augment` —— 于是 Ctrl+C 写的哨兵录不到，4 秒后被强杀，
 * `report.json`/`recorder.close()` 永远不执行（一整局的 golden 就没了）。
 *
 * 现在：从本文件位置算出仓库根，**并把同一个绝对路径通过环境变量下发给子进程**
 * （录制程序优先读它），两边不再各算一遍。
 */
const repoRoot = resolve(here, '..', '..');
const augmentOut = (() => {
  const raw = (process.env.HEXBOX_AUGMENT_OUT ?? '').trim();
  if (raw === '') return join(repoRoot, 'debug', 'augment');
  // 与前缀语义保持一致（见 debug-augment.ts 的 OUT_DIR）：绝对路径直接使用，
  // 相对名字落到 `debug/<名字>`，而不是相对 cwd（cwd 是 apps/overlay）。
  return isAbsolute(raw) ? raw : join(repoRoot, 'debug', raw);
})();
env.HEXBOX_AUGMENT_OUT = augmentOut;

const child = spawn(exe, [entry, ...process.argv.slice(3)], {
  stdio: 'inherit',
  env,
  windowsHide: true,
});

/**
 * Ctrl+C 的**接力**（真机教训 2026-10-05）。
 *
 * Electron 是 GUI 子系统进程，**不挂控制台** → Windows 的 CTRL_C_EVENT
 * 根本不会送到它的主进程（`process.on('SIGINT')` 在那边是死代码）。
 * Ctrl+C 只会送到这一层（Node，挂控制台）。
 *
 * 所以：这里收到信号后**写一个哨兵文件**，被录制程序轮询到就自己干净收尾
 * （写 report.json / api-trigger.csv / 识别结果），然后再等一会儿才退出，
 * 避免把子进程连带杀掉、白丢一整局数据。
 */
const sentinel = join(augmentOut, '.stop');
let stopping = false;
const requestStop = (signal) => {
  if (stopping) return;
  stopping = true;
  console.log(`\n[launcher] 收到 ${signal} → 通知录制程序收尾（写好产物再退出）…`);
  try {
    mkdirSync(dirname(sentinel), { recursive: true });
    writeFileSync(sentinel, String(Date.now()));
  } catch (e) {
    console.error(`[launcher] ⚠ 无法写哨兵文件 ${sentinel}: ${e?.message ?? e}`);
    child.kill();
    return;
  }
  // 给录制程序 ~4 秒写产物（它每秒轮询一次哨兵）
  setTimeout(() => {
    try {
      child.kill();
    } catch {
      /* 已经退出 */
    }
  }, 4000);
};
process.on('SIGINT', () => requestStop('SIGINT'));
process.on('SIGTERM', () => requestStop('SIGTERM'));
process.on('SIGBREAK', () => requestStop('SIGBREAK'));

child.on('exit', (code) => {
  process.exitCode = code ?? 0;
  try {
    rmSync(sentinel, { force: true });
  } catch {
    /* 无所谓 */
  }
});
