/**
 * panel-geometry 测试
 *
 * 重点回归真机 bug：全屏游戏时面板被摆到屏幕外。
 * 真机几何：游戏窗口 2293×960、显示器 2294×960。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  computePanelBounds,
  computeVisionBounds,
  PANEL_GAP,
  PANEL_HEIGHT,
  PANEL_WIDTH,
} from './panel-geometry.ts';

/** 真机工作区：2294×960 全屏。 */
const WORK = { x: 0, y: 0, width: 2294, height: 960 };

test('全屏游戏（2293×960）：面板必须完整落在屏幕内', () => {
  const panel = computePanelBounds({ x: 0, y: 0, width: 2293, height: 960 }, WORK);
  // 旧算式给出 x=2301 → 面板 2301..2641，整个在屏幕外（2294 宽）
  assert.ok(panel.x >= WORK.x, `x 不能为负: ${panel.x}`);
  assert.ok(
    panel.x + panel.width <= WORK.x + WORK.width,
    `面板右缘 ${panel.x + panel.width} 超出屏幕 ${WORK.x + WORK.width}`,
  );
  assert.ok(panel.y + panel.height <= WORK.y + WORK.height, '面板底缘不能超出屏幕');
  assert.equal(panel.width, PANEL_WIDTH);
  assert.equal(panel.height, PANEL_HEIGHT);
});

test('窗口化游戏：优先贴在游戏窗口外侧右边（不遮挡游戏）', () => {
  const game = { x: 100, y: 50, width: 1600, height: 900 };
  const panel = computePanelBounds(game, WORK);
  assert.equal(panel.x, game.x + game.width + PANEL_GAP);
  assert.equal(panel.y, game.y + 40);
  assert.ok(panel.x + panel.width <= WORK.width, '外侧放得下时不应越界');
});

test('游戏窗口偏右、外侧放不下：退到内侧右边（不越界）', () => {
  const game = { x: 500, y: 40, width: 1700, height: 900 };
  const panel = computePanelBounds(game, WORK);
  assert.ok(panel.x + panel.width <= WORK.width, '必须落在屏幕内');
  assert.ok(panel.x < game.x + game.width, '此时应叠在游戏窗口内');
});

test('游戏窗口比工作区还宽：贴工作区右缘（仍可见）', () => {
  const game = { x: -200, y: 0, width: 2600, height: 960 };
  const panel = computePanelBounds(game, WORK);
  assert.equal(panel.x, WORK.x + WORK.width - PANEL_WIDTH - PANEL_GAP);
  assert.ok(panel.x >= WORK.x);
});

test('游戏窗口未知：贴工作区右缘，不抛错', () => {
  const panel = computePanelBounds(null, WORK);
  assert.equal(panel.x, WORK.width - PANEL_WIDTH - PANEL_GAP);
  assert.equal(panel.y, 40);
});

test('纵向夹紧：游戏窗口贴底时面板不越出下缘', () => {
  const game = { x: 0, y: 700, width: 1200, height: 1000 };
  const panel = computePanelBounds(game, WORK);
  assert.ok(panel.y + panel.height <= WORK.height, '面板底缘不能超出工作区');
  assert.ok(panel.y >= WORK.y);
});

test('副屏工作区有偏移时按绝对坐标放置', () => {
  const work2 = { x: 2294, y: 0, width: 1920, height: 1080 };
  const game = { x: 2400, y: 100, width: 1600, height: 900 };
  const panel = computePanelBounds(game, work2);
  assert.ok(panel.x >= work2.x, '不能落到副屏左侧之外');
  assert.ok(panel.x + panel.width <= work2.x + work2.width);
});

test('极小工作区：面板尺寸收缩到工作区以内', () => {
  const small = { x: 0, y: 0, width: 300, height: 400 };
  const panel = computePanelBounds(null, small);
  assert.ok(panel.width <= small.width);
  assert.ok(panel.height <= small.height);
  assert.ok(panel.x >= 0 && panel.y >= 0);
});

test('computeVisionBounds：覆盖层铺满工作区', () => {
  assert.deepEqual(computeVisionBounds(WORK), { x: 0, y: 0, width: 2294, height: 960 });
});
