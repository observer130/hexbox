/**
 * 英雄卡片定位
 *
 * 目标：从截屏中找出选人阶段英雄卡片的矩形。
 *
 * 为什么不能硬编码坐标：分辨率、UI 缩放、窗口大小任一变化都会失效。
 *
 * 采用的策略（利用选人 UI 的**结构约束**）：
 *   1. 卡片有醒目的**金色边框** → 先在水平方向做「金色像素投影」
 *   2. 卡片的**列位置等距**且宽度相近 → 用等距性筛选候选
 *   3. 卡片高度占屏幕固定比例 → 用高度比校验
 *
 * 任何一步不满足就返回「不可信」，调用方**不应绘制** ——
 * 宁可漏，不可错（错标胜率比不显示更糟）。
 */

import type { Bitmap, CardSlot, Rect } from './types.ts';

/** 金色边框的判定阈值（RGB）。英雄卡片边框是暖金色。 */
export interface GoldThreshold {
  readonly minR: number;
  readonly minG: number;
  readonly maxB: number;
  /** R 与 B 的最小差值，用于排除白色/灰色。 */
  readonly minRBGap: number;
}

/**
 * 默认金色阈值。
 *
 * 取值偏宽松：不同皮肤/不同 UI 主题下边框亮度有差异，
 * 但「R 高、G 中、B 低」这一暖色特征是一致的。
 */
export const DEFAULT_GOLD: GoldThreshold = {
  minR: 140,
  minG: 100,
  maxB: 110,
  minRBGap: 40,
};

/** 判断某像素是否「金色」。 */
export function isGoldPixel(
  r: number,
  g: number,
  b: number,
  th: GoldThreshold = DEFAULT_GOLD,
): boolean {
  return r >= th.minR && g >= th.minG && b <= th.maxB && r - b >= th.minRBGap;
}

/**
 * 计算每列的金色像素数（列投影）。
 *
 * 卡片左右边框会在投影上形成两个尖峰，峰之间即卡片。
 */
export function goldColumnProjection(
  bmp: Bitmap,
  th: GoldThreshold = DEFAULT_GOLD,
): Uint32Array {
  const proj = new Uint32Array(bmp.width);
  const { data, width, height } = bmp;
  for (let y = 0; y < height; y++) {
    const rowOff = y * width * 4;
    for (let x = 0; x < width; x++) {
      const i = rowOff + x * 4;
      // 只统计明显偏亮的金色，避免暗部噪声
      if (data[i + 3]! > 128 && isGoldPixel(data[i]!, data[i + 1]!, data[i + 2]!, th)) {
        proj[x]!++;
      }
    }
  }
  return proj;
}

/**
 * 从投影中找出「竖线」（卡片边框）的 x 位置。
 *
 * 做法：取自适应阈值（最大值的比例）+ **绝对下限**，再找连续超阈区段的中心。
 *
 * ⚠️ 绝对下限必不可少：若只有零散噪点，投影最大值可能只有 1~2，
 * 此时 `max * ratio` 也极小，于是**每一列都会「超过阈值」**，
 * 检出几十条假竖线并拼出十几张假卡片。
 * 真实卡片边框会占据数百个垂直像素，故设一个绝对下限即可滤掉噪点。
 */
export function findVerticalLines(
  proj: Uint32Array,
  options: {
    readonly ratio?: number;
    readonly minGap?: number;
    /**
     * 一条竖线至少需要多少个金色像素。
     * 默认 20：足以排除噪点，又允许低分辨率截图。
     */
    readonly minPixels?: number;
  } = {},
): number[] {
  const ratio = options.ratio ?? 0.35;
  const minGap = options.minGap ?? 4;
  const minPixels = options.minPixels ?? 20;

  let max = 0;
  for (const v of proj) if (v > max) max = v;
  if (max < minPixels) return []; // 整体太弱 —— 根本没有边框

  const cut = Math.max(max * ratio, minPixels);
  const lines: number[] = [];
  let runStart = -1;

  for (let x = 0; x < proj.length; x++) {
    const on = proj[x]! >= cut;
    if (on && runStart < 0) runStart = x;
    if (!on && runStart >= 0) {
      // 取区段中心作为线的位置
      lines.push(Math.round((runStart + x - 1) / 2));
      runStart = -1;
    }
  }
  if (runStart >= 0) lines.push(Math.round((runStart + proj.length - 1) / 2));

  // 合并过近的线（同一根边框的多次检测）
  const merged: number[] = [];
  for (const x of lines) {
    const last = merged[merged.length - 1];
    if (last === undefined || x - last >= minGap) merged.push(x);
  }
  return merged;
}

/**
 * 由竖线位置推断卡片矩形。
 *
 * 两步：
 *   1. `groupAndPair` 在**全部**竖线里搜索「等宽等距」的配对组合，
 *      而不是朴素地按顺序两两配对 —— 后者会被无关金色元素破坏；
 *   2. 校验组合的整体结构（张数、位置区间）。
 *
 * 相邻两条竖线构成一张卡片的左右边界；再按给定高度比推上下边界。
 * 无法组成可信结构时返回「不可信」，调用方**不应绘制**。
 */
export function cardsFromLines(
  lines: readonly number[],
  imageWidth: number,
  imageHeight: number,
  options: {
    readonly topRatio?: number;
    readonly heightRatio?: number;
    /** 允许的宽度偏差比例。 */
    readonly widthTolerance?: number;
    /** 相邻卡片最大间隙（占卡宽比例，默认 0.3）。 */
    readonly maxGapRatio?: number;
  } = {},
): { cards: Rect[]; confident: boolean; reason?: string } {
  const topRatio = options.topRatio ?? 0.05;
  const heightRatio = options.heightRatio ?? 0.42;
  const tol = options.widthTolerance ?? 0.35;

  if (lines.length < 4) {
    return { cards: [], confident: false, reason: `竖线太少(${lines.length})，不足以构成卡片` };
  }
  if (imageWidth <= 0 || imageHeight <= 0) {
    return { cards: [], confident: false, reason: '图像尺寸非法' };
  }

  const grouped = groupAndPair(lines, tol, options.maxGapRatio ?? 0.3);

  if (grouped.cards.length === 0) {
    return {
      cards: [],
      confident: false,
      reason: grouped.reason ?? `竖线无法组成等宽卡片(${lines.length} 条)`,
    };
  }

  // 校验：选人界面至少 2 张卡片。
  // 只检出 1 张通常意味着把别处的金色元素误检了，宁可不出结果。
  if (grouped.cards.length < 2) {
    return {
      cards: [],
      confident: false,
      reason: `只检出 ${grouped.cards.length} 张卡片，不足以确认是选人界面`,
    };
  }

  // 组内残余宽度差校验（groupAndPair 已保证组内等宽，这里防御性复查）
  const widths = grouped.cards.map((r) => r.right - r.left);
  const avg = widths.reduce((a, b) => a + b, 0) / widths.length;
  const bad = widths.filter((w) => Math.abs(w - avg) / avg > tol);
  if (bad.length > 0) {
    return {
      cards: [],
      confident: false,
      reason: `卡片宽度不一致(${widths.map((w) => w.toFixed(3)).join(',')})，可能是误检`,
    };
  }

  // 按从左到右排序
  const rects: Rect[] = [...grouped.cards]
    .sort((a, b) => a.left - b.left)
    .map((c) => ({
      x: c.left / imageWidth,
      y: topRatio,
      w: (c.right - c.left) / imageWidth,
      h: heightRatio,
    }));
  return { cards: rects, confident: true, reason: grouped.reason };
}

/** 等宽等距配对选出的一张卡片（像素坐标，尚未归一化）。 */
interface PairedCard {
  readonly left: number;
  readonly right: number;
}

/**
 * 等宽等距配对结果。
 *
 * `reason` 携带筛选过程的诊断信息（"从 N 条竖线筛出 M 张"），
 * 供调试日志与标注图使用 —— 定位失败时能看出是「没有候选」还是
 * 「候选被等宽约束滤掉」。
 */
interface GroupedCards {
  readonly cards: PairedCard[];
  readonly reason?: string;
}

/**
 * 在竖线集合中搜索「等宽等距」的左右边界配对。
 *
 * 算法（穷举 + 结构校验，竖线数量通常 < 30，代价可忽略）：
 *   1. 枚举全部 (i, j) 组合作为候选卡片的左右边界；
 *   2. **按宽度精确聚桶**（±2%）：真卡片的每对边界都严格复现同一宽度，
 *      噪声线对的宽度互不相同；
 *   3. 桶内配对做**互不相交链校验**（端点不共享、左右递增）；
 *   4. **小间隙校验**：相邻卡片间隙 ≤ 卡宽 × maxGapRatio
 *      （选人卡片几乎相触；纯周期线对会形成大间隙假链）；
 *   5. 相邻卡片**中心等距**校验。
 *
 * 桶按出现次数降序**依次尝试**（而非只试第一个）：
 * 均匀网格里「左边缘序列」与「右边缘序列」会产生与真卡宽同频的
 * 「间距桶」（宽度 = 卡宽 + 间隙），它的假链会被第 4 步拒绝，
 * 随后真卡宽桶胜出。
 *
 * 历史教训：宽松贪心（从左到右找第一条宽度匹配的线）会在真实噪声上
 * 产生假阳性 —— 结算界面 10 条杂线能配出 2 张"等宽卡片"。
 */
function groupAndPair(
  lines: readonly number[],
  tol: number,
  maxGapRatio: number,
): GroupedCards {
  // 1) 枚举全部配对
  const pairs: Array<{ left: number; right: number; w: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const w = lines[j]! - lines[i]!;
      if (w > 0) pairs.push({ left: lines[i]!, right: lines[j]!, w });
    }
  }
  if (pairs.length === 0) return { cards: [], reason: '无可配对竖线' };

  // 2) 按宽度精确聚桶（±2% 相对带宽；tol 只用于链内复查）
  const buckets: Array<{ w: number; pairs: typeof pairs }> = [];
  for (const p of pairs) {
    const hit = buckets.find((b) => Math.abs(b.w - p.w) / p.w <= 0.02);
    if (hit) {
      hit.pairs.push(p);
    } else {
      buckets.push({ w: p.w, pairs: [p] });
    }
  }
  const candidates = buckets
    .filter((b) => b.pairs.length >= 2)
    .sort((a, b) => b.pairs.length - a.pairs.length || b.w - a.w);
  if (candidates.length === 0) {
    return { cards: [], reason: '无重复出现的卡片宽度（全是孤立噪声）' };
  }

  // 3)-5) 依次尝试候选桶
  let maxChain = 0;
  for (const cand of candidates) {
    const chain = cand.pairs
      .slice()
      .sort((a, b) => a.left - b.left || a.right - b.right);
    const chosen: Array<{ left: number; right: number }> = [];
    let lastRight = -Infinity;
    for (const p of chain) {
      const wRef = chosen.length > 0 ? chosen[0]!.right - chosen[0]!.left : p.w;
      if (Math.abs(p.w - wRef) / wRef > tol) continue;
      if (p.left <= lastRight) continue; // 与上一张卡片重叠/共享端点
      chosen.push({ left: p.left, right: p.right });
      lastRight = p.right;
    }
    if (chosen.length < 2) {
      maxChain = Math.max(maxChain, chosen.length);
      continue;
    }

    // 4) 小间隙校验：真卡片几乎相触；周期假链的间隙 ≈ 卡宽
    const wRef = chosen[0]!.right - chosen[0]!.left;
    const tooWideGap = chosen.some(
      (c, k) =>
        k > 0 && c.left - chosen[k - 1]!.right > wRef * maxGapRatio,
    );
    if (tooWideGap) {
      continue;
    }

    // 5) 中心等距校验：相邻卡片中心距应相近（偏差 >25% 视为混入噪声）
    const centers = chosen.map((c) => (c.left + c.right) / 2);
    const gaps: number[] = [];
    for (let k = 1; k < centers.length; k++) gaps.push(centers[k]! - centers[k - 1]!);
    const gapAvg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    if (gaps.some((g) => Math.abs(g - gapAvg) / gapAvg > 0.25)) {
      continue;
    }

    return {
      cards: chosen.map((c) => ({ left: c.left, right: c.right })),
      reason: `从 ${lines.length} 条竖线按宽度 ${cand.w.toFixed(0)}px 筛出 ${chosen.length} 张`,
    };
  }

  return {
    cards: [],
    reason: `等宽候选桶均未通过间距校验（最多串成 ${maxChain} 张）`,
  };
}

/**
 * 一站式：从位图检测卡片。
 *
 * 流程：金色列投影 → 竖线检测 → **等宽等距分组配对**（抗噪关键）→ 校验。
 *
 * 抗噪背景（真实教训）：在结算界面运行时，金色数字/图标/按钮会产生
 * 十几条假竖线，朴素「两两相邻配对」会把它们拼成宽度悬殊的假卡片。
 * `groupAndPair` 用「等宽 + 等距」两个结构约束把它们滤掉。
 *
 * @param goldRatio 金色投影的自适应阈值比例
 */
export function detectCards(
  bmp: Bitmap,
  options: {
    readonly gold?: GoldThreshold;
    readonly goldRatio?: number;
    readonly minPixels?: number;
    readonly topRatio?: number;
    readonly heightRatio?: number;
  } = {},
): { cards: Rect[]; confident: boolean; reason?: string; lines: number[] } {
  if (bmp.width === 0 || bmp.height === 0) {
    return { cards: [], confident: false, reason: '位图为空', lines: [] };
  }

  const proj = goldColumnProjection(bmp, options.gold ?? DEFAULT_GOLD);
  const lines = findVerticalLines(proj, {
    ratio: options.goldRatio ?? 0.35,
    minPixels: options.minPixels,
  });
  const res = cardsFromLines(lines, bmp.width, bmp.height, {
    topRatio: options.topRatio,
    heightRatio: options.heightRatio,
  });
  return { ...res, lines };
}

/** 把检测结果包装为 CardSlot（尚未识别英雄）。 */
export function toCardSlots(rects: readonly Rect[]): CardSlot[] {
  return rects.map((rect) => ({ rect, championId: null, score: 0 }));
}
