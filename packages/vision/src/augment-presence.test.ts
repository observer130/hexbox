/**
 * 「面板仍在」独立信号的测试
 *
 * 锁的是**这一次真机回归的形状**（2026-10-06）：
 *   翻牌动画里**卡片判据失效**（内部/对比/结构任何一条挂掉），
 *   但面板这个 UI 元素**还在屏上**（卡片上下缘两条亮带仍在原处）
 *   → `detectPanelPresence()` 必须仍然说"在"。
 *
 * 真机标定表（各帧的实测值）见 `augment-presence.ts` 文件头；
 * 这里用合成位图锁**逻辑与余量**（真机帧不入库）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  NO_PANEL_PRESENCE,
  PANEL_PRESENCE_REGION,
  PANEL_PRESENCE_THRESHOLDS,
  detectPanelPresence,
  detectPanelPresenceInRegions,
} from './augment-presence.ts';
import { PANEL_ROW_REGION, detectAugmentPanel } from './augment-panel.ts';
import type { Bitmap, Rect } from './types.ts';

const W = 800;
const H = 450;

/** 实测卡片几何（归一化）：三张等宽卡横排在屏幕中部。 */
const CARD_XS = [0.298, 0.441, 0.584] as const;
const CARD_W = 0.115;
const CARD_Y = 0.2;
const CARD_H = 0.36;

function blank(v: number): Bitmap {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
  }
  return { width: W, height: H, data };
}

function fill(bmp: Bitmap, r: Rect, v: number): void {
  const x0 = Math.max(0, Math.round(r.x * W));
  const y0 = Math.max(0, Math.round(r.y * H));
  const x1 = Math.min(W, Math.round((r.x + r.w) * W));
  const y1 = Math.min(H, Math.round((r.y + r.h) * H));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      bmp.data[i] = v;
      bmp.data[i + 1] = v;
      bmp.data[i + 2] = v;
      bmp.data[i + 3] = 255;
    }
  }
}

/** 画一张卡片：内部 `interior`，边框环 `edge`（厚度 px）。 */
function drawCard(bmp: Bitmap, r: Rect, interior: number, edge: number, thickness = 6): void {
  fill(bmp, r, edge);
  fill(
    bmp,
    {
      x: r.x + thickness / W,
      y: r.y + thickness / H,
      w: r.w - (2 * thickness) / W,
      h: r.h - (2 * thickness) / H,
    },
    interior,
  );
}

interface FrameSpec {
  readonly xs?: readonly number[];
  readonly interior?: number;
  readonly edge?: number;
  readonly cardY?: number;
  readonly cardH?: number;
  readonly bg?: number;
}

function makeFrame(spec: FrameSpec = {}): Bitmap {
  // ⚠️ 背景默认 60（**低于 `brightLuma=110`**）：真机上面板周围是游戏画面，
  // 区域亮像素占比只有 6%~10% —— "亮的只有卡边框"。合成帧若用亮背景（比如 120），
  // 整片背景自己就算亮，行占比会恒等于 1，测试就测不到判据本身了（踩过）。
  const bmp = blank(spec.bg ?? 60);
  for (const x of spec.xs ?? CARD_XS) {
    drawCard(
      bmp,
      { x, y: spec.cardY ?? CARD_Y, w: CARD_W, h: spec.cardH ?? CARD_H },
      spec.interior ?? 25,
      spec.edge ?? 200,
    );
  }
  return bmp;
}

/**
 * 在**搜索区归一化**的 y 上画一条横贯搜索区的亮线（模拟"别的 UI 恰好有两条亮线"）。
 *
 * 坐标按搜索区（帧的 y 0.10~0.76）换算 —— 直接给帧坐标很容易画到搜索区**外面**
 * （那样检测器根本扫不到，测试就变成了"什么都没画"）。
 */
function drawBrightRowAtRegionY(bmp: Bitmap, regionY: number, v = 220, rows = 2): void {
  const frameY = PANEL_PRESENCE_REGION.y + regionY * PANEL_PRESENCE_REGION.h;
  fill(bmp, { x: 0, y: frameY, w: 1, h: rows / H }, v);
}

/* ------------------------------------------------------------------ */
/* 几何一致性                                                          */
/* ------------------------------------------------------------------ */

test('PANEL_PRESENCE_REGION 与卡片判据的搜索区**同值**（两处必须看同一块区）', () => {
  // 刻意在两个模块里各写一份常量（"独立信号"不 import 检测器的任何东西），
  // 但值必须一致：不然会出现"卡片判据看一块、面板信号看另一块"。
  assert.deepEqual(PANEL_PRESENCE_REGION, PANEL_ROW_REGION);
});

/* ------------------------------------------------------------------ */
/* 真阳性：翻牌期间卡片判据失效，但面板还在                              */
/* ------------------------------------------------------------------ */

test('detectPanelPresence：正常面板帧（内部暗）→ 面板仍在，且亮带落在**卡片上下缘**那一档', () => {
  const bmp = makeFrame();
  const det = detectAugmentPanel(bmp);
  const p = detectPanelPresence(bmp);
  assert.equal(det.found, true, det.reason);
  assert.equal(p.present, true, p.reason);
  assert.ok(p.topFrac >= PANEL_PRESENCE_THRESHOLDS.minBorderRowFrac, p.reason);
  assert.ok(p.bottomFrac >= PANEL_PRESENCE_THRESHOLDS.minBorderRowFrac, p.reason);
  // 上缘 ≈ (0.20×450 − 45)/297 = 0.15；下缘 ≈ (0.56×450 − 45)/297 = 0.70
  assert.ok(p.topRow !== null && p.topRow > 0.05 && p.topRow < 0.35, p.reason);
  assert.ok(p.bottomRow !== null && p.bottomRow > 0.6 && p.bottomRow < 0.8, p.reason);
  assert.ok(p.topProminence >= PANEL_PRESENCE_THRESHOLDS.minLineProminence, p.reason);
});

test('detectPanelPresence：**卡片内部变亮**（内容切换/翻牌中间帧）→ 卡片判据失效，但面板信号仍在', () => {
  // 这就是 2026-10-06 回归的判据形状：`detectAugmentPanel` 因为没有"内部暗"而拒绝，
  // 而面板（卡片上下缘亮带）一直在屏上 —— 门控绝不能因此判关闭。
  const bmp = makeFrame({ interior: 120, edge: 200 });
  const det = detectAugmentPanel(bmp);
  const p = detectPanelPresence(bmp);
  assert.equal(det.found, false, '内部亮 → 卡片判据必须依旧拒绝');
  assert.match(det.reason, /内部不够暗/);
  assert.equal(p.present, true, p.reason);
});

test('detectPanelPresence：**卡片列结构没了**（真机翻牌中间帧的形状：只剩上下缘亮带）→ 卡片判据失效，面板信号仍在', () => {
  // 真机 `timeline.csv` 里翻牌那几帧的判据原文是「卡片数 0（无重复出现的卡片宽度
  // （全是孤立噪声））」—— 也就是**纵向的卡片列结构**没了（bands 6 → 4）。
  // 这里就按那个形状造帧：只画每张卡的上下缘亮线，不画左右竖边。
  // ⚠️ 仓库里没有真的动画帧（`debug/augment/*.png` 是探错窗口的客户端截图），
  //    所以这是**形状近似**，不是实测；真正的兜底是门控的"双信号 + 3 帧"。
  const bmp = blank(60);
  for (const x of CARD_XS) {
    fill(bmp, { x, y: CARD_Y, w: CARD_W, h: 6 / H }, 200);
    fill(bmp, { x, y: CARD_Y + CARD_H - 6 / H, w: CARD_W, h: 6 / H }, 200);
  }
  const det = detectAugmentPanel(bmp);
  const p = detectPanelPresence(bmp);
  assert.equal(det.found, false, '没有竖边 → 卡片判据必须拒绝');
  assert.match(det.reason, /卡片数 0/);
  assert.equal(p.present, true, p.reason);
});

test('detectPanelPresence：边框对比不足（暗场景里结构还在）→ 卡片判据失效，面板信号仍在', () => {
  // 卡片判据要求「内部 < 40 **且** 边框−内部 ≥ 70」；这里内部 30（够暗）、
  // 边框 90（< 110 不算"亮"）—— 卡片判据因对比拒绝，但把亮阈值降到 60 后
  // 上下缘就是两条亮带。用自定义阈值来锁"这两个判据是**分开**的"。
  const bmp = makeFrame({ bg: 15, interior: 30, edge: 90 });
  const det = detectAugmentPanel(bmp);
  assert.equal(det.found, false, det.reason);
  assert.match(det.reason, /对比不够/);
  const p = detectPanelPresence(bmp, PANEL_PRESENCE_REGION, {
    ...PANEL_PRESENCE_THRESHOLDS,
    brightLuma: 60,
  });
  assert.equal(p.present, true, p.reason);
});

test('detectPanelPresence：上下缘各让一格（动画里卡片"长大/上移"，实测 Δy 0.015 / Δh 0.028）也在容差内', () => {
  const bmp = makeFrame({ cardY: CARD_Y - 0.015, cardH: CARD_H + 0.028 });
  const p = detectPanelPresence(bmp);
  assert.equal(p.present, true, p.reason);
});

test('detectPanelPresence：采样步长（xStep）不改变判定（离线省时间用）', () => {
  const bmp = makeFrame();
  const a = detectPanelPresence(bmp, PANEL_PRESENCE_REGION, {
    ...PANEL_PRESENCE_THRESHOLDS,
    xStep: 1,
  });
  const b = detectPanelPresence(bmp, PANEL_PRESENCE_REGION, {
    ...PANEL_PRESENCE_THRESHOLDS,
    xStep: 4,
  });
  assert.equal(a.present, true, a.reason);
  assert.equal(b.present, true, b.reason);
});

test('detectPanelPresenceInRegions：主区未命中时用备用区（与卡片判据同一套回退语义）', () => {
  const bmp = makeFrame();
  const wrong: Rect = { x: 0.9, y: 0.9, w: 0.05, h: 0.05 };
  const hit = detectPanelPresenceInRegions(bmp, [wrong, PANEL_PRESENCE_REGION]);
  assert.equal(hit.presence.present, true, hit.presence.reason);
  assert.equal(hit.regionIndex, 1);
  const miss = detectPanelPresenceInRegions(blank(120), [PANEL_PRESENCE_REGION]);
  assert.equal(miss.presence.present, false);
  assert.equal(miss.regionIndex, -1);
});

/* ------------------------------------------------------------------ */
/* 真阴性（价值所在）                                                   */
/* ------------------------------------------------------------------ */

test('detectPanelPresence：整片亮背景（均匀）→ 不在（**线**判据，不是亮度判据）', () => {
  // 亮背景（120/200）会让上/下搜索区各有一行占比 1.0、跨度也恰好落在卡高档；
  // 但那是"整片亮"，不是"两条细亮线" → 突出量 ≈ 0 → 必须否掉。
  for (const v of [0, 60, 120, 200, 255]) {
    const p = detectPanelPresence(blank(v));
    assert.equal(p.present, false, `亮度 ${v}: ${p.reason}`);
  }
  assert.match(detectPanelPresence(blank(200)).reason, /不突出|没有卡片/);
});

test('detectPanelPresence：卡片没有亮边框（暗色地图结构）→ 不在', () => {
  const p = detectPanelPresence(makeFrame({ bg: 30, interior: 25, edge: 40 }));
  assert.equal(p.present, false, p.reason);
});

test('detectPanelPresence：只有一条亮线（缺一条缘）→ 不在', () => {
  const onlyTop = blank(60);
  drawBrightRowAtRegionY(onlyTop, 0.15);
  const p = detectPanelPresence(onlyTop);
  assert.equal(p.present, false, p.reason);
  assert.match(p.reason, /下半区没有/);
});

test('detectPanelPresence：两条亮线**挨得太近**（跨度不在卡高档）→ 不在', () => {
  // 防止"别的 UI 恰好有两条亮线"被当成卡片上下缘。
  // 两条线都要落在搜索区里、且各自在上下半区（0.20 / 0.57），跨度 0.37 < 0.40。
  const bmp = blank(60);
  drawBrightRowAtRegionY(bmp, 0.2);
  drawBrightRowAtRegionY(bmp, 0.57);
  const p = detectPanelPresence(bmp);
  assert.equal(p.present, false, p.reason);
  assert.match(p.reason, /跨度/);
});

test('detectPanelPresence：两条亮线**离得太远**（超出卡高档）→ 不在', () => {
  const bmp = blank(60);
  drawBrightRowAtRegionY(bmp, 0.02);
  drawBrightRowAtRegionY(bmp, 0.98);
  const p = detectPanelPresence(bmp);
  assert.equal(p.present, false, p.reason);
  assert.match(p.reason, /跨度/);
});

test('detectPanelPresence：搜索区越界 → 不在（不抛异常）', () => {
  const p = detectPanelPresence(makeFrame(), { x: 0.95, y: 0.95, w: 0.6, h: 0.6 });
  assert.equal(p.present, false, p.reason);
  assert.match(p.reason, /越界/);
});

test('NO_PANEL_PRESENCE：按"不在"处理（旧渲染端不报信号 = 与接线前行为一致）', () => {
  assert.equal(NO_PANEL_PRESENCE.present, false);
  assert.equal(NO_PANEL_PRESENCE.topRow, null);
});
