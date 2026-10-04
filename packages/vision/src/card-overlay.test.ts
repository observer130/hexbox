/**
 * card-overlay 测试：标签布局与边界约束
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cardLabelFor, slotLabelFor, CARD_LABEL_GAP, LABEL_WIDTH } from './card-overlay.ts';
import { normalizedRectToScreen } from './geometry.ts';

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

test('cardLabelFor：标签在卡片正下方，紧凑定宽并水平居中', () => {
  const label = cardLabelFor(CARD, GEO, WORK, {
    name: '不屈之枪',
    winRate: 0.572,
    hasData: true,
    championId: 80,
  });
  // 真机反馈"标签宽度太大"：不再与卡片同宽（卡片约 233 DIP），改为紧凑定宽
  const cardW = CARD.w * GEO.windowWidth;
  assert.equal(label.w, LABEL_WIDTH);
  assert.ok(label.w < cardW, '标签必须比卡片窄');
  // 相对卡片居中
  const cardX = GEO.windowX + CARD.x * GEO.windowWidth;
  assert.ok(Math.abs(label.x - (cardX + (cardW - LABEL_WIDTH) / 2)) < 1e-6);
  // 标签上缘 = 检测框下缘 + CARD_LABEL_GAP（36 DIP：名字条约 30 DIP 高，
  // 用 6 会压住职业图标与英雄名 —— 真机合成核对发现的问题）
  const cardBottom = GEO.windowY + (CARD.y + CARD.h) * GEO.windowHeight;
  assert.ok(Math.abs(label.y - (cardBottom + CARD_LABEL_GAP)) < 1e-6);
  assert.equal(label.text, '57.2%');
  assert.equal(label.sub, '不屈之枪');
  assert.equal(label.hasData, true);
  // 标签必须完全落在检测框之外（不再与名字条重叠）
  assert.ok(label.y >= cardBottom, '标签不应压进卡片检测框内');
});

test('cardLabelFor：卡片比标签更窄时收缩到卡宽（不溢出卡片）', () => {
  const narrow = { x: 0.4, y: 0.3, w: 0.02, h: 0.4 }; // 32 DIP 宽
  const label = cardLabelFor(narrow, GEO, WORK, {
    name: '窄卡',
    winRate: 0.5,
    hasData: true,
    championId: 1,
  });
  assert.equal(label.w, narrow.w * GEO.windowWidth);
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
  assert.ok(cardBottom + CARD_LABEL_GAP + 34 > 500, '前提:默认位置应越界');
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

test('cardLabelFor：任何工作区下标签都完整可见（不产生负 y）', () => {
  // 回归：间距调到 233 DIP 后，"翻转"分支会算出负 y —— 标签被推到屏幕
  // 上边缘之外，真机上表现为"标签消失"。这里把不变量写死：
  // 无论工作区多小、卡片在哪儿，标签必须完整落在工作区内。
  const sizes = [40, 120, 300, 500, 900, 1080];
  const cards = [
    { x: 0.2, y: 0.05, w: 0.1, h: 0.9 }, // 很高的卡片
    CARD,
    { x: 0.2, y: 0.8, w: 0.1, h: 0.19 }, // 贴底
    { x: 0.2, y: 0, w: 0.1, h: 0.05 }, // 贴顶
  ];
  for (const height of sizes) {
    const workArea = { x: 0, y: 0, width: 1920, height };
    for (const card of cards) {
      const label = cardLabelFor(card, GEO, workArea, {
        name: 'x',
        winRate: 0.5,
        hasData: true,
        championId: 1,
      });
      assert.ok(label.y >= 0, `工作区 h=${height} 卡片 y=${card.y}: 标签 y=${label.y} 不应为负`);
      assert.ok(
        label.y + label.h <= height + 1e-6,
        `工作区 h=${height} 卡片 y=${card.y}: 标签底 ${label.y + label.h} 超出`,
      );
    }
  }
});

test('slotLabelFor：标签在槽位正下方、居中对齐、最小宽 56', () => {
  // display 形态真机几何:截屏 3413×1920（显示器逻辑 2400×1350）,
  // 窗口 1600×900 @ (313,1)。槽位矩形已是**截屏空间**归一化
  // （windowRectToCapture 的产物）:格 0 窗口内 x0=659/2400 →
  // 截屏 313/2400 + (659/2400)×(1600/2400)。
  const geo = {
    captureWidth: 3413,
    captureHeight: 1920,
    windowX: 313,
    windowY: 1,
    windowWidth: 1600,
    windowHeight: 900,
  };
  const nx0 = 313 / 2400;
  const nw = 1600 / 2400;
  const ny0 = 1 / 1350;
  const nh = 900 / 1350;
  const winSlot = { x: 659 / 2400, y: 19 / 1350, w: 93 / 2400, h: 94 / 1350 };
  const captureSlot = {
    x: nx0 + winSlot.x * nw,
    y: ny0 + winSlot.y * nh,
    w: winSlot.w * nw,
    h: winSlot.h * nh,
  };
  const workArea = { x: 0, y: 0, width: 2400, height: 1344 };
  const label = slotLabelFor(captureSlot, geo, workArea, {
    name: '不屈之枪',
    winRate: 0.572,
    hasData: true,
    championId: 80,
  });
  assert.equal(label.text, '57.2%');
  assert.equal(label.sub, '不屈之枪');
  assert.ok(label.w >= 56, `标签宽应 ≥56,实际 ${label.w}`);
  // 水平居中:标签中心 = 槽位中心
  const slotScreen = normalizedRectToScreen(captureSlot, geo);
  const slotCenter = slotScreen.x + slotScreen.w / 2;
  const labelCenter = label.x + label.w / 2;
  assert.ok(Math.abs(slotCenter - labelCenter) < 1e-6);
  // 垂直:标签上缘 = 槽位下缘 + gap
  assert.ok(Math.abs(label.y - (slotScreen.y + slotScreen.h + 4)) < 1e-6);
});

test('slotLabelFor：无数据显示「暂无数据」', () => {
  const geo = {
    captureWidth: 1000, captureHeight: 1000,
    windowX: 0, windowY: 0, windowWidth: 1000, windowHeight: 1000,
  };
  const workArea = { x: 0, y: 0, width: 1000, height: 1000 };
  const label = slotLabelFor({ x: 0.3, y: 0.1, w: 0.04, h: 0.07 }, geo, workArea, {
    name: 'x', winRate: 0, hasData: false, championId: 1,
  });
  assert.equal(label.text, '暂无数据');
  assert.equal(label.hasData, false);
});

test('slotLabelFor：越出工作区底缘时夹回（防御,正常不触发）', () => {
  const geo = {
    captureWidth: 1000, captureHeight: 1000,
    windowX: 0, windowY: 0, windowWidth: 1000, windowHeight: 1000,
  };
  // 槽位贴近工作区底部
  const workArea = { x: 0, y: 0, width: 1000, height: 200 };
  const label = slotLabelFor({ x: 0.3, y: 0.9, w: 0.04, h: 0.07 }, geo, workArea, {
    name: 'x', winRate: 0.5, hasData: true, championId: 1,
  });
  assert.ok(label.y + label.h <= 200 + 1e-6, `${label.y + label.h} 应 ≤ 200`);
});
