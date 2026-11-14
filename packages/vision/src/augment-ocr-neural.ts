/**
 * 神经网络 OCR（PP-OCRv5 中文识别模型）的**纯函数**部分
 *
 * 这一层不碰 fs / ONNX / Electron，只做三件事：
 *   1. 把"名字带灰度图"变成模型输入（紧包围盒 → 反相 → 缩放到 48 高）；
 *   2. 把模型输出的逐帧概率与 **239 个已知海克斯名**做 CTC 前向打分（闭集解码）；
 *   3. 用分数/分差阈值拒绝不确定结果（宁漏勿错）。
 *
 * 为什么不直接"识别成字符串再模糊匹配"：
 *   · 名字是**闭集**（`data/dataset.json` 的 hextechs），直接对每个候选名算 CTC
 *     似然，能同时利用整段概率分布，不需要字符级切分；
 *   · 不会输出图鉴里不存在的"幻觉名字"，也不会把 `坦克引擎` 匹配成别的短名。
 *
 * 预处理与标定来自 2026-11-14 真机会话的 24 个卡位（跨两次录制）：
 *   固定名字条直接送模型 21~22/24；紧包围盒 + 反相后 24/24（阈值 150、48 高）。
 * 模型输入按 PaddleOCR 的 rec 约定：BGR 三通道、归一化到 [-1, 1]。
 */

import type { AugmentNameMatch } from './augment-ocr.ts';
import type { Rect } from './types.ts';

/** 模型输入高度（PP-OCRv5 rec 的标准高度）。 */
export const NEURAL_NAME_HEIGHT = 48;
/** 模型输入宽度上限（一屏最多约 7 个汉字；保留余量防超长噪声）。 */
export const NEURAL_NAME_MAX_WIDTH = 640;
/** 名字带文字像素的二值化阈值（与 `augment-ocr.ts` 的 nameStrip 标定同源）。 */
export const NEURAL_NAME_THRESHOLD = 150;

/**
 * 闭集解码的默认阈值。
 *
 * 2026-11-14 真机 24 个卡位实测：正确项归一化 log 概率约 -2.8 ~ 0，
 * 与次高名的分差最小 1.58。这里取 -3.0 / 0.8 留余量；低于任一阈值就返回 null
 * （不画标签），宁可漏也不能把错误强度表画到卡上。
 */
export const NEURAL_NAME_THRESHOLDS = {
  minScore: -3.0,
  minMargin: 0.8,
} as const;

/**
 * 从卡片矩形取**神经网络用名字带**（归一化坐标）。
 *
 * 与模板匹配的 `augmentNameStripRect` 相比：横向覆盖到卡宽 92%、纵向 10% 卡高
 * （模板用的 0.8×0.075 太紧，模型需要一点上下文）。预处理还会再按亮度裁紧包围盒，
 * 所以这里宁可稍大；实测 24/24。
 */
export function augmentNameBandRect(card: Rect): Rect {
  return {
    x: card.x + card.w * 0.04,
    y: card.y + card.h * 0.42,
    w: card.w * 0.92,
    h: card.h * 0.1,
  };
}

/** 一张名字带的灰度像素（worker 从全分辨率帧裁出来，经 IPC 送到主进程）。 */
export interface GrayNameBand {
  readonly width: number;
  readonly height: number;
  /** 行优先灰度，长度 = width * height。 */
  readonly gray: Uint8Array | Uint8ClampedArray;
}

/** 预处理后的模型输入（3 通道，行优先，通道平面布局）。 */
export interface PreparedNeuralName {
  readonly width: number;
  readonly height: number;
  /** 长度 = 3 * width * height。 */
  readonly data: Float32Array;
}

/** 一个已知名字 → CTC 类别序列。 */
export interface NameLexiconEntry {
  readonly augmentId: number;
  readonly name: string;
  /** 非空格字符在模型字典里的类别下标（blank = 0，所以字符从 1 开始）。 */
  readonly classes: readonly number[];
}

export interface NameLexicon {
  readonly entries: readonly NameLexiconEntry[];
  /** 因为字符不在模型字典里而跳过的名字（正常应为空；空格不算）。 */
  readonly skipped: readonly string[];
}

/** 解析 PaddleOCR 识别模型自带的字典：第 i 行（1-based）对应类别 i，blank 是 0。 */
export function parsePpOcrDict(text: string): Map<string, number> {
  const map = new Map<string, number>();
  const lines = text.split(/\r?\n/);
  for (const [i, line] of lines.entries()) {
    // 空格可以作为普通字符存在，但 PaddleOCR 的 dict 里通常没有；保留原样由调用方决定
    if (line.length === 0) continue;
    if (!map.has(line)) map.set(line, i + 1);
  }
  return map;
}

/**
 * 构造闭集词表。
 *
 * ⚠️ 海克斯名里允许有空格（`纯粹主义者 - 术师`、`鼓声暴起 低音轰鸣`）：
 * 空格不是模型字典里的字符，匹配前**去掉空格**，但展示仍用原名。
 */
export function buildNameLexicon(
  names: readonly { readonly augmentId: number; readonly name: string }[],
  dict: ReadonlyMap<string, number>,
): NameLexicon {
  const entries: NameLexiconEntry[] = [];
  const skipped: string[] = [];
  for (const item of names) {
    const chars = [...item.name.replace(/\s+/g, '')];
    if (chars.length === 0) {
      skipped.push(item.name);
      continue;
    }
    const classes: number[] = [];
    let ok = true;
    for (const ch of chars) {
      const cls = dict.get(ch);
      if (cls === undefined) {
        ok = false;
        break;
      }
      classes.push(cls);
    }
    if (!ok) {
      skipped.push(item.name);
      continue;
    }
    entries.push({ augmentId: item.augmentId, name: item.name, classes });
  }
  return { entries, skipped };
}

/**
 * 名字带 → 神经网络输入。
 *
 * 步骤（与真机标定一致）：
 *   1. 在名字带内按亮度阈值找**文字包围盒**（去掉卡片底色/上下装饰）；
 *   2. 四周留白（横向 8%、纵向 35%）后裁出；
 *   3. **反相**（游戏是白字深底，模型训练分布是深字浅底）；
 *   4. 按文字宽高比缩放到高 48，最近邻采样（保持与标定脚本一致）；
 *   5. 归一化到 [-1, 1]，复制成 3 通道。
 *
 * 找不到文字（全黑/全空白/动画中间帧）→ null。
 */
export function prepareNeuralName(
  band: GrayNameBand,
  options: { readonly threshold?: number } = {},
): PreparedNeuralName | null {
  const { width, height } = band;
  if (width <= 0 || height <= 0) return null;
  if (band.gray.length < width * height) return null;
  const threshold = options.threshold ?? NEURAL_NAME_THRESHOLD;

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (band.gray[y * width + x]! >= threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;

  const padX = Math.max(4, Math.round((maxX - minX + 1) * 0.08));
  const padY = Math.max(6, Math.round((maxY - minY + 1) * 0.35));
  const x0 = Math.max(0, minX - padX);
  const x1 = Math.min(width, maxX + 1 + padX);
  const y0 = Math.max(0, minY - padY);
  const y1 = Math.min(height, maxY + 1 + padY);
  const cw = x1 - x0;
  const ch = y1 - y0;
  if (cw <= 0 || ch <= 0) return null;

  const outH = NEURAL_NAME_HEIGHT;
  const outW = Math.min(
    NEURAL_NAME_MAX_WIDTH,
    Math.max(32, Math.round(outH * (cw / ch))),
  );

  const data = new Float32Array(3 * outH * outW);
  for (let y = 0; y < outH; y++) {
    const sy = Math.min(ch - 1, Math.floor((y * ch) / outH));
    for (let x = 0; x < outW; x++) {
      const sx = Math.min(cw - 1, Math.floor((x * cw) / outW));
      // 反相：白字（亮）→ 深色字，深底 → 浅色底
      const v = 255 - band.gray[(y0 + sy) * width + (x0 + sx)]!;
      const n = v / 127.5 - 1;
      for (let c = 0; c < 3; c++) data[c * outH * outW + y * outW + x] = n;
    }
  }
  return { width: outW, height: outH, data };
}

/**
 * 一条候选名字的 CTC 对数似然（blank = 0）。
 *
 * 模型输出的 `probs` 是**每帧已 softmax 的概率**（不是 logits，实测 sum≈1）。
 * 这里取 log 后做标准 CTC 前向；分数按 `(字符数 + 1)` 归一化，
 * 避免长名字天然分数更低。
 */
export function ctcLogProbability(
  probs: Float32Array,
  steps: number,
  classes: number,
  labels: readonly number[],
): number {
  const L = labels.length;
  if (steps <= 0 || classes <= 0 || L === 0) return Number.NEGATIVE_INFINITY;
  const neg = -1e30;
  let prev = new Float32Array(2 * L + 1).fill(neg);
  const logProb = (t: number, cls: number): number =>
    Math.log(Math.max(probs[t * classes + cls]!, 1e-30));
  prev[0] = logProb(0, 0);
  prev[1] = logProb(0, labels[0]!);
  for (let t = 1; t < steps; t++) {
    const cur = new Float32Array(2 * L + 1).fill(neg);
    for (let s = 0; s < 2 * L + 1; s++) {
      let acc = prev[s]!;
      if (s > 0) acc = Math.max(acc, prev[s - 1]!);
      if (s % 2 === 1 && s > 1) {
        const k = (s - 1) >> 1;
        if (labels[k] !== labels[k - 1]) acc = Math.max(acc, prev[s - 2]!);
      }
      const cls = s % 2 === 0 ? 0 : labels[(s - 1) >> 1]!;
      cur[s] = acc + logProb(t, cls);
    }
    prev = cur;
  }
  const best = Math.max(prev[2 * L] ?? neg, prev[2 * L - 1] ?? neg);
  return best / (L + 1);
}

/**
 * 闭集解码：对每个候选名算 CTC 分数，返回最高分（含分差）。
 *
 * @param probs 模型输出，行优先 `[T][C]`，每帧概率和 ≈1。
 */
export function resolveNeuralName(
  probs: Float32Array,
  steps: number,
  classes: number,
  lexicon: readonly NameLexiconEntry[],
  options: { readonly minScore?: number; readonly minMargin?: number } = {},
): AugmentNameMatch | null {
  if (lexicon.length === 0) return null;
  let best: { entry: NameLexiconEntry; score: number } | null = null;
  let second = Number.NEGATIVE_INFINITY;
  for (const entry of lexicon) {
    const score = ctcLogProbability(probs, steps, classes, entry.classes);
    if (best === null || score > best.score) {
      if (best !== null) second = Math.max(second, best.score);
      best = { entry, score };
    } else if (score > second) {
      second = score;
    }
  }
  if (best === null) return null;
  const minScore = options.minScore ?? NEURAL_NAME_THRESHOLDS.minScore;
  const minMargin = options.minMargin ?? NEURAL_NAME_THRESHOLDS.minMargin;
  if (best.score < minScore) return null;
  const margin = best.score - second;
  if (margin < minMargin) return null;
  return {
    augmentId: best.entry.augmentId,
    name: best.entry.name,
    score: best.score,
    margin,
  };
}
