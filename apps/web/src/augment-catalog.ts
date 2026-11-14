/**
 * 海克斯图鉴合并（**国服口径优先**，纯函数）
 *
 * 两套官方静态数据：
 *   · `Dataset.augments`   — CommunityDragon `cherry-augments.json`（594 条，
 *     含其它模式/事件条目；只有内部名称与图标路径，无中文描述）；
 *   · `Dataset.hextechs`   — 腾讯一方 `kiwi_augments.json`（235 条国服图鉴，
 *     带官方中文名/描述/图标直链）。
 *
 * 2026-11-14 决策：**同名条目以国服为准**（名称/品质/模式/图标），CDragon 只用来
 * 补全国服未收录的条目。原因：同一海克斯两源存在稀有度冲突（如
 * `ChainReaction`、`Quest_UrfsChampion`：CDragon `kGold` vs 国服 `kPrismatic`），
 * 本站榜单也以国服 ID 为准，图鉴再按 CDragon 展示会让同一页出现两套品质。
 *
 * ⚠️ 两套 ID 不能互相换算（见 `packages/core/src/types.ts` 的 ID 体系说明），
 * 只能按归一化 `augmentNameId` 对齐；Vue `key` 必须带来源前缀，
 * 否则两套 ID 空间数值重叠会出现重复 key。
 */

import type {
  Augment,
  AugmentMode,
  AugmentRarity,
  HextechStatic,
} from '@hexbox/core';

/** 图鉴瓦片：两套官方口径归一化后的可渲染形态。 */
export interface CatalogTile {
  /** Vue key：`cn:` / `cdragon:` + 源 ID（两套 ID 空间数值会重叠）。 */
  readonly key: string;
  /** 该条目的展示口径来源。 */
  readonly source: 'cn' | 'cdragon';
  readonly id: number;
  readonly augmentNameId: string;
  readonly name: string;
  readonly rarity: AugmentRarity;
  readonly modes: readonly AugmentMode[];
  /** 可直接 `<img src>`：国服 CDN 直链或 CDragon 资源 URL；可能为空串。 */
  readonly iconUrl: string;
  /** 国服官方描述（仅国服条目有）。 */
  readonly tooltip?: string;
  /** 国服上游标记（仅国服条目有）。 */
  readonly isNew?: boolean;
}

const CDRAGON_ASSET_PREFIX = 'https://raw.communitydragon.org/latest/plugins';

/** CDragon 资源路径 → 可访问 URL（空路径保持空串，由 UI 渲染占位块）。 */
export function iconUrlFromPath(iconPath: string): string {
  return iconPath ? `${CDRAGON_ASSET_PREFIX}${iconPath}` : '';
}

/** 名称归一化：去掉 `ARAM_` 前缀并小写（两源对齐口径，唯一来源）。 */
export function normalizeAugmentName(augmentNameId: string): string {
  return augmentNameId.replace(/^ARAM_/i, '').toLowerCase();
}

/**
 * 合并两套官方图鉴，国服优先、CDragon 补全。
 *
 * 纯函数：不依赖 DOM/网络，可在 Node 里直接单测（`augment-catalog.test.ts`）。
 */
export function buildAugmentCatalog(
  augments: readonly Augment[],
  hextechs: readonly HextechStatic[],
): CatalogTile[] {
  const tiles: CatalogTile[] = [];
  const emitted = new Set<string>();

  // 1) 国服条目全量优先（含 CDragon 未收录的；同名重复行只留第一条）。
  for (const h of hextechs) {
    const nameKey = normalizeAugmentName(h.augmentNameId);
    if (emitted.has(nameKey)) continue;
    emitted.add(nameKey);
    tiles.push({
      key: `cn:${h.id}`,
      source: 'cn',
      id: h.id,
      augmentNameId: h.augmentNameId,
      name: h.name,
      rarity: h.rarity,
      modes: h.modes,
      iconUrl: h.smallIcon || h.largeIcon,
      ...(h.tooltip ? { tooltip: h.tooltip } : {}),
      ...(h.isNew ? { isNew: true } : {}),
    });
  }

  // 2) CDragon 只补国服没有的；同名重复行（图鉴里存在）只留第一条。
  for (const a of augments) {
    const nameKey = normalizeAugmentName(a.augmentNameId);
    if (emitted.has(nameKey)) continue;
    emitted.add(nameKey);
    tiles.push({
      key: `cdragon:${a.id}`,
      source: 'cdragon',
      id: a.id,
      augmentNameId: a.augmentNameId,
      name: a.name,
      rarity: a.rarity,
      modes: a.modes,
      iconUrl: iconUrlFromPath(a.iconPath),
    });
  }

  return tiles;
}
