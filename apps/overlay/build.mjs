#!/usr/bin/env node
/**
 * 构建脚本
 *
 * 为什么需要打包（而不只是 tsc）：
 *   渲染进程 import 了 workspace 包（@hexbox/lcu 等），
 *   而 Electron 渲染端不解析 node_modules / workspace 链接。
 *   用 esbuild 把渲染端打成单个 IIFE 文件最简单可靠。
 *
 * 产物：
 *   dist/main/index.js      （主进程，CommonJS，Node 环境）
 *   dist/preload/index.js   （preload，CommonJS，隔离上下文）
 *   dist/renderer/renderer.js（渲染端，IIFE，含打包进来的业务代码）
 */

import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist');

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

// 1) 主进程 + preload → CommonJS（Electron 主进程环境）
//    注意产物用 .cjs：项目根 package.json 有 "type": "module"，
//    否则 Electron 会把 .js 当 ESM 加载，导致 "require is not defined"。
await build({
  entryPoints: [
    join(here, 'src', 'main', 'index.ts'),
    join(here, 'src', 'preload', 'index.ts'),
    // 截屏识别调试工具（独立入口，不参与常规运行）
    join(here, 'src', 'debug-capture.ts'),
    // 覆盖层渲染自测（无需游戏即可验证渲染端）
    join(here, 'src', 'debug-overlay-test.ts'),
    // 阶段探针（守望采集脚本用；纯 Node，不依赖 Electron）
    join(here, 'src', 'phase-probe.ts'),
  ],
  outdir: out,
  outExtension: { '.js': '.cjs' },
  outbase: join(here, 'src'),
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  bundle: true,
  external: ['electron'],
  sourcemap: false,
  logLevel: 'info',
});

// 2) 渲染端 → IIFE（侧边悬浮窗 + S2 全屏覆盖层,两个入口）
//    渲染端只 import preload 暴露的 `window.overlay`，
//    不 import 任何 workspace/Node 依赖（LCU 与数据集读取都在主进程），
//    因此无需 external，也不会误把 node:* 打进来。
await build({
  entryPoints: [
    join(here, 'src', 'renderer', 'renderer.ts'),
    join(here, 'src', 'renderer', 'overlay-canvas.ts'),
  ],
  outdir: join(out, 'renderer'),
  platform: 'browser',
  format: 'iife',
  target: 'chrome120',
  bundle: true,
  minify: false,
  sourcemap: false,
  logLevel: 'info',
});

// 3) 静态资源
await mkdir(join(out, 'renderer'), { recursive: true });
for (const f of ['index.html', 'overlay.html', 'styles.css']) {
  await cp(join(here, 'src', 'renderer', f), join(out, 'renderer', f));
}

console.log('✓ overlay 构建完成 →', out);
