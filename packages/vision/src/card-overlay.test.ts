/**
 * card-overlay 测试：标签布局与边界约束
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cardLabelFor } from './card-overlay.ts';

/** 与真机一致的几何：窗口 1600x900 @ (313,1),截屏 3413x1920。 */
const GEO = {
  captureWidth: 3413,
  captureHeight: 1920,
  windowX: 313,
  windowY: 1,
  windowWidth: 1600,
  windowHeight: 900,
};

/** 真机卡片矩形（不屈之枪）。 */
const CARD = { x: 0.3416349252856724, y: 0.2484375, w: 0.14591268678581892, h: 0.4125 };

const WORK = { x: 0, y: 0, width: 1920, height: 1080 };

test('cardLabelFor：标签在卡片正下方,宽度与卡片对齐', () => {
  const label = cardLabelFor(CARD, GEO, WORK, {
    name: '不屈之枪',
    winRate: 0.572,
    hasData: true,
    championId: 80,
  });
  assert.ok(Math.abs(label.w - CARD.w * GEO.windowWidth) < 1e-6);
  // 标签上缘 = 卡片下缘 + gap
  const cardBottom = GEO.windowY + (CARD.y + CARD.h) * GEO.windowHeight;
  assert.ok(Math.abs(label.y - (cardBottom + 6)) < 1e-6);
  assert.equal(label.text, '57.2%');
  assert.equal(label.sub, '不屈之枪');
  assert.equal(label.hasData, true);
  assert.equal(label.x, GEO.windowX + CARD.x * GEO.windowWidth);
});

test('cardLabelFor：无数据显示「暂无数据」且 hasData=false', () => {
  const label = cardLabelFor(CARD, GEO, WORK, {
    name: '某英雄',
    winRate: 0,
    hasData: false,
    championId: 42,
  });
  assert.equal(label.text, '暂无数据');
  assert.equal(label.hasData, false);
});

test('cardLabelFor：卡片贴显示器底部时标签翻到上方', () => {
  // 卡片下缘距工作区底部不足 gap+labelHeight
  const workArea = { x: 0, y: 0, width: 1920, height: 500 };
  const label = cardLabelFor(CARD, GEO, workArea, {
    name: '不屈之枪',
    winRate: 0.5,
    hasData: true,
    championId: 80,
  });
  // 卡片下缘 ≈ 1 + 0.6609*900 ≈ 596 > 500 → 必须翻转
  const cardBottom = GEO.windowY + (CARD.y + CARD.h) * GEO.windowHeight;
  assert.ok(cardBottom + 6 + 34 > 500, '前提:默认位置应越界');
  assert.ok(label.y + label.h <= 500, `标签底 ${label.y + label.h} 应 <= 500`);
});

test('cardLabelFor：翻转仍越界时贴显示器底部', () => {
  // 极端:工作区高度只够放下标签本身
  const workArea = { x: 0, y: 0, width: 1920, height: 40 };
  const label = cardLabelFor(CARD, GEO, workArea, {
    name: 'x',
    winRate: 0.5,
    hasData: true,
    championId: 1,
  });
  assert.ok(Math.abs(label.y + label.h - 40) < 1e-6);
});
