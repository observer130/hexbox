/**
 * 局内海克斯面板门控测试
 *
 * 用**合成位图**验证判据本身：3 张"内部近黑 + 边框亮"的等宽卡片横排在屏幕中部
 * 才算面板；内部亮（选人界面那种美术立绘）或边框不亮（游戏画面里的地图结构）
 * 一律拒绝。
 *
 * ⚠️ 阈值本身来自**真机帧标定**（见 augment-panel.ts 文件头与
 * docs/AUGMENT-PANEL.md）：面板帧内部 25~29 / 边框 151~158，
 * 游戏画面与选人界面内部 ≥52 / 边框 ≤108。本文件的断言锁"逻辑与余量"，
 * 不锁具体数值。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PANEL_CLOSE_CONFIRM_FRAMES,
  PANEL_PRESENCE_TRUST_FRAMES,
  PANEL_ROW_REGION,
  PANEL_THRESHOLDS,
  createPanelTracker,
  cropBitmap,
  detectAugmentPanel,
  panelGateEvidence,
  type PanelThresholds,
} from './augment-panel.ts';
import { detectPanelPresence } from './augment-presence.ts';
import { panelRowRectInCapture } from './augment-region.ts';
import type { Bitmap, Rect } from './types.ts';

/* ------------------------------------------------------------------ */
/* 合成位图工具                                                        */
/* ------------------------------------------------------------------ */

const W = 800;
const H = 450;

/** 实测卡片几何（归一化，来自真机帧）：3 张等宽卡横排在屏幕中部。 */
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

function putPx(bmp: Bitmap, x: number, y: number, v: number): void {
  if (x < 0 || y < 0 || x >= bmp.width || y >= bmp.height) return;
  const i = (y * bmp.width + x) * 4;
  bmp.data[i] = v;
  bmp.data[i + 1] = v;
  bmp.data[i + 2] = v;
  bmp.data[i + 3] = 255;
}

function fill(bmp: Bitmap, r: Rect, v: number): void {
  const x0 = Math.round(r.x * W);
  const y0 = Math.round(r.y * H);
  const x1 = Math.round((r.x + r.w) * W);
  const y1 = Math.round((r.y + r.h) * H);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) putPx(bmp, x, y, v);
}

/** 画一张卡片：内部 `interior`，边框环 `edge`（厚度 px）。 */
function drawCard(bmp: Bitmap, r: Rect, interior: number, edge: number, thickness = 6): void {
  fill(bmp, r, edge);
  const inner: Rect = {
    x: r.x + thickness / W,
    y: r.y + thickness / H,
    w: r.w - (2 * thickness) / W,
    h: r.h - (2 * thickness) / H,
  };
  fill(bmp, inner, interior);
}

interface FrameSpec {
  /** 卡片横向位置（默认实测位置）。 */
  readonly xs?: readonly number[];
  /** 卡片内部亮度。 */
  readonly interior?: number;
  /** 卡片边框亮度。 */
  readonly edge?: number;
  /** 卡片高度（归一化）。 */
  readonly cardH?: number;
  /** 背景亮度（模拟游戏画面）。 */
  readonly bg?: number;
}

function makeFrame(spec: FrameSpec = {}): Bitmap {
  const bmp = blank(spec.bg ?? 120);
  for (const x of spec.xs ?? CARD_XS) {
    drawCard(
      bmp,
      { x, y: CARD_Y, w: CARD_W, h: spec.cardH ?? CARD_H },
      spec.interior ?? 25,
      spec.edge ?? 200,
    );
  }
  return bmp;
}

/* ------------------------------------------------------------------ */
/* 几何                                                                */
/* ------------------------------------------------------------------ */

test('panelRowRectInCapture：拿不到窗口矩形时退化为恒等（window 形态截屏）', () => {
  const r = panelRowRectInCapture({ width: W, height: H }, null, {
    bounds: { x: 0, y: 0, width: W, height: H },
    scaleFactor: 1,
  });
  assert.deepEqual(r, PANEL_ROW_REGION);
});

test('cropBitmap：越界或空尺寸返回 null（不抛异常）', () => {
  const bmp = makeFrame();
  assert.equal(cropBitmap(bmp, { x: 0.9, y: 0.9, w: 0.5, h: 0.5 }), null);
  assert.equal(cropBitmap(bmp, { x: 0, y: 0, w: 0, h: 0.5 }), null);
  const ok = cropBitmap(bmp, { x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
  assert.ok(ok !== null);
  assert.equal(ok.width, Math.round(0.2 * W));
});

/* ------------------------------------------------------------------ */
/* 真阳性                                                              */
/* ------------------------------------------------------------------ */

test('detectAugmentPanel：3 张「内部暗 + 边框亮」的等宽卡 → 认定面板', () => {
  const det = detectAugmentPanel(makeFrame());
  assert.equal(det.found, true, det.reason);
  assert.equal(det.cards.length, 3, det.reason);
  // 卡片位置应落在实测几何附近（±0.03 归一化）
  for (const [i, card] of det.cards.entries()) {
    const expected = CARD_XS[i]!;
    assert.ok(
      Math.abs(card.rect.x - expected) < 0.03,
      `第 ${i + 1} 张卡 x=${card.rect.x.toFixed(3)} 应≈${expected}`,
    );
    assert.ok(card.interiorLuma < PANEL_THRESHOLDS.interiorMax);
    assert.ok(card.edgeLuma - card.interiorLuma >= PANEL_THRESHOLDS.contrastMin);
  }
});

test('detectAugmentPanel：2 张卡也认（重随/动画中间帧可能只重建出 2 张）', () => {
  const det = detectAugmentPanel(makeFrame({ xs: [CARD_XS[0], CARD_XS[1]] }));
  assert.equal(det.found, true, det.reason);
  assert.equal(det.cards.length, 2);
});

/* ------------------------------------------------------------------ */
/* 假阳性（这几条是真正的价值所在）                                       */
/* ------------------------------------------------------------------ */

test('detectAugmentPanel：卡片内部是亮的（选人界面美术立绘）→ 拒绝', () => {
  const det = detectAugmentPanel(makeFrame({ interior: 120, edge: 200 }));
  assert.equal(det.found, false, det.reason);
  assert.match(det.reason, /内部不够暗/);
});

test('detectAugmentPanel：内部够暗但边框不够亮（暗色地图结构）→ 拒绝', () => {
  // 暗场景（bg 15）：结构能检出（边框 90 明显亮于背景），内部也够暗（25），
  // 但「边框 − 内部」只有 65 < 70 —— 面板实测是 92~129。必须拒绝。
  // 这一条锁的是"两道判据都在"：只有内部亮度是不够的。
  const det = detectAugmentPanel(makeFrame({ bg: 15, interior: 25, edge: 90 }));
  assert.equal(det.found, false, det.reason);
  assert.match(det.reason, /对比不够/);
});

test('detectAugmentPanel：卡片太矮（细长条结构）→ 拒绝', () => {
  const det = detectAugmentPanel(makeFrame({ cardH: 0.12 }));
  assert.equal(det.found, false, det.reason);
});

test('detectAugmentPanel：卡片超过 3 张（多列网格，如商店）→ 拒绝', () => {
  const xs = [0.22, 0.335, 0.45, 0.565, 0.68];
  const det = detectAugmentPanel(makeFrame({ xs }));
  assert.equal(det.found, false, det.reason);
  assert.match(det.reason, /卡片数/);
});

test('detectAugmentPanel：纯色画面（无结构）→ 拒绝且不抛异常', () => {
  const det = detectAugmentPanel(blank(100));
  assert.equal(det.found, false, det.reason);
});

test('detectAugmentPanel：整幅全黑/全白也不误判', () => {
  for (const v of [0, 255]) {
    const det = detectAugmentPanel(blank(v));
    assert.equal(det.found, false, `亮度 ${v}: ${det.reason}`);
  }
});

/* ------------------------------------------------------------------ */
/* 状态机                                                              */
/* ------------------------------------------------------------------ */

test('tracker：连续 2 帧命中才开；关闭要连续 3 帧"两个信号都不在"（旧阈值 2 帧会被翻牌动画穿过）', () => {
  const tracker = createPanelTracker();
  const panel = makeFrame();
  /**
   * ⚠️ "面板没了"的帧 = **那排卡片整个不在了**（只剩游戏画面）。
   *
   * 不能用"卡片内部变亮"来当负样本：按新语义那属于**面板仍在**
   * （卡面在动而已，正是要保护的那一类，见下面的回归用例）。
   */
  const gone = makeFrame({ xs: [], bg: 90 });

  const a = tracker.pushBitmap(panel);
  assert.equal(a.state, 'closed');
  assert.equal(a.edge, null);
  assert.equal(a.hits, 1);

  const b = tracker.pushBitmap(panel);
  assert.equal(b.state, 'open');
  assert.equal(b.edge, 'open');
  assert.equal(b.cards.length, 3);

  // 面板期间"重随"（卡面变但结构不变）不产生任何边沿
  const reroll = tracker.pushBitmap(makeFrame());
  assert.equal(reroll.state, 'open');
  assert.equal(reroll.edge, null);

  const c = tracker.pushBitmap(gone);
  assert.equal(c.state, 'open', '单帧未命中不立刻关');
  assert.equal(c.edge, null);
  const d = tracker.pushBitmap(gone);
  assert.equal(d.edge, null, '第 2 帧未命中还不关（旧阈值 2 帧 = 0.8 秒，会被翻牌动画穿过）');
  assert.equal(d.state, 'open');
  assert.equal(d.misses, 2);
  const e = tracker.pushBitmap(gone);
  assert.equal(e.edge, 'close', '第 3 帧才算关闭（400ms 采样 = 1.2 秒）');
  assert.equal(e.state, 'closed');
  assert.equal(tracker.pushBitmap(gone).edge, null, 'close 边沿只报一次');
});

test('tracker：翻牌动画里卡片判据连续失效但**面板信号仍在** → 不判关闭（2026-10-06 回归）', () => {
  // 真机 `timeline.csv`：32524 命中 → 32930/33333/33612/33862 连续失效（翻牌，1178ms）
  // → 34108 又命中。旧阈值 2 帧（0.8 秒）会在这中间判"关闭" → 清标签 + 关截屏
  // → 那块面板永久空白。这里锁"面板信号仍在时不得关闭"。
  const tracker = createPanelTracker();
  const panel = makeFrame({ bg: 60 });
  // 翻牌中间帧的形状：卡面在动（内容变亮 → 卡片判据失效），但上下缘亮带还在。
  const flipping = makeFrame({ bg: 60, interior: 130, edge: 200 });
  const flipDet = detectAugmentPanel(flipping);
  const flipPresence = detectPanelPresence(flipping);
  assert.equal(flipDet.found, false, '构造前提：卡片判据必须失效');
  assert.ok(/内部不够暗|卡片数/.test(flipDet.reason), flipDet.reason);
  assert.equal(flipPresence.present, true, flipPresence.reason);

  tracker.pushBitmap(panel);
  assert.equal(tracker.pushBitmap(panel).edge, 'open');

  for (let i = 1; i <= 4; i++) {
    const r = tracker.push(flipDet, flipPresence);
    assert.equal(r.edge, null, `第 ${i} 帧卡片判据失效不得产生关闭边沿`);
    assert.equal(r.state, 'open', `第 ${i} 帧状态必须保持 open`);
    assert.equal(r.misses, 0, '有面板信号托底时不得计入未命中');
    assert.equal(r.presenceHolds, i);
  }

  // 面板其实还在：下一次命中即恢复（标签从未被清）
  const back = tracker.pushBitmap(panel);
  assert.equal(back.state, 'open');
  assert.equal(back.edge, null);
  assert.equal(back.presenceHolds, 0, '重新命中后托底计数复位');
});

test('tracker：托底额度（5 帧）用完 → 未命中照常累计并关闭（额度必须有上限）', () => {
  // 防止"面板信号误报 → 标签永远不消失"。
  const tracker = createPanelTracker();
  const panel = makeFrame({ bg: 60 });
  const flipping = makeFrame({ bg: 60, interior: 130, edge: 200 });
  const flipDet = detectAugmentPanel(flipping);
  const flipPresence = detectPanelPresence(flipping);
  const gone = detectAugmentPanel(makeFrame({ xs: [], bg: 60 }));
  assert.equal(flipPresence.present, true, flipPresence.reason);

  tracker.pushBitmap(panel);
  assert.equal(tracker.pushBitmap(panel).edge, 'open');

  for (let i = 1; i <= PANEL_PRESENCE_TRUST_FRAMES; i++) {
    assert.equal(tracker.push(flipDet, flipPresence).misses, 0, `第 ${i} 帧仍在托底`);
  }
  // 额度用完：即使面板信号还在说"在"，也不再托底
  const over = tracker.push(flipDet, flipPresence);
  assert.equal(over.misses, 1, '额度用完后未命中照常累计');
  assert.match(over.reason, /额度/);
  assert.equal(over.edge, null);
  assert.equal(tracker.push(gone, detectPanelPresence(makeFrame({ xs: [], bg: 60 }))).misses, 2);
  assert.equal(
    tracker.push(gone, detectPanelPresence(makeFrame({ xs: [], bg: 60 }))).edge,
    'close',
    '累计到 3 帧仍然要关（额度只影响托底，不影响关闭阈值）',
  );
});

test('tracker：reset 清空去抖计数', () => {
  const tracker = createPanelTracker();
  const panel = makeFrame();
  tracker.pushBitmap(panel); // hits=1
  tracker.reset();
  const after = tracker.pushBitmap(panel);
  assert.equal(after.state, 'closed', 'reset 后要重新攒 2 帧');
  assert.equal(after.hits, 1);
});

test('tracker：跨帧亮度剧变不再有"基线自锁"问题（真实 bug 回归）', () => {
  // 旧实现用 EMA 基线判"压暗"：若第一帧恰好是面板帧（暗），基线被播种成暗值，
  // 之后正常游玩更亮 → dimDrop 恒为负、门控永远不开。现在没有任何跨帧亮度状态。
  const tracker = createPanelTracker();
  const darkGameplay = makeFrame({ bg: 20, interior: 60, edge: 90, xs: [] });
  const brightGameplay = makeFrame({ bg: 200, interior: 120, edge: 90, xs: [] });
  const a = tracker.pushBitmap(darkGameplay);
  const b = tracker.pushBitmap(brightGameplay);
  assert.equal(a.state, 'closed');
  assert.equal(b.state, 'closed');
  assert.equal(b.edge, null);
  // 暗游戏画面之后的真面板照样能开
  const panel = makeFrame();
  tracker.pushBitmap(panel);
  assert.equal(tracker.pushBitmap(panel).edge, 'open');
});

test('tracker：自定义阈值可覆盖（标定期间试参数用）', () => {
  const strict: PanelThresholds = { ...PANEL_THRESHOLDS, contrastMin: 250 };
  const tracker = createPanelTracker({ thresholds: strict, openAfterHits: 1 });
  // ⚠️ 背景必须**暗**（60 < 亮阈值 110）：亮背景会被"线突出量"判据否掉
  // （整片亮不是两条细亮线），那样这条用例测的就不是"自定义阈值"了。
  const r = tracker.pushBitmap(makeFrame({ bg: 60 }));
  assert.equal(r.found, false);
  // reason 现在是**组合文本**（面板信号托底时会把判据原文接在后面）→ 用子串匹配：
  // 既要能看出"哪条判据挂了"，也要能看出"面板信号还在托底"。
  assert.match(r.reason, /对比不够/);
  assert.match(r.reason, /面板信号仍在/);
  assert.equal(r.presenceHolds, 1);
  assert.equal(r.misses, 0, '面板信号托底时不累计未命中');
});

test('tracker：可由渲染端上报的 PanelDetection 驱动（正式路径：检测在渲染端）', () => {
  // 生产路径是"渲染端 worker 检测 → 小 JSON 过 IPC → 主进程状态机"，
  // 因此 push() 必须直接吃 PanelDetection，不依赖位图。
  // 只传 detection（不给面板信号）= 与接线前完全一致：未命中照常累计。
  const tracker = createPanelTracker();
  const hit = detectAugmentPanel(makeFrame());
  const miss = detectAugmentPanel(makeFrame({ xs: [], bg: 90 }));

  assert.equal(tracker.push(hit).hits, 1, '第一帧只攒命中数');
  assert.equal(tracker.push(hit).edge, 'open');
  assert.equal(tracker.state, 'open');
  assert.equal(tracker.push(miss).state, 'open', '单帧未命中不关');
  assert.equal(tracker.push(miss).state, 'open', '两帧未命中还不关（新阈值 3 帧）');
  assert.equal(tracker.push(miss).edge, 'close');
  assert.equal(tracker.state, 'closed');
});

test('tracker：push 与 pushBitmap 结果一致（同一位图路径）', () => {
  const a = createPanelTracker({ openAfterHits: 1 });
  const b = createPanelTracker({ openAfterHits: 1 });
  const bmp = makeFrame();
  assert.deepEqual(a.push(detectAugmentPanel(bmp)), b.pushBitmap(bmp));
});

test('panelGateEvidence：关闭判定的依据一次打全（各信号连续次数 + 阈值 + 判据原文）', () => {
  // 用户报"面板开着、标签几秒后自己消失"时，日志里唯一能回答的就是这一行
  // —— 真机踩过：旧日志只有一句"面板消失 #1"，看不出门控凭什么这么判。
  const tracker = createPanelTracker();
  const panel = makeFrame({ bg: 60 });
  const gone = makeFrame({ xs: [], bg: 60 });
  tracker.pushBitmap(panel);
  assert.equal(tracker.pushBitmap(panel).edge, 'open');
  tracker.pushBitmap(gone);
  tracker.pushBitmap(gone);
  const closing = tracker.pushBitmap(gone);
  assert.equal(closing.edge, 'close');

  const line = panelGateEvidence(closing);
  assert.match(line, new RegExp(`未命中 ${PANEL_CLOSE_CONFIRM_FRAMES}/${PANEL_CLOSE_CONFIRM_FRAMES} 帧`));
  assert.match(line, new RegExp(`面板信号 0/${PANEL_PRESENCE_TRUST_FRAMES} 帧仍成立`));
  assert.match(line, /面板信号=不在/);
  assert.match(line, /阈值/);

  // 托底帧上也要说得出"这次为什么**不**关"
  const flipping = makeFrame({ bg: 60, interior: 130, edge: 200 });
  const held = tracker.push(detectAugmentPanel(flipping), detectPanelPresence(flipping));
  assert.equal(held.edge, null);
  assert.match(held.reason, /面板信号仍在/);
});
