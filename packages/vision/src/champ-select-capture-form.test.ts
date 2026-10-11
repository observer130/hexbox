/**
 * 选人阶段「截屏形态」候选与形态选择（回归锁）
 *
 * 锁的是本机真机帧复现出来的那个整链路失效：
 * **16:9 显示器 + 默认 1600×900 客户端窗口**下，`snapshotKind` 的"三者同比"退化
 * 判据把**窗口快照**判成**显示器快照** → 搜索区被缩到 0.083+0.833、
 * 标定几何偏 90~130px → 候选卡 0 张、顶栏一格认不出。
 *
 * 所以本文件有两个职责：
 *   1. 把"退化判据会误判"这件事**钉死在测试里**（前提交代清楚，
 *      别让后来人以为 `champSelectCaptureForms` 是多余的）；
 *   2. 锁"主形态 = 窗口、证据优先、region 与 geo 同源"这几条不变量。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  champSelectCaptureForms,
  chooseChampSelectCaptureForm,
  type CaptureFormReading,
} from './champ-select-capture-form.ts';
import { makeScreenGeometry, snapshotKind } from './win-geometry.ts';
import type { Rect } from './types.ts';

/* ------------------------------------------------------------------ */
/* 两组真机几何（都来自本机记录）                                        */
/* ------------------------------------------------------------------ */

/** 选人截屏 = 客户端窗口内容 3413×1920（窗口 1600×900 的等比放大）。 */
const CAPTURE = { width: 3413, height: 1920 } as const;

/** 本机：3440×1440@150% → 逻辑 2293×960（21:9），窗口 1600×900@347,6。 */
const DEV_DISPLAY = {
  bounds: { x: 0, y: 0, width: 2293, height: 960 },
  scaleFactor: 1.5,
  workArea: { x: 0, y: 0, width: 2293, height: 912 },
};
const DEV_WINDOW = { x: 347, y: 6, width: 1600, height: 900 };

/** 16:9 显示器（最常见的组合）：1920×1080@100%，客户端窗口用默认 1600×900。 */
const WIDE16_9_DISPLAY = {
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  scaleFactor: 1,
  workArea: { x: 0, y: 0, width: 1920, height: 1032 },
};
const WIDE16_9_WINDOW = { x: 160, y: 90, width: 1600, height: 900 };

const IDENTITY: Rect = { x: 0, y: 0, w: 1, h: 1 };

function rectEq(a: Rect, b: Rect, eps = 1e-9): boolean {
  return (
    Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps &&
    Math.abs(a.w - b.w) < eps && Math.abs(a.h - b.h) < eps
  );
}

/* ------------------------------------------------------------------ */
/* 前提：退化判据确实会误判（这就是要两个形态都试的原因）                 */
/* ------------------------------------------------------------------ */

test('前提：16:9 显示器 + 默认窗口 → 自动判据判成 display（误判）', () => {
  const auto = snapshotKind(
    CAPTURE,
    { width: 1920, height: 1080 },
    WIDE16_9_WINDOW,
    WIDE16_9_WINDOW.width / 1920,
  );
  assert.equal(auto, 'display', '三方同比时退化判据只能靠 winShare 猜 —— 这正是 bug 的来源');

  // 而同一组几何下强制按"窗口快照"处理时，区域是恒等（= 真机帧实际的样子）
  const forms = champSelectCaptureForms(CAPTURE, WIDE16_9_WINDOW, WIDE16_9_DISPLAY);
  assert.equal(forms[0]!.form, 'window');
  assert.ok(rectEq(forms[0]!.region, IDENTITY), '窗口形态的区域必须是恒等');
});

test('前提：本机（21:9）自动判据判成 window —— 所以本机看不到这个 bug', () => {
  const auto = snapshotKind(
    CAPTURE,
    { width: 3440, height: 1440 },
    DEV_WINDOW,
    DEV_WINDOW.width / 2293,
  );
  assert.equal(auto, 'window');
});

/* ------------------------------------------------------------------ */
/* 形态候选                                                            */
/* ------------------------------------------------------------------ */

test('候选：16:9 显示器 → 两个形态都要试，display 形态把窗口缩到 0.083+0.833', () => {
  const forms = champSelectCaptureForms(CAPTURE, WIDE16_9_WINDOW, WIDE16_9_DISPLAY);
  assert.deepEqual(forms.map((f) => f.form), ['window', 'display']);

  const win = forms[0]!;
  assert.ok(rectEq(win.region, IDENTITY));
  // 窗口形态：屏幕坐标 = 窗口原点 + 归一化 × 窗口尺寸
  assert.equal(win.geo.windowX, 160);
  assert.equal(win.geo.windowY, 90);
  assert.equal(win.geo.windowWidth, 1600);
  assert.equal(win.geo.windowHeight, 900);

  const disp = forms[1]!;
  assert.ok(rectEq(disp.region, { x: 160 / 1920, y: 90 / 1080, w: 1600 / 1920, h: 900 / 1080 }));
  // 显示器形态：窗口只占显示器一块 → 基准被拉到显示器原点/整块显示器
  assert.equal(disp.geo.windowX, 0);
  assert.equal(disp.geo.windowWidth, 1920);
});

test('候选：本机（21:9）→ 两个形态的区域不同（备形态是平移缩放，不是恒等）', () => {
  const forms = champSelectCaptureForms(CAPTURE, DEV_WINDOW, DEV_DISPLAY);
  assert.deepEqual(forms.map((f) => f.form), ['window', 'display']);
  assert.ok(rectEq(forms[0]!.region, IDENTITY));
  assert.ok(
    rectEq(forms[1]!.region, {
      x: 347 / 2293,
      y: 6 / 960,
      w: 1600 / 2293,
      h: 900 / 960,
    }),
  );
});

test('候选：窗口铺满显示器 → 两个形态几何等价，只留一个', () => {
  const display = {
    bounds: { x: 0, y: 0, width: 1600, height: 900 },
    scaleFactor: 1,
    workArea: { x: 0, y: 0, width: 1600, height: 900 },
  };
  const forms = champSelectCaptureForms(CAPTURE, { x: 0, y: 0, width: 1600, height: 900 }, display);
  assert.deepEqual(forms.map((f) => f.form), ['window'], '等价形态不该白试第二遍');
});

test('候选：拿不到窗口矩形 → 单个候选 + 标记为"推断几何"', () => {
  const forms = champSelectCaptureForms(CAPTURE, null, WIDE16_9_DISPLAY);
  assert.equal(forms.length, 1);
  assert.equal(forms[0]!.form, 'window');
  assert.ok(rectEq(forms[0]!.region, IDENTITY));
  assert.equal(forms[0]!.estimated, true);
});

test('候选：region 与 geo 同源（形态错了两个一起错，绝不一半一半）', () => {
  for (const [display, win] of [
    [WIDE16_9_DISPLAY, WIDE16_9_WINDOW],
    [DEV_DISPLAY, DEV_WINDOW],
  ] as const) {
    for (const view of champSelectCaptureForms(CAPTURE, win, display)) {
      // 用同一形态单独算一遍，必须与候选里给出的完全一致
      const geo = makeScreenGeometry(CAPTURE, win, display, view.form);
      assert.equal(view.geo.windowX, geo.geo.windowX);
      assert.equal(view.geo.windowWidth, geo.geo.windowWidth);
      assert.equal(view.geo.windowHeight, geo.geo.windowHeight);
      assert.equal(view.estimated, geo.estimated);
    }
  }
});

/* ------------------------------------------------------------------ */
/* 形态选择：判据强弱 = 顶栏认出 > 候选卡判据全过 > 主形态                 */
/* ------------------------------------------------------------------ */

function reading(
  form: 'window' | 'display',
  occupied: number,
  identified: number,
  cardsConfident: boolean,
): CaptureFormReading {
  return { form, occupied, identified, cardsConfident };
}

test('选择：主形态就认出来了 → 用主形态（常态，零额外成本）', () => {
  const picked = chooseChampSelectCaptureForm([
    reading('window', 1, 1, false),
    reading('display', 10, 0, false),
  ]);
  assert.equal(picked.form, 'window');
});

test('选择：主形态认出 1 格 → 用主形态；主形态"占用 10 但识别 0" → 让位给备形态', () => {
  // 本机（21:9）：主形态就对
  const onDev = chooseChampSelectCaptureForm([
    reading('window', 1, 1, false),
    reading('display', 10, 0, false),
  ]);
  assert.equal(onDev.form, 'window');

  // 16:9 那一组：错形态的占用是**噪声**（实测能到 10 格）而识别恒为 0 ——
  // 所以判据必须看**识别**，不能看占用
  const onWide = chooseChampSelectCaptureForm([
    reading('window', 10, 0, false),
    reading('display', 1, 1, false),
  ]);
  assert.equal(onWide.form, 'display');
});

test('选择：都没认出时，候选卡判据全过的形态胜出（第一阶段的证据）', () => {
  const picked = chooseChampSelectCaptureForm([
    reading('window', 0, 0, false),
    reading('display', 0, 0, true),
  ]);
  assert.equal(picked.form, 'display');
});

test('选择：一点证据都没有 → 主形态 + 如实说明', () => {
  const picked = chooseChampSelectCaptureForm([
    reading('window', 0, 0, false),
    reading('display', 6, 0, false),
  ]);
  assert.equal(picked.form, 'window');
  assert.match(picked.reason, /没有内容证据/);
});

test('选择：两个形态都认出来 → 取认得更多的那个', () => {
  const picked = chooseChampSelectCaptureForm([
    reading('window', 1, 1, false),
    reading('display', 3, 3, false),
  ]);
  assert.equal(picked.form, 'display');
});

test('选择：平手 → 主形态优先（顺序即优先级）', () => {
  const picked = chooseChampSelectCaptureForm([
    reading('window', 2, 2, false),
    reading('display', 2, 2, false),
  ]);
  assert.equal(picked.form, 'window');
});

test('选择：候选卡在多个形态都全过 → 取靠前的（主形态优先）', () => {
  const picked = chooseChampSelectCaptureForm([
    reading('window', 0, 0, true),
    reading('display', 0, 0, true),
  ]);
  assert.equal(picked.form, 'window');
});

test('选择：空读数不抛错（主进程不许因为这个崩）', () => {
  const picked = chooseChampSelectCaptureForm([]);
  assert.equal(picked.form, 'window');
});
