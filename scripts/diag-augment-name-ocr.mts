/**
 * 诊断：海克斯卡面名字 OCR —— **回归 + 复标定**
 *
 * 跑的是**线上同一份代码**（`vision/augment-ocr.ts`），不是复制品
 * （本项目踩过"脚本与主流程两份实现漂移"的坑）。
 *
 * 默认用正式默认参数（yCenter 0.47 / 阈值 160 / minScore 0.55 / minMargin 0.03）
 * 在真机帧上核对；`--sweep` 会在参数网格上重跑一遍，用于换字体/换分辨率时复标定。
 *
 * 用法：
 *   node --experimental-strip-types scripts/diag-augment-name-ocr.mts \
 *     --expect 缩小引擎,夜狩,威能之追求 debug/shots/inprogress-152515-raw.png
 *   # 加 --sweep 复标定
 *
 * ⚠️ 帧图与指纹库不入库（`debug/`、`data/` 都在 .gitignore 里）。
 */

import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
  AUGMENT_NAME_STRIP,
  augmentNameStripRect,
  decodePng,
  detectAugmentPanel,
  matchAugmentName,
  readAugmentNameStrip,
  type AugmentNameFingerprint,
  type Bitmap,
} from '../packages/vision/src/index.ts';

/* ------------------------------------------------------------------ */
/* 指纹库                                                              */
/* ------------------------------------------------------------------ */

interface PackEntry {
  readonly id: number;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly bits: string;
}

function unpackBits(b64: string, width: number, height: number): Uint8Array {
  const packed = Buffer.from(b64, 'base64');
  const bits = new Uint8Array(width * height);
  for (let i = 0; i < bits.length; i++) bits[i] = (packed[Math.floor(i / 8)]! >> (i % 8)) & 1;
  return bits;
}

function loadLibrary(path: string): AugmentNameFingerprint[] {
  const arr = JSON.parse(readFileSync(path, 'utf8')) as PackEntry[];
  return arr.map((e) => ({
    augmentId: e.id,
    name: e.name,
    width: e.width,
    height: e.height,
    bits: unpackBits(e.bits, e.width, e.height),
  }));
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const expectIdx = argv.findIndex((a) => a === '--expect');
const expect = (expectIdx >= 0 ? (argv[expectIdx + 1] ?? '') : '').split(',').filter(Boolean);
const sweep = argv.includes('--sweep');
const files = argv.filter((a, i) => !a.startsWith('--') && i !== expectIdx + 1);

const PACK = join('data', 'augment-names.json');
const lib = loadLibrary(PACK);
console.log(`指纹库 ${PACK}：${lib.length} 条`);
if (expect.length > 0) console.log(`期望（按卡序）：${expect.join(' / ')}`);
console.log(
  `线上默认：yCenter ${AUGMENT_NAME_STRIP.yCenter} 高 ${AUGMENT_NAME_STRIP.height} 宽 ${AUGMENT_NAME_STRIP.width}` +
    ` 阈值 ${AUGMENT_NAME_STRIP.threshold} minScore ${AUGMENT_NAME_STRIP.minScore} minMargin ${AUGMENT_NAME_STRIP.minMargin}\n`,
);

interface Variant {
  readonly label: string;
  readonly yCenter: number;
  readonly threshold: number;
}

const variants: Variant[] = sweep
  ? [0.462, 0.47, 0.478].flatMap((yCenter) =>
      [140, 160, 180].map((threshold) => ({ label: `yc${yCenter}/阈${threshold}`, yCenter, threshold })),
    )
  : [{ label: '正式默认', yCenter: AUGMENT_NAME_STRIP.yCenter, threshold: AUGMENT_NAME_STRIP.threshold }];

let allPass = true;

for (const file of files) {
  let bmp: Bitmap;
  try {
    const img = decodePng(new Uint8Array(readFileSync(file)));
    bmp = { width: img.width, height: img.height, data: img.data };
  } catch (e) {
    console.error(`✗ ${file}: ${e instanceof Error ? e.message : String(e)}`);
    continue;
  }
  const det = detectAugmentPanel(bmp);
  console.log(`=== ${basename(file)} 卡片 ${det.cards.length} 张 ===`);

  for (const v of variants) {
    const cells: string[] = [];
    let pass = true;
    const cfg = { yCenter: v.yCenter, height: AUGMENT_NAME_STRIP.height, width: AUGMENT_NAME_STRIP.width };
    for (const [i, card] of det.cards.entries()) {
      // 走**线上同一份代码**：readAugmentNameStrip（几何由 cfg 覆盖）+ matchAugmentName
      const panelCard = det.cards[i];
      if (!panelCard) continue;
      const strip = readAugmentNameStrip(bmp, panelCard.rect, { threshold: v.threshold, strip: cfg });
      const m = strip ? matchAugmentName(strip, lib) : null;
      const want = expect[i];
      const ok = m !== null && (want === undefined || m.name === want);
      if (!ok) pass = false;
      cells.push(
        `${ok ? '✅' : '❌'}${m ? m.name : '无'}${m ? `(${m.score.toFixed(2)}/${m.margin.toFixed(2)})` : ''}`,
      );
    }
    if (!pass) allPass = false;
    console.log(`  ${v.label.padEnd(14)} → ${cells.join('  ')}${pass ? '   ★全对' : ''}`);
  }
  console.log();
}

console.log(allPass ? '结论：✅ 线上默认参数在真机帧上全对' : '结论：❌ 有帧/卡未通过 —— 需复标定（加 --sweep）');
process.exitCode = allPass ? 0 : 1;
