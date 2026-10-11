/**
 * 采集几何：游戏窗口矩形 → 门控搜索区（**唯一碰 Electron `screen` 的地方**）
 *
 * 为什么单独一个文件（2026-10-12）：`AugmentController` 想被**离线回放**驱动
 * （`scripts/replay-session.mts`，纯 Node、无 Electron），就必须能 `import` 而不拉起
 * Electron。它原本在模块顶层 `import { screen } from 'electron'` —— 只要这一句还在，
 * 普通 Node 里连 `import` 都做不到（回放就只能退化成"另写一份状态机"，而那是这个
 * 项目明确禁止的事：诊断脚本与主流程两份实现必然漂移）。
 *
 * 所以：**几何作为依赖注入**。真实运行用这里（Electron + win-geometry），
 * 回放直接给会话里存档的几何（`session.json` 的 `region`/`altRegion`/`display`）。
 */

import { screen } from 'electron';

import { findGameWindowRectCached, panelRowRectInCapture, PANEL_ROW_REGION } from '@hexbox/vision';

import type { AugmentCaptureGeometry } from './augment-controller.ts';

/** 门控画布缩放下限（与控制器同一条：更低就重建不出卡片）。 */
export const AUGMENT_THUMB_SCALE_FLOOR = 0.25;

/**
 * 算一次采集几何（游戏窗口 → 截屏归一化搜索区）。
 *
 * 导出给录制工具的**基准模式**用（它自己建一次流对照两种截屏路径，
 * 不该为了拿几何再去 new 一个控制器）。
 */
export async function resolveAugmentCaptureGeometry(
  thumbScale: number = AUGMENT_THUMB_SCALE_FLOOR,
): Promise<AugmentCaptureGeometry> {
  const windowPhysical = await findGameWindowRectCached();
  // ⚠️ 用**游戏窗口所在**显示器，不是主显示器（多显示器 + 不同 DPI 时全错）
  const display = windowPhysical
    ? screen.getDisplayNearestPoint({ x: windowPhysical.x + 10, y: windowPhysical.y + 10 })
    : screen.getPrimaryDisplay();
  const targetWidth = Math.round(display.size.width * 2 * thumbScale);
  const region = panelRowRectInCapture(
    { width: targetWidth, height: Math.round(display.size.height * 2 * thumbScale) },
    windowPhysical,
    display,
  );
  return { display, windowPhysical, region, altRegion: PANEL_ROW_REGION, targetWidth };
}
