/**
 * `@hexbox/vision/browser` —— **浏览器安全**子集
 *
 * 为什么要单独一个入口：局内海克斯门控的检测跑在**渲染端**的常驻截屏 worker 里
 * （拿得到 `getDisplayMedia` 视频流），而主进程那份 `index.ts` 会把
 * `win-geometry.ts`（起 PowerShell 探窗口矩形）与 `png.ts`（node:zlib）一起带进来，
 * 渲染端打包会直接失败。
 *
 * 这里只导出**纯计算、零 Node 依赖**的部分。坐标换算（`panelRowRectInCapture`）
 * 依赖 win-geometry，因此留在主进程：主进程算好"截屏归一化"的搜索区，
 * 经 IPC 传给 worker。
 *
 * 不要往这里加带副作用或依赖 node:* 的模块 —— 渲染端 bundle 会立刻报错。
 */

export * from './types.ts';
export * from './augment-panel.ts';
// ⚠️ 紧挨着 augment-panel：渲染端 worker 在"卡片判据未命中"的帧上要**顺手算**
// 这个独立信号（`detectPanelPresence`），随本帧一起回传。它纯计算、零 Node 依赖。
export * from './augment-presence.ts';
export * from './augment-ocr.ts';
export * from './augment-trigger.ts';
// 开边沿整批识别的**矩形来源**决策（渲染端 worker 用：原生重检失败 → 门控矩形兜底）
export * from './augment-open-recognize.ts';
export * from './augment-label.ts';
// 面板停留期间的**单卡刷新**检测（指纹在渲染端算：只有它拿得到门控画布像素）
export * from './augment-reroll.ts';
// 覆盖层画布纯计算（渲染端 overlay-canvas.ts 用它算位图尺寸）
export * from './label-overlay-coords.ts';
// 标签绘制计划（渲染端 overlay-canvas.ts 用它取圆角/字号/配色 —— 与离线预览同一份）
export * from './label-draw.ts';
