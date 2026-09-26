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
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

const child = spawn(exe, [entry, ...process.argv.slice(3)], {
  stdio: 'inherit',
  env,
  windowsHide: true,
});
child.on('exit', (code) => {
  process.exitCode = code ?? 0;
});
