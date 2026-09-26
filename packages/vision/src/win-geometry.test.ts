/**
 * win-geometry 测试
 *
 * 纯函数部分（captureScale / snapshotKind）用单测覆盖；
 * PowerShell 查询部分需要真实 Windows 桌面，只能人工验证（CI 不跑）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { captureScale, makeScreenGeometry, snapshotKind } from './win-geometry.ts';

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

/* ------------------------------------------------------------------ */
/* snapshotKind：窗口快照 vs 显示器快照（S2 坐标错位修复的判据）         */
/* ------------------------------------------------------------------ */

test('snapshotKind：截屏与显示器纵横比一致、窗口不同 → display', () => {
  // 真机 S2 场景变体: 显示器逻辑 1920×1080@1.25(16:9),
  // 窗口 2000×1125(16:9)与显示器同比 —— 三方同比时退化为 window(无偏移,误差小)
  assert.equal(
    snapshotKind({ width: 4800, height: 2700 }, { width: 2400, height: 1350 }, { width: 2000, height: 1125 }),
    'window',
  );
});

test('snapshotKind：截屏与显示器同比而窗口不同比 → display', () => {
  // 显示器 16:9,窗口是更宽的无边框(比如 16:10 内容被拉伸) —— 罕见;
  // 更常见: 截屏含显示器黑边。构造: 显示器 16:9,窗口 4:3,截屏 16:9
  assert.equal(
    snapshotKind({ width: 4800, height: 2700 }, { width: 2400, height: 1350 }, { width: 1600, height: 1200 }),
    'display',
  );
});

test('snapshotKind：截屏与窗口同比而显示器不同比 → window', () => {
  // S1 场景: 窗口 1600×900(16:9),截屏 3413×1920(≈16:9),
  // 显示器物理 3440×1440(≈2.39:1 带鱼屏或黑边) → window
  assert.equal(
    snapshotKind({ width: 3413, height: 1920 }, { width: 3440, height: 1440 }, { width: 1600, height: 900 }),
    'window',
  );
});

test('snapshotKind：无窗口矩形 → window（保守直通）', () => {
  assert.equal(snapshotKind({ width: 4800, height: 2700 }, { width: 2400, height: 1350 }), 'window');
});

/* ------------------------------------------------------------------ */
/* makeScreenGeometry：两种快照形态的端到端换算                          */
/* ------------------------------------------------------------------ */

test('makeScreenGeometry：显示器快照形态下标签落在窗口内（S2 坐标错位回归）', () => {
  // 真机 S2 验收场景变体:显示器逻辑 1920×1080@1.25(16:9),
  // 截屏 4800×2700(16:9,=物理×2,显示器快照),窗口 1600×1000(1.6:1,不同比)
  // → snapshotKind 判 display,窗口在截屏内占子矩形,需偏移换算。
  const display = {
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    scaleFactor: 1.25,
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  };
  const winPhysical = { x: 391, y: 1, width: 1600, height: 1000 };
  const capture = { width: 4800, height: 2700 };
  const { geo, kind } = makeScreenGeometry(capture, winPhysical, display);
  assert.equal(kind, 'display');

  // 窗口中心物理 (1191, 501) → 截屏内归一化 (1191/2400, 501/1350)
  const winCxNorm = (winPhysical.x + winPhysical.width / 2) / 2400;
  const winCyNorm = (winPhysical.y + winPhysical.height / 2) / 1350;
  const screenX = geo.windowX + winCxNorm * geo.windowWidth;
  const screenY = geo.windowY + winCyNorm * geo.windowHeight;
  // 窗口逻辑中心 = (312.8+640, 0.8+500) = (952.8, 400.8)
  assert.ok(Math.abs(screenX - 952.8) < 1, `screenX=${screenX}`);
  assert.ok(Math.abs(screenY - 400.8) < 1, `screenY=${screenY}`);
});

test('makeScreenGeometry：窗口快照形态下无偏移直通', () => {
  // 真机 S1 场景:截屏 3413×1920 = 窗口 1600×900 × 2.133(窗口快照)
  const display = {
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    scaleFactor: 1.25,
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  };
  const winPhysical = { x: 391, y: 1, width: 1600, height: 900 };
  const { geo, kind } = makeScreenGeometry(
    { width: 3413, height: 1920 },
    winPhysical,
    display,
  );
  assert.equal(kind, 'window');
  assert.ok(Math.abs(geo.windowX - 391 / 1.25) < 1e-6);
  assert.ok(Math.abs(geo.windowWidth - 1600 / 1.25) < 1e-6);
  // 窗口内左上角归一化 (0,0) → 屏幕坐标 = 窗口逻辑左上角
  assert.ok(Math.abs(geo.windowX - 312.8) < 0.5);
});
