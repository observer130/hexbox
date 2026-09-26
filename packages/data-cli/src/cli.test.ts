/**
 * data-cli 测试
 *
 * 重点覆盖 `mergeDatasets` —— 多源合并是本模块唯一的纯逻辑，
 * 也是隐性风险点：当前策略是「后者只补前者没有的部分」，且只处理 hextechs。
 *
 * 注：cli.ts 已加入入口保护（isDirectRun），import 本模块不会执行 CLI。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Dataset, HextechStatic } from '@hexbox/core';

import { mergeDatasets } from './cli.ts';

function hex(id: number, name: string): HextechStatic {
  return {
    id,
    augmentNameId: `ARAM_${name}`,
    name,
    tooltip: '',
    rarity: 'kSilver',
    modes: ['KIWI'],
    largeIcon: '',
    smallIcon: '',
    isNew: false,
  };
}

function ds(source: string, opts: Partial<Dataset> = {}): Dataset {
  return {
    meta: { source, patch: null, fetchedAt: '2026-09-26T00:00:00.000Z' },
    augments: [],
    champions: [],
    items: [],
    hextechs: [],
    ...opts,
  };
}

test('mergeDatasets：单源时原样返回', () => {
  const only = ds('a', { hextechs: [hex(1, 'X')] });
  const merged = mergeDatasets([only]);
  assert.equal(merged.meta.source, 'a');
  assert.equal(merged.hextechs.length, 1);
});

test('mergeDatasets：以第一个源为基准（meta/英雄/装备取自它）', () => {
  const primary = ds('cdragon', {
    champions: [{ id: 1, name: '安妮', alias: 'Annie', roles: [], iconPath: '' }],
    items: [{ id: 1001, name: '长剑', description: '', price: 0, priceTotal: 0, iconPath: '', categories: [] }],
  });
  const secondary = ds('tencent', { hextechs: [hex(1001, '泰坦')] });

  const merged = mergeDatasets([primary, secondary]);
  assert.equal(merged.meta.source, 'cdragon'); // 基准源的 meta 保留
  assert.equal(merged.champions.length, 1);
  assert.equal(merged.items.length, 1);
  assert.equal(merged.hextechs.length, 1); // 由次源补上
});

test('mergeDatasets：基准源已有 hextechs 时不覆盖', () => {
  const primary = ds('cdragon', { hextechs: [hex(1, '原有')] });
  const secondary = ds('tencent', { hextechs: [hex(2, '外来')] });

  const merged = mergeDatasets([primary, secondary]);
  assert.equal(merged.hextechs.length, 1);
  assert.equal(merged.hextechs[0]!.name, '原有'); // 保持基准源
});

test('mergeDatasets：多个次源按顺序补齐（首个非空者胜出）', () => {
  const primary = ds('cdragon');
  const first = ds('source-a', { hextechs: [hex(1, 'A')] });
  const second = ds('source-b', { hextechs: [hex(2, 'B')] });

  const merged = mergeDatasets([primary, first, second]);
  assert.equal(merged.hextechs.length, 1);
  assert.equal(merged.hextechs[0]!.name, 'A');
});

test('mergeDatasets：不修改输入对象（无副作用）', () => {
  const primary = ds('cdragon');
  const secondary = ds('tencent', { hextechs: [hex(1, 'X')] });

  mergeDatasets([primary, secondary]);

  // 合并结果应写入新对象，原 primary 不应被就地改写
  assert.equal(primary.hextechs.length, 0);
});

test('mergeDatasets：空数组抛错（避免写出空数据集）', () => {
  assert.throws(() => mergeDatasets([]), /没有可合并的数据集/);
});

/**
 * 记录当前合并策略的**已知边界**：只合并 hextechs。
 *
 * 这不是在认可该行为，而是把它钉成显式契约 —— 将来若新增
 * 第二个需要合并的字段（如 augments 增量），这个测试会失败，
 * 提醒开发者同步扩展 mergeDatasets，而不是静默丢数据。
 */
test('mergeDatasets：当前只合并 hextechs（已知边界，改动需显式扩展）', () => {
  const primary = ds('cdragon');
  const secondary = ds('tencent', {
    augments: [
      {
        id: 9,
        augmentNameId: 'ARAM_Extra',
        name: '额外',
        simpleName: '',
        iconPath: '',
        rarity: 'kGold',
        modes: ['KIWI'],
      },
    ],
  });

  const merged = mergeDatasets([primary, secondary]);
  // 次源的 augments 目前**不会**被合并进来
  assert.equal(merged.augments.length, 0);
  assert.equal(merged.hextechs.length, 0);
});
