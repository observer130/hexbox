/**
 * 悬浮窗定位（纯函数，可单测）
 *
 * 为什么抽出来：原算式内联在 `apps/overlay/src/main/index.ts` 里，
 * 而覆盖层/悬浮窗在 CI 里跑不起来 —— 于是这个真实 bug 一直没人测到：
 *
 *   **全屏游戏时右侧没有空间，面板被摆到屏幕外。**
 *   真机几何：游戏窗口 2293×960、显示器 2294×960（全屏），
 *   算式 `x = game.x + game.width + 8` = 2301，而面板宽 340 →
 *   占据 2301..2641，屏幕只到 2294 —— **整个面板都在屏幕外**，
 *   表现为"悬浮窗大小和位置都不对"。
 *
 * 现在的放置策略（按优先级）：
 *   1. 游戏窗口**外侧右边**能放下 → 贴在外侧右边（不遮挡游戏）；
 *   2. 游戏窗口**内侧右边**能放下 → 贴在内侧右边（叠在游戏上但不越界）；
 *   3. 退到工作区右缘对齐（始终可见）。
 * 纵向统一夹在屏幕内，保证标题栏不会被顶出屏幕。
 */

export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 侧边悬浮窗尺寸（DIP）。 */
export const PANEL_WIDTH = 340;
export const PANEL_HEIGHT = 560;
/** 与游戏窗口的间距（DIP）。 */
export const PANEL_GAP = 8;
/** 距工作区上沿的留白（DIP）。 */
export const PANEL_TOP_MARGIN = 40;

/**
 * 计算侧边悬浮窗应处的 bounds。
 *
 * @param game    游戏窗口矩形（逻辑 DIP）；未知时传 null
 * @param workArea 目标显示器的工作区（逻辑 DIP）
 */
export function computePanelBounds(game: Bounds | null, workArea: Bounds): Bounds {
  const width = Math.min(PANEL_WIDTH, workArea.width);
  const height = Math.min(PANEL_HEIGHT, workArea.height);

  // 游戏窗口未知（未开局/最小化）：贴在目标显示器右缘
  // （workArea 比面板还窄时 x 会算成负数，必须夹回工作区左缘）
  if (!game || game.width <= 0 || game.height <= 0) {
    return {
      x: Math.max(workArea.x, workArea.x + workArea.width - width - PANEL_GAP),
      y: workArea.y + PANEL_TOP_MARGIN,
      width,
      height,
    };
  }

  const rightEdge = workArea.x + workArea.width;
  // 1) 外侧右边
  let x = game.x + game.width + PANEL_GAP;
  if (x + width > rightEdge) {
    // 2) 内侧右边（叠在游戏上，但不越界）
    x = game.x + game.width - width - PANEL_GAP;
  }
  if (x + width > rightEdge) {
    // 3) 仍放不下（游戏窗口比工作区还宽）：贴工作区右缘
    x = rightEdge - width - PANEL_GAP;
  }
  // 左边界保护（游戏窗口在左屏外时不要跑到屏幕左边之外）。
  // ⚠️ 只有"右缘也放不下"时才夹到左边界：否则工作区比面板还窄时，
  // 先算出的负 x 会被夹成 workArea.x，反而让右缘溢出（真实边界用例）。
  if (x < workArea.x && x + width > rightEdge) x = workArea.x;

  // 纵向：以游戏窗口上沿为基准，但夹进工作区
  let y = game.y + PANEL_TOP_MARGIN;
  if (y + height > workArea.y + workArea.height) {
    y = workArea.y + workArea.height - height;
  }
  if (y < workArea.y) y = workArea.y;

  return { x, y, width, height };
}

/** 全屏透明覆盖层：铺满目标显示器工作区。 */
export function computeVisionBounds(workArea: Bounds): Bounds {
  return {
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
  };
}
