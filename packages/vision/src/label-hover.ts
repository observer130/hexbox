/**
 * 标签 **hover** 的纯计算：命中测试 + 提示框布局（有单测，渲染端只负责画）
 *
 * ── 为什么值得抄这一条（思路来自对同类工具的做法调研）──────────────────────
 *
 * 覆盖窗是**永久穿透**的（`setIgnoreMouseEvents(true, { forward: true })`），
 * 所以它永远不吞点击 —— 但 `forward: true` 会把 **mousemove 送进渲染端**。
 * 我们此前只用它显示标签，把这条通道白白丢掉了；同类工具用同一手法做
 * "悬停出详情、点击仍全部落到游戏"。
 *
 * ── 为什么布局是纯函数而不是写在渲染端 ─────────────────────────────────────
 *
 * 提示框要处理三件容易出错的事，且都只能靠测试保证：
 *   ① **贴边**：靠右的标签如果提示框还居中，就会有一半在屏幕外；
 *   ② **贴底**：局内三张卡本来就在屏幕下半部分，提示框默认在下方会直接看不见；
 *   ③ **行距/字号**：行与行的 top 由这里算好，渲染端只按 `rows` 逐个画 ——
 *      渲染端自己再排一次版，就会与离线自测/将来预览不一致（本仓库的老坑）。
 *
 * 坐标一律是**窗口内逻辑 DIP**（与画布一致）；`measure` 由调用方注入
 * （浏览器用 `ctx.measureText`，测试给一个确定的假函数）。
 */

/** 命中测试只需要矩形。 */
export interface HoverRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * 返回被命中的标签下标；`null` = 没命中。
 *
 * **从后往前**找：标签按数组顺序绘制，后面的画在上面 —— 万一两块框重叠
 * （真机上出现过"选人标签盖住顶栏"），命中的应该是**看得见的那一个**。
 */
export function hoveredLabelIndex(
  labels: readonly HoverRect[],
  x: number,
  y: number,
): number | null {
  for (let i = labels.length - 1; i >= 0; i--) {
    const l = labels[i];
    if (!l) continue;
    if (x >= l.x && x <= l.x + l.w && y >= l.y && y <= l.y + l.h) return i;
  }
  return null;
}

/** 提示框里的一行。 */
export interface TooltipRow {
  readonly text: string;
  /** 行**顶**（不是基线）：渲染端用 `textBaseline = 'top'` 画，排版才与这里逐像素一致。 */
  readonly top: number;
  readonly font: string;
  /** 标题行（第一行，字重更大）。 */
  readonly isTitle: boolean;
}

export interface TooltipPlan {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly rows: readonly TooltipRow[];
  /** 文字左边距（= padding，渲染端不用自己算）。 */
  readonly padding: number;
  /** 是否因为下方放不下而翻到了标签上方（诊断/测试用）。 */
  readonly flipped: boolean;
}

export interface TooltipStyle {
  readonly font: string;
  readonly titleFont: string;
  readonly lineHeight: number;
  readonly titleLineHeight: number;
  readonly padding: number;
  /** 宽度上限（超过就夹到上限；**不换行**，渲染端按框裁剪）。 */
  readonly maxWidth: number;
  /** 提示框与标签之间的距离。 */
  readonly gap: number;
  readonly measure: (text: string, font: string) => number;
}

/** 提示框最小宽度（只有一两个字的标题也不至于变成一条缝）。 */
const MIN_TOOLTIP_WIDTH = 96;

/**
 * 提示框的**默认视觉参数**（渲染端与将来的离线预览共用同一份）。
 *
 * 与 `labelBoxPlan()` 同样的道理：这些数一旦写在渲染端，离线预览就会各写一套，
 * 于是"预览好看、局内不一样"。字体用系统中文字体族（与标签一致的口径）。
 */
export const TOOLTIP_STYLE: Omit<TooltipStyle, 'measure'> = {
  font: '12px "Microsoft YaHei", "PingFang SC", sans-serif',
  titleFont: 'bold 13px "Microsoft YaHei", "PingFang SC", sans-serif',
  lineHeight: 17,
  titleLineHeight: 22,
  padding: 10,
  maxWidth: 320,
  gap: 8,
};

/** 提示框配色（深色半透明底 + 细描边；在白字标签旁边不刺眼）。 */
export const TOOLTIP_COLORS = {
  fill: 'rgba(12, 16, 24, 0.94)',
  stroke: 'rgba(255, 255, 255, 0.18)',
  title: '#ffffff',
  text: 'rgba(255, 255, 255, 0.86)',
  radius: 8,
} as const;

/**
 * 便捷入口：用默认视觉参数 + 注入的测量函数排一个提示框。
 *
 * 渲染端只需要 `ctx.measureText`，其余（内边距/行高/上限/贴边规则）全在这里 ——
 * 渲染端不排版、不调间距。
 */
export function tooltipPlanFor(
  measure: (text: string, font: string) => number,
  input: {
    readonly title?: string | undefined;
    readonly lines?: readonly string[] | undefined;
    readonly anchor: HoverRect;
    readonly canvas: { readonly width: number; readonly height: number };
  },
  overrides: Partial<Omit<TooltipStyle, 'measure'>> = {},
): TooltipPlan | null {
  return tooltipPlan({ ...input, style: { ...TOOLTIP_STYLE, ...overrides, measure } });
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

export interface TooltipPlanInput {
  readonly title?: string | undefined;
  readonly lines?: readonly string[] | undefined;
  /** 命中的**标签**框（提示框贴在它下方/上方居中）。 */
  readonly anchor: HoverRect;
  /** 画布（窗口内）尺寸 —— 用来夹住提示框，别画到屏幕外。 */
  readonly canvas: { readonly width: number; readonly height: number };
  readonly style: TooltipStyle;
}

/**
 * 排一个提示框；没有内容可显示时返回 `null`。
 *
 * 位置规则（按优先级）：
 *   1. 水平：以标签为中心 → 再夹进画布 `[0, canvasW - w]`；
 *   2. 垂直：默认贴标签**下方** `gap`；下方放不下则翻到**上方**；
 *      上下都放不下（标签几乎占满屏幕）时退回"夹进画布"（此时提示框会盖住标签，
 *      但至少有内容可见 —— 比画到屏幕外强）。
 */
export function tooltipPlan(input: TooltipPlanInput): TooltipPlan | null {
  const { style, anchor, canvas } = input;
  const title = (input.title ?? '').trim();
  const lines = (input.lines ?? []).map((s) => s.trim()).filter((s) => s !== '');
  if (title === '' && lines.length === 0) return null;

  const padding = Math.max(0, style.padding);
  const textWidths = [
    ...(title !== '' ? [style.measure(title, style.titleFont)] : []),
    ...lines.map((l) => style.measure(l, style.font)),
  ];
  const widest = textWidths.reduce((m, v) => (Number.isFinite(v) ? Math.max(m, v) : m), 0);
  // 画布本身可能比 maxWidth 还窄（小窗口/自测）：两个约束都要满足
  const widthCap = Math.max(1, Math.min(style.maxWidth, canvas.width));
  const w = Math.round(clamp(widest + padding * 2, Math.min(MIN_TOOLTIP_WIDTH, widthCap), widthCap));

  const titleH = title !== '' ? style.titleLineHeight : 0;
  const h = Math.round(padding * 2 + titleH + lines.length * style.lineHeight);

  // ① 水平：居中于标签 → 夹进画布
  const x = Math.round(clamp(anchor.x + anchor.w / 2 - w / 2, 0, Math.max(0, canvas.width - w)));

  // ② 垂直：优先下方，放不下翻上方，最后兜底夹住
  const below = anchor.y + anchor.h + style.gap;
  const above = anchor.y - style.gap - h;
  let y = Math.round(below);
  let flipped = false;
  if (y + h > canvas.height) {
    if (above >= 0) {
      y = Math.round(above);
      flipped = true;
    } else {
      y = Math.round(clamp(below, 0, Math.max(0, canvas.height - h)));
    }
  }
  y = Math.round(clamp(y, 0, Math.max(0, canvas.height - h)));

  // ③ 行：标题在最上，正文依次向下；top 由这里算好，渲染端不排版
  const rows: TooltipRow[] = [];
  let top = y + padding;
  if (title !== '') {
    rows.push({ text: title, top, font: style.titleFont, isTitle: true });
    top += style.titleLineHeight;
  }
  for (const text of lines) {
    rows.push({ text, top, font: style.font, isTitle: false });
    top += style.lineHeight;
  }

  return { x, y, w, h, rows, padding, flipped };
}
