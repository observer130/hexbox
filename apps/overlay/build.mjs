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
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
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
    // 局内海克斯面板录制（门控标定用；需真实对局）
    join(here, 'src', 'debug-augment.ts'),
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

// 2) 渲染端 → IIFE（侧边悬浮窗 + S2 全屏覆盖层 + 常驻截屏 worker）
//    渲染端只 import preload 暴露的 `window.overlay`（以及 @hexbox/vision/browser
//    里的纯函数），不 import 任何 Node 依赖（LCU 与数据集读取都在主进程），
//    因此无需 external，也不会误把 node:* 打进来。
//
// ⚠️⚠️ **每个入口必须写显式 out**（真机事故 2026-10-05：「画布 300x150，
//      屏幕上什么都没有」）：
//    esbuild 的 outdir 布局由 **outbase** 决定，而 outbase 是从入口的公共父目录
//    **推断**的。入口全在 `src/renderer/` 时公共父目录是 `src/renderer`
//    → `dist/renderer/overlay-canvas.js`（正确）；一旦加入 `src/capture/worker.ts`，
//    公共父目录变成 `src` → `renderer.js` / `overlay-canvas.js` 被写到
//    `dist/renderer/renderer/` 下，而 `overlay.html` 里写的是 `./overlay-canvas.js`
//    → 模块 404。**这个 404 是静默的**（Electron 不会把它交给
//    `console-message`，主进程那层日志转发一个字都看不到），于是整块画布脚本
//    一行都没跑：`canvas.width/height` 停在 HTML 默认的 300×150，按窗口算出来的
//    标签坐标全部落在画布之外 —— 表现就是"日志里说画了、屏幕上一个字都没有"。
//    显式 `out` 让产物路径与入口目录无关；再加第 3 步的引用自检，
//    这类静默失败不可能再溜过去。
await build({
  entryPoints: [
    { in: join(here, 'src', 'renderer', 'renderer.ts'), out: 'renderer' },
    { in: join(here, 'src', 'renderer', 'overlay-canvas.ts'), out: 'overlay-canvas' },
    // 常驻截屏 worker（局内海克斯门控；用它自己的窗口，见 main/augment-stream.ts）
    { in: join(here, 'src', 'capture', 'worker.ts'), out: 'capture/worker' },
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
const HTML_FILES = [
  join('renderer', 'index.html'),
  join('renderer', 'overlay.html'),
  join('renderer', 'capture', 'worker.html'),
];
await mkdir(join(out, 'renderer', 'capture'), { recursive: true });
for (const f of ['index.html', 'overlay.html', 'styles.css']) {
  await cp(join(here, 'src', 'renderer', f), join(out, 'renderer', f));
}
await cp(join(here, 'src', 'capture', 'worker.html'), join(out, 'renderer', 'capture', 'worker.html'));

// 3b) **引用自检**：HTML 里 `<script src>` / `<link href>` 指向的本地文件必须真的存在。
//     为什么值得单独写一段：产物路径一旦错位，渲染端是**静默什么都不做**
//     （不抛异常、不打日志），表现为"画布空白/尺寸还是默认值"，极难定位。
//     这里让它在**构建期**就红掉，并把期望路径打出来。
for (const rel of HTML_FILES) {
  const file = join(out, rel);
  const html = await readFile(file, 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)].map((m) => m[1]);
  if (refs.length === 0) {
    console.error(`✗ ${rel} 里没有任何本地 script/link 引用 —— HTML 被改坏了？`);
    process.exit(1);
  }
  for (const ref of refs) {
    const target = join(dirname(file), ref);
    if (!existsSync(target)) {
      console.error(
        `✗ ${rel} 引用了不存在的 ${ref}\n  期望文件：${target}\n` +
          '  渲染端会**静默地什么都不做**（画布尺寸停在 300x150）—— 先看 build.mjs 里各入口的 out。',
      );
      process.exit(1);
    }
  }
}

console.log('✓ overlay 构建完成 →', out);
