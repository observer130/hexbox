/**
 * 极简软件光栅化（纯函数，零依赖）——**只服务于离线预览**
 *
 * 为什么需要它：局内标签画在 Electron 渲染端的 canvas 上，而"不用开游戏就能挑
 * 尺寸"的预览图（`scripts/preview-augment-labels.mts`）跑在纯 Node 里，**没有 canvas**。
 * 两边要长得一样，就只能把"圆角框 + 描边 + 居中的字母"在 Node 侧也实现一遍 ——
 * 实现放在这里（纯函数，可单测），而不是塞进脚本里，这样它跟几何/字号一样能被 CI 盯住。
 *
 * 约定：
 *   · 位图是 `Bitmap`（RGBA，premultiply 无关，src-over 混合）；
 *   · 覆盖率用**有符号距离**解析算（不是超采样）：边框/直线一律 1px 抗锯齿，
 *     与 canvas 的 `arcTo` 圆角 + 1px 描边观感一致；
 *   · 这里不做任何单位换算 —— 调用方给的都是**同一种单位**的像素坐标
 *     （预览里 = 截屏帧像素；渲染端不需要本模块）。
 */

import type { Bitmap, Rect } from './types.ts';
import type { Rgba } from './label-draw.ts';

/**
 * 圆角矩形的**有符号距离**（< 0 在内部，单位 = 像素）。
 *
 * 标准"圆角盒" SDF：`q = |p − center| − (half − r)`，外面取模长、里面取分量最大值，
 * 最后减去 r。它对**内部**是近似值（精确 SDF 内部要修正），但本文件只关心
 * 边界附近的覆盖率（内部深处恒等于"完全覆盖"），所以够用。
 */
export function roundedRectDistance(px: number, py: number, rect: Rect, radius: number): number {
  const r = Math.max(0, Math.min(radius, Math.min(rect.w, rect.h) / 2));
  const dx = Math.abs(px - (rect.x + rect.w / 2)) - (rect.w / 2 - r);
  const dy = Math.abs(py - (rect.y + rect.h / 2)) - (rect.h / 2 - r);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - r;
}

/** 点到线段的距离（线条/字形的圆头笔画就是靠它）。 */
export function distanceToSegment(
  px: number,
  py: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const vx = x1 - x0;
  const vy = y1 - y0;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x0) * vx + (py - y0) * vy) / len2));
  return Math.hypot(px - (x0 + vx * t), py - (y0 + vy * t));
}

/** src-over 混合一个像素（覆盖率 × 颜色 alpha）。 */
export function blendPixel(
  bmp: Bitmap,
  x: number,
  y: number,
  color: Rgba,
  coverage = 1,
): void {
  if (coverage <= 0) return;
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= bmp.width || yi >= bmp.height) return;
  const a = Math.max(0, Math.min(1, coverage)) * Math.max(0, Math.min(1, color.a));
  if (a <= 0) return;
  const i = (yi * bmp.width + xi) * 4;
  const d = bmp.data;
  d[i] = d[i]! * (1 - a) + color.r * a;
  d[i + 1] = d[i + 1]! * (1 - a) + color.g * a;
  d[i + 2] = d[i + 2]! * (1 - a) + color.b * a;
  d[i + 3] = 255;
}

/** 遍历矩形范围内（含外扩 `pad` 像素）的每个像素。 */
function forEachPixel(
  bmp: Bitmap,
  rect: Rect,
  pad: number,
  fn: (x: number, y: number) => void,
): void {
  const x0 = Math.max(0, Math.floor(rect.x - pad));
  const y0 = Math.max(0, Math.floor(rect.y - pad));
  const x1 = Math.min(bmp.width - 1, Math.ceil(rect.x + rect.w + pad));
  const y1 = Math.min(bmp.height - 1, Math.ceil(rect.y + rect.h + pad));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) fn(x, y);
  }
}

/** 填充圆角矩形（抗锯齿）。 */
export function fillRoundedRect(
  bmp: Bitmap,
  rect: Rect,
  radius: number,
  color: Rgba,
  alphaMul = 1,
): void {
  if (rect.w <= 0 || rect.h <= 0) return;
  forEachPixel(bmp, rect, 1, (x, y) => {
    const cov = Math.max(0, Math.min(1, 0.5 - roundedRectDistance(x + 0.5, y + 0.5, rect, radius)));
    blendPixel(bmp, x, y, color, cov * alphaMul);
  });
}

/** 圆角矩形描边（线宽居中在边界上，抗锯齿）。 */
export function strokeRoundedRect(
  bmp: Bitmap,
  rect: Rect,
  radius: number,
  width: number,
  color: Rgba,
): void {
  if (rect.w <= 0 || rect.h <= 0 || width <= 0) return;
  const half = width / 2;
  forEachPixel(bmp, rect, half + 2, (x, y) => {
    const d = Math.abs(roundedRectDistance(x + 0.5, y + 0.5, rect, radius));
    const cov = Math.max(0, Math.min(1, half + 0.5 - d));
    blendPixel(bmp, x, y, color, cov);
  });
}

/** 实心矩形（标注底色、刻度线用）。 */
export function fillRect(bmp: Bitmap, rect: Rect, color: Rgba): void {
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(bmp.width, Math.round(rect.x + rect.w));
  const y1 = Math.min(bmp.height, Math.round(rect.y + rect.h));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) blendPixel(bmp, x, y, color, 1);
  }
}

/** 画一条圆头线段（抗锯齿）——引导线、字形笔画都用它。 */
export function strokeSegment(
  bmp: Bitmap,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  width: number,
  color: Rgba,
): void {
  const half = width / 2;
  const rect: Rect = {
    x: Math.min(x0, x1) - half,
    y: Math.min(y0, y1) - half,
    w: Math.abs(x1 - x0) + width,
    h: Math.abs(y1 - y0) + width,
  };
  forEachPixel(bmp, rect, 2, (x, y) => {
    const cov = Math.max(0, Math.min(1, half + 0.5 - distanceToSegment(x + 0.5, y + 0.5, x0, y0, x1, y1)));
    blendPixel(bmp, x, y, color, cov);
  });
}

/**
 * 画一条**折线**（相邻线段共享端点 → 天然是圆角接头，因为笔画是圆头的）。
 *
 * @param points 像素坐标的折线点（至少 2 个点才画）
 */
export function strokePolyline(
  bmp: Bitmap,
  points: readonly (readonly [number, number])[],
  width: number,
  color: Rgba,
): void {
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    strokeSegment(bmp, a[0], a[1], b[0], b[1], width, color);
  }
}

/* ------------------------------------------------------------------ */
/* 多边形填充（档位字母的真字体轮廓 → 覆盖率）与"到墨迹的距离场"            */
/* ------------------------------------------------------------------ */

/** 每条像素行取几条子扫描线（子扫描线间只做纵向平均；横向是解析覆盖）。 */
const SUB_SCANLINES = 4;

/**
 * 把一组**闭合多边形**光栅化成覆盖率缓冲（只服务于离线预览的档位字母）。
 *
 * 为什么不是超采样：预览里的字母按 100+ 像素的字号画，`4` 条子扫描线 + 横向
 * **解析覆盖**已经与 canvas 的灰度抗锯齿同级，代价却只有 4×4 超采样的四分之一。
 *
 * 填充规则取**偶奇**：`GraphicsPath`（`AddString` 出来的字形路径）的 `FillMode`
 * 就是 `Alternate`，而这些轮廓来自它 —— 两边必须是同一条规则，否则字怀会填实。
 *
 * @param polygons 每条 = 一条闭合轮廓的平坦点表（`[x0, y0, x1, y1, …]`，**位图像素**坐标）
 * @param width 缓冲区宽（像素）
 * @param height 缓冲区高（像素）
 * @param originX 缓冲区左上角在位图里的 x（子扫描线与像素中心都用绝对坐标算）
 * @param originY 同上（y）
 * @returns 长度 `width × height` 的覆盖率（0~1，行优先）
 */
export function rasterizePolygons(
  polygons: readonly (readonly number[])[],
  width: number,
  height: number,
  originX: number,
  originY: number,
): Float32Array {
  const out = new Float32Array(Math.max(0, width) * Math.max(0, height));
  if (width <= 0 || height <= 0) return out;
  // 边表（水平边不参与扫描线求交）
  const ax: number[] = [];
  const ay: number[] = [];
  const bx: number[] = [];
  const by: number[] = [];
  for (const poly of polygons) {
    const n = poly.length >> 1;
    if (n < 3) continue;
    for (let i = 0; i < n; i++) {
      const j = i + 1 === n ? 0 : i + 1;
      const y0 = poly[i * 2 + 1]!;
      const y1 = poly[j * 2 + 1]!;
      if (y0 === y1) continue;
      ax.push(poly[i * 2]!);
      ay.push(y0);
      bx.push(poly[j * 2]!);
      by.push(y1);
    }
  }
  if (ax.length === 0) return out;
  const xs: number[] = [];
  for (let row = 0; row < height; row++) {
    for (let k = 0; k < SUB_SCANLINES; k++) {
      const y = originY + row + (k + 0.5) / SUB_SCANLINES;
      xs.length = 0;
      for (let e = 0; e < ax.length; e++) {
        const y0 = ay[e]!;
        const y1 = by[e]!;
        // 半开区间：顶点不会被算两次
        if (y < (y0 < y1 ? y0 : y1) || y >= (y0 < y1 ? y1 : y0)) continue;
        const x0 = ax[e]!;
        xs.push(x0 + ((y - y0) * (bx[e]! - x0)) / (y1 - y0));
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      // 偶奇：排序后相邻配对就是内部段
      for (let i = 0; i + 1 < xs.length; i += 2) {
        addCoverageSpan(out, row, width, originX, xs[i]!, xs[i + 1]!);
      }
    }
  }
  for (let i = 0; i < out.length; i++) {
    if (out[i]! > 1) out[i] = 1; // 自交/重叠轮廓时夹住（偶奇下不该发生）
  }
  return out;
}

/** 把一条 `[xa, xb)` 的横向覆盖按**解析重叠**加到该行的像素上。 */
function addCoverageSpan(
  out: Float32Array,
  row: number,
  width: number,
  originX: number,
  xa: number,
  xb: number,
): void {
  if (xb <= xa) return;
  const first = Math.max(0, Math.floor(xa - originX));
  const last = Math.min(width - 1, Math.ceil(xb - originX) - 1);
  for (let i = first; i <= last; i++) {
    const x0 = originX + i;
    const overlap = Math.min(xb, x0 + 1) - Math.max(xa, x0);
    if (overlap <= 0) continue;
    const idx = row * width + i;
    out[idx] = (out[idx] ?? 0) + overlap / SUB_SCANLINES;
  }
}

/**
 * 由覆盖率缓冲算**到墨迹的距离场**（chamfer 两遍扫描；单位 = 像素，墨迹内为 0）。
 *
 * 为什么需要它：canvas 的 `strokeText(lineWidth = 2r)` 画出来的效果正是
 * "墨迹向外扩 `r`"（向内那半被随后的 `fillText` 盖住）。预览的字形是轮廓/点阵，
 * 想按**同一份 reach 数据**（`label-draw.ts` 的 `tierGlowLayers()` / `outlineWidth`）
 * 向外扩，只能靠距离场 —— 这样发光与描边的粗细与局内同源，DPR 变了也不会漂。
 *
 * 距离是"到最近的**墨迹像素中心**"，与真正的轮廓相差约半个像素；
 * 调用方按 `clamp(1 + reach − d)` 取覆盖率（`+1` 里含那半个像素的修正）。
 */
export function inkDistanceField(
  coverage: Float32Array,
  width: number,
  height: number,
): Float32Array {
  const n = Math.max(0, width) * Math.max(0, height);
  const d = new Float32Array(n);
  const INF = 1e9;
  for (let i = 0; i < n; i++) d[i] = (coverage[i] ?? 0) >= 0.5 ? 0 : INF;
  const D1 = 1;
  const D2 = Math.SQRT2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let v = d[i]!;
      if (x > 0) v = Math.min(v, d[i - 1]! + D1);
      if (y > 0) {
        v = Math.min(v, d[i - width]! + D1);
        if (x > 0) v = Math.min(v, d[i - width - 1]! + D2);
        if (x + 1 < width) v = Math.min(v, d[i - width + 1]! + D2);
      }
      d[i] = v;
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      let v = d[i]!;
      if (x + 1 < width) v = Math.min(v, d[i + 1]! + D1);
      if (y + 1 < height) {
        v = Math.min(v, d[i + width]! + D1);
        if (x + 1 < width) v = Math.min(v, d[i + width + 1]! + D2);
        if (x > 0) v = Math.min(v, d[i + width - 1]! + D2);
      }
      d[i] = v;
    }
  }
  return d;
}
