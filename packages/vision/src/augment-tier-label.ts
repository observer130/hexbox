/**
 * 海克斯**强度评级标签**（S5.4c）：识别结果 × 该英雄的强度表 × 屏幕几何 → 可绘制的标签
 *
 * 数据链路（全部是一方数据 + 屏幕像素，不新增采集）：
 *   国服英雄详情 `augment_json_irank`
 *     → provider-tencent `parseChampionAugments()`（每条含 `tier` + `pickRate`）
 *     → core `augmentStrength()` / `ChampionDetail.augments`
 *     → 本文件的 `augmentTierTable()`（augmentId → tier）/ `augmentPickRateTable()`（→ 选取率）
 *   × 渲染端识别结果（`RecognizedReport.cards`，`augmentId === null` = 认不准）
 *     → `augmentTierLabels()`（标签矩形 + 档位配色 + 文案，**截屏归一化**）
 *     → `toScreenTierLabels()`（复用 `normalizedRectToScreen` 换成屏幕逻辑坐标）
 *
 * 产品决策（docs/AUGMENT-PANEL.md §七/§十三/§十六，勿改）：
 *   1. 标签画在**卡片底部空白区、水平居中**，且**整排纵向对齐**
 *      （`augmentLabelRect` 给卡内比例；整排的 y/h 由**行基准锁**统一 ——
 *      开边沿锁一次、面板存续期间复用，见 `augmentTierLabelsLocked()`；预设见
 *      `AUGMENT_BADGE_PRESETS`）；
 *   2. 标签内容 = **大号档位字母（S/A/B/C）+ 两侧尖括号 + 一行「选取率 x%」**；
 *      选取率缺失/为 0 时**只少一行**，字母照画（绝不猜一个数字）；
 *   3. **认不准的卡不画**（`augmentId === null` 跳过，不画占位）；
 *   4. 查不到强度的卡也**不画**（宁可少画，不要画一个猜出来的等级）；
 *   5. 面板关闭边沿由调用方**立刻清空**（本文件不做任何跨帧记忆 ——
 *      不要复用选人阶段的 `label-memory.ts` 那套 6 轮 TTL）。
 *
 * 本文件是纯函数（无 IO、无 Electron、无 Node 依赖），因此可单测 ——
 * 局内 overlay 在 CI 里跑不了，能测的都必须放在这里。
 */

import type { CaptureGeometry, Rect } from './types.ts';
import {
  AUGMENT_BADGE_DEFAULT,
  AUGMENT_BADGE_PRESETS,
  alignRowLabelsLocked,
  augmentBadgeZone,
  lockLabelRowBand,
  type AugmentBadgePreset,
  type LabelRowLock,
} from './augment-label.ts';
import { normalizedRectToScreen } from './geometry.ts';

/**
 * 一张识别出来的卡（本模块只关心这两件事）。
 *
 * 用结构化类型而不是 import 渲染端的 `RecognizedCard`：渲染端报告里还有
 * `interiorLuma` / `score` / `margin` 等诊断字段，多出来的字段直接忽略即可
 * （尤其**登场率不在这里** —— 它只来自该英雄的详情表，不由 OCR 报告给）。
 */
export interface AugmentTierCard {
  /** 卡片矩形（**截屏归一化**，`detectAugmentPanel` 的输出）。 */
  readonly rect: Rect;
  /** 认出来的海克斯 ID；`null` = 认不准 → 不画。 */
  readonly augmentId: number | null;
}

/**
 * 强度表：`augmentId` → 档位字母（S/A/B/C）。
 *
 * 两种形态都支持：主进程用 `Map` 组装（O(1) 查、天然去重），
 * 测试与产物 JSON 里用普通对象更省事。
 */
export type AugmentTierTable = ReadonlyMap<number, string> | Readonly<Record<number, string>>;

/**
 * 档位配色（**字母 / 尖括号 / 发光同族**，2026-10-05 按用户给的参考图对齐）。
 *
 * 参考图观感：**S = 金 / A = 红 / B = 青蓝 / C = 中性灰**；尖括号与发光只是
 * 同一颜色的 alpha 不同（见 `label-draw.ts` 的 `TIER_BRACKET_ALPHA` /
 * `TIER_TREATMENTS` 里各风格的发光层 alpha），
 * 所以档位配色只有这一个来源，加档也不会漏配。
 *
 * 色值就是 canvas 的强调色 —— 渲染端只认一个颜色字符串，
 * 颜色本身在**纯函数**里选好，所以配色可单测（不必起 overlay 看）。
 */
export const AUGMENT_TIER_COLORS = {
  S: '#f7c948',
  A: '#e8484f',
  B: '#37c1e8',
  C: '#7f8ea6',
} as const;

/**
 * 没见过的档位 → 中性灰。
 *
 * 上游将来可能加档（S+ / D / 中文档位），**不要猜**它属于哪一档：
 * 认不出来就给中性色，字母照画（信息仍然正确，只是没有配色加成）。
 */
export const AUGMENT_TIER_UNKNOWN_COLOR = '#8b96ad';

/** 档位 → 强调色（未知档位给中性色）。 */
export function augmentTierColor(tier: string): string {
  const key = tier.trim().toUpperCase();
  const hit = (AUGMENT_TIER_COLORS as Readonly<Record<string, string>>)[key];
  return hit ?? AUGMENT_TIER_UNKNOWN_COLOR;
}

/**
 * 从英雄详情的 `augments` 组装强度表（`augment_json_irank` 的口径：**以该英雄为准**）。
 *
 * 同 ID 重复出现时**取先出现的那条**（上游按 rank 升序给，先出现的排名更高）；
 * 档位为空的条目跳过（没有等级就没有可画的东西）。
 */
export function augmentTierTable(
  stats: readonly { readonly augmentId: number; readonly tier: string }[],
): Map<number, string> {
  const table = new Map<number, string>();
  for (const s of stats) {
    const tier = (s.tier ?? '').trim();
    if (tier === '') continue;
    if (table.has(s.augmentId)) continue;
    table.set(s.augmentId, tier);
  }
  return table;
}

/** 查一个海克斯的档位（Map / 普通对象都支持）；查不到返回 null。 */
export function lookupAugmentTier(tiers: AugmentTierTable, augmentId: number | null): string | null {
  if (augmentId === null || !Number.isFinite(augmentId)) return null;
  const asMap = tiers as ReadonlyMap<number, string>;
  const raw =
    typeof asMap.get === 'function'
      ? asMap.get(augmentId)
      : (tiers as Readonly<Record<number, string>>)[augmentId];
  if (typeof raw !== 'string') return null;
  const tier = raw.trim();
  return tier === '' ? null : tier;
}

/* ------------------------------------------------------------------ */
/* 选取率（局内画在字母下面那一行；同样以**该英雄**为准）                  */
/* ------------------------------------------------------------------ */

/** 选取率表：`augmentId` → 登场率（0..1）。形态与 `AugmentTierTable` 一致。 */
export type AugmentPickRateTable = ReadonlyMap<number, number> | Readonly<Record<number, number>>;

/** 选取率行的文案前缀（参考图就是「选取率 12.1%」这一行）。 */
export const AUGMENT_PICK_RATE_PREFIX = '选取率';

/**
 * 从英雄详情的 `augments` 组装选取率表。
 *
 * 口径与强度表**同源**（同一个 `augment_json_irank` 的登场率列），所以键也对齐：
 * 查不到档位的 ID 一定也查不到选取率。
 */
export function augmentPickRateTable(
  stats: readonly { readonly augmentId: number; readonly pickRate: number }[],
): Map<number, number> {
  const table = new Map<number, number>();
  for (const s of stats) {
    if (table.has(s.augmentId)) continue;
    if (!Number.isFinite(s.pickRate)) continue;
    table.set(s.augmentId, s.pickRate);
  }
  return table;
}

/** 查一个海克斯的选取率（Map / 普通对象都支持）；查不到返回 null。 */
export function lookupAugmentPickRate(
  rates: AugmentPickRateTable | undefined,
  augmentId: number | null,
): number | null {
  if (!rates || augmentId === null || !Number.isFinite(augmentId)) return null;
  const asMap = rates as ReadonlyMap<number, number>;
  const raw =
    typeof asMap.get === 'function'
      ? asMap.get(augmentId)
      : (rates as Readonly<Record<number, number>>)[augmentId];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

/**
 * 选取率 → 那一行的文案（`'选取率 12.1%'`）。
 *
 * **缺失 / 0 / 负 / 非有限值 → 空串（这一行不画）**：数字只能来自官方表，
 * 宁可少画一行，也不要为了让版面完整去补一个猜出来的百分比。
 */
export function pickRateText(pickRate: number | null | undefined): string {
  if (pickRate === null || pickRate === undefined) return '';
  if (!Number.isFinite(pickRate) || pickRate <= 0) return '';
  return `${AUGMENT_PICK_RATE_PREFIX} ${(pickRate * 100).toFixed(1)}%`;
}

/** 一条「这张卡可以画」的记录（位置是标签矩形，已算好）。 */
export interface ResolvedAugmentTier {
  readonly augmentId: number;
  /** 档位字母（已 trim）。 */
  readonly tier: string;
  /** 卡片矩形（截屏归一化）—— 排查时用，与标签矩形同一坐标系。 */
  readonly card: Rect;
  /** **标签矩形**（截屏归一化，卡内底部空白区、水平居中）。 */
  readonly rect: Rect;
  /** 字母字号 / 框高（来自标签预设）；渲染端与离线预览共用同一条规则。 */
  readonly fontScale: number;
  /** 该英雄口径的选取率（0..1）；查不到为 null（那一行不画）。 */
  readonly pickRate: number | null;
}

/**
 * 过滤出**真正要画**的卡，并算好标签矩形（**无锁**形态：本帧的卡片现算整排基准）。
 *
 * 两道过滤（都对应产品决策，语义未变）：
 *   1. `augmentId === null` → 认不准，不画；
 *   2. 强度表里查不到（或为空串）→ 不画（不猜档位）。
 *
 * **纵向位置走"整行对齐"**（`alignRowLabels()`，2026-10-06 用户："同一排三个标签
 * 明显不在一个高度"）：先按上面两道过滤挑出这一排真正要画的卡，再用
 * **这一排卡片矩形的中位数**推出**唯一的纵向基准**（y 与 h），三张标签因此
 * 基线像素级相同、字母大小也一致；横向仍按各自卡片水平居中（横向不是问题）。
 *
 * ⚠️ 局内**不再用这个无锁形态**（见 `augmentTierLabelsLocked()`）：中位数在
 * "三张里两张被重随重认"时会跟着挪，真机二次验收确实看到整排下移。
 * 这个函数保留给"没有跨帧状态的调用方"（单测、产物核对、离线预览的单排计算）。
 *
 * 「关闭清空」在这里体现为**无状态**：面板关闭时调用方传入空卡片列表
 * （或直接不调用绘制），得到空输出 —— 本函数不持有任何历史。
 */
export function resolveAugmentTiers<T extends AugmentTierCard>(
  cards: readonly T[],
  tiers: AugmentTierTable,
  options: AugmentTierLabelOptions = {},
): ResolvedAugmentTier[] {
  return augmentTierLabelsLocked(null, cards, tiers, options).labels;
}

/** 一整排标签的计算结果：**标签** + 下一帧要接着用的**行基准锁**。 */
export interface AugmentTierRowResult {
  readonly labels: AugmentTierLabel[];
  /**
   * 本帧之后这一局面板的行基准锁 —— 调用方**必须**存下来，下一次（重随）重识别
   * 原样传回来，面板关闭时丢掉。为 `null` = 这一帧一张卡都没认出来（还没锁定）。
   */
  readonly rowLock: LabelRowLock | null;
}

/**
 * 局内真正走的那条路：**行基准开边沿锁一次、面板存续期间一直复用**。
 *
 * 与 `resolveAugmentTiers()` 只差一件事：纵向基准不再每帧按当前卡片重算。
 *   · `rowLock` 传上一帧拿到的锁（开边沿第一次传 `null`）；
 *   · 这一排**首次**有 ≥1 张要画的卡时锁定（`lockLabelRowBand()`）；
 *   · 之后**只更新内容**：刷新换一颗海克斯 → 字母/选取率变；认不出/查不到 →
 *     那张标签消失；**几何一律不动**（`alignRowLabelsLocked()`）。于是
 *     "某次单卡刷新后三个标签整体下移"在代码层面不可能发生 —— 基准与刷新无关。
 *
 * 横向仍是每张卡各自水平居中（用各自的卡片矩形算 `x`/`w`，与 `rowLock` 无关）。
 * 没有锁（这一局面板一张卡都没认出来过）→ `labels` 为空 = 不画。
 */
export function augmentTierLabelsLocked<T extends AugmentTierCard>(
  rowLock: LabelRowLock | null | undefined,
  cards: readonly T[],
  tiers: AugmentTierTable,
  options: AugmentTierLabelOptions = {},
): AugmentTierRowResult {
  const preset = options.preset ?? AUGMENT_BADGE_PRESETS[AUGMENT_BADGE_DEFAULT];
  const zone = augmentBadgeZone(preset);
  // ① 先过两道过滤，得到"这一排真正要画的卡"
  const drawable: Array<{
    readonly augmentId: number;
    readonly tier: string;
    readonly card: Rect;
    readonly pickRate: number | null;
  }> = [];
  for (const card of cards) {
    if (card.augmentId === null) continue;
    const tier = lookupAugmentTier(tiers, card.augmentId);
    if (tier === null) continue;
    drawable.push({
      augmentId: card.augmentId,
      tier,
      card: card.rect,
      pickRate: lookupAugmentPickRate(options.pickRates, card.augmentId),
    });
  }
  // ② 整排共用一个纵向基准：首次 ≥1 张卡时锁定，之后原样复用（横向仍按各自卡片居中）
  const rowCards = drawable.map((d) => d.card);
  const lock = lockLabelRowBand(rowLock, rowCards, zone);
  const rects = alignRowLabelsLocked(rowCards, lock, zone);
  const labels: AugmentTierLabel[] = [];
  for (const [i, d] of drawable.entries()) {
    const rect = rects[i];
    if (!rect) continue; // 长度一一对应（防御 noUncheckedIndexedAccess，不会走到）
    labels.push({
      augmentId: d.augmentId,
      tier: d.tier,
      card: d.card,
      rect,
      fontScale: preset.fontScale,
      pickRate: d.pickRate,
      text: d.tier,
      subText: pickRateText(d.pickRate),
      color: augmentTierColor(d.tier),
    });
  }
  return { labels, rowLock: lock };
}

export interface AugmentTierLabelOptions {
  /**
   * 标签预设（**唯一的尺寸开关**：几何 + 字号一起由它决定）。
   *
   * 默认 `AUGMENT_BADGE_PRESETS[AUGMENT_BADGE_DEFAULT]`（「小」档，2026-10-06 起）。
   * 换大小只改 `AUGMENT_BADGE_DEFAULT`，或临时用环境变量
   * `HEXBOX_AUGMENT_BADGE=medium|large`（录制/自测路径）。
   */
  readonly preset?: AugmentBadgePreset;
  /**
   * 选取率表（该英雄的 `augments[].pickRate`）。
   *
   * 不给 → 标签上**不画**「选取率 x%」那一行（字母照画，位置不变）。
   */
  readonly pickRates?: AugmentPickRateTable;
}

/** 一条要画的标签（**截屏归一化** + 配色 + 内容）。 */
export interface AugmentTierLabel extends ResolvedAugmentTier {
  /** 大号字母 = **只有档位字母**（不拼登场率、不带百分号）。 */
  readonly text: string;
  /** 字母下面那一行（`'选取率 12.1%'`）；空串 = 不画那一行。 */
  readonly subText: string;
  /** 档位强调色（渲染端直接用它写字、画尖括号与发光）。 */
  readonly color: string;
}

/**
 * 识别结果 + 强度表（+ 可选取取率表）→ 标签列表（截屏归一化 + 配色 + 文案）。
 *
 * `text` **就是档位字母本身**、`subText` 是选取率那一行 —— 两行都由本函数给，
 * 渲染端不拼字符串、不算百分比（这样局内与离线预览的文案也同源）。
 */
export function augmentTierLabels<T extends AugmentTierCard>(
  cards: readonly T[],
  tiers: AugmentTierTable,
  options: AugmentTierLabelOptions = {},
): AugmentTierLabel[] {
  return augmentTierLabelsLocked(null, cards, tiers, options).labels;
}

/** 屏幕逻辑坐标（DIP）下的一条标签 —— 渲染端最终要的就是这个。 */
export interface ScreenAugmentTierLabel {
  readonly augmentId: number;
  readonly tier: string;
  readonly text: string;
  /** 字母下面那一行（选取率）；空串 = 不画。 */
  readonly subText: string;
  readonly color: string;
  /**
   * 绘制样式（**固定 `'tier'`**）：渲染端据此走"大号描边字母 + 尖括号 +
   * 选取率行、没有色块底"那条绘制路径（样式参数仍全部来自 `labelBoxPlan()`）。
   */
  readonly style: 'tier';
  /** 字母字号 / 框高（标签预设带来；渲染端不要自己按框高猜比例）。 */
  readonly fontScale: number;
  /** 该英雄口径的选取率（0..1）；null = 查不到（那一行不画，字母照画）。 */
  readonly pickRate: number | null;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * 截屏归一化标签 → **屏幕逻辑坐标**（DIP）。
 *
 * ⚠️ 这里刻意**复用** `normalizedRectToScreen`（S2 选人标签走的是同一个桥），
 * 不自己再写一遍换算：截屏可能是「显示器快照」也可能是「窗口快照」，
 * 两种形态的偏移都在 `CaptureGeometry` 里表达（见 win-geometry.ts 的踩坑注释），
 * 自写一份必然漂移。
 */
export function toScreenTierLabels(
  labels: readonly AugmentTierLabel[],
  geo: CaptureGeometry,
): ScreenAugmentTierLabel[] {
  return labels.map((l) => {
    const r = normalizedRectToScreen(l.rect, geo);
    return {
      augmentId: l.augmentId,
      tier: l.tier,
      text: l.text,
      subText: l.subText,
      color: l.color,
      style: 'tier',
      fontScale: l.fontScale,
      pickRate: l.pickRate,
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
    };
  });
}
