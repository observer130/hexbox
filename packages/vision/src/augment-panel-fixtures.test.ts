/**
 * 真机帧 fixture → **线上门控检测器**（不需要游戏 / Electron）
 *
 * fixture 的来历：`scripts/make-frame-fixtures.mts` 把 `debug/` 里的真机截图
 * 缩到门控画布分辨率（1/3）、裁到并集(留档搜索区, PANEL_ROW_REGION)、转成灰度后入库。
 * `expectFound` 来自**真机当时的判定**（`open-*.json` / `closed-sample-*.json` 的留档，
 * 以及门控判据标定文档里的正负样本），不是"跑一遍记下来"。
 *
 * 这个测试补的是 `pnpm test` 长期缺的一环：判据与阈值全都是拿真机画面标定的，
 * 而在此之前 CI 里没有任何**真实输入**。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { detectAugmentPanelInRegions } from './augment-panel.ts';
import type { Bitmap, Rect } from './types.ts';
import { cropContains, rectFromCrop, regionsInCrop } from './augment-session.ts';
import { bitmapToGray, decodePng, grayToBitmap } from './png.ts';

interface FixtureFrame {
  readonly file: string;
  readonly source: string;
  readonly sourceSize: string;
  readonly gateSize: string;
  readonly region: Rect;
  readonly altRegion: Rect;
  readonly crop: Rect;
  readonly expectFound: boolean;
  readonly liveNativeFound?: boolean;
  readonly liveReason?: string;
  readonly note: string;
  readonly builtFound: boolean;
  readonly builtReason: string;
}

const MANIFEST = fileURLToPath(new URL('../fixtures/augment-panel/frames.json', import.meta.url));

function loadManifest(): FixtureFrame[] {
  const o = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { frames: FixtureFrame[] };
  return o.frames;
}

/** 按**线上同一套换算**把 fixture 变成检测器的输入。 */
function frameToBitmap(f: FixtureFrame): { bmp: Bitmap; regions: { region: Rect; altRegion: Rect } } {
  const img = decodePng(new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/augment-panel/${f.file}`, import.meta.url)))));
  const bmp = grayToBitmap({ width: img.width, height: img.height, gray: bitmapToGray(img) });
  const regions = regionsInCrop(f.region, f.altRegion, f.crop);
  assert.ok(regions !== null, `${f.file}: 裁剪区必须覆盖两个搜索区`);
  return { bmp, regions };
}

test('fixture：真机帧在**线上检测器**下的判定与真机一致（正样本 3 / 负样本 3）', () => {
  const frames = loadManifest();
  assert.ok(frames.length >= 6, `fixture 太少：${frames.length}`);
  assert.equal(frames.filter((f) => f.expectFound).length, 2);
  assert.equal(frames.filter((f) => !f.expectFound).length, 4);

  for (const f of frames) {
    const { bmp, regions } = frameToBitmap(f);
    const det = detectAugmentPanelInRegions(bmp, [regions.region, regions.altRegion]).detection;
    assert.equal(
      det.found,
      f.expectFound,
      `${f.file}（${f.note}）判定不符：期望 ${f.expectFound ? '面板' : '无面板'}，实际「${det.reason}」`,
    );
    // 生成时的结果也要与真机一致（不一致的帧必须显式写清楚，不许悄悄入库）
    assert.equal(f.builtFound, f.expectFound, `${f.file}: 生成时结果与真机判定不一致`);
  }
});

test('fixture：网格几何落在搜索区内（坐标映射没有整体偏移）', () => {
  for (const f of loadManifest().filter((x) => x.expectFound)) {
    const { bmp, regions } = frameToBitmap(f);
    const det = detectAugmentPanelInRegions(bmp, [regions.region, regions.altRegion]).detection;
    assert.equal(det.cards.length, 3, `${f.file}: 面板帧应当检出 3 张卡`);
    for (const c of det.cards) {
      // 裁剪坐标 → 画布坐标（回放的所有几何都必须走这一步）
      const canvasRect = rectFromCrop(c.rect, f.crop);
      assert.ok(canvasRect.w > 0 && canvasRect.h > 0, `${f.file}: 卡片矩形尺寸非法`);
      assert.ok(
        canvasRect.x >= 0 && canvasRect.y >= 0 && canvasRect.x + canvasRect.w <= 1.001 && canvasRect.y + canvasRect.h <= 1.001,
        `${f.file}: 卡片矩形越界 ${JSON.stringify(canvasRect)}`,
      );
      // 卡片必须落在**留档的主搜索区**或备用区里（面板就是在这两个区域里被找到的）
      const inPrimary = cropContains(f.region, canvasRect);
      const inAlt = cropContains(f.altRegion, canvasRect);
      assert.ok(inPrimary || inAlt, `${f.file}: 卡片不在任何搜索区内 ${JSON.stringify(canvasRect)}`);
    }
  }
});

test('fixture：`open-1` 锁住"门控说在、原生重检说不在"这条兜底的现场', () => {
  const f = loadManifest().find((x) => x.file === 'panel-open-1.gray.png');
  assert.ok(f, 'fixture 里必须有 open-1');
  // 两个口径都要锁：留档的原生重检是"未命中"，本 fixture（1/3 重建）也是"未命中"
  assert.equal(f.liveNativeFound, false);
  assert.equal(f.expectFound, false);
  const { bmp, regions } = frameToBitmap(f);
  const det = detectAugmentPanelInRegions(bmp, [regions.region, regions.altRegion]).detection;
  assert.equal(det.found, false);
  // 它会检出候选卡片但不足以成立 —— 这正是"原生重检失败 → 退回门控矩形"要处理的形态
  assert.match(det.reason, /边框带太少|卡片数/);
});

test('灰度帧与彩色帧：判定相同、卡片相同（"只存灰度"这条前提的直接证明）', () => {
  // 真机帧 fixture 存的是灰度（体积小一个量级）。这条测试锁住前提：检测器**只**看
  // `0.299/0.587/0.114` 的亮度 —— 将来谁引入色度判据，这里立刻红。
  const f = loadManifest().find((x) => x.expectFound)!;
  const { bmp, regions } = frameToBitmap(f);
  const regionsArg = [regions.region, regions.altRegion];

  // ① 精确版：灰度 → RGBA → 灰度（**回放走的正是这条路**），
  //    连原因串里的亮度数字都必须逐字相同。
  const grayOnly = grayToBitmap({ width: bmp.width, height: bmp.height, gray: bitmapToGray(bmp) });
  const g0 = detectAugmentPanelInRegions(bmp, regionsArg).detection;
  const g1 = detectAugmentPanelInRegions(grayOnly, regionsArg).detection;
  assert.equal(g0.reason, g1.reason, '灰度往返改变了判据读数');
  assert.equal(g0.found, g1.found);

  // ② 色度版：同亮度加随机色度（**近似**中性 —— 整数取整让每像素亮度可能差 ≤ 0.3，
  //    所以这里只断言"判定与卡片几何不变"，不去比原因串里的整数）。
  const chroma: Bitmap = { width: bmp.width, height: bmp.height, data: new Uint8ClampedArray(bmp.data.length) };
  let seed = 12345;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < bmp.data.length; i += 4) {
    const g = bmp.data[i]!;
    if (rnd() < 0.5) {
      const d = Math.round(rnd() * 40) - 20;
      chroma.data[i] = Math.max(0, Math.min(255, g + d));
      chroma.data[i + 1] = Math.max(0, Math.min(255, g));
      chroma.data[i + 2] = Math.max(0, Math.min(255, g - d));
    } else {
      chroma.data[i] = g;
      chroma.data[i + 1] = g;
      chroma.data[i + 2] = g;
    }
    chroma.data[i + 3] = 255;
  }
  const gc = detectAugmentPanelInRegions(chroma, regionsArg).detection;
  assert.equal(gc.found, g0.found, '同亮度的彩色帧给出了不同判定 → 检测器用到了色度');
  assert.equal(gc.cards.length, g0.cards.length, '卡片数不一致');
  for (const [i, c] of gc.cards.entries()) {
    const ref = g0.cards[i]!;
    assert.ok(Math.abs(c.rect.x - ref.rect.x) < 0.01 && Math.abs(c.rect.w - ref.rect.w) < 0.01, '卡片矩形漂移');
  }
});
