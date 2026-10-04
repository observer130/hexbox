/**
 * 选人卡片「英雄名区」OCR
 *
 * 策略（2026-09-27 与用户确认）：
 *   选人卡片下部的英雄名是**印刷体白字**（微软雅黑类系统字体），
 *   相比实时渲染的立绘，是稳定得多的识别特征。
 *
 * 两阶段识别（本模块负责第一阶段）：
 *   1. 卡片阶段：名字区二值化 → 连通域分割 → 与「名字位图指纹库」比对
 *   2. 确认阶段：英雄锁定后，顶部栏/玩家条出现标准方头像
 *      → 用静态头像模板匹配（templates.json,与官方图标同源）
 *
 * 指纹库构建：`pnpm templates` 时用与游戏内一致的字体（Microsoft YaHei）
 * 渲染全部 245 个英雄名，生成每个名字的二值位图指纹，落盘 templates.json。
 * 运行时将卡片名字区的二值位图与全部指纹比相似度，取最高且过阈值者。
 */

/** 二值位图指纹（1 = 文字像素）。 */
export interface NameFingerprint {
  readonly championId: number;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** 行优先位串，1 = 有笔画。长度 = width * height。 */
  readonly bits: Uint8Array;
}

/** 名字区提取与归一化参数。 */
export const NAME_STRIP = {
  /**
   * 名字区在卡片内的纵向位置（真机实测校准 2026-09-27）。
   * 初版 0.885 偏高 —— 提取图里文字上半被切；
   * 依据 name-strip 裁剪图回归：文字实际中心 ≈ 0.856 卡高。
   */
  yCenter: 0.856,
  /** 名字区高度（占卡高）。略高于文字高度,留余量吸收缩放误差。 */
  height: 0.095,
  /** 名字区宽度上限（占卡宽，两侧留边距避开边框）。 */
  width: 0.78,
  /** 比对网格：裁剪到文字包围盒后统一拉伸到此尺寸再做 Jaccard。 */
  gridWidth: 96,
  gridHeight: 16,
} as const;

/**
 * 从名字带灰度图中提取**文字包围盒**内的二值位图，
 * 并统一拉伸到固定网格（与指纹库同规格）。
 *
 * 为什么要裁剪包围盒再拉伸：截屏里名字带的位置/宽度受卡片
 * 缩放影响，而指纹库是渲染后裁剪的紧致位图 —— 直接按位置
 * 对齐会因长宽比不同而 Jaccard 崩坏。裁剪到文字本身再拉伸，
 * 两端就都是「紧致文字位图」，可比性成立。
 */
export function extractNameStrip(
  gray: Uint8Array,
  width: number,
  height: number,
  options: {
    /** 二值化阈值（0..255）。名字是白字，默认 150。 */
    readonly threshold?: number;
    /** 输出网格宽。默认与 NAME_STRIP.gridWidth 一致。 */
    readonly outWidth?: number;
    /** 输出网格高。默认与 NAME_STRIP.gridHeight 一致。 */
    readonly outHeight?: number;
  } = {},
): { bits: Uint8Array; width: number; height: number } {
  const threshold = options.threshold ?? 150;
  const outWidth = options.outWidth ?? 96;
  const outHeight = options.outHeight ?? 16;

  // 1) 全图二值化 + 求文字包围盒
  const bin = new Uint8Array(width * height);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (gray[y * width + x]! >= threshold) {
        bin[y * width + x] = 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) {
    return { bits: new Uint8Array(outWidth * outHeight), width: outWidth, height: outHeight };
  }
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;

  // 2) 包围盒 → 统一网格（面积平均再二值化,比最近邻抗锯齿稳健）
  const bits = new Uint8Array(outWidth * outHeight);
  for (let oy = 0; oy < outHeight; oy++) {
    for (let ox = 0; ox < outWidth; ox++) {
      let sum = 0;
      let n = 0;
      const sy0 = minY + Math.floor((oy * bh) / outHeight);
      const sy1 = Math.max(sy0 + 1, minY + Math.floor(((oy + 1) * bh) / outHeight));
      const sx0 = minX + Math.floor((ox * bw) / outWidth);
      const sx1 = Math.max(sx0 + 1, minX + Math.floor(((ox + 1) * bw) / outWidth));
      for (let sy = sy0; sy < sy1 && sy < minY + bh; sy++) {
        for (let sx = sx0; sx < sx1 && sx < minX + bw; sx++) {
          sum += bin[sy * width + sx]!;
          n++;
        }
      }
      bits[oy * outWidth + ox] = n > 0 && sum / n >= 0.5 ? 1 : 0;
    }
  }
  return { bits, width: outWidth, height: outHeight };
}

/**
 * 位图指纹相似度：Jaccard 系数（交集/并集）。
 *
 * 相比逐位一致率，Jaccard 对笔画粗细差异（渲染字号/抗锯齿）更宽容，
 * 对完全不同的字惩罚更重 —— 中文区分度依赖它。
 *
 * ⚠️ 尺寸不符返回 0：调用方（matchName）负责先把双方归一化到
 * 同一网格 —— 真机教训：库里存原始渲染尺寸、查询是统一网格，
 * 直接比全是 0。
 */
export function fingerprintSimilarity(a: NameFingerprint, b: NameFingerprint): number {
  if (a.width !== b.width || a.height !== b.height) return 0;
  let inter = 0;
  let union = 0;
  const n = a.bits.length;
  for (let i = 0; i < n; i++) {
    const x = a.bits[i]!;
    const y = b.bits[i]!;
    if (x | y) union++;
    if (x & y) inter++;
  }
  return union === 0 ? 0 : inter / union;
}

/**
 * 把二值位图拉伸到指定网格（面积平均 + 0.5 阈值）。
 *
 * 用于 matchName 的归一化：库指纹（原始渲染尺寸各异）与查询位图
 * （统一网格）必须落在同一网格上，Jaccard 才有意义。
 */
export function stretchBitsToGrid(
  fp: NameFingerprint,
  gridWidth: number,
  gridHeight: number,
): NameFingerprint {
  if (fp.width === gridWidth && fp.height === gridHeight) return fp;
  const bits = new Uint8Array(gridWidth * gridHeight);
  for (let oy = 0; oy < gridHeight; oy++) {
    for (let ox = 0; ox < gridWidth; ox++) {
      let sum = 0;
      let n = 0;
      const sy0 = Math.floor((oy * fp.height) / gridHeight);
      const sy1 = Math.max(sy0 + 1, Math.floor(((oy + 1) * fp.height) / gridHeight));
      const sx0 = Math.floor((ox * fp.width) / gridWidth);
      const sx1 = Math.max(sx0 + 1, Math.floor(((ox + 1) * fp.width) / gridWidth));
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          sum += fp.bits[sy * fp.width + sx]!;
          n++;
        }
      }
      bits[oy * gridWidth + ox] = n > 0 && sum / n >= 0.5 ? 1 : 0;
    }
  }
  return { championId: fp.championId, name: fp.name, width: gridWidth, height: gridHeight, bits };
}

/**
 * 在指纹库中找最相似的名字。
 *
 * 归一化：库指纹的原始渲染尺寸随名字长度而异（89×21 / 66×21 / …），
 * 查询位图是统一网格 —— 比对前把**双方都拉伸到 GRID 尺寸**，
 * 否则尺寸不符 Jaccard 恒为 0（真机教训）。
 */
export function matchName(
  strip: { bits: Uint8Array; width: number; height: number },
  library: readonly NameFingerprint[],
  options: { readonly minScore?: number; readonly gridWidth?: number; readonly gridHeight?: number } = {},
): { championId: number; name: string; score: number } | null {
  const minScore = options.minScore ?? 0.45;
  const gw = options.gridWidth ?? NAME_STRIP.gridWidth;
  const gh = options.gridHeight ?? NAME_STRIP.gridHeight;
  if (library.length === 0) return null;

  const query = stretchBitsToGrid(
    { championId: 0, name: '', width: strip.width, height: strip.height, bits: strip.bits },
    gw,
    gh,
  );

  let best: { championId: number; name: string; score: number } | null = null;
  for (const fp of library) {
    const norm = stretchBitsToGrid(fp, gw, gh);
    const score = fingerprintSimilarity(query, norm);
    if (!best || score > best.score) {
      best = { championId: fp.championId, name: fp.name, score };
    }
  }
  if (!best || best.score < minScore) return null;
  return best;
}

/**
 * 带**区分度**校验的名字匹配（对照 `matchChampionCareful` 的思路）。
 *
 * 为什么需要：真机实测里 `detectCards` 会在**非卡片画面**（选人确认态、
 * 局内的技能/装饰元素）上误检出 2~3 个矩形。此时名字带落在美术图上，
 * 只看"最高分"会给出 0.45~0.5 的**假命中**，于是覆盖层把错误的胜率
 * 画在屏幕中间 —— 比不显示更糟（项目原则：宁漏勿错）。
 *
 * 判定：最高分 ≥ minScore **且** 与第二名拉开 minMargin。
 * 真实卡片（实测 0.56 / 0.67）与错误名字之间差距明显；
 * 美术图上的假命中普遍"跟谁都不像"，分数聚集、分差极小。
 */
export function matchNameCareful(
  strip: { bits: Uint8Array; width: number; height: number },
  library: readonly NameFingerprint[],
  options: {
    readonly minScore?: number;
    readonly minMargin?: number;
    readonly gridWidth?: number;
    readonly gridHeight?: number;
  } = {},
): { championId: number; name: string; score: number; margin: number } | null {
  const minScore = options.minScore ?? 0.5;
  const minMargin = options.minMargin ?? 0.05;
  const gw = options.gridWidth ?? NAME_STRIP.gridWidth;
  const gh = options.gridHeight ?? NAME_STRIP.gridHeight;
  if (library.length === 0) return null;

  const query = stretchBitsToGrid(
    { championId: 0, name: '', width: strip.width, height: strip.height, bits: strip.bits },
    gw,
    gh,
  );

  let first: { championId: number; name: string; score: number } | null = null;
  let secondScore = 0;
  for (const fp of library) {
    const score = fingerprintSimilarity(query, stretchBitsToGrid(fp, gw, gh));
    if (!first || score > first.score) {
      secondScore = first?.score ?? 0;
      first = { championId: fp.championId, name: fp.name, score };
    } else if (score > secondScore) {
      secondScore = score;
    }
  }
  if (!first || first.score < minScore) return null;
  const margin = first.score - secondScore;
  if (margin < minMargin) return null; // 区分度不足：不猜
  return { ...first, margin };
}
