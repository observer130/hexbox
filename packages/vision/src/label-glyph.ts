/**
 * 离线预览用的**字形**（纯函数，零依赖）
 *
 * 局内标签的字母是 Chromium 用系统字体画的（canvas `font`），而离线预览
 * 跑在纯 Node 里、没有字体引擎。这里给三套字形，各管一件事：
 *
 *   1. **档位字母（A~Z）= 真字体轮廓**（`label-letter-outlines.ts`，由
 *      `scripts/render-tier-letter-glyphs.ps1` 从**与局内同一套字体**导出）：
 *      矢量数据 → 任意字号都清晰，且轮廓就是局内那套字体的轮廓。
 *      见 `drawTierLetter()`（发光/描边按"到墨迹的距离场"向外扩，与 canvas 的
 *      `strokeText` 同一语义）。⚠️ `drawVectorGlyph()` 那套**单线字形**现在只是
 *      **兜底**：字母不在 A~Z（将来加了非字母档位）时才会用到。
 *   2. **文字与数字（ASCII）= 5×7 点阵**：预览图上的标注小字，以及标签里
 *      「选取率 12.1%」那一行的数字部分。
 *   3. **三个汉字（选取率）= 4bit 点阵**（`label-cjk.ts`，由系统字体渲染生成）：
 *      局内这行是系统字体画的，预览没有字体引擎 —— 内嵌这三个字才能让
 *      **版面**（字号 / 居中 / 墨迹高）与局内一致。见 `drawRateLine()`。
 *
 * 三条都刻意写成纯函数（可单测）：字形数据一旦画歪，预览就会骗人。
 */

import { blendPixel, inkDistanceField, rasterizePolygons, strokePolyline } from './label-raster.ts';
import { LABEL_CAP_RATIO, type Rgba, type TierGlowLayer } from './label-draw.ts';
import { cjkRateGlyph, type CjkRateGlyph } from './label-cjk.ts';
import { tierLetterGlyph, type TierLetterGlyph } from './label-letter-outlines.ts';
import type { Bitmap } from './types.ts';

export type Point = readonly [number, number];

/**
 * cap 高 / 字号（微软雅黑大写字母实测 ≈0.71~0.73）。
 *
 * ⚠️ **必须与 `label-draw.ts` 的 `LABEL_CAP_RATIO` 是同一个数**：尖括号的位置、
 * 字母基线、选取率行的位置全按它算 —— 一旦这里另写一个值，
 * 预览里的尖括号就会与局内错开（这正是"预览 = 局内"要防的那类问题）。
 */
export const GLYPH_CAP_RATIO = LABEL_CAP_RATIO;
/** 笔画宽 / 字号（雅黑粗体大写字母竖干 ≈0.16~0.18 em）。 */
export const GLYPH_STROKE_RATIO = 0.17;
/** 笔画宽（**cap 单位**）：字形点表用的就是这个坐标系。 */
export const GLYPH_STROKE_UNITS = GLYPH_STROKE_RATIO / GLYPH_CAP_RATIO;

/**
 * 椭圆弧 → 折线点（y 向下，角度按屏幕坐标取：0° 向右、90° 向下）。
 *
 * `toDeg < fromDeg` 表示反向扫（逆时针），这是字母 C 必需的
 * （它从右上往**上**走，再绕左、下，最后到右下）。
 */
function arc(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  fromDeg: number,
  toDeg: number,
  steps = 48,
): Point[] {
  const out: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const deg = fromDeg + ((toDeg - fromDeg) * i) / steps;
    const rad = (deg * Math.PI) / 180;
    out.push([cx + rx * Math.cos(rad), cy + ry * Math.sin(rad)]);
  }
  return out;
}

/** cap 单位下的中心线（x ∈ [0, ~0.7]、y ∈ [0, 1]；两端点已内缩半个笔画宽）。 */
interface VectorGlyph {
  readonly strokes: readonly (readonly Point[])[];
}

const INSET = GLYPH_STROKE_UNITS / 2; // = 0.118
const RIGHT = 0.7 - INSET; // 字面右边界（字面宽 ≈0.7 cap）
const HALF_W = 0.35 - INSET; // 椭圆横向半径（保证字面宽 ≈0.7）
const BOWL_RY = 0.176; // S/B 的半个碗高

const VECTOR_GLYPHS: Readonly<Record<string, VectorGlyph>> = {
  // C：右侧开口 100° 的椭圆弧（从右上逆时针绕一圈到右下）
  C: { strokes: [arc(0.35, 0.5, HALF_W, 0.5 - INSET, -50, -310)] },
  // S：上碗（右上 → 上 → 左 → 腰）+ 下碗（腰 → 右 → 下 → 左下），两碗墨迹相接
  S: {
    strokes: [
      arc(0.35, 0.294, HALF_W, BOWL_RY, -50, -270),
      arc(0.35, 0.706, HALF_W, BOWL_RY, -90, 130),
    ],
  },
  // A：两斜腿 + 横杠（顶点留半个笔画宽的尖）
  A: {
    strokes: [
      [
        [0.35, INSET],
        [INSET, 1 - INSET],
      ],
      [
        [0.35, INSET],
        [RIGHT, 1 - INSET],
      ],
      [
        [0.1885, 0.65],
        [0.5115, 0.65],
      ],
    ],
  },
  // B：竖干 + 上下两个右半碗 + 三条横杠
  B: {
    strokes: [
      [
        [INSET, INSET],
        [INSET, 1 - INSET],
      ],
      [
        [INSET, INSET],
        [0.35, INSET],
      ],
      arc(0.35, 0.294, HALF_W, BOWL_RY, -90, 90),
      [
        [0.35, 0.47],
        [INSET, 0.47],
      ],
      arc(0.35, 0.706, HALF_W, BOWL_RY, -90, 90),
      [
        [0.35, 1 - INSET],
        [INSET, 1 - INSET],
      ],
    ],
  },
};

/** 取一个字符的字形（大写、只认第一个字符）。 */
export function vectorGlyph(ch: string): VectorGlyph | null {
  const key = ch.trim().toUpperCase().slice(0, 1);
  return VECTOR_GLYPHS[key] ?? null;
}

/** 是否支持该字形（预览用它决定要不要画字母）。 */
export function glyphSupported(ch: string): boolean {
  return vectorGlyph(ch) !== null;
}

export interface InkBox {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** 字形**墨迹**包围盒（cap 单位；已把半个笔画宽算进去）。 */
export function glyphInkBox(ch: string): InkBox | null {
  const g = vectorGlyph(ch);
  if (!g) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const stroke of g.strokes) {
    for (const p of stroke) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
  }
  return {
    minX: minX - INSET,
    minY: minY - INSET,
    maxX: maxX + INSET,
    maxY: maxY + INSET,
  };
}

/** 字形墨迹 宽/高（诊断与单测用；YaHei 的大写字母约 0.6~0.75）。 */
export function glyphInkAspect(ch: string): number | null {
  const b = glyphInkBox(ch);
  return b ? (b.maxX - b.minX) / (b.maxY - b.minY) : null;
}

export interface DrawGlyphOptions {
  /** cap 高 / 字号（默认 `GLYPH_CAP_RATIO`）。 */
  readonly capRatio?: number;
  /** 笔画宽 / 字号（默认 `GLYPH_STROKE_RATIO`）。 */
  readonly strokeRatio?: number;
}

/**
 * 把一个字形画到位图上，**墨迹中心**对齐 `(cx, cy)`。
 *
 * 与 canvas 的差异：canvas 的 `textBaseline='middle'` 是把**em 盒**居中，
 * 对雅黑而言字母墨迹中心会再低约 0.04 em（≈1~2px）；这里直接按墨迹居中，
 * 偏差远小于一个笔画宽，视觉上等价。
 *
 * @returns 是否真的画了（不支持的字符返回 false，调用方据此提示）
 */
export function drawVectorGlyph(
  bmp: Bitmap,
  ch: string,
  sizePx: number,
  cx: number,
  cy: number,
  color: Rgba,
  options: DrawGlyphOptions = {},
): boolean {
  const g = vectorGlyph(ch);
  const ink = glyphInkBox(ch);
  if (!g || !ink) return false;
  const capH = Math.max(1, sizePx * (options.capRatio ?? GLYPH_CAP_RATIO));
  const stroke = Math.max(1, sizePx * (options.strokeRatio ?? GLYPH_STROKE_RATIO));
  const originX = cx - ((ink.minX + ink.maxX) / 2) * capH;
  const originY = cy - ((ink.minY + ink.maxY) / 2) * capH;
  for (const line of g.strokes) {
    const pts = line.map((p) => [originX + p[0] * capH, originY + p[1] * capH] as const);
    strokePolyline(bmp, pts, stroke, color);
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* 5×7 点阵（预览图上的英文标注）                                        */
/* ------------------------------------------------------------------ */

/** 点阵字宽（列）、字高（行）、步进（含 1 列间距）。 */
export const ASCII_GLYPH_W = 5;
export const ASCII_GLYPH_H = 7;
export const ASCII_ADVANCE = 6;

const DOTS = '.....';

/** 5×7 点阵：每字符 7 行、每行 5 列（`#` = 墨迹）。只用于离线预览的标注小字。 */
const FONT_5X7: Readonly<Record<string, string>> = {
  A: '.###./#...#/#...#/#####/#...#/#...#/#...#',
  B: '####./#...#/#...#/####./#...#/#...#/####.',
  C: '.###./#...#/#..../#..../#..../#...#/.###.',
  D: '####./#...#/#...#/#...#/#...#/#...#/####.',
  E: '#####/#..../#..../####./#..../#..../#####',
  F: '#####/#..../#..../####./#..../#..../#....',
  G: '.###./#...#/#..../#.###/#...#/#...#/.###.',
  H: '#...#/#...#/#...#/#####/#...#/#...#/#...#',
  I: '#####/..#../..#../..#../..#../..#../#####',
  J: '..###/...#./...#./...#./...#./#..#./.##..',
  K: '#...#/#..#./#.#../##.../#.#../#..#./#...#',
  L: '#..../#..../#..../#..../#..../#..../#####',
  M: '#...#/##.##/#.#.#/#.#.#/#...#/#...#/#...#',
  N: '#...#/##..#/#.#.#/#..##/#...#/#...#/#...#',
  O: '.###./#...#/#...#/#...#/#...#/#...#/.###.',
  P: '####./#...#/#...#/####./#..../#..../#....',
  Q: '.###./#...#/#...#/#...#/#.#.#/#..#./.##.#',
  R: '####./#...#/#...#/####./#.#../#..#./#...#',
  S: '.####/#..../#..../.###./....#/....#/####.',
  T: '#####/..#../..#../..#../..#../..#../..#..',
  U: '#...#/#...#/#...#/#...#/#...#/#...#/.###.',
  V: '#...#/#...#/#...#/#...#/#...#/.#.#./..#..',
  W: '#...#/#...#/#...#/#.#.#/#.#.#/##.##/#...#',
  X: '#...#/#...#/.#.#./..#../.#.#./#...#/#...#',
  Y: '#...#/#...#/.#.#./..#../..#../..#../..#..',
  Z: '#####/....#/...#./..#../.#.../#..../#####',
  '0': '.###./#...#/#..##/#.#.#/##..#/#...#/.###.',
  '1': '..#../.##../..#../..#../..#../..#../.###.',
  '2': '.###./#...#/....#/...#./..#../.#.../#####',
  '3': '####./....#/....#/.###./....#/....#/####.',
  '4': '...#./..##./.#.#./#..#./#####/...#./...#.',
  '5': '#####/#..../####./....#/....#/#...#/.###.',
  '6': '..##./.#.../#..../####./#...#/#...#/.###.',
  '7': '#####/....#/...#./..#../.#.../.#.../.#...',
  '8': '.###./#...#/#...#/.###./#...#/#...#/.###.',
  '9': '.###./#...#/#...#/.####/....#/...#./.##..',
  ':': '...../..#../..#../...../..#../..#../.....',
  '.': '...../...../...../...../...../.##../.##..',
  '-': '...../...../...../#####/...../...../.....',
  '/': '....#/....#/...#./..#../.#.../#..../#....',
  '+': '...../..#../..#../#####/..#../..#../.....',
  '(': '..#../.#.../#..../#..../#..../.#.../..#..',
  ')': '..#../...#./....#/....#/....#/...#./..#..',
  // 「选取率 12.1%」那一行要用到百分号（5 列下只能给个示意形状）
  '%': '##..#/##.#./...#./..#../.#.../.#.##/#..##',
  ' ': DOTS,
};

/** 一个字符的点阵行（大写化；不支持的字符当空格）。 */
export function asciiGlyph(ch: string): readonly string[] {
  const rows = FONT_5X7[ch.toUpperCase()] ?? FONT_5X7[' ']!;
  const out = rows.split('/');
  // 防御：表写错（行数/列数不对）时补齐，避免画的时候越界
  while (out.length < ASCII_GLYPH_H) out.push(DOTS);
  return out.slice(0, ASCII_GLYPH_H).map((r) => (r + DOTS).slice(0, ASCII_GLYPH_W));
}

/** 文本像素宽（scale 为整数倍率；字间距 1 列）。 */
export function asciiTextWidth(text: string, scale: number): number {
  const n = text.length;
  return n === 0 ? 0 : (n * ASCII_ADVANCE - 1) * scale;
}

/** 文本像素高。 */
export function asciiTextHeight(scale: number): number {
  return ASCII_GLYPH_H * scale;
}

/**
 * 画一段 ASCII 标注（`(x, y)` 是**左上角**）。
 *
 * 点阵按整数倍率放大（`scale >= 1`），不做抗锯齿 —— 小字标注要的是清晰。
 */
export function drawAsciiText(
  bmp: Bitmap,
  text: string,
  x: number,
  y: number,
  scale: number,
  color: Rgba,
): void {
  const s = Math.max(1, Math.round(scale));
  let penX = Math.round(x);
  const top = Math.round(y);
  for (const ch of text) {
    const rows = asciiGlyph(ch);
    for (let ry = 0; ry < ASCII_GLYPH_H; ry++) {
      const row = rows[ry]!;
      for (let rx = 0; rx < ASCII_GLYPH_W; rx++) {
        if (row[rx] !== '#') continue;
        for (let dy = 0; dy < s; dy++) {
          for (let dx = 0; dx < s; dx++) {
            const px = penX + rx * s + dx;
            const py = top + ry * s + dy;
            if (px < 0 || py < 0 || px >= bmp.width || py >= bmp.height) continue;
            const i = (py * bmp.width + px) * 4;
            bmp.data[i] = color.r;
            bmp.data[i + 1] = color.g;
            bmp.data[i + 2] = color.b;
            bmp.data[i + 3] = 255;
          }
        }
      }
    }
    penX += ASCII_ADVANCE * s;
  }
}

/* ------------------------------------------------------------------ */
/* 局内强度评级要用到的两笔：**发光**与**选取率那一行**                    */
/* ------------------------------------------------------------------ */

/**
 * 画字母的**外发光**（局内同样是分层加宽描边 —— 见 `label-draw.ts` 的 `tierGlowLayers`）。
 *
 * 为什么不用 canvas 的 `shadowBlur` 对齐：`shadowBlur` 是设备像素级的模糊量、
 * 与 CTM/DPR 的关系各家不一致，预览里也没有滤镜。所以两边都改成
 * "把字母墨迹边界向外加宽 `reach`"的**同一份分层数据**，
 * 只是 canvas 用 `lineWidth = 2 × reach` 的 `strokeText`、这里加宽字形笔画。
 *
 * @returns 是否真的画了（字形不支持时返回 false）
 */
export function drawGlowGlyph(
  bmp: Bitmap,
  ch: string,
  sizePx: number,
  cx: number,
  cy: number,
  layers: readonly TierGlowLayer[],
): boolean {
  if (!vectorGlyph(ch)) return false;
  // 由宽到窄：宽的在下、窄的在上，叠出柔光
  for (const layer of [...layers].reverse()) {
    drawVectorGlyph(bmp, ch, sizePx, cx, cy, layer.rgba, {
      strokeRatio: outlineStrokeRatio(sizePx, layer.reach * 2),
    });
  }
  return true;
}

/**
 * canvas 的 `lineWidth = w` 描边 ↔ 预览的字形笔画比。
 *
 * canvas 把 `w` 居中压在墨迹边界上 → 向外扩 `w/2`；预览的字形是"中心线 + 笔画宽"，
 * 把笔画加宽到 `字形笔画 + 2×(w/2)/字号` 就得到同样的外扩量。两边因此**同外扩量**。
 */
export function outlineStrokeRatio(sizePx: number, lineWidth: number): number {
  return GLYPH_STROKE_RATIO + lineWidth / Math.max(1, sizePx);
}

/** 点阵字形的 alpha（十六进制字符 → 0..1）。 */
function hexAlpha(ch: string | undefined): number {
  if (ch === undefined) return 0;
  const v = Number.parseInt(ch, 16);
  return Number.isFinite(v) ? Math.max(0, Math.min(15, v)) / 15 : 0;
}

/** 点阵按归一化坐标 (u, v) ∈ [0,1] 双线性取样。 */
function sampleCjkGlyph(g: CjkRateGlyph, u: number, v: number): number {
  if (u < 0 || v < 0 || u >= 1 || v >= 1) return 0;
  const fx = u * g.w - 0.5;
  const fy = v * g.h - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const at = (col: number, row: number): number => {
    if (col < 0 || row < 0 || col >= g.w || row >= g.h) return 0;
    return hexAlpha(g.rows[row]?.[col]);
  };
  const a = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
  const b = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
  return a * (1 - ty) + b * ty;
}

/**
 * 画一个汉字：**墨迹**铺满 `[baselineY - inkHeight, baselineY]`、水平居中于 `cx`。
 *
 * 这正是 `label-draw.ts` 排版的假设（选取率行的墨迹高 = `rate.inkHeight`），
 * 所以预览里那一行的位置与局内一致 —— 差的是字形本身（位图 vs 矢量字体）。
 */
export function drawCjkRateGlyph(
  bmp: Bitmap,
  g: CjkRateGlyph,
  cx: number,
  baselineY: number,
  inkHeight: number,
  color: Rgba,
): void {
  const h = Math.max(1, inkHeight);
  const w = Math.max(1, (h * g.w) / g.h);
  const x0 = cx - w / 2;
  const y0 = baselineY - h;
  const px0 = Math.max(0, Math.floor(x0) - 1);
  const py0 = Math.max(0, Math.floor(y0) - 1);
  const px1 = Math.min(bmp.width - 1, Math.ceil(x0 + w) + 1);
  const py1 = Math.min(bmp.height - 1, Math.ceil(y0 + h) + 1);
  for (let y = py0; y <= py1; y++) {
    for (let x = px0; x <= px1; x++) {
      const cov = sampleCjkGlyph(g, (x + 0.5 - x0) / w, (y + 0.5 - y0) / h);
      blendPixel(bmp, x, y, color, cov);
    }
  }
}

/**
 * 画「选取率 12.1%」那一行（**预览专用**）：汉字用内置点阵、数字/百分号用 5×7 点阵，
 * 整行以 `cx` 水平居中、坐在 `baselineY` 上。
 *
 * ⚠️ 与局内的差异（唯一一处）：局内是矢量字体，这里汉字是位图、数字是点阵，
 * 各自的**字宽**因此略有差别（整行居中，所以偏差会被摊到两侧，视觉上不可辨）。
 * 字号、墨迹高、基线、居中都按 `label-draw.ts` 的同一份计划给。
 *
 * @returns 画了几个汉字（0 = 内置点阵没有这几个字，调用方可以提示）
 */
export function drawRateLine(
  bmp: Bitmap,
  text: string,
  fontSize: number,
  inkHeight: number,
  cx: number,
  baselineY: number,
  color: Rgba,
): number {
  const asciiScale = Math.max(1, Math.round((fontSize * GLYPH_CAP_RATIO) / ASCII_GLYPH_H));
  // 预算整行宽度：汉字按 1 em、ASCII 按点阵步进（局内是字体度量，这里只能近似，
  // 差别会被"整行居中"摊到两侧）
  let total = 0;
  for (const ch of text) total += cjkRateGlyph(ch) ? fontSize : ASCII_ADVANCE * asciiScale;
  let penX = cx - total / 2;
  let drew = 0;
  for (const ch of text) {
    const g = cjkRateGlyph(ch);
    if (g) {
      drawCjkRateGlyph(bmp, g, penX + fontSize / 2, baselineY, inkHeight, color);
      penX += fontSize;
      drew++;
      continue;
    }
    // ASCII：点阵高 = cap 高，坐在基线上
    drawAsciiText(bmp, ch, penX, baselineY - asciiTextHeight(asciiScale), asciiScale, color);
    penX += ASCII_ADVANCE * asciiScale;
  }
  return drew;
}

/* ------------------------------------------------------------------ */
/* 档位字母：真字体轮廓（`label-letter-outlines.ts`）+ 发光/描边（距离场向外扩） */
/* ------------------------------------------------------------------ */

/** 一条档位字母标签要画的三笔（与 `label-draw.ts` 的 `TierTagPlan` 同源）。 */
export interface TierLetterPaint {
  /** 外发光层（内 → 外；就是 `tierGlowLayers()` 的输出）。 */
  readonly glow: readonly TierGlowLayer[];
  /** 深色描边**线宽**（canvas `lineWidth` 的语义：居中压在墨迹边界 → 向外扩它的一半）。 */
  readonly outlineWidth: number;
  readonly outline: Rgba;
  readonly fill: Rgba;
}

/**
 * 把一个字母的轮廓换算到**目标位图像素坐标**。
 *
 * 与 canvas 完全同构：`textAlign='center'` 把**前进宽**居中 → 笔位原点
 * `penX = textX − advance × 字号 ÷ 2`；`textBaseline='alphabetic'` → y 从**基线**起算。
 */
export function transformLetterContours(
  g: TierLetterGlyph,
  fontSize: number,
  penX: number,
  baselineY: number,
): number[][] {
  const out: number[][] = [];
  for (const c of g.contours) {
    const pts = new Array<number>(c.length);
    for (let i = 0; i + 1 < c.length; i += 2) {
      pts[i] = penX + c[i]! * fontSize;
      pts[i + 1] = baselineY + c[i + 1]! * fontSize;
    }
    out.push(pts);
  }
  return out;
}

/**
 * 画一个档位字母：**发光（宽 → 窄）→ 深色描边 → 字母本体**。
 *
 * 与局内 canvas 的 `drawTierTag()`（`apps/overlay/src/renderer/overlay-canvas.ts`）
 * **同序同参**，只是把"描边字形"换成"按距离场向外扩"：
 *   · 局内：`strokeText(lineWidth = 2 × reach)` → 墨迹向外扩 `reach`；
 *   · 预览：`coverage = clamp(1 + reach − 距离)` → 同一个外扩量（`+1` 含半像素修正）。
 *   深色描边同理（`lineWidth = outlineWidth` → 外扩 `outlineWidth / 2`），
 *   向内那半随后被字母本体盖住 —— 与 canvas 的合成顺序一致。
 *
 * 字形不存在（不在 A~Z）时返回 `false`，调用方回退到 `drawVectorGlyph()` 或提示。
 * 完全画在画布之外时返回 `true`（没有可见墨迹，但**不是**字形缺失，不该触发回退）。
 */
export function drawTierLetter(
  bmp: Bitmap,
  ch: string,
  fontSize: number,
  textX: number,
  baselineY: number,
  paint: TierLetterPaint,
): boolean {
  const g = tierLetterGlyph(ch);
  if (!g) return false;
  const size = Math.max(1, fontSize);
  let pad = Math.max(0, paint.outlineWidth / 2);
  for (const layer of paint.glow) pad = Math.max(pad, layer.reach);
  pad = Math.ceil(pad) + 2;
  const penX = textX - (g.advance * size) / 2;
  const ox = Math.max(0, Math.floor(penX + g.inkLeft * size - pad));
  const oy = Math.max(0, Math.floor(baselineY + g.inkTop * size - pad));
  const ex = Math.min(bmp.width, Math.ceil(penX + g.inkRight * size + pad));
  const ey = Math.min(bmp.height, Math.ceil(baselineY + g.inkBottom * size + pad));
  const w = ex - ox;
  const h = ey - oy;
  if (w <= 0 || h <= 0) return true; // 落在画布外：没有字形缺失，别让调用方回退
  const cov = rasterizePolygons(transformLetterContours(g, size, penX, baselineY), w, h, ox, oy);
  const dist = inkDistanceField(cov, w, h);
  // ① 发光：由宽到窄（宽的在下），叠出柔光
  for (const layer of [...paint.glow].reverse()) {
    paintDilated(bmp, dist, w, h, ox, oy, layer.reach, layer.rgba);
  }
  // ② 深色描边：给彩色字母定形
  if (paint.outlineWidth > 0) {
    paintDilated(bmp, dist, w, h, ox, oy, paint.outlineWidth / 2, paint.outline);
  }
  // ③ 字母本体（覆盖率直接合成；盖住描边/发光向内那半）
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = cov[y * w + x] ?? 0;
      if (c > 0) blendPixel(bmp, ox + x, oy + y, paint.fill, c);
    }
  }
  return true;
}

/** 把"墨迹向外扩 `reach`"的覆盖率铺到目标位图上（`dist` = `inkDistanceField()` 的输出）。 */
function paintDilated(
  bmp: Bitmap,
  dist: Float32Array,
  width: number,
  height: number,
  originX: number,
  originY: number,
  reach: number,
  color: Rgba,
): void {
  if (reach <= 0) return;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cov = 1 + reach - (dist[y * width + x] ?? 0);
      if (cov <= 0) continue;
      blendPixel(bmp, originX + x, originY + y, color, cov > 1 ? 1 : cov);
    }
  }
}
