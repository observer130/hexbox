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

test('snapshotKind：截屏与显示器纵横比一致、窗口同比但未占满 → display（联合判据）', () => {
  // 三方同比但窗口只占显示器 83%(2000/2400) → 联合判据归 display
  assert.equal(
    snapshotKind({ width: 4800, height: 2700 }, { width: 2400, height: 1350 }, { width: 2000, height: 1125 }, 2000 / 2400),
    'display',
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

test('snapshotKind：三方同比且窗口未占满显示器 → display（S2 真机退化场景）', () => {
  // 真机 S2 第二轮验收: 全部 16:9,窗口逻辑 1600 占显示器逻辑 2400 的 67%
  // → desktopCapturer 返回的是显示器快照（含窗口外桌面）,
  //   按窗口快照处理会让标签偏移一个窗口宽度
  assert.equal(
    snapshotKind({ width: 3413, height: 1920 }, { width: 3000, height: 1688 }, { width: 1600, height: 900 }, 1600 / 2400),
    'display',
  );
});

test('snapshotKind：窗口占满显示器（>0.9）→ window（等价直通）', () => {
  assert.equal(
    snapshotKind({ width: 3440, height: 1440 }, { width: 3440, height: 1440 }, { width: 3440, height: 1440 }, 1),
    'window',
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
  // 窗口与显示器同比且窗口占满显示器物理屏 → snapshotKind 判 window,
  // nw=1 无偏移,截屏内归一化直通窗口逻辑坐标
  // （GetWindowRect 直出逻辑 2560×1440;显示器物理 3200×1800,share=1）
  const display = {
    bounds: { x: 0, y: 0, width: 2560, height: 1440 },
    scaleFactor: 1.25,
    workArea: { x: 0, y: 0, width: 2560, height: 1440 },
  };
  const winPhysical = { x: 0, y: 0, width: 2560, height: 1440 };
  const { geo, kind } = makeScreenGeometry(
    { width: 3413, height: 1920 },
    winPhysical,
    display,
  );
  assert.equal(kind, 'window');
  assert.ok(Math.abs(geo.windowX - 0) < 1e-6);
  // nw = 2560/2560 = 1 → windowWidth = 2560（窗口逻辑宽）
  assert.ok(Math.abs(geo.windowWidth - 2560) < 1e-6, `windowWidth=${geo.windowWidth}`);
});
