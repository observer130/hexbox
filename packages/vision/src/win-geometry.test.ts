/**
 * win-geometry 测试
 *
 * 纯函数部分（captureScale）用单测覆盖；PowerShell 查询部分
 * 需要真实 Windows 桌面，只能人工验证（CI 不跑）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { captureScale } from './win-geometry.ts';

test('captureScale：窗口矩形与截屏同源时自校准出真实缩放', () => {
  // 窗口物理 1706×960，截屏 3412×1920 → scale = 2.0（整除，避免浮点噪声）
  const r = captureScale(
    { width: 3412, height: 1920 },
    { x: 0, y: 0, width: 1706, height: 960 },
  );
  assert.equal(r.estimated, false);
  assert.ok(Math.abs(r.scale - 2.0) < 1e-9);
});

test('captureScale：缺窗口矩形时按 1.0 兜底并标记 estimated', () => {
  const r = captureScale({ width: 3413, height: 1920 }, null);
  assert.equal(r.scale, 1);
  assert.equal(r.estimated, true);
});

test('captureScale：窗口宽为 0（异常）时按 1.0 兜底', () => {
  const r = captureScale(
    { width: 3413, height: 1920 },
    { x: 0, y: 0, width: 0, height: 960 },
  );
  assert.equal(r.estimated, true);
  assert.equal(r.scale, 1);
});

test('captureScale：截屏宽为 0 时按 1.0 兜底', () => {
  const r = captureScale(
    { width: 0, height: 0 },
    { x: 0, y: 0, width: 1706, height: 960 },
  );
  assert.equal(r.estimated, true);
  assert.equal(r.scale, 1);
});
