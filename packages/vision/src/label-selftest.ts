/**
 * 覆盖窗自测标签（**纯函数**）：屏幕左 / 中 / 右各一个大字母。
 *
 * 用途：`HEXBOX_LABEL_OVERLAY_TEST=1` 时，覆盖层不接游戏、直接画这三块，
 * 让用户**任何时刻**都能回答"这块全屏透明画布到底能不能显示在我屏幕上"
 * （局内标签"画了但看不见"无法靠一局真机反复验证：一局 20 分钟、条件不可控）。
 *
 * 为什么要单测（CI 里 Electron 跑不起来，但几何必须是对的）：
 *   · 标签必须**完整落在工作区内**（多显示器时工作区原点不是 0,0，
 *     写死 `x=24` 会在副屏跑到屏幕外 —— 这类错会让"自测看不见"变成新的假象）；
 *   · 字必须够大（1080p 下 ≥100px 高），否则"看不见"又分不清是窗口问题还是字太小。
 */

/** 自测标签盒（逻辑 DIP）；小屏会按比例缩小。 */
export const LABEL_SELFTEST_BOX = { w: 300, h: 200 } as const;

/** 距工作区边缘的留白。 */
export const LABEL_SELFTEST_MARGIN = 32;

/** 一个自测标签（字段与渲染端 `overlay-canvas.ts` 的 VisionLabel 对齐）。 */
export interface LabelOverlaySelftestLabel {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** 大字母（L / C / R）。 */
  readonly text: string;
  /** 小字（左 / 中 / 右）。 */
  readonly sub: string;
  readonly hasData: boolean;
  readonly championId: number;
  /** 强调色（沿用档位配色，顺便验证颜色通道）。 */
  readonly color: string;
}

/** 工作区矩形（`display.workArea`，逻辑 DIP）。 */
export interface SelfTestWorkArea {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * 生成三个自测标签：左 / 中 / 右水平排开、垂直居中。
 *
 * 缩放规则（只为"一定看得见、一定在屏内"）：
 *   · 盒子宽度最多占工作区 1/3（再减去边距），保证三个盒子不重叠；
 *   · 高度最多占工作区 1/3；两者都有下限，避免算出 0 宽/负坐标。
 */
export function labelOverlaySelftestLabels(
  workArea: SelfTestWorkArea,
): readonly LabelOverlaySelftestLabel[] {
  const margin = LABEL_SELFTEST_MARGIN;
  const roomW = Math.floor((workArea.width - margin * 4) / 3);
  const w = Math.max(80, Math.min(LABEL_SELFTEST_BOX.w, roomW));
  const h = Math.max(60, Math.min(LABEL_SELFTEST_BOX.h, Math.floor(workArea.height / 3)));
  const y = Math.round(workArea.y + workArea.height / 2 - h / 2);
  const xLeft = Math.round(workArea.x + margin);
  const xCenter = Math.round(workArea.x + (workArea.width - w) / 2);
  const xRight = Math.round(workArea.x + workArea.width - margin - w);

  return [
    {
      x: xLeft,
      y,
      w,
      h,
      text: 'L',
      sub: '左 可见',
      hasData: true,
      championId: 1,
      color: '#4ade80',
    },
    {
      x: xCenter,
      y,
      w,
      h,
      text: 'C',
      sub: '中 可见',
      hasData: true,
      championId: 2,
      color: '#e6a33a',
    },
    {
      x: xRight,
      y,
      w,
      h,
      text: 'R',
      sub: '右 可见',
      hasData: true,
      championId: 3,
      color: '#a76ede',
    },
  ];
}
