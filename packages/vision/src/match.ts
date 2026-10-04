/**
 * 英雄头像模板匹配
 *
 * 为什么不用 OCR：英雄卡片上的名字是**美术字体**，中文识别不可靠；
 * 而头像是固定尺寸的方形图像，做模板匹配稳定得多。
 *
 * 算法：缩放到统一尺寸 → 转灰度 → 归一化 → 比 L1 距离。
 *
 * 该算法刻意保持简单：
 *   - 不引入图像处理依赖（本项目目前零外部运行时依赖）
 *   - 纯函数、可单测
 *   - 阈值保守：**宁可识别不出，也不给出错的英雄**
 */

import type { Bitmap, Rect } from './types.ts';

/** 一个英雄的头像模板（灰度、已缩放到统一尺寸）。 */
export interface PortraitTemplate {
  readonly championId: number;
  /** 边长（正方形）。 */
  readonly size: number;
  /** 灰度值，长度 = size * size，取值 0..255。 */
  readonly gray: Uint8Array;
}

/** 匹配结果。 */
export interface MatchCandidate {
  readonly championId: number;
  /** 相似度 0..1（1 = 完全一致）。 */
  readonly score: number;
}

/**
 * 从位图取子矩形 → **原始分辨率**灰度矩阵（不做缩放）。
 *
 * 与 `extractGray(outSize)` 的区别：OCR 名字带需要原始长宽比
 * （名字宽度随字数变化，强行正方形会破坏字形），由调用方自行降采样。
 */
export function extractGrayRaw(
  bmp: Bitmap,
  rect: Rect,
): { gray: Uint8Array; width: number; height: number } | null {
  const x0 = Math.round(rect.x * bmp.width);
  const y0 = Math.round(rect.y * bmp.height);
  const w = Math.round(rect.w * bmp.width);
  const h = Math.round(rect.h * bmp.height);
  if (w <= 0 || h <= 0 || x0 < 0 || y0 < 0) return null;
  if (x0 + w > bmp.width || y0 + h > bmp.height) return null;

  const gray = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((y0 + y) * bmp.width + (x0 + x)) * 4;
      gray[y * w + x] = Math.round(
        0.299 * bmp.data[i]! + 0.587 * bmp.data[i + 1]! + 0.114 * bmp.data[i + 2]!,
      );
    }
  }
  return { gray, width: w, height: h };
}

/** 从位图取子矩形 → 灰度数组（含面积平均降采样）。 */
export function extractGray(
  bmp: Bitmap,
  rect: Rect,
  outSize: number,
): Uint8Array | null {  // 归一化矩形 → 像素范围
  const x0 = Math.round(rect.x * bmp.width);
  const y0 = Math.round(rect.y * bmp.height);
  const w = Math.round(rect.w * bmp.width);
  const h = Math.round(rect.h * bmp.height);
  if (w <= 0 || h <= 0 || x0 < 0 || y0 < 0) return null;
  if (x0 + w > bmp.width || y0 + h > bmp.height) return null;

  const out = new Uint8Array(outSize * outSize);
  for (let oy = 0; oy < outSize; oy++) {
    const sy0 = y0 + Math.floor((oy * h) / outSize);
    const sy1 = Math.max(sy0 + 1, y0 + Math.floor(((oy + 1) * h) / outSize));
    for (let ox = 0; ox < outSize; ox++) {
      const sx0 = x0 + Math.floor((ox * w) / outSize);
      const sx1 = Math.max(sx0 + 1, x0 + Math.floor(((ox + 1) * w) / outSize));

      // 面积平均：比最近邻抗噪，且实现简单
      let sum = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1 && sy < bmp.height; sy++) {
        for (let sx = sx0; sx < sx1 && sx < bmp.width; sx++) {
          const i = (sy * bmp.width + sx) * 4;
          const r = bmp.data[i]!;
          const g = bmp.data[i + 1]!;
          const b = bmp.data[i + 2]!;
          // Rec.601 亮度
          sum += 0.299 * r + 0.587 * g + 0.114 * b;
          n++;
        }
      }
      out[oy * outSize + ox] = n > 0 ? Math.round(sum / n) : 0;
    }
  }
  return out;
}

/**
 * 从位图取子矩形 → RGBA 数组（面积平均降采样）。
 *
 * 与 `extractGray` 同一套降采样逻辑，额外保留颜色通道 ——
 * 占用检测需要**色度**信息（空槽是纯色、头像有颜色变化），
 * 而灰度会把彩色内容压平（真机实测：暗色头像的灰度 std 可能很低）。
 */
export function extractRgb(
  bmp: Bitmap,
  rect: Rect,
  outSize: number,
): Uint8ClampedArray | null {
  const x0 = Math.round(rect.x * bmp.width);
  const y0 = Math.round(rect.y * bmp.height);
  const w = Math.round(rect.w * bmp.width);
  const h = Math.round(rect.h * bmp.height);
  if (w <= 0 || h <= 0 || x0 < 0 || y0 < 0) return null;
  if (x0 + w > bmp.width || y0 + h > bmp.height) return null;

  const out = new Uint8ClampedArray(outSize * outSize * 4);
  for (let oy = 0; oy < outSize; oy++) {
    const sy0 = y0 + Math.floor((oy * h) / outSize);
    const sy1 = Math.max(sy0 + 1, y0 + Math.floor(((oy + 1) * h) / outSize));
    for (let ox = 0; ox < outSize; ox++) {
      const sx0 = x0 + Math.floor((ox * w) / outSize);
      const sx1 = Math.max(sx0 + 1, x0 + Math.floor(((ox + 1) * w) / outSize));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1 && sy < bmp.height; sy++) {
        for (let sx = sx0; sx < sx1 && sx < bmp.width; sx++) {
          const i = (sy * bmp.width + sx) * 4;
          r += bmp.data[i]!;
          g += bmp.data[i + 1]!;
          b += bmp.data[i + 2]!;
          n++;
        }
      }
      const di = (oy * outSize + ox) * 4;
      if (n > 0) {
        out[di] = Math.round(r / n);
        out[di + 1] = Math.round(g / n);
        out[di + 2] = Math.round(b / n);
      }
      out[di + 3] = 255;
    }
  }
  return out;
}

/**
 * 归一化灰度（减去均值、除以标准差）。
 *
 * 必要性：游戏内头像受**亮度/色调/技能特效**影响，
 * 原图直接比较会被整体亮度差主导。归一化后只比「结构」，
 * 对亮度变化鲁棒。
 */
export function normalizeGray(gray: Uint8Array): Float32Array {
  const n = gray.length;
  const out = new Float32Array(n);
  if (n === 0) return out;

  let mean = 0;
  for (let i = 0; i < n; i++) mean += gray[i]!;
  mean /= n;

  let varSum = 0;
  for (let i = 0; i < n; i++) {
    const d = gray[i]! - mean;
    varSum += d * d;
  }
  const std = Math.sqrt(varSum / n);
  if (std < 1e-6) {
    // 纯色图：无结构可比
    return out;
  }
  for (let i = 0; i < n; i++) out[i] = (gray[i]! - mean) / std;
  return out;
}

/**
 * 由灰度数组构造模板。
 *
 * 模板应在**构建期**从本地英雄头像生成（见 vision-cli），
 * 运行时只做比较。
 */
export function makeTemplate(
  championId: number,
  gray: Uint8Array,
  size: number,
): PortraitTemplate {
  if (gray.length !== size * size) {
    throw new Error(`模板灰度长度 ${gray.length} 与 size² ${size * size} 不符`);
  }
  return { championId, size, gray };
}

/**
 * 相似度：归一化互相关（NCC 的简化形式）。
 *
 * 输入须为 `normalizeGray` 的输出；返回 -1..1，映射到 0..1。
 */
export function similarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  // a、b 已各自标准化到 std=1，故点积 / n 即相关系数
  const r = dot / a.length;
  return (r + 1) / 2;
}

/** 预处理后的模板（归一化结果缓存在外，避免每次重算）。 */
export interface PreparedTemplate {
  readonly championId: number;
  readonly norm: Float32Array;
}

/** 批量预处理模板。 */
export function prepareTemplates(
  templates: readonly PortraitTemplate[],
): PreparedTemplate[] {
  return templates.map((t) => ({
    championId: t.championId,
    norm: normalizeGray(t.gray),
  }));
}

/**
 * 在模板库中找最相似的英雄。
 *
 * @returns 最佳候选；若最佳得分低于 `minScore` 则返回 null
 *          （**宁可识别不出，也不给错英雄**）
 *
 * ⚠️ 阈值依据（2026-09-27 真机实测，勿凭感觉调低）：
 *   游戏内选人卡片的立绘是**实时渲染**，与官方静态头像构图差异大，
 *   真实冠军的灰度模板得分仅 ~0.53，而**错误冠军可达 0.77+**
 *   （两次真机验证：Quinn 排 179 名/0.528，错误匹配 0.776）。
 *   因此默认阈值必须高到足以拒绝这类假阳性 —— 0.85 之下
 *   一律不认定。识别的可用性待模板源换成游戏内 UI 资源后再评估。
 */
export function matchChampion(
  gray: Uint8Array,
  templates: readonly PreparedTemplate[],
  options: { readonly minScore?: number } = {},
): MatchCandidate | null {
  const minScore = options.minScore ?? 0.85;
  if (templates.length === 0) return null;

  const q = normalizeGray(gray);
  let best: MatchCandidate | null = null;

  for (const t of templates) {
    if (t.norm.length !== q.length) continue;
    const score = similarity(q, t.norm);
    if (!best || score > best.score) {
      best = { championId: t.championId, score };
    }
  }

  if (!best || best.score < minScore) return null;
  return best;
}

/**
 * 带**区分度**校验的匹配。
 *
 * 仅看最高分不够：若前两名得分接近，说明图像区分度低
 * （可能是加载中/被特效遮挡），此时也应拒绝。
 *
 * @param minScore 最低相似度（默认 0.85,真机实测依据见 matchChampion）
 * @param minMargin 第一名与第二名的最小分差（默认 0.10）
 */
export function matchChampionCareful(
  gray: Uint8Array,
  templates: readonly PreparedTemplate[],
  options: { readonly minScore?: number; readonly minMargin?: number } = {},
): MatchCandidate | null {
  const minScore = options.minScore ?? 0.85;
  const minMargin = options.minMargin ?? 0.10;
  if (templates.length === 0) return null;

  const q = normalizeGray(gray);
  const scored: MatchCandidate[] = [];
  for (const t of templates) {
    if (t.norm.length !== q.length) continue;
    scored.push({ championId: t.championId, score: similarity(q, t.norm) });
  }
  if (scored.length === 0) return null;

  scored.sort((a, b) => b.score - a.score);
  const first = scored[0]!;
  const second = scored[1];

  if (first.score < minScore) return null;
  if (second && first.score - second.score < minMargin) return null; // 区分度不足
  return first;
}
