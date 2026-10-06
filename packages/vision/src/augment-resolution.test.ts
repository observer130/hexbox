/**
 * 分辨率无关性测试（2026-10-05 用户要求："一换分辨率就不能用了"不行）
 *
 * 锁两件事：
 *   1. **门控画布尺寸**只取决于流的原生宽度（与 DPI 缩放、显示器分辨率无关）；
 *   2. **搜索区**在 4:3 ~ 32:9 之间都包得住卡片行
 *      （LoL 的 UI 按**屏幕高度**缩放 → 卡片行宽 = 0.956 × 帧高）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PANEL_ROW_REGION, gateCanvasWidth } from './augment-panel.ts';

/* ------------------------------------------------------------------ */
/* 门控画布                                                            */
/* ------------------------------------------------------------------ */

test('门控画布：常见分辨率都取到"原生的 ≥1/4"（标定下限）', () => {
  // [名称, 流原生宽, 期望比例下限]
  const cases: Array<[string, number]> = [
    ['1080p', 1920],
    ['2K (2560×1440)', 2560],
    ['3440×1440 (本机)', 3440],
    ['4K (3840×2160)', 3840],
  ];
  for (const [name, w] of cases) {
    const out = gateCanvasWidth(w, { targetScale: 1 / 3, minWidth: 960 });
    const ratio = out / w;
    assert.ok(ratio >= 0.25, `${name}: 有效分辨率 ${ratio.toFixed(3)} 低于标定下限 1/4`);
    assert.ok(ratio <= 1, `${name}: 不该放大`);
  }
});

test('门控画布：与 DPI 缩放无关（同样的流宽 → 同样的画布宽）', () => {
  // 旧算法会因 scaleFactor 不同而给出不同比例（0.5/scaleFactor），这里必须一致
  const a = gateCanvasWidth(3440, { targetScale: 1 / 3, minWidth: 960 });
  const b = gateCanvasWidth(3440, { targetScale: 1 / 3, minWidth: 960 });
  assert.equal(a, b);
  assert.equal(a, 1147, '3440/3 ≈ 1147');
});

test('门控画布：小屏靠 minWidth 兜底，但绝不超过流的原生宽度', () => {
  // 720p 的 1/3 = 640 < 960 → 取 960（仍小于原生 1280）
  assert.equal(gateCanvasWidth(1280, { targetScale: 1 / 3, minWidth: 960 }), 960);
  // 极小流：minWidth 大于原生 → 退回原生宽度（不放大）
  assert.equal(gateCanvasWidth(640, { targetScale: 1 / 3, minWidth: 960 }), 640);
});

test('门控画布：非法宽度不炸（返回 minWidth）', () => {
  assert.equal(gateCanvasWidth(0, { minWidth: 960 }), 960);
  assert.equal(gateCanvasWidth(Number.NaN, { minWidth: 960 }), 960);
});

/* ------------------------------------------------------------------ */
/* 搜索区覆盖（与纵横比无关）                                            */
/* ------------------------------------------------------------------ */

/** 实测：卡片行宽 = 0.956 × 帧高（LoL 的 UI 按屏幕高度缩放）。 */
const ROW_WIDTH_IN_HEIGHTS = 0.956;

test('搜索区：4:3 ~ 32:9 都包得住卡片行（换分辨率/换显示器不会瞎）', () => {
  for (const [name, ar] of [
    ['4:3', 4 / 3],
    ['16:10', 1.6],
    ['16:9', 16 / 9],
    ['21:9', 64 / 27],
    ['3440×1440', 3440 / 1440],
    ['32:9', 32 / 9],
  ] as Array<[string, number]>) {
    const half = ROW_WIDTH_IN_HEIGHTS / ar / 2;
    const x0 = 0.5 - half;
    const x1 = 0.5 + half;
    assert.ok(
      x0 >= PANEL_ROW_REGION.x && x1 <= PANEL_ROW_REGION.x + PANEL_ROW_REGION.w,
      `${name}: 卡片行 x ${x0.toFixed(3)}~${x1.toFixed(3)} 超出搜索区 ` +
        `${PANEL_ROW_REGION.x}~${(PANEL_ROW_REGION.x + PANEL_ROW_REGION.w).toFixed(2)}`,
    );
  }
});

test('搜索区：纵向（帧高比例，与纵横比无关）也包得住实测 0.179~0.666', () => {
  const y0 = 0.179;
  const y1 = 0.666;
  assert.ok(y0 >= PANEL_ROW_REGION.y);
  assert.ok(y1 <= PANEL_ROW_REGION.y + PANEL_ROW_REGION.h);
});

test('搜索区：水平居中（面板是居中的，换分辨率仍居中）', () => {
  const center = PANEL_ROW_REGION.x + PANEL_ROW_REGION.w / 2;
  assert.ok(Math.abs(center - 0.5) < 1e-9, `中心应在 0.5，实得 ${center}`);
});
