/**
 * 图鉴合并（国服优先）单测
 *
 * 锁定的是 2026-11-14 的产品决策：同名条目以国服为准，CDragon 只补全；
 * 以及两个真实数据陷阱：
 *   · 两套 ID 空间数值会重叠 → Vue key 必须带来源前缀；
 *   · CDragon 同一 `augmentNameId` 存在重复行（稀有度还可能矛盾）→ 只留一条。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Augment, HextechStatic } from '@hexbox/core';

import {
  buildAugmentCatalog,
  iconUrlFromPath,
  normalizeAugmentName,
} from './augment-catalog.ts';

function cdragon(id: number, augmentNameId: string, name: string): Augment {
  return {
    id,
    augmentNameId,
    name,
    simpleName: name,
    iconPath: `/lol-game-data/assets/${id}.png`,
    rarity: 'kGold',
    modes: ['KIWI'],
  };
}

function cn(id: number, augmentNameId: string, name: string): HextechStatic {
  return {
    id,
    augmentNameId,
    name,
    tooltip: `${name}的官方描述`,
    rarity: 'kPrismatic',
    modes: ['KIWI', 'KIWI_JADE'],
    largeIcon: `https://example.test/${id}_large.png`,
    smallIcon: `https://example.test/${id}_small.png`,
    isNew: true,
  };
}

test('normalizeAugmentName：去 ARAM_ 前缀 + 小写（两源对齐唯一口径）', () => {
  assert.equal(normalizeAugmentName('ARAM_ImTheJuggernaut'), 'imthejuggernaut');
  assert.equal(normalizeAugmentName('ChainReaction'), 'chainreaction');
  assert.equal(normalizeAugmentName('aram_quest_urfschampion'), 'quest_urfschampion');
});

test('iconUrlFromPath：CDragon 相对路径补前缀，空路径保持空串', () => {
  assert.equal(
    iconUrlFromPath('/lol-game-data/assets/a.png'),
    'https://raw.communitydragon.org/latest/plugins/lol-game-data/assets/a.png',
  );
  assert.equal(iconUrlFromPath(''), '');
});

test('buildAugmentCatalog：同名时国服名称/品质/模式/图标全胜出（CDragon 不再并列）', () => {
  const tiles = buildAugmentCatalog(
    [cdragon(1205, 'ARAM_ChainReaction', '连锁反应')],
    [cn(1001, 'ChainReaction', '连锁反应（国服）')],
  );

  assert.equal(tiles.length, 1, '同名条目只能出现一次');
  assert.deepEqual(tiles[0], {
    key: 'cn:1001',
    source: 'cn',
    id: 1001,
    augmentNameId: 'ChainReaction',
    name: '连锁反应（国服）',
    rarity: 'kPrismatic',
    modes: ['KIWI', 'KIWI_JADE'],
    iconUrl: 'https://example.test/1001_small.png',
    tooltip: '连锁反应（国服）的官方描述',
    isNew: true,
  });
});

test('buildAugmentCatalog：构建国服未收录的 CDragon 条目（空图标 → 空串）', () => {
  const tiles = buildAugmentCatalog(
    [
      {
        ...cdragon(1205, 'ARAM_OnlyCdragon', '仅 CDragon'),
        iconPath: '',
      },
    ],
    [],
  );

  assert.equal(tiles.length, 1);
  assert.equal(tiles[0]?.source, 'cdragon');
  assert.equal(tiles[0]?.rarity, 'kGold');
  assert.equal(tiles[0]?.iconUrl, '');
});

test('buildAugmentCatalog：两套 ID 数值重叠也不产生重复 key', () => {
  // 真实数据里国服 ID 1001+ 与 CDragon 数字 ID 存在数值重叠
  const tiles = buildAugmentCatalog(
    [cdragon(1001, 'ARAM_OtherMode', '其它模式')],
    [cn(1001, 'ImTheJuggernaut', '泰坦的坚决')],
  );

  assert.equal(tiles.length, 2);
  assert.deepEqual(
    tiles.map((t) => t.key),
    ['cn:1001', 'cdragon:1001'],
  );
});

test('buildAugmentCatalog：CDragon 重复行只留第一条（稀有度冲突由国服裁决）', () => {
  const tiles = buildAugmentCatalog(
    [
      cdragon(1154, 'ARAM_Quest_UrfsChampion', '任务：海牛阿福的勇士'),
      { ...cdragon(9999, 'Quest_UrfsChampion', '海牛阿福的勇士'), rarity: 'kPrismatic' },
    ],
    [cn(1200, 'Quest_UrfsChampion', '海牛阿福的勇士')],
  );

  assert.equal(tiles.length, 1, '国服已收录 → 两条 CDragon 重复行都不再展示');
  assert.equal(tiles[0]?.id, 1200);
  assert.equal(tiles[0]?.rarity, 'kPrismatic');
});
