/**
 * 诊断：把**真机帧**回放进选人候选卡检出器（跑线上同一份代码）+ 名字区 OCR 对照
 *
 * 为什么需要：选人第一阶段的卡片几何是**离线标定**出来的（`vision/champ-select-cards.ts`
 * 的常数与判据），而"标定对不对"只能拿真机帧逐帧对：正样本必须检出、几何与目视
 * 真值差几 DIP、阴性（第二阶段大立绘 / 局内海克斯面板）必须**一张都不出**。
 * 本脚本直接调用线上函数（不是复制一份算法），并可选跑
 * `NAME_STRIP → extractNameStrip → matchNameCareful` 那条**真实**识别链路，
 * 把 OCR 出的英雄名与目视英雄名对照 —— 这就是"标签位置与英雄对应关系是否正确"
 * 的证据。
 *
 * 用法：
 *   node --experimental-strip-types scripts/diag-champ-select-cards.mts
 *   node --experimental-strip-types scripts/diag-champ-select-cards.mts <帧.png...> [--ocr] [--annotate]
 *
 * 说明：
 *   · 不带参数 = 跑内置的真机帧清单（`debug/` 下，缺文件自动跳过）；
 *   · 带文件参数时按"窗口快照"处理（截屏即窗口内容）；显示器快照请用内置清单
 *     里的 `verify1/shot1`（它们的窗口矩形是量出来的，见脚本内 DESKTOP）。
 *   · `--annotate` 会把检出框画到帧副本上（红=检出，绿=标定布局的期望位置），
 *     落盘 `<帧>.champcards.png` —— 目视核对用。
 *   · `--ocr` 会打印每个卡框的 OCR 结果与目视真值是否一致。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

import {
  NAME_STRIP,
  base64ToBits,
  champSelectCardRects,
  decodePack,
  decodePng,
  detectCards,
  detectChampSelectCards,
  encodePng,
  extractGrayRaw,
  extractNameStrip,
  matchNameCareful,
  type Bitmap,
  type NameFingerprint,
  type Rect,
} from '../packages/vision/src/index.ts';

/* ------------------------------------------------------------------ */
/* 真机帧清单                                                          */
/* ------------------------------------------------------------------ */

const IDENT: Rect = { x: 0, y: 0, w: 1, h: 1 };
/**
 * 全屏快照（3246×1291，左侧还有别的窗口）里 LoL 客户端窗口的实际矩形。
 * 量测口径：列平均亮度的最大跳变在 x=490 / 2754，行跳变在 y=8 / 1281。
 */
const DESKTOP: Rect = {
  x: 490 / 3246,
  y: 8 / 1291,
  w: (2754 - 490) / 3246,
  h: (1281 - 8) / 1291,
};

interface Case {
  readonly file: string;
  readonly kind: 'stage1-2card' | 'stage2-art' | 'ingame-panel';
  readonly region: Rect;
  /** 目视真值（窗口归一化卡框），用于算偏差。 */
  readonly truth?: readonly Rect[];
  /** 目视真值英雄名（`--ocr` 时对照）。 */
  readonly names?: readonly string[];
}

/** 2 张候选卡的两套真机帧（3413×1920 与 2393×1347）的目视量测值。 */
const TRUTH_3413: readonly Rect[] = [
  { x: 1166 / 3413, y: 477 / 1920, w: 498 / 3413, h: 800 / 1920 },
  { x: 1741 / 3413, y: 477 / 1920, w: 499 / 3413, h: 800 / 1920 },
];
const TRUTH_2393: readonly Rect[] = [
  { x: 817 / 2393, y: 336 / 1347, w: 350 / 2393, h: 563 / 1347 },
  { x: 1221 / 2393, y: 336 / 1347, w: 352 / 2393, h: 563 / 1347 },
];
/**
 * 全屏快照里两张卡的真值 —— **换算成窗口归一化**（与检出器同一坐标系）。
 *
 * 窗口在截屏里是 x 490..2754（2264px）、y 8..1281（1273px）；
 * 目视量出的卡框在截屏里是 x 1264..1594 / 1646..1977、y 325..856。
 */
const TRUTH_DESKTOP: readonly Rect[] = [
  { x: (1264 - 490) / 2264, y: (325 - 8) / 1273, w: 331 / 2264, h: 531 / 1273 },
  { x: (1646 - 490) / 2264, y: (325 - 8) / 1273, w: 332 / 2264, h: 531 / 1273 },
];

const D = 'debug';
const CASES: readonly Case[] = [
  // ── 正样本：第一阶段「选择你的英雄」两张候选卡 ──
  { file: `${D}/shots/champselect-locked-152419-raw.png`, kind: 'stage1-2card', region: IDENT, truth: TRUTH_3413, names: ['痛苦之拥', '风暴之怒'] },
  { file: `${D}/shots/champselect-hover-152415-raw.png`, kind: 'stage1-2card', region: IDENT, truth: TRUTH_3413, names: ['痛苦之拥', '风暴之怒'] },
  { file: `${D}/shots/champselect-hover-152423-raw.png`, kind: 'stage1-2card', region: IDENT, truth: TRUTH_3413, names: ['痛苦之拥', '风暴之怒'] },
  { file: `${D}/real/phase1.png`, kind: 'stage1-2card', region: IDENT, truth: TRUTH_2393, names: ['纳祖芒荣耀', '殇之木乃伊'] },
  { file: `${D}/real/verify1.png`, kind: 'stage1-2card', region: DESKTOP, truth: TRUTH_DESKTOP, names: ['傲之追猎者', '狂野女猎手'] },
  { file: `${D}/real/shot1.png`, kind: 'stage1-2card', region: DESKTOP, truth: TRUTH_DESKTOP, names: ['傲之追猎者', '狂野女猎手'] },
  // ── 阴性：第二阶段（已锁定 → 大立绘）──
  { file: `${D}/shots/champselect-hover-152431-raw.png`, kind: 'stage2-art', region: IDENT },
  { file: `${D}/shots/champselect-hover-152439-raw.png`, kind: 'stage2-art', region: IDENT },
  { file: `${D}/shots/champselect-hover-152447-raw.png`, kind: 'stage2-art', region: IDENT },
  { file: `${D}/shots/champselect-hover-152455-raw.png`, kind: 'stage2-art', region: IDENT },
  { file: `${D}/shots/champselect-locked-152427-raw.png`, kind: 'stage2-art', region: IDENT },
  { file: `${D}/shots/champselect-locked-152435-raw.png`, kind: 'stage2-art', region: IDENT },
  { file: `${D}/shots/champselect-locked-152443-raw.png`, kind: 'stage2-art', region: IDENT },
  { file: `${D}/shots/champselect-locked-152451-raw.png`, kind: 'stage2-art', region: IDENT },
  { file: `${D}/real/phase2.png`, kind: 'stage2-art', region: IDENT },
  { file: `${D}/real/verify2.png`, kind: 'stage2-art', region: DESKTOP },
  { file: `${D}/real/shot2.png`, kind: 'stage2-art', region: DESKTOP },
  // ── 阴性：局内海克斯面板（3 张，另一套布局）──
  { file: `${D}/shots/inprogress-152509-raw.png`, kind: 'ingame-panel', region: IDENT },
  { file: `${D}/shots/inprogress-152515-raw.png`, kind: 'ingame-panel', region: IDENT },
];

/* ------------------------------------------------------------------ */
/* 辅助                                                                */
/* ------------------------------------------------------------------ */

/** 窗口归一化矩形 → 窗口内 DIP（真机窗口 1600×900）。 */
function toDip(r: Rect): { x: number; y: number; w: number; h: number } {
  return { x: r.x * 1600, y: r.y * 900, w: r.w * 1600, h: r.h * 900 };
}

function fmtCards(cards: readonly Rect[]): string {
  if (cards.length === 0) return '0 张';
  return cards
    .map((r) => {
      const d = toDip(r);
      return `x=${d.x.toFixed(0)} y=${d.y.toFixed(0)} w=${d.w.toFixed(0)} h=${d.h.toFixed(0)}`;
    })
    .join(' | ');
}

/** 在帧副本上画框（红=检出，绿=期望），落盘供目视核对。 */
function annotate(bmp: Bitmap, detected: readonly Rect[], expected: readonly Rect[], region: Rect): Bitmap {
  const data = new Uint8ClampedArray(bmp.data);
  const put = (x: number, y: number, rgb: readonly [number, number, number]): void => {
    if (x < 0 || y < 0 || x >= bmp.width || y >= bmp.height) return;
    const i = (y * bmp.width + x) * 4;
    data[i] = rgb[0];
    data[i + 1] = rgb[1];
    data[i + 2] = rgb[2];
    data[i + 3] = 255;
  };
  const draw = (r: Rect, rgb: readonly [number, number, number], thick: number): void => {
    const x0 = Math.round((region.x + r.x * region.w) * bmp.width);
    const y0 = Math.round((region.y + r.y * region.h) * bmp.height);
    const x1 = Math.round((region.x + (r.x + r.w) * region.w) * bmp.width);
    const y1 = Math.round((region.y + (r.y + r.h) * region.h) * bmp.height);
    for (let t = 0; t < thick; t++) {
      for (let x = x0; x <= x1; x++) {
        put(x, y0 + t, rgb);
        put(x, y1 - t, rgb);
      }
      for (let y = y0; y <= y1; y++) {
        put(x0 + t, y, rgb);
        put(x1 - t, y, rgb);
      }
    }
  };
  for (const r of expected) draw(r, [0, 220, 0], 2);
  for (const r of detected) draw(r, [255, 40, 40], 4);
  return { width: bmp.width, height: bmp.height, data };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const files = argv.filter((a) => !a.startsWith('--'));
const wantOcr = flags.has('--ocr');
const wantAnnotate = flags.has('--annotate');

const cases: Case[] =
  files.length > 0
    ? files.map((f) => ({ file: f, kind: 'stage1-2card' as const, region: IDENT }))
    : CASES;

let library: readonly NameFingerprint[] = [];
if (wantOcr) {
  if (!existsSync('data/templates.json')) {
    console.warn('⚠ 缺少 data/templates.json（先跑 pnpm templates）→ 跳过 OCR 对照');
  } else {
    const pack = decodePack(readFileSync('data/templates.json', 'utf8').trim());
    library = (pack.names ?? []).map((n) => ({
      championId: n.championId,
      name: n.name,
      width: n.width,
      height: n.height,
      bits: base64ToBits(n.bits, n.width * n.height),
    }));
  }
}

/** 与 `apps/overlay/src/main/vision-loop.ts` 第一阶段**同一段**取名字区 + 匹配。 */
function ocrOne(bmp: Bitmap, rect: Rect): string {
  const stripRect = {
    x: rect.x + (rect.w * (1 - NAME_STRIP.width)) / 2,
    y: rect.y + (rect.h * NAME_STRIP.yCenter - (rect.h * NAME_STRIP.height) / 2),
    w: rect.w * NAME_STRIP.width,
    h: rect.h * NAME_STRIP.height,
  };
  const raw = extractGrayRaw(bmp, stripRect);
  if (!raw) return '取样越界';
  const strip = extractNameStrip(raw.gray, raw.width, raw.height);
  const m = matchNameCareful(strip, library);
  return `${m?.name ?? '(未识别)'}(得分${(m?.score ?? 0).toFixed(2)}/分差${(m?.margin ?? 0).toFixed(2)})`;
}

let positives = 0;
let positiveHit = 0;
let negatives = 0;
let negativeWrong = 0;
let ocrHit = 0;
let ocrTotal = 0;

console.log('kind\tfile\t几何检出\t旧 detectCards\t真值偏差(DIP)');
for (const c of cases) {
  if (!existsSync(c.file)) {
    console.log(`${c.kind}\t${basename(c.file)}\t（文件不存在，跳过）`);
    continue;
  }
  const img = decodePng(new Uint8Array(readFileSync(c.file)));
  const bmp: Bitmap = { width: img.width, height: img.height, data: img.data };
  const geo = detectChampSelectCards(bmp, { region: c.region });
  const legacy = detectCards(bmp);

  if (c.kind === 'stage1-2card') {
    positives++;
    if (geo.confident) positiveHit++;
  } else {
    negatives++;
    if (geo.confident) negativeWrong++;
  }

  let dev = '-';
  if (geo.confident && c.truth) {
    dev = c.truth
      .map((t, i) => {
        const g = geo.cards[i];
        if (!g) return `#${i} 缺`;
        const a = toDip(t);
        const b = toDip(g);
        return (
          `#${i} dx=${(b.x - a.x).toFixed(1)} dy=${(b.y - a.y).toFixed(1)}` +
          ` dw=${(b.w - a.w).toFixed(1)} dh=${(b.h - a.h).toFixed(1)}`
        );
      })
      .join(' ');
  }

  console.log(
    `${c.kind}\t${basename(c.file)}\t` +
      `几何=${geo.confident ? `${geo.count} 张 [${fmtCards(geo.cards)}]` : `0 张（${geo.reason.slice(0, 48)}…）`}\t` +
      `旧=${legacy.confident ? `${legacy.cards.length} 张` : '0 张'}\t${dev}`,
  );

  if (geo.confident && c.kind === 'stage1-2card' && !c.truth) {
    console.log(`    （无目视真值可比对）`);
  }
  if (!geo.confident && c.kind === 'stage1-2card') {
    console.log(`    ⚠ 正样本没检出：${geo.reason}`);
  }
  if (geo.confident && c.kind !== 'stage1-2card') {
    console.log(`    ⚠ 阴性样本误检（必须修）：${fmtCards(geo.cards)}`);
  }

  if (wantOcr && library.length > 0) {
    geo.cards.forEach((rect, i) => {
      const got = ocrOne(bmp, rect);
      const expect = c.names?.[i];
      if (expect) {
        ocrTotal++;
        if (got.startsWith(expect)) ocrHit++;
      }
      console.log(`    card${i} OCR=${got}${expect ? `  目视=${expect}  ${got.startsWith(expect) ? '一致 ✓' : '**不一致**'}` : ''}`);
    });
  }

  if (wantAnnotate) {
    const out = `${c.file}.champcards.png`;
    const expected = geo.confident ? geo.cards : champSelectCardRects(2);
    writeFileSync(out, encodePng(annotate(bmp, geo.cards, expected, c.region)));
    console.log(`    → 标注图 ${out}`);
  }
}

console.log('');
console.log(
  `小结：正样本检出 ${positiveHit}/${positives}；阴性误检 ${negativeWrong}/${negatives}` +
    (ocrTotal > 0 ? `；OCR 与目视一致 ${ocrHit}/${ocrTotal}` : ''),
);
console.log('（布局常数下的理论矩形，窗口归一化 → DIP @1600×900）');
for (const n of [2, 3]) {
  console.log(
    `  ${n} 张: ` +
      champSelectCardRects(n)
        .map((r) => {
          const d = toDip(r);
          return `x=${d.x.toFixed(1)} y=${d.y.toFixed(1)} w=${d.w.toFixed(1)} h=${d.h.toFixed(1)}`;
        })
        .join(' | '),
  );
}
