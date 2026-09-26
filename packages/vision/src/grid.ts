/**
 * 英雄卡片定位
 *
 * 检测原理（2026-09-27 用真实选人截图校准，勿凭印象改回）：
 *
 *   ⚠️ 边框颜色：海克斯乱斗选人卡片的边框是**象牙白双描边**
 *   （实测 RGB ≈ 150,143,138，R-B 差仅 ~15）—— 不是饱和金色！
 *   「金色检测」在真实界面上检不出任何卡片（此教训已写进测试）。
 *   边框的可靠结构特征是：**暗背景上的亮竖线**（边框两侧都是暗像素），
 *   因此用**亮度垂直梯度**做列投影，不依赖色相。
 *
 *   实测结构（3413×1920 截图）：
 *     - 每张卡片左右边框各由 2~3 条相邻亮线组成（跨 ~25px），
 *       需先合并成一条「带」再配对，否则子线组合会拆散等宽校验；
 *     - 卡片左右两侧还有对称的装饰弧线（各 2 条亮线），
 *       它们与卡片能拼出「等宽对」（弧→卡宽 842），必须靠
 *       **纵横比校验**（卡高/卡宽 ≈ 1.59）淘汰；
 *     - 卡片纵向范围由行方向梯度投影取「最厚的上下边框带」。
 *
 * 任何一步不满足就返回「不可信」，调用方**不应绘制** ——
 * 宁可漏，不可错（错标胜率比不显示更糟）。
 */

import type { Bitmap, CardSlot, Rect } from './types.ts';

/** 亮度（Rec.601）。 */
function lumaAt(data: Uint8ClampedArray, width: number, x: number, y: number): number {
  const i = (y * width + x) * 4;
  return 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
}

export interface EdgeProjectOptions {
  /** 判定为「亮于邻域」的最小亮度差（0-255 亮度空间，与分辨率无关）。 */
  readonly minLumaDelta?: number;
  /** 邻域采样距离（像素）。默认 max(3, round(H*0.003))，随分辨率缩放。 */
  readonly offset?: number;
  /** 参与投影的纵向范围（归一化），避开顶部任务栏/底部聊天。 */
  readonly yTop?: number;
  readonly yBottom?: number;
}

function projectOptions(bmp: Bitmap, o: EdgeProjectOptions = {}): {
  delta: number;
  offset: number;
  y0: number;
  y1: number;
} {
  return {
    delta: o.minLumaDelta ?? 22,
    offset: o.offset ?? Math.max(3, Math.round(bmp.height * 0.003)),
    y0: Math.round(bmp.height * (o.yTop ?? 0.1)),
    y1: Math.round(bmp.height * (o.yBottom ?? 0.9)),
  };
}

/**
 * 垂直边缘列投影：每列统计「比左右邻域亮得多」的行数。
 *
 * 卡片边框是暗底上的亮竖线 → 在投影上形成尖峰带。
 */
export function edgeColumnProjection(
  bmp: Bitmap,
  options: EdgeProjectOptions = {},
): Uint32Array {
  const { delta, offset, y0, y1 } = projectOptions(bmp, options);
  const proj = new Uint32Array(bmp.width);
  for (let y = y0; y < y1; y++) {
    for (let x = offset; x < bmp.width - offset; x++) {
      const c = lumaAt(bmp.data, bmp.width, x, y);
      const d = Math.max(
        c - lumaAt(bmp.data, bmp.width, x - offset, y),
        c - lumaAt(bmp.data, bmp.width, x + offset, y),
      );
      if (d > delta) proj[x]!++;
    }
  }
  return proj;
}

/**
 * 水平边缘行投影：每行统计「比上下邻域亮得多」的像素数。
 *
 * 用于确定卡片的纵向范围（上下边框是亮横线）。
 * 只统计 `[x0, x1]` 列范围（通常是一张卡片的横向范围）。
 */
export function edgeRowProjection(
  bmp: Bitmap,
  x0: number,
  x1: number,
  options: EdgeProjectOptions = {},
): Uint32Array {
  const { delta, offset, y0, y1 } = projectOptions(bmp, options);
  const proj = new Uint32Array(bmp.height);
  for (let y = offset; y < bmp.height - offset; y++) {
    for (let x = x0; x <= x1; x++) {
      const c = lumaAt(bmp.data, bmp.width, x, y);
      const d = Math.max(
        c - lumaAt(bmp.data, bmp.width, x, y - offset),
        c - lumaAt(bmp.data, bmp.width, x, y + offset),
      );
      if (d > delta) proj[y]!++;
    }
  }
  return proj;
}

/** 投影上的一段连续超阈区（一条边框带，可能含多条相邻子线）。 */
export interface Band {
  readonly start: number;
  readonly end: number;
  /** 带中心（配对用）。 */
  readonly center: number;
  /** 带内投影峰值（强度）。 */
  readonly strength: number;
}

/**
 * 从投影中提取边框带。
 *
 * ⚠️ 合并相邻子线必不可少：实测每条边框由 2~3 条相邻亮线组成
 * （跨 ~25px）。若不合并，同一边框的子线会互相组合出大量假宽度，
 * 拆散等宽校验。`mergeGap` 应 ≈ 边框总厚（0.010×图像宽）。
 *
 * `minPixels` 绝对下限依旧必要：噪点场景下投影最大值可能只有个位数，
 * 自适应阈值会失效（详见 git 历史 —— 该坑真实发生过）。
 */
export function findBands(
  proj: Uint32Array,
  options: {
    readonly ratio?: number;
    readonly minPixels?: number;
    readonly mergeGap?: number;
  } = {},
): Band[] {
  const ratio = options.ratio ?? 0.35;
  const minPixels = options.minPixels ?? 20;
  const mergeGap = options.mergeGap ?? 0;

  let max = 0;
  for (const v of proj) if (v > max) max = v;
  if (max < minPixels) return [];

  const cut = Math.max(max * ratio, minPixels);
  const raw: Band[] = [];
  let runStart = -1;
  for (let x = 0; x < proj.length; x++) {
    const on = proj[x]! >= cut;
    if (on && runStart < 0) runStart = x;
    if (!on && runStart >= 0) {
      raw.push({ start: runStart, end: x - 1, center: 0, strength: 0 });
      runStart = -1;
    }
  }
  if (runStart >= 0) {
    raw.push({ start: runStart, end: proj.length - 1, center: 0, strength: 0 });
  }

  // 合并过近的带（同一根边框的多次检测 / 描边子线）
  const merged: Band[] = [];
  for (const b of raw) {
    const last = merged[merged.length - 1];
    if (last && b.start - last.end <= mergeGap) {
      // 就地扩展（对象创建后只在这里变更）
      (last as { end: number }).end = b.end;
    } else {
      merged.push(b);
    }
  }
  return merged.map((b) => {
    let peak = 0;
    for (let x = b.start; x <= b.end; x++) peak = Math.max(peak, proj[x]!);
    return {
      start: b.start,
      end: b.end,
      center: Math.round((b.start + b.end) / 2),
      strength: peak,
    };
  });
}

/** 卡片纵向范围（像素）。 */
export interface VerticalExtent {
  readonly top: number;
  readonly bottom: number;
}

export interface CardsFromBandsOptions {
  /** 相邻卡片最大间隙（占卡宽比例）。选人卡片几乎相触，默认 0.3。 */
  readonly maxGapRatio?: number;
  /** 卡片高宽比（实测 791/497 ≈ 1.59，纵向人形卡）。 */
  readonly aspectRatio?: number;
  /** 纵横比允许偏差。 */
  readonly aspectTolerance?: number;
}

/**
 * 在边框带中搜索「等宽等距」的左右配对，重构卡片矩形。
 *
 * 算法（穷举 + 结构校验，边框带通常 < 20 条，代价可忽略）：
 *   1. 用**带中心**枚举全部 (左,右) 配对；
 *   2. 按宽度精确聚桶（±2%）：真卡片的每对边界都复现同一宽度；
 *   3. 桶内配对做**互不相交链**校验（端点不重叠）；
 *   4. **小间隙校验**：相邻卡片间隙 ≤ 卡宽 × maxGapRatio
 *      （淘汰「弧线+卡片」拼成的超宽假链与均匀周期线）；
 *   5. **纵横比校验**：卡高/卡宽应 ≈ aspectRatio
 *      （淘汰与卡片等宽重复出现的装饰结构）；
 *      纵向范围由 `extent` 回调实测（无实测则该链不可信）。
 *
 * 桶按出现次数降序、宽度降序**依次尝试**（详见测试里的真实案例）。
 * 最终矩形用**带外缘**（比带中心更贴近视觉边界）。
 */
export function cardsFromBands(
  bands: readonly Band[],
  imageWidth: number,
  imageHeight: number,
  options: CardsFromBandsOptions = {},
  extent?: (x0: number, x1: number) => VerticalExtent | null,
): { cards: Rect[]; confident: boolean; reason?: string; pairs?: number } {
  const maxGapRatio = options.maxGapRatio ?? 0.3;
  const aspectRatio = options.aspectRatio ?? 1.59;
  const aspectTolerance = options.aspectTolerance ?? 0.3;

  if (bands.length < 4) {
    return { cards: [], confident: false, reason: `边框带太少(${bands.length})，不足以构成卡片` };
  }
  if (imageWidth <= 0 || imageHeight <= 0) {
    return { cards: [], confident: false, reason: '图像尺寸非法' };
  }

  // 1)-2) 枚举配对 + 宽度精确聚桶（±2%）
  interface Pair {
    left: Band;
    right: Band;
    w: number;
  }
  const pairs: Pair[] = [];
  for (let i = 0; i < bands.length; i++) {
    for (let j = i + 1; j < bands.length; j++) {
      const w = bands[j]!.center - bands[i]!.center;
      if (w > 0) pairs.push({ left: bands[i]!, right: bands[j]!, w });
    }
  }
  if (pairs.length === 0) return { cards: [], confident: false, reason: '无可配对边框带' };

  const buckets: Array<{ w: number; pairs: Pair[] }> = [];
  for (const p of pairs) {
    const hit = buckets.find((b) => Math.abs(b.w - p.w) / p.w <= 0.02);
    if (hit) hit.pairs.push(p);
    else buckets.push({ w: p.w, pairs: [p] });
  }
  const candidates = buckets
    .filter((b) => b.pairs.length >= 2)
    .sort((a, b) => b.pairs.length - a.pairs.length || b.w - a.w);
  if (candidates.length === 0) {
    return { cards: [], confident: false, reason: '无重复出现的卡片宽度（全是孤立噪声）' };
  }

  // 3)-5) 依次尝试候选桶
  for (const cand of candidates) {
    const chain = cand.pairs
      .slice()
      .sort((a, b) => a.left.center - b.left.center || a.right.center - b.right.center);
    const chosen: Pair[] = [];
    for (const p of chain) {
      const last = chosen[chosen.length - 1];
      // 互不相交：下一条的左带必须在本条右带之后（留 1px 余量）
      if (last && p.left.start <= last.right.end) continue;
      chosen.push(p);
    }
    if (chosen.length < 2) continue;

    // 4) 小间隙校验（用带外缘：真卡片几乎相触；周期假链间隙 ≈ 卡宽）
    let gapOk = true;
    for (let k = 1; k < chosen.length; k++) {
      const gap = chosen[k]!.left.start - chosen[k - 1]!.right.end;
      const w = chosen[k - 1]!.right.end - chosen[k - 1]!.left.start + 1;
      if (gap > w * maxGapRatio) {
        gapOk = false;
        break;
      }
    }
    if (!gapOk) continue;

    // 5) 纵横比校验：纵向范围必须实测。
    //    ⚠️ 宽度取**单张卡片**的外缘宽（第一条配对），不是整条链的
    //    外宽 —— 多卡链的外宽含间隙，纵横比会被稀释（真实踩过）。
    const first = chosen[0]!;
    const singleW = first.right.end - first.left.start + 1;
    const ex = extent?.(first.left.start, first.right.end) ?? null;
    if (!ex) continue; // 无实测纵向范围 → 不可信
    const h = ex.bottom - ex.top + 1;
    const aspect = h / singleW;
    if (Math.abs(aspect - aspectRatio) > aspectTolerance) continue;

    const rects: Rect[] = chosen.map((p) => ({
      x: p.left.start / imageWidth,
      y: ex.top / imageHeight,
      w: (p.right.end - p.left.start + 1) / imageWidth,
      h: (ex.bottom - ex.top + 1) / imageHeight,
    }));
    return {
      cards: rects,
      confident: true,
      reason: `从 ${bands.length} 条边框带按宽度 ${cand.w.toFixed(0)}px 筛出 ${chosen.length} 张`,
      pairs: chosen.length,
    };
  }

  return {
    cards: [],
    confident: false,
    reason: `等宽候选桶均未通过间隙/纵横比校验（共 ${candidates.length} 个候选桶）`,
  };
}

/**
 * 一站式：从位图检测卡片。
 *
 * 抗噪背景（真实教训，勿回退）：
 *   - 结算界面的金色元素会产生大量假竖线 → 等宽聚桶 + 间隙/纵横比校验拦截；
 *   - 选人界面的装饰弧线与卡片能拼出「等宽对」→ 纵横比校验拦截；
 *   - 顶部任务栏/底部聊天会污染投影 → 投影限制在 [0.10H, 0.90H]。
 */
export function detectCards(
  bmp: Bitmap,
  options: CardsFromBandsOptions & EdgeProjectOptions & {
    readonly ratio?: number;
    readonly minPixels?: number;
  } = {},
): { cards: Rect[]; confident: boolean; reason?: string; lines: number[] } {
  if (bmp.width === 0 || bmp.height === 0) {
    return { cards: [], confident: false, reason: '位图为空', lines: [] };
  }

  const proj = edgeColumnProjection(bmp, options);
  const bands = findBands(proj, {
    ratio: options.ratio,
    minPixels: options.minPixels,
    mergeGap: Math.max(6, Math.round(bmp.width * 0.01)),
  });

  const extentFn = (x0: number, x1: number): VerticalExtent | null => {
    const rowProj = edgeRowProjection(bmp, x0, x1, options);
    const rowBands = findBands(rowProj, {
      ratio: options.ratio,
      minPixels: options.minPixels,
      // 行方向同样要合并相邻子线：边框横线由「外沿亮线+内沿亮线」
      // 构成（间隔 ≤ 2×offset 时属同一条横带的两个边），
      // 不合并会出现 4 条细带，minThick 过滤后剩 0 条（真实踩过）。
      mergeGap: Math.max(12, Math.round(bmp.height * 0.012)),
    });
    const minThick = Math.max(5, Math.round(bmp.height * 0.005));
    const thick = rowBands.filter((b) => b.end - b.start + 1 >= minThick);
    if (thick.length < 2) return null;
    // 外宽（带外缘）—— 与纵横比的定义保持一致
    const w = x1 - x0 + 1;
    let best: { t: Band; b: Band; score: number } | null = null;
    for (let i = 0; i < thick.length; i++) {
      for (let j = i + 1; j < thick.length; j++) {
        const t = thick[i]!;
        const b = thick[j]!;
        const h = b.end - t.start + 1;
        const aspect = h / w;
        if (Math.abs(aspect - (options.aspectRatio ?? 1.59)) > (options.aspectTolerance ?? 0.3)) {
          continue;
        }
        const score = t.end - t.start + 1 + (b.end - b.start + 1);
        if (!best || score > best.score) best = { t, b, score };
      }
    }
    return best ? { top: best.t.start, bottom: best.b.end } : null;
  };
  const res = cardsFromBands(bands, bmp.width, bmp.height, options, extentFn);
  return { ...res, lines: bands.map((b) => b.center) };
}

/** 把检测结果包装为 CardSlot（尚未识别英雄）。 */
export function toCardSlots(rects: readonly Rect[]): CardSlot[] {
  return rects.map((rect) => ({ rect, championId: null, score: 0 }));
}
