/**
 * 提示框文案测试
 *
 * 重点不是"字符串长什么样"，而是三条**不许出错的话**：
 *   · 日期解析不出来时不许编一个（`统计日期：未知`）；
 *   · 海克斯那一条必须写明"官方强度表、不是本局选项"；
 *   · 没有官方数据时不许留空（要显式说"暂无官方统计"）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  augmentTierLabelTip,
  championLabelTip,
  TIP_AUGMENT_SOURCE,
  TIP_CHAMPION_SOURCE,
  TIP_RECOGNIZED_FROM_SCREEN,
} from './label-tip.ts';

test('选人提示：胜率/选取率都按一位小数量化，并带排名与名次变化', () => {
  const { tipTitle, tip } = championLabelTip({
    name: '酒桶',
    winRate: 0.5324,
    pickRate: 0.1209,
    rank: 7,
    rankChangeDesc: '上升1位',
    dataDate: '20261005',
  });
  assert.equal(tipTitle, '酒桶');
  assert.deepEqual(tip, [
    '胜率 53.2%',
    '选取率 12.1%',
    '榜单排名 第 7 名（上升1位）',
    '统计日期 2026-10-05',
    TIP_CHAMPION_SOURCE,
  ]);
});

test('★ 选人提示：日期非法时写"未知"，**绝不**拼一个错位日期', () => {
  const { tip } = championLabelTip({
    name: '酒桶',
    winRate: 0.5,
    dataDate: '2026105', // 位数不对
  });
  assert.ok(tip.includes('统计日期：未知'));
  assert.ok(!tip.some((l) => l.includes('2026-10-5')), '不许把 2026105 硬切成日期');
  assert.ok(!tip.some((l) => l.includes('2026-10-05')), '更不许编一个正确的日期出来');
});

test('选人提示：没有官方数据 → 显式说明，而不是留空', () => {
  const { tip } = championLabelTip({ name: '新英雄', winRate: null });
  assert.deepEqual(tip, ['暂无官方统计（该英雄不在榜单里）', '统计日期：未知', TIP_CHAMPION_SOURCE]);
});

test('选人提示：rank<=0 / 名次描述为空时的措辞', () => {
  const a = championLabelTip({ name: '酒桶', winRate: 0.5, rank: 0 });
  assert.ok(!a.tip.some((l) => l.includes('榜单排名')), 'rank 0 不该显示名次');
  const b = championLabelTip({ name: '酒桶', winRate: 0.5, rank: 3, rankChangeDesc: '  ' });
  assert.ok(b.tip.includes('榜单排名 第 3 名'), '描述为空时不留空括号');
});

test('选人提示：名称为空 → 标题用"英雄"兜底（绝不空标题）', () => {
  assert.equal(championLabelTip({ name: '  ', winRate: 0.5 }).tipTitle, '英雄');
});

test('★ 海克斯提示：标题带档位、写出本局英雄、选取率与标签同源格式', () => {
  const { tipTitle, tip } = augmentTierLabelTip({
    tier: 'S',
    pickRate: 0.121,
    championName: '酒桶',
    dataDate: '20261005',
  });
  assert.equal(tipTitle, '强度评级 S');
  assert.ok(tip[0]?.includes('本局英雄：酒桶'));
  assert.ok(
    tip.some((l) => l === '选取率 12.1%（该英雄口径）'),
    `选取率那一行必须与标签同源：${tip.join(' | ')}`,
  );
  assert.ok(tip.includes('统计日期 2026-10-05'));
  assert.ok(tip.includes(TIP_RECOGNIZED_FROM_SCREEN));
  assert.ok(tip.includes(TIP_AUGMENT_SOURCE));
});

test('★ 海克斯提示：必须写明"不是本局给你的选项"（用户明确要求的口径）', () => {
  const { tip } = augmentTierLabelTip({ tier: 'B', pickRate: null });
  const source = tip.find((l) => l === TIP_AUGMENT_SOURCE);
  assert.ok(source, '口径说明必须在');
  assert.ok(source.includes('不是本局给你的选项'), '必须显式排除"本局选项"的误读');
  assert.ok(!source.includes('推荐给你'), '不许写成"推荐给你"');
});

test('海克斯提示：查不到选取率 → 明说，而不是省掉那一行', () => {
  const { tip } = augmentTierLabelTip({ tier: 'A', pickRate: null, championName: '' });
  assert.ok(tip.includes('该英雄暂无官方选取率'));
  assert.ok(!tip.some((l) => l.startsWith('本局英雄：')), '没有英雄名时不留空行');
});

test('海克斯提示：选取率为 0 → 与"查不到"同样明说（标签上那一行本来就不画）', () => {
  // `pickRateText` 对 0 返回空串（标签不画）；提示框必须补一句，否则会读成"没查"
  const { tip } = augmentTierLabelTip({ tier: 'C', pickRate: 0 });
  assert.ok(tip.includes('该英雄暂无官方选取率'));
  assert.ok(!tip.some((l) => l.includes('（）')), '不许留下空括号');
});

test('海克斯提示：档位为空 → 标题退回"强度评级"（不出现双空格）', () => {
  assert.equal(augmentTierLabelTip({ tier: '  ', pickRate: 0.1 }).tipTitle, '强度评级');
});

test('两条提示都不可能返回空数组（空内容 = 没有提示框，不该由文案层产生）', () => {
  assert.ok(championLabelTip({ name: '', winRate: null }).tip.length > 0);
  assert.ok(augmentTierLabelTip({ tier: '', pickRate: null }).tip.length > 0);
});
