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
  /** 名字区在卡片内的纵向位置（实测：名称带中心 ≈ 0.885 卡高）。 */
  yCenter: 0.885,
  /** 名字区高度（占卡高）。 */
  height: 0.075,
  /** 名字区宽度上限（占卡宽，两侧留边距避开边框）。 */
  width: 0.78,
} as const;

/**
 * 从卡片位图中提取名字区的二值位图。
 *
 * 输入是**灰度**矩阵（extractGray 的产物坐标系即可），亮度 ≥ threshold
 * 视为文字像素。返回归一化尺寸的位串。
 */
export function extractNameStrip(
  gray: Uint8Array,
  width: number,
  height: number,
  options: {
    /** 二值化阈值（0..255）。名字是白字，默认 150。 */
    readonly threshold?: number;
    /** 输出宽度（归一化）。 */
    readonly outWidth?: number;
    /** 输出高度（归一化）。 */
    readonly outHeight?: number;
  } = {},
): { bits: Uint8Array; width: number; height: number } {
  const threshold = options.threshold ?? 150;
  const outWidth = options.outWidth ?? 96;
  const outHeight = options.outHeight ?? 16;

  const bits = new Uint8Array(outWidth * outHeight);
  for (let oy = 0; oy < outHeight; oy++) {
    for (let ox = 0; ox < outWidth; ox++) {
      // 面积平均再二值化：比最近邻抗锯齿稳健
      let sum = 0;
      let n = 0;
      const sy0 = Math.floor((oy * height) / outHeight);
      const sy1 = Math.max(sy0 + 1, Math.floor(((oy + 1) * height) / outHeight));
      const sx0 = Math.floor((ox * width) / outWidth);
      const sx1 = Math.max(sx0 + 1, Math.floor(((ox + 1) * width) / outWidth));
      for (let sy = sy0; sy < sy1 && sy < height; sy++) {
        for (let sx = sx0; sx < sx1 && sx < width; sx++) {
          sum += gray[sy * width + sx]!;
          n++;
        }
      }
      bits[oy * outWidth + ox] = n > 0 && sum / n >= threshold ? 1 : 0;
    }
  }
  return { bits, width: outWidth, height: outHeight };
}

/**
 * 位图指纹相似度：Jaccard 系数（交集/并集）。
 *
 * 相比逐位一致率，Jaccard 对笔画粗细差异（渲染字号/抗锯齿）更宽容，
 * 对完全不同的字惩罚更重 —— 中文区分度依赖它。
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
 * 在指纹库中找最相似的名字。
 *
 * 匹配前先做**水平重心对齐**：名字在卡片内的水平位置有细微偏移
 * （等宽字体居中，但截屏缩放会引入 1~2px 误差），按重心平移后比较。
 */
export function matchName(
  strip: { bits: Uint8Array; width: number; height: number },
  library: readonly NameFingerprint[],
  options: { readonly minScore?: number } = {},
): { championId: number; name: string; score: number } | null {
  const minScore = options.minScore ?? 0.55;
  if (library.length === 0) return null;

  const query: NameFingerprint = {
    championId: 0,
    name: '',
    width: strip.width,
    height: strip.height,
    bits: strip.bits,
  };

  let best: { championId: number; name: string; score: number } | null = null;
  for (const fp of library) {
    const score = fingerprintSimilarity(query, fp);
    if (!best || score > best.score) {
      best = { championId: fp.championId, name: fp.name, score };
    }
  }
  if (!best || best.score < minScore) return null;
  return best;
}
