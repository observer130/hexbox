/**
 * 局内海克斯卡面**名字 OCR**（纯函数，可单测）
 *
 * 用户定的优先级（2026-10-05）：**OCR 为主，图标只在同名消歧时用**。
 * 这个决定在 dataset 上得到支持：KIWI 共 218 个海克斯、**218 个不同名字、0 重名**
 * → 认对名字即可 join 到唯一 id，不需要图标参与。
 *
 * 与选人阶段英雄名的关系：同一套机制（二值化 → 裁文字包围盒 → 拉伸到固定网格
 * → 与渲染指纹库做 Jaccard），但**名字带位置完全不同**：
 *   · 选人卡（[ocr.ts](./ocr.ts) 的 NAME_STRIP）：名字在卡片下部 yCenter **0.856**；
 *   · 海克斯卡：图标在上、名字在中部 yCenter **≈0.470**，下方还有稀有度标签与描述。
 * 直接套用 NAME_STRIP 会切到描述文字上去。
 *
 * ── 真机标定（2026-10-05，两帧真机面板共 6 张卡）──────────────────────
 *
 *   字体库        正确项得分      分差        结论
 *   Bold@40      0.62 ~ 0.73   0.07 ~ 0.17   ✅ 采用（卡面是粗体）
 *   Regular@40   0.45 ~ 0.61   0.02 ~ 0.19   分数明显更低
 *
 *   · 名字带纵向中心 0.462~0.475 都稳；**0.488 会吃到下方稀有度标签**，
 *     出现"急速之追求"（近似混淆）→ 必须用分差规则兜住。
 *   · 阈值 140/160/180 都成立（Bold 0.62~0.73）→ 取中值 160。
 *   · ⚠️ 样本只有 3 个不同名字（同一局的同一批三选一）—— **阈值/分差要在更多局上复核**，
 *     尤其那些名字相近的组合（如 急速之追求 / 威能之追求 / 缩小引擎 / 坦克引擎）。
 *
 * 指纹库由 `scripts/render-augment-name-fingerprints.ps1` 构建
 * （Microsoft YaHei **Bold** 40px，与卡面同源），产物 `data/augment-names.json`。
 */

import { extractGrayRaw } from './match.ts';
import { extractNameStrip, matchNameCareful, type NameFingerprint } from './ocr.ts';
import type { Bitmap, Rect } from './types.ts';

/**
 * 名字带参数（**卡内**归一化；真机实测）。
 *
 * `yCenter = 0.47`：0.462~0.475 区间都成立，取中值。
 * 上界注意别超过 ~0.48（会吃到稀有度标签）。
 */
export const AUGMENT_NAME_STRIP = {
  /** 名字带纵向中心（占卡高）。 */
  yCenter: 0.47,
  /** 名字带高度（占卡高）——略高于字高，吸收缩放误差。 */
  height: 0.075,
  /** 名字带宽度（占卡宽）——两侧留边距避开卡片边框发光。 */
  width: 0.8,
  /** 二值化阈值（白字，取真机扫描的中值）。 */
  threshold: 160,
  /**
   * 匹配阈值与分差（真机标定）。
   *
   * 正确项得分 0.62~0.73，所以 0.55 有余量；分差 0.03 用来挡"名字相近"的误认
   * （实测出现过 威能之追求 → 急速之追求 这种近似对）。**宁漏勿错**：
   * 认不准就返回 null，调用方不画。
   */
  minScore: 0.55,
  minMargin: 0.03,
  gridWidth: 96,
  gridHeight: 16,
} as const;

/** 一颗海克斯名字的位图指纹（由构建期脚本产出）。 */
export interface AugmentNameFingerprint {
  readonly augmentId: number;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** 行优先位串，1 = 有笔画。长度 = width * height。 */
  readonly bits: Uint8Array;
}

/** 匹配结果。 */
export interface AugmentNameMatch {
  readonly augmentId: number;
  readonly name: string;
  readonly score: number;
  /** 与次高（**排除同名者**）的分差。 */
  readonly margin: number;
}

/** 名字带矩形（在**截屏归一化**坐标系里，相对整帧）。 */
export function augmentNameStripRect(
  card: Rect,
  cfg: { yCenter: number; height: number; width: number } = AUGMENT_NAME_STRIP,
): Rect {
  const h = card.h * cfg.height;
  const w = card.w * cfg.width;
  return {
    x: card.x + (card.w - w) / 2,
    y: card.y + card.h * cfg.yCenter - h / 2,
    w,
    h,
  };
}

/**
 * 从卡面提取名字位图（二值化 → 裁文字包围盒 → 拉伸到网格）。
 *
 * @returns 与指纹库同规格的位图；取不到内容时返回 null（调用方不画）。
 */
export function readAugmentNameStrip(
  bmp: Bitmap,
  card: Rect,
  options: {
    readonly threshold?: number;
    /** 名字带几何覆盖（换分辨率/复标定时用；默认取 AUGMENT_NAME_STRIP）。 */
    readonly strip?: { yCenter: number; height: number; width: number };
  } = {},
): { bits: Uint8Array; width: number; height: number } | null {
  const rect = augmentNameStripRect(card, options.strip ?? AUGMENT_NAME_STRIP);
  const g = extractGrayRaw(bmp, rect);
  if (!g) return null;
  const strip = extractNameStrip(g.gray, g.width, g.height, {
    threshold: options.threshold ?? AUGMENT_NAME_STRIP.threshold,
    outWidth: AUGMENT_NAME_STRIP.gridWidth,
    outHeight: AUGMENT_NAME_STRIP.gridHeight,
  });
  // 整块空白（例如带走神/动画中间帧）→ 视为没读到
  let ink = 0;
  for (const b of strip.bits) ink += b;
  if (ink === 0) return null;
  return strip;
}

/** 指纹库 → 内部格式（复用 ocr.ts 的匹配机制，字段语义在此转换，不外泄）。 */
function asLibrary(
  library: readonly AugmentNameFingerprint[],
): Array<NameFingerprint & { augmentId: number }> {
  return library.map((f) => ({
    championId: f.augmentId, // 内部字段：只作透传
    augmentId: f.augmentId,
    name: f.name,
    width: f.width,
    height: f.height,
    bits: f.bits,
  }));
}

/**
 * 认名字（宁漏勿错）。
 *
 * @param strip   `readAugmentNameStrip` 的输出
 * @param library 指纹库（构建期产物）
 */
export function matchAugmentName(
  strip: { bits: Uint8Array; width: number; height: number },
  library: readonly AugmentNameFingerprint[],
  options: { readonly minScore?: number; readonly minMargin?: number } = {},
): AugmentNameMatch | null {
  if (library.length === 0) return null;
  const m = matchNameCareful(strip, asLibrary(library), {
    minScore: options.minScore ?? AUGMENT_NAME_STRIP.minScore,
    minMargin: options.minMargin ?? AUGMENT_NAME_STRIP.minMargin,
    gridWidth: AUGMENT_NAME_STRIP.gridWidth,
    gridHeight: AUGMENT_NAME_STRIP.gridHeight,
  });
  if (!m) return null;
  return { augmentId: m.championId, name: m.name, score: m.score, margin: m.margin };
}

/** 一站式：卡面 → 名字（认不准返回 null）。 */
export function readAugmentName(
  bmp: Bitmap,
  card: Rect,
  library: readonly AugmentNameFingerprint[],
  options: { readonly threshold?: number; readonly minScore?: number; readonly minMargin?: number } = {},
): AugmentNameMatch | null {
  const strip = readAugmentNameStrip(bmp, card, options);
  if (!strip) return null;
  return matchAugmentName(strip, library, options);
}
