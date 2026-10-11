/**
 * 真机帧 fixture 生成器（**一次性/可重跑**；源帧在 `debug/` 里，不入库）
 *
 * 为什么要有它：`pnpm test` 至今碰不到门控检测器的"真实输入" —— 判据与阈值
 * （内部 < 40、边框−内部 ≥ 70、卡片 3 张、宽高比/间隙）全部是拿真机帧标定的，
 * 而真机帧在 `debug/`（gitignored，含个人信息，随时会被清掉）。
 * 这里把它们**裁到门控搜索区、缩到门控画布分辨率、转成灰度**后入库，
 * 于是 CI 里也能跑"线上同一份检测器 × 真实画面"。
 *
 * 三个刻意的选择（都是为了"fixture 与线上输入同分布"）：
 *   1. **缩到门控画布分辨率**：线上门控看的是 1/3 分辨率（`gateCanvasWidth`），
 *      拿原生帧测出来的结果**不代表**线上（真机 39 vs 40 的边界事故就是这个教训）；
 *   2. **裁到 `PANEL_ROW_REGION`**：只留搜索区 → 体积小、且不含 HUD/聊天等个人信息；
 *   3. **存灰度**：链路的全部判据（门控/OCR/指纹）都只看亮度，灰度在语义上无损
 *      （见 `png.ts` 的 `encodeGrayPng`）。
 *
 * ⚠️ 降采样用**盒式平均**，而线上是 Chromium 的 `drawImage` 缩放 —— 两者不是
 * 逐位相同（理想低通 vs 实现细节）。所以 fixture 是"同分布"，不是"同一帧"；
 * 出现分歧时先怀疑这一点，再怀疑判据。
 *
 * 用法（仓库根）：
 *   node --experimental-strip-types scripts/make-frame-fixtures.mts
 *   node --experimental-strip-types scripts/make-frame-fixtures.mts --out=<目录>
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
  bitmapToGray,
  cropBitmap,
  decodePng,
  detectAugmentPanelInRegions,
  encodeGrayPng,
  gateCanvasWidth,
  PANEL_ROW_REGION,
  PANEL_THRESHOLDS,
  regionsInCrop,
  type Bitmap,
  type Rect,
} from '../packages/vision/src/index.ts';

/* ------------------------------------------------------------------ */
/* 输入清单（源帧 + 真机判定）                                          */
/* ------------------------------------------------------------------ */

interface Source {
  /** 源帧（`debug/` 里的真机截图）。 */
  readonly source: string;
  /** 输出名（入库的文件名）。 */
  readonly name: string;
  /** 线上门控当时的判定（真机事实，不是"跑一遍看看"）。 */
  readonly expectFound: boolean;
  /**
   * 同一次留档里**原生分辨率重检**的判定（`open-*.json` 的 `found`）。
   *
   * 它与 `expectFound` 可以不同，而且**必须分开记**：门控跑在屏幕流的 1/3 画布上，
   * 留档帧却是 `desktopCapturer` 抓的另一张图 —— 两者不是同一帧（见 `open-1` 的注）。
   */
  readonly liveNativeFound?: boolean;
  /** 真机门控的原因串（有留档就抄下来，用于人工核对）。 */
  readonly liveReason?: string;
  readonly note: string;
}

const SOURCES: readonly Source[] = [
  {
    source: 'debug/shots/inprogress-152515-raw.png',
    name: 'panel-inprogress-152515.gray.png',
    expectFound: true,
    note: '真机三选一面板（判据标定用的正样本之一，见 docs/AUGMENT-PANEL.md §二）',
  },
  {
    source: 'debug/shots/inprogress-152509-raw.png',
    name: 'panel-inprogress-152509.gray.png',
    expectFound: true,
    note: '真机三选一面板（同上；与上一张不同时刻、不同官方统计）',
  },
  {
    source: 'debug/augment/open-1.png',
    name: 'panel-open-1.gray.png',
    // ⚠️ 这一帧的**真机判定就是"未命中"**（open-1.json: found=false,
    //    "卡片数 0（边框带太少(1)…)"）—— 它是"开边沿由门控给出、原生重检却说不"
    //    那条兜底（`vision/augment-open-recognize.ts`）的现场证据。
    expectFound: false,
    liveNativeFound: false,
    liveReason: '门控当时说"3 张卡片：内部暗(28/28/27) 边框亮(121/122/129)"，但**同一时刻的原生重检说未命中**',
    note:
      '**别把它当成正样本改断言**：门控跑在**屏幕流**的 1/3 画布上，而取证帧是 ' +
      '`desktopCapturer` 抓的另一张图 —— 两者不是同一帧（这一帧上：门控说 3 张卡、' +
      '原生重检说 0 张、本 fixture 的 1/3 重建说 3 条边框带但 0 张卡，后两者一致）。' +
      '它锁住的正是"**会话必须存门控画布帧、不能存 desktopCapturer 帧**"这条结论',
  },
  {
    source: 'debug/augment/closed-sample-1.png',
    name: 'closed-sample-1.gray.png',
    expectFound: false,
    liveReason: '卡片数 0（等宽候选桶均未通过间隙/纵横比校验（共 6 个候选桶））',
    note: '局内但面板未弹（真机负样本；它同时也是"录制从面板开始"的边界样本）',
  },
  {
    source: 'debug/shots/champselect-hover-152415-raw.png',
    name: 'champselect-hover.gray.png',
    expectFound: false,
    note: '选人阶段帧：**绝不能**被局内门控认成面板（误判会在选人界面画局内标签）',
  },
  {
    source: 'debug/shots/champselect-locked-152419-raw.png',
    name: 'champselect-locked.gray.png',
    expectFound: false,
    note: '选人第二阶段（已锁定）帧：同上，且它的大立绘是"像卡片"的干扰源',
  },
];

/* ------------------------------------------------------------------ */
/* 图像工具                                                            */
/* ------------------------------------------------------------------ */

/** 盒式平均降采样到目标宽度（高度按比例）—— 与线上 `drawImage` 缩放最接近的近似。 */
function downscaleToWidth(bmp: Bitmap, targetWidth: number): Bitmap {
  const w = Math.max(1, Math.round(targetWidth));
  const h = Math.max(1, Math.round((bmp.height / bmp.width) * w));
  const data = new Uint8ClampedArray(w * h * 4);
  const sx = bmp.width / w;
  const sy = bmp.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.ceil((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.ceil((x + 1) * sx));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let j = y0; j < Math.min(y1, bmp.height); j++) {
        for (let i = x0; i < Math.min(x1, bmp.width); i++) {
          const p = (j * bmp.width + i) * 4;
          r += bmp.data[p]!;
          g += bmp.data[p + 1]!;
          b += bmp.data[p + 2]!;
          n++;
        }
      }
      const o = (y * w + x) * 4;
      data[o] = r / n;
      data[o + 1] = g / n;
      data[o + 2] = b / n;
      data[o + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

const outArg = process.argv.find((a) => a.startsWith('--out='));
const OUT_DIR = outArg ? outArg.split('=')[1]! : join('packages', 'vision', 'fixtures', 'augment-panel');
const TARGET_SCALE = 1 / 3;
const MIN_WIDTH = 960;

interface ManifestFrame {
  readonly file: string;
  readonly source: string;
  readonly sourceSize: string;
  readonly gateSize: string;
  /** 线上那一次用的**主搜索区**（有留档就抄留档，否则用 `PANEL_ROW_REGION`）。 */
  readonly region: Rect;
  readonly altRegion: Rect;
  readonly crop: Rect;
  readonly expectFound: boolean;
  /** 同一次留档里**原生分辨率重检**的判定（`open-*.json` 的 `found`；没有就不写）。 */
  readonly liveNativeFound?: boolean;
  readonly liveReason?: string;
  readonly note: string;
  /** 生成时用**线上检测器**跑出来的结果（人工核对用；测试断言的是 `expectFound`）。 */
  readonly builtFound: boolean;
  readonly builtReason: string;
}

/**
 * 读取同名的留档 JSON 里的 `region`（真机那一次的主搜索区）。
 *
 * ⚠️ 为什么必须抄它（2026-10-12 实测踩到）：`detectAugmentPanel` 的候选桶是
 * **相对搜索区**算的，换一个搜索区就会得到另一组候选 —— 拿 `PANEL_ROW_REGION`
 * 去跑 `open-1.png`，结果从"3 张卡片"变成"边框带太少(1)"，**看起来像判据失效，
 * 其实是搜索区换了**。留档 JSON 里就有当时用的 region。
 */
function readLiveRegion(source: string): Rect | null {
  const jsonPath = source.replace(/\.png$/i, '.json');
  if (!existsSync(jsonPath)) return null;
  try {
    const o = JSON.parse(readFileSync(jsonPath, 'utf8')) as { region?: Rect };
    const r = o.region;
    if (
      r &&
      [r.x, r.y, r.w, r.h].every((v) => typeof v === 'number' && Number.isFinite(v)) &&
      r.w > 0 &&
      r.h > 0
    ) {
      return { x: r.x, y: r.y, w: r.w, h: r.h };
    }
  } catch {
    /* 留档坏了就不用它 */
  }
  return null;
}

/** 两个归一化矩形的并集（fixture 的裁剪区必须同时覆盖主区与备用区）。 */
function unionRect(a: Rect, b: Rect): Rect {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const frames: ManifestFrame[] = [];
const kb = (n: number): string => `${(n / 1024).toFixed(0)}KB`;

console.log('\n──────── 生成真机帧 fixture ────────');
console.log(`输出目录：${OUT_DIR}`);
console.log(
  `门控口径：targetScale=${TARGET_SCALE.toFixed(3)} minWidth=${MIN_WIDTH}；` +
    `裁剪 = 并集(留档 region, PANEL_ROW_REGION)\n`,
);

for (const s of SOURCES) {
  if (!existsSync(s.source)) {
    console.log(`  ⚠ 跳过（源帧不存在）：${s.source}`);
    continue;
  }
  const img = decodePng(new Uint8Array(readFileSync(s.source)));
  const src: Bitmap = { width: img.width, height: img.height, data: img.data };
  const gateW = gateCanvasWidth(src.width, { targetScale: TARGET_SCALE, minWidth: MIN_WIDTH });
  const gate = downscaleToWidth(src, gateW);

  const liveRegion = readLiveRegion(s.source) ?? PANEL_ROW_REGION;
  const altRegion = PANEL_ROW_REGION;
  const cropRect = unionRect(liveRegion, altRegion);
  const crop = cropBitmap(gate, cropRect);
  const regions = regionsInCrop(liveRegion, altRegion, cropRect);
  if (!crop || !regions) {
    console.log(`  ✗ ${s.name}：搜索区/裁剪区换算失败`);
    continue;
  }
  // 用**线上检测器 + 线上那两个搜索区（换算到裁剪坐标）**跑一遍
  const hit = detectAugmentPanelInRegions(crop, [regions.region, regions.altRegion]);
  const det = hit.detection;
  const gray = bitmapToGray(crop);
  const png = encodeGrayPng({ width: crop.width, height: crop.height, gray }, 2);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, s.name), png);

  const ok = det.found === s.expectFound;
  console.log(
    `  ${ok ? '✅' : '❌'} ${s.name.padEnd(34)} ${src.width}x${src.height} → 门控 ${gate.width}x${gate.height}` +
      ` → 裁剪 ${crop.width}x${crop.height} ${kb(png.length)}  主区=${liveRegion.w < 1 ? '留档' : '默认'}`,
  );
  console.log(`       期望 found=${s.expectFound ? 1 : 0} / 生成时 found=${det.found ? 1 : 0}：${det.reason}`);
  if (!ok) {
    console.log('       ⚠ **与真机判定不一致** —— 先查降采样近似（盒式 vs Chromium），不要直接改断言');
  }
  frames.push({
    file: s.name,
    source: s.source,
    sourceSize: `${src.width}x${src.height}`,
    gateSize: `${gate.width}x${gate.height}`,
    region: liveRegion,
    altRegion,
    crop: cropRect,
    expectFound: s.expectFound,
    ...(s.liveNativeFound !== undefined ? { liveNativeFound: s.liveNativeFound } : {}),
    ...(s.liveReason !== undefined ? { liveReason: s.liveReason } : {}),
    note: s.note,
    builtFound: det.found,
    builtReason: det.reason,
  });
}

writeFileSync(
  join(OUT_DIR, 'frames.json'),
  JSON.stringify(
    {
      note:
        '真机帧 fixture（由 scripts/make-frame-fixtures.mts 生成）：缩到门控画布分辨率、' +
        '裁到并集(留档 region, PANEL_ROW_REGION)、灰度。不含个人信息；' +
        '`expectFound` 是**真机门控当时的判定**，`builtFound` 是生成时跑线上检测器的结果。',
      gate: { targetScale: TARGET_SCALE, minWidth: MIN_WIDTH },
      thresholds: PANEL_THRESHOLDS,
      frames,
    },
    null,
    2,
  ) + '\n',
);

const bad = frames.filter((f) => f.builtFound !== f.expectFound);
console.log(
  `\n共 ${frames.length} 帧入库（${bad.length} 帧与真机判定不一致）→ ${join(OUT_DIR, 'frames.json')}`,
);
