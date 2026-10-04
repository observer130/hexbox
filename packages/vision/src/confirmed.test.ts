/**
 * confirmed 测试：顶栏槽位几何、占用检测、逐格识别
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  countOccupiedSlots,
  detectTopBarCandidates,
  isSlotOccupied,
  OCCUPANCY,
  topBarSlotRect,
  topBarSlotRects,
  TOP_BAR_ROW,
  type TopBarCandidate,
} from './confirmed.ts';
import { prepareTemplates } from './match.ts';
import type { Bitmap, Rect } from './types.ts';

/* ------------------------------------------------------------------ */
/* 工具                                                                 */
/* ------------------------------------------------------------------ */

/** 纯色位图。 */
function solidBitmap(w: number, h: number, gray: number): Bitmap {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = gray;
    data[i * 4 + 1] = gray;
    data[i * 4 + 2] = gray;
    data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}

/**
 * 构造一张「顶栏」位图：全部格子为暗底（空格）,
 * 其中 occupiedSlots 填入**与 twoTemplates 同款块结构**的纹理。
 *
 * 关键：纹理按 24×24 逻辑格铺满**整个**槽位矩形,格值与模板公式一致 ——
 * 这样 extractGray(rect, 24) 的面积平均几乎精确还原模板灰度,
 * 相似度 ≈ 1（模拟真机「方头像与模板同源」的最高可靠度场景）。
 * 真机占用格 std 60+ / 空格 <9 的区分度同样被满足。
 */
function topBarBitmap(
  scale: number,
  occupiedSlots: ReadonlyArray<{ slot: number; gray: number }>,
  w = Math.round(2400 * scale),
  h = Math.round(1350 * scale),
): Bitmap {
  const bmp = solidBitmap(w, h, 12);
  const setPx = (x: number, y: number, v: number): void => {
    const i = (y * w + x) * 4;
    bmp.data[i] = v;
    bmp.data[i + 1] = v;
    bmp.data[i + 2] = v;
  };
  const CELLS = 24;
  for (const { slot, gray } of occupiedSlots) {
    const r = topBarSlotRect(slot);
    const x0 = Math.round(r.x * w);
    const y0 = Math.round(r.y * h);
    const sw = Math.round(r.w * w);
    const sh = Math.round(r.h * h);
    for (let cy = 0; cy < CELLS; cy++) {
      for (let cx = 0; cx < CELLS; cx++) {
        const v = (gray + ((Math.floor(cx / 6) * 3 + Math.floor(cy / 6) * 7) % 4) * 50) % 256;
        const cx0 = x0 + Math.floor((cx * sw) / CELLS);
        const cx1 = x0 + Math.floor(((cx + 1) * sw) / CELLS);
        const cy0 = y0 + Math.floor((cy * sh) / CELLS);
        const cy1 = y0 + Math.floor(((cy + 1) * sh) / CELLS);
        for (let y = cy0; y < Math.max(cy0 + 1, cy1); y++) {
          for (let x = cx0; x < Math.max(cx0 + 1, cx1); x++) {
            setPx(x, y, v);
          }
        }
      }
    }
  }
  return bmp;
}

/** 两个模板：champion 1 = 亮纹理,champion 2 = 中灰纹理（粗块,同上）。 */
function twoTemplates(): ReturnType<typeof prepareTemplates> {
  const mk = (v: number): Uint8Array => {
    const g = new Uint8Array(24 * 24);
    for (let y = 0; y < 24; y++) {
      for (let x = 0; x < 24; x++) {
        g[y * 24 + x] = (v + (((Math.floor(x / 6) * 3) + Math.floor(y / 6) * 7) % 4) * 50) % 256;
      }
    }
    return g;
  };
  return prepareTemplates([
    { championId: 1, size: 24, gray: mk(150) },
    { championId: 2, size: 24, gray: mk(90) },
  ]);
}

/* ------------------------------------------------------------------ */
/* 几何                                                                 */
/* ------------------------------------------------------------------ */

test('topBarSlotRect：10 格且互不重叠、从左到右步进一致', () => {
  const rects = topBarSlotRects();
  assert.equal(rects.length, 10);
  for (let k = 0; k < 9; k++) {
    const a = rects[k]!;
    const b = rects[k + 1]!;
    const step = b.x - a.x;
    assert.ok(Math.abs(step - TOP_BAR_ROW.step) < 1e-9, `步进应一致: ${step}`);
    assert.ok(a.x + a.w <= b.x + 1e-9, `格 ${k} 与 ${k + 1} 不应重叠`);
  }
});

test('topBarSlotRect：越界序号抛错', () => {
  assert.throws(() => topBarSlotRect(-1));
  assert.throws(() => topBarSlotRect(10));
});

test('topBarSlotRect：x0 与真机校准值一致（防无意改动）', () => {
  // 2026-09-28 实测:第 1 格左缘 x=659/2400
  assert.ok(Math.abs(TOP_BAR_ROW.x0 - 659 / 2400) < 1e-9);
  assert.ok(Math.abs(TOP_BAR_ROW.y - 19 / 1350) < 1e-9);
});

test('2026-10-04 复核：预测槽位与真机截图像素级对齐', () => {
  // 两张真机图交叉验证（同一套归一化几何）：
  //   · champselect-locked-152419-raw.png（3413×1920，10 格全空）
  //   · phase2.png（2397×1346，第 1 格有头像）
  // 两张图的空格左缘都落在 0.2746（= 937/3413 与 657/2397），
  // 而**有头像的那一格也在 0.2746** —— 曾误以为它左移了一格，
  // 把行扩成 11 格，结果第 11 格落在"可用"**文字**上（幽灵格，
  // 一阶段也会判为占用）。此处锁死 10 格与首格位置，防止重演。
  const rects = topBarSlotRects();
  assert.equal(rects.length, 10);
  for (const W of [3413, 2397]) {
    const px = rects.map((r) => [Math.round(r.x * W), Math.round((r.x + r.w) * W)]);
    if (W === 3413) {
      assert.deepEqual(px[0], [937, 1069]);
      assert.deepEqual(px[9], [2345, 2477]);
    } else {
      assert.deepEqual(px[0], [658, 751], 'phase2.png 实测：头像格 px 658..751');
    }
  }
});

/* ------------------------------------------------------------------ */
/* 占用判定（多指标：真机实测阈值）                                     */
/* ------------------------------------------------------------------ */

test('countOccupiedSlots：真机"10 格全空"场景必须返回 0', () => {
  // phase1.png 实测：第一阶段顶栏 10 格全空（粗边缘占比 0.000）。
  // 若这里返回非 0，就会误判成第二阶段 —— 卡片胜率将永远不显示。
  const bmp = topBarBitmap(1, []);
  assert.equal(countOccupiedSlots(bmp, topBarSlotRects()), 0);
});

test('countOccupiedSlots：有头像的格子被计入（阶段判据）', () => {
  const bmp = topBarBitmap(1, [{ slot: 1, gray: 150 }]);
  assert.equal(countOccupiedSlots(bmp, topBarSlotRects()), 1);
});

test('OCCUPANCY 阈值夹在真机实测量值之间（防再次误判/漏判）', () => {
  // 2026-10-04 真机两阶段实测（按库内真实算法：16×16 网格 + 12% 内缩）：
  //   指标        空槽最大值   有头像
  //   grayVar     0.00101     0.02196
  //   chromaVar   0.00120     0.00698
  //   粗边缘占比  0.000       0.200
  // 阈值必须**高于空槽最大值**（否则空槽判占用 → 阶段错乱），
  // 同时**低于有头像值**（否则漏判 → 二阶段整格不显示）。
  const EMPTY_GRAY_VAR = 0.00101;
  const HERO_GRAY_VAR = 0.02196;
  const EMPTY_EDGE = 0;
  const HERO_EDGE = 0.2;
  assert.ok(OCCUPANCY.grayVar > EMPTY_GRAY_VAR, '灰度方差阈值应高于空槽上界');
  assert.ok(OCCUPANCY.grayVar < HERO_GRAY_VAR, '灰度方差阈值应低于有头像值');
  assert.ok(OCCUPANCY.edgeDensity > EMPTY_EDGE, '粗边缘阈值应高于空槽上界');
  assert.ok(OCCUPANCY.edgeDensity < HERO_EDGE, '粗边缘阈值应低于有头像值');
  // 主判据是"粗边缘占比"，余量应最大（空槽 0 对头像 0.2）
  assert.ok(
    OCCUPANCY.edgeDensity <= HERO_EDGE / 3,
    '粗边缘阈值应留出至少 3 倍余量',
  );
});

test('interiorStats 语义：edgeDensity 是"占比"而非"平均梯度"', () => {
  // 回归：实现曾返回平均灰度差（0..255 量级），而阈值按占比（0..1）设定，
  // 于是 0.25 的阈值等于"有一点梯度就算占用" → 空槽被判占用。
  // 真实空槽并非绝对纯色（视频压缩/渐变会留下 ±3 级噪声），
  // 用这种区域验证：新口径（粗边缘占比）判为**空**，
  // 旧口径（平均梯度 ≈2 > 0.25）会误判为占用。
  const W = 64;
  const H = 64;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // 灰底 20，叠加 ±3 的确定性"噪声"（相邻差最大 6 << EDGE_STEP 24）
      const v = 20 + ((x * 7 + y * 13) % 7) - 3;
      const i = (y * W + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  const bmp = { width: W, height: H, data };
  assert.equal(
    isSlotOccupied(bmp, { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }),
    false,
    '带轻微噪声的空槽必须判为空（占比口径下无粗边缘）',
  );
});

/* ------------------------------------------------------------------ */
/* 占用检测                                                             */
/* ------------------------------------------------------------------ */

test('isSlotOccupied：纹理格为真、纯色格为假', () => {
  const bmp = topBarBitmap(1, [{ slot: 0, gray: 150 }, { slot: 3, gray: 90 }]);
  assert.equal(isSlotOccupied(bmp, topBarSlotRect(0)), true);
  assert.equal(isSlotOccupied(bmp, topBarSlotRect(3)), true);
  assert.equal(isSlotOccupied(bmp, topBarSlotRect(1)), false);
  assert.equal(isSlotOccupied(bmp, topBarSlotRect(9)), false);
});

test('isSlotOccupied：跨分辨率稳定（0.5x 与 1x 同判定）', () => {
  for (const scale of [0.5, 1, 1.42]) {
    const bmp = topBarBitmap(scale, [{ slot: 2, gray: 150 }]);
    assert.equal(isSlotOccupied(bmp, topBarSlotRect(2)), true, `scale=${scale}`);
    assert.equal(isSlotOccupied(bmp, topBarSlotRect(5)), false, `scale=${scale}`);
  }
});

/* ------------------------------------------------------------------ */
/* 逐格识别                                                             */
/* ------------------------------------------------------------------ */

test('detectTopBarCandidates：占用格全部识别,空格跳过', () => {
  const bmp = topBarBitmap(1, [
    { slot: 0, gray: 150 }, // 模板 1
    { slot: 2, gray: 90 }, // 模板 2
  ]);
  const templates = twoTemplates();
  const slots = topBarSlotRects();
  const out = detectTopBarCandidates(bmp, slots, templates);
  assert.equal(out.length, 2);
  const bySlot = new Map<number, TopBarCandidate>(out.map((c) => [c.slotIndex, c]));
  assert.equal(bySlot.get(0)?.championId, 1);
  assert.equal(bySlot.get(2)?.championId, 2);
  // 其余 8 格无结果
  assert.equal(bySlot.size, 2);
});

test('detectTopBarCandidates：跨分辨率出同一结果', () => {
  const templates = twoTemplates();
  for (const scale of [0.5, 1]) {
    const bmp = topBarBitmap(scale, [{ slot: 4, gray: 150 }]);
    const out = detectTopBarCandidates(bmp, topBarSlotRects(), templates);
    assert.equal(out.length, 1, `scale=${scale}`);
    assert.equal(out[0]!.championId, 1, `scale=${scale}`);
    assert.equal(out[0]!.slotIndex, 4);
  }
});

test('detectTopBarCandidates：分数不过阈值时静默跳过（宁漏勿错）', () => {
  // 槽位填「上下二分」纹理:与两个块状模板结构都不同 ——
  // 相似度恰 0.5（映射空间的无相关基线）且 margin 0,
  // 占用检测通过（std ≈ 95）但匹配被拒。
  const w = 2400;
  const h = 1350;
  const bmp = solidBitmap(w, h, 12);
  const r = topBarSlotRect(0);
  const x0 = Math.round(r.x * w);
  const y0 = Math.round(r.y * h);
  const sw = Math.round(r.w * w);
  const sh = Math.round(r.h * h);
  for (let y = y0; y < y0 + sh; y++) {
    const v = y < y0 + sh / 2 ? 220 : 30;
    for (let x = x0; x < x0 + sw; x++) {
      const i = (y * w + x) * 4;
      bmp.data[i] = v;
      bmp.data[i + 1] = v;
      bmp.data[i + 2] = v;
    }
  }
  assert.equal(detectTopBarCandidates(bmp, topBarSlotRects(), twoTemplates()).length, 0);
  // 对照:同阈值下,同源纹理（与模板 1 同结构）能识别出来 ——
  // 证明上面的拒绝来自「分数/区分度不足」而非占用或几何故障
  assert.equal(
    detectTopBarCandidates(topBarBitmap(1, [{ slot: 0, gray: 150 }]), topBarSlotRects(), twoTemplates())
      .length,
    1,
  );
});

test('detectTopBarCandidates：空模板库返回空数组', () => {
  const bmp = topBarBitmap(1, [{ slot: 0, gray: 150 }]);
  assert.equal(detectTopBarCandidates(bmp, topBarSlotRects(), []).length, 0);
});

test('detectTopBarCandidates：捕获截屏空间矩形（windowRectToCapture 的产物）', () => {
  // 模拟 display 形态：窗口只占截屏左半,槽位应整体平移
  // 截屏 2× 显示器,窗口逻辑 1200×1350 → 截屏里窗口占 x∈[0,0.5]
  const geo = {
    captureWidth: 4800,
    captureHeight: 2700,
    windowX: 0,
    windowY: 0,
    windowWidth: 2400, // display 形态下 = 显示器逻辑宽
    windowHeight: 1350,
  };
  // 用 windowRectToCapture 的公式手工变换格 0（与 win-geometry.ts 同式）
  const r0 = topBarSlotRect(0);
  const cap0: Rect = {
    x: (r0.x * geo.windowWidth + geo.windowX) / geo.captureWidth,
    y: (r0.y * geo.windowHeight + geo.windowY) / geo.captureHeight,
    w: (r0.w * geo.windowWidth) / geo.captureWidth,
    h: (r0.h * geo.windowHeight) / geo.captureHeight,
  };
  // 位图:在变换后的位置铺与 twoTemplates 同款的 24×24 块结构
  // （gray=150 → 模板 1;extractGray 后相似度 ≈ 1）
  const bmp = solidBitmap(geo.captureWidth, geo.captureHeight, 12);
  const x0 = Math.round(cap0.x * geo.captureWidth);
  const y0 = Math.round(cap0.y * geo.captureHeight);
  const sw = Math.round(cap0.w * geo.captureWidth);
  const sh = Math.round(cap0.h * geo.captureHeight);
  const CELLS = 24;
  for (let cy = 0; cy < CELLS; cy++) {
    for (let cx = 0; cx < CELLS; cx++) {
      const v = (150 + ((Math.floor(cx / 6) * 3 + Math.floor(cy / 6) * 7) % 4) * 50) % 256;
      const cx0 = x0 + Math.floor((cx * sw) / CELLS);
      const cx1 = x0 + Math.floor(((cx + 1) * sw) / CELLS);
      const cy0 = y0 + Math.floor((cy * sh) / CELLS);
      const cy1 = y0 + Math.floor(((cy + 1) * sh) / CELLS);
      for (let y = cy0; y < Math.max(cy0 + 1, cy1); y++) {
        for (let x = cx0; x < Math.max(cx0 + 1, cx1); x++) {
          const i = (y * geo.captureWidth + x) * 4;
          bmp.data[i] = v;
          bmp.data[i + 1] = v;
          bmp.data[i + 2] = v;
        }
      }
    }
  }
  const out = detectTopBarCandidates(bmp, [cap0], twoTemplates());
  assert.equal(out.length, 1);
  assert.equal(out[0]!.championId, 1);
});
