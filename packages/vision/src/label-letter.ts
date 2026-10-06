/**
 * 档位字母的**字体度量**（生成物：`scripts/render-tier-letter-glyphs.ps1`）
 *
 * 局内的档位字母是 Chromium 用系统字体画的（`label-draw.ts` 的 `LABEL_TIER_FONT_FAMILY`），
 * 而离线预览（`scripts/preview-augment-labels.mts`）跑在纯 Node 里、没有字体引擎。
 * 这份数据是**同一套字体**（字体栈首项）的大写字母度量：
 *
 *   · `advance` / `ink*`：字体度量（em）。canvas 的 `textAlign='center'` 居中的是
 *     **前进宽**，展示型字体的墨迹并不在前进宽正中，所以 `label-draw.ts` 用
 *     `advance/2 − 墨迹中心` 做**视觉居中**（每个字母各自修正，卡与卡之间才一致），
 *     并按 `inkWidth` 排尖括号（每个字母"墨迹 + 固定空隙"，见 `tierTagPlan`）；
 *   · `TIER_LETTERS_CAP_RATIO`：大写字高/em —— `label-draw.ts` 的 `LABEL_CAP_RATIO` **引用它**，
 *     所以"预览里字号多大、局内就多大"这条关系不可能漂（与 `GLYPH_CAP_RATIO` 同一套做法）。
 *
 * ⚠️ 坐标约定：x 自**笔位原点**（`fillText` 的左端，未含视觉居中修正）起算，
 * y 自**基线**起算、**向下为正**（圆字母（S/C/O）会略微低于基线，这是字体本身的 overshoot）。
 *
 * ⚠️ **轮廓在另一个生成物里**（`label-letter-outlines.ts`）：局内只要度量，
 * 把几十 KB 的轮廓带进渲染端 bundle 是白花的（实测 14KB → 74KB）。
 *
 * 生成方式（字体换了就重跑；文件是生成物，不要手改）：pwsh -NoProfile -File scripts/render-tier-letter-glyphs.ps1   # Segoe UI Black @ em 512px，平坦化容差 0.25
 * 实测：cap/em = 0.7002，S/A/B/C 墨迹宽/cap 高最大 = 1.0425（= 未知字母的保守值）。
 */

/**
 * 一个字母的度量（全部 **em 单位**：1 = 一个字号）。
 *
 * `ink*` 是**墨迹包围盒**（x 自笔位原点、y 自基线向下为正）。
 */
export interface TierLetterEmMetrics {
  /** 前进宽 / em（canvas 按它居中）。 */
  readonly advance: number
  readonly inkLeft: number
  readonly inkRight: number
  readonly inkTop: number
  readonly inkBottom: number
}

/** 生成这份数据的字体族 —— `label-draw.ts` 的字体栈**首项必须等于它**（有单测锁）。 */
export const TIER_LETTERS_FONT = 'Segoe UI Black'

/** 生成时的 em 尺寸（px）与平坦化容差（em 像素）——只用于说明精度，运行时不用。 */
export const TIER_LETTERS_EM = 512
export const TIER_LETTERS_FLATTEN = 0.25

/** 大写字高 / em（= `label-draw.ts` 的 `LABEL_CAP_RATIO`，两边不可能漂）。 */
export const TIER_LETTERS_CAP_RATIO = 0.7002

/** S/A/B/C 的墨迹宽 / cap 高的**最大值** —— 没有实测度量的字母按它保守排版。 */
export const TIER_LETTERS_DESIGN_INK_ASPECT = 1.0425

/** A~Z 的度量（键 = 大写字母）。 */
export const TIER_LETTER_EM_METRICS: Readonly<Record<string, TierLetterEmMetrics>> = {
  A: { advance: 0.75, inkLeft: 0.0068, inkRight: 0.7368, inkTop: -0.7002, inkBottom: 0 },
  B: { advance: 0.6909, inkLeft: 0.0688, inkRight: 0.667, inkTop: -0.7002, inkBottom: 0 },
  C: { advance: 0.6299, inkLeft: 0.0298, inkRight: 0.5898, inkTop: -0.7119, inkBottom: 0.0122 },
  D: { advance: 0.7588, inkLeft: 0.0688, inkRight: 0.729, inkTop: -0.7002, inkBottom: 0 },
  E: { advance: 0.5518, inkLeft: 0.0688, inkRight: 0.521, inkTop: -0.7002, inkBottom: 0 },
  F: { advance: 0.541, inkLeft: 0.0688, inkRight: 0.5078, inkTop: -0.7002, inkBottom: 0 },
  G: { advance: 0.7271, inkLeft: 0.0298, inkRight: 0.6821, inkTop: -0.7119, inkBottom: 0.0122 },
  H: { advance: 0.8022, inkLeft: 0.0688, inkRight: 0.7329, inkTop: -0.7002, inkBottom: 0 },
  I: { advance: 0.3486, inkLeft: 0.0688, inkRight: 0.2798, inkTop: -0.7002, inkBottom: 0 },
  J: { advance: 0.5112, inkLeft: 0.02, inkRight: 0.4502, inkTop: -0.7002, inkBottom: 0.0122 },
  K: { advance: 0.6899, inkLeft: 0.0688, inkRight: 0.7119, inkTop: -0.7002, inkBottom: 0 },
  L: { advance: 0.541, inkLeft: 0.0688, inkRight: 0.521, inkTop: -0.7002, inkBottom: 0 },
  M: { advance: 0.9868, inkLeft: 0.0688, inkRight: 0.918, inkTop: -0.7002, inkBottom: 0 },
  N: { advance: 0.812, inkLeft: 0.0688, inkRight: 0.7432, inkTop: -0.7002, inkBottom: 0 },
  O: { advance: 0.7651, inkLeft: 0.0298, inkRight: 0.7349, inkTop: -0.7119, inkBottom: 0.0122 },
  P: { advance: 0.6558, inkLeft: 0.0688, inkRight: 0.6411, inkTop: -0.7002, inkBottom: 0 },
  Q: { advance: 0.7651, inkLeft: 0.0298, inkRight: 0.8149, inkTop: -0.7119, inkBottom: 0.0942 },
  R: { advance: 0.6821, inkLeft: 0.0688, inkRight: 0.6699, inkTop: -0.7002, inkBottom: 0 },
  S: { advance: 0.5718, inkLeft: 0.04, inkRight: 0.5552, inkTop: -0.7119, inkBottom: 0.0122 },
  T: { advance: 0.6362, inkLeft: 0.0151, inkRight: 0.6211, inkTop: -0.7002, inkBottom: 0 },
  U: { advance: 0.7402, inkLeft: 0.061, inkRight: 0.6792, inkTop: -0.7002, inkBottom: 0.0122 },
  V: { advance: 0.7021, inkLeft: 0.0049, inkRight: 0.6968, inkTop: -0.7002, inkBottom: 0 },
  W: { advance: 1.0532, inkLeft: 0.0098, inkRight: 1.043, inkTop: -0.7002, inkBottom: 0 },
  X: { advance: 0.7021, inkLeft: 0, inkRight: 0.7021, inkTop: -0.7002, inkBottom: 0 },
  Y: { advance: 0.6499, inkLeft: 0, inkRight: 0.6499, inkTop: -0.7002, inkBottom: 0 },
  Z: { advance: 0.6411, inkLeft: 0.0298, inkRight: 0.6172, inkTop: -0.7002, inkBottom: 0 },
}

/** 取一个字母的度量（只认 A~Z；小写与大写等价，其他字符返回 null）。 */
export function tierLetterEmMetrics(ch: string): TierLetterEmMetrics | null {
  return TIER_LETTER_EM_METRICS[ch.trim().toUpperCase().slice(0, 1)] ?? null
}

