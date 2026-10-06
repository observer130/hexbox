/**
 * 海克斯面板搜索区的坐标换算
 *
 * 单独一个文件（而不是放在 augment-panel.ts 里）的理由：
 * `augment-panel.ts` 要能在**渲染端**（截屏 worker）里跑 —— 那里没有 Node 能力，
 * 而本文件依赖 `win-geometry.ts`（内部起 PowerShell 探窗口矩形，属于主进程专属）。
 * 一旦混在一起，渲染端打包会连 child_process 一起拉进来（esbuild 直接报错）。
 *
 * 用法：主进程算好**截屏归一化**的搜索区，通过 IPC 交给渲染端；
 * 渲染端只调 `detectAugmentPanel(bmp, region)`。
 */

import type { Rect } from './types.ts';
import { windowRectToCapture } from './win-geometry.ts';
import { PANEL_ROW_REGION } from './augment-panel.ts';

/** 显示器信息（只用到这两项，避免依赖 Electron 类型）。 */
export interface DisplayLike {
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly scaleFactor: number;
}

/**
 * 把 `PANEL_ROW_REGION`（窗口归一化）变换到**截屏归一化**。
 *
 * ⚠️ 不换算直接用会整体错位：截屏可能是**显示器快照**（含窗口外的桌面区域），
 * 此时窗口归一化 ≠ 截屏归一化 —— S2 真机验收的标签错位就是这个原因
 * （见 win-geometry.ts 的 `windowRectToCapture` 头注）。
 *
 * window 形态截屏时退化为恒等（同一套判定），因此两种形态都成立。
 */
export function panelRowRectInCapture(
  bmp: { readonly width: number; readonly height: number },
  windowPhysical: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null,
  display: DisplayLike,
  region: Rect = PANEL_ROW_REGION,
): Rect {
  return windowRectToCapture(region, bmp, windowPhysical, display);
}
