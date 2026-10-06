/**
 * 诊断：**整排行基准锁**的真机重随帧回放（2026-10-06 二次验收）
 *
 * 用户报的现象："**某次单卡刷新后，三个标签整体下移了一点**（但彼此仍同一高度）"。
 *
 * 根因（已由真机产物证实）：标签的纵向基准原来是**每帧**按这一排卡片矩形的**中位数**
 * 推的（`labelRowBand()`），而重随重识别会把被刷新那张卡的矩形换成**翻牌动画中间帧**
 * 的矩形（`mergeRefreshedCards()` 的语义）—— 三张里有两张一变，中位数就跟着挪，
 * 整排基准平移。中位数只抗**离群**，不保证**不变**。
 *
 * 本脚本用**验收报告那一帧的矩形组合**把修复前后各跑一遍，打印刷新前 vs 刷新后
 * 三张标签的 y / 基线，证明线上路径**位移恰好为 0**：
 *
 *   · 修复后 = `augmentTierLabelsLocked()` + `lockLabelRowBand()`（局内真实路径，
 *     基准在开边沿锁定、面板存续期间复用）；
 *   · 修复前 = `augmentTierLabels()`（每帧重算中位数的那一版，用作对照），
 *     它必须复现出"整体下移"（否则这些数字不能证明修的是什么）。
 *
 * 用法：
 *   node --experimental-strip-types scripts/diag-augment-row-band.mts
 *   node --experimental-strip-types scripts/diag-augment-row-band.mts --report debug/augment/report.json
 *
 * 退出码非 0 = 修复后的路径出现了位移（**别上线**；修复前的对照组不算失败）。
 *
 * 合规：只读本地 JSON/像素（本脚本只读 JSON）。不联网、不开游戏、不注入、不读内存。
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import {
  AUGMENT_BADGE_DEFAULT,
  AUGMENT_BADGE_PRESETS,
  augmentBadgeZone,
  augmentTierLabels,
  augmentTierLabelsLocked,
  labelBoxPlan,
  normalizedRectToScreen,
  type AugmentBadgePreset,
  type LabelRowLock,
  type Rect,
} from '../packages/vision/src/index.ts';

/* ------------------------------------------------------------------ */
/* 一份"这一排要画什么"的输入（跑线上纯函数用）                            */
/* ------------------------------------------------------------------ */

interface ReplayCard {
  readonly rect: Rect;
  readonly augmentId: number | null;
}

interface ReplayFrame {
  readonly label: string;
  readonly origin: 'open' | 'reroll';
  readonly cards: readonly ReplayCard[];
}

/** 真机显示器参数（帧像素 → 屏幕物理像素 → DIP 的换算链，见 docs/AUGMENT-PANEL.md §十三）。 */
interface DisplayScale {
  readonly frameW: number;
  readonly frameH: number;
  /** DIP = 帧像素 ÷ scale。 */
  readonly scale: number;
}

const DEFAULT_DISPLAY: DisplayScale = { frameW: 3440, frameH: 1440, scale: 1.5 };

function geoOf(display: DisplayScale) {
  return {
    dipW: display.frameW / display.scale,
    dipH: display.frameH / display.scale,
  };
}

/** 归一化标签矩形 → 屏幕 DIP（复用线上那一座换算桥，脚本里不写第二份）。 */
function toDip(rect: Rect, display: DisplayScale): Rect {
  const { dipW, dipH } = geoOf(display);
  return normalizedRectToScreen(rect, {
    captureWidth: display.frameW,
    captureHeight: display.frameH,
    windowX: 0,
    windowY: 0,
    windowWidth: dipW,
    windowHeight: dipH,
  });
}

/** 归一化 y → 屏幕**物理像素**。 */
function toPhysical(y: number, display: DisplayScale): number {
  return y * display.frameH;
}

/** 一条标签的**基线**（字母 cap 带下沿，DIP）—— "三个标签在同一高度"最终看的就是它。 */
function baselineOf(rect: Rect, preset: AugmentBadgePreset, display: DisplayScale, text = 'S'): number {
  return labelBoxPlan(toDip(rect, display), {
    color: '#f7c948',
    textScale: preset.fontScale,
    style: 'tier',
    text,
  }).tier!.letter.textY;
}

/* ------------------------------------------------------------------ */
/* 两种跑法：修复后（锁）/ 修复前（每帧重算中位数）                        */
/* ------------------------------------------------------------------ */

interface LabelRow {
  readonly index: number;
  readonly augmentId: number | null;
  readonly text: string;
  readonly yDip: number;
  readonly yPhysical: number;
  readonly baselineDip: number;
}

interface RunResult {
  /** 每帧的每张标签（顺序同输入卡序）。 */
  readonly frames: ReadonlyArray<{ readonly label: string; readonly rows: readonly LabelRow[] }>;
  /** 相对**第一帧（开边沿）**的最大纵向位移（DIP）—— 修复后必须是 0。 */
  readonly maxShiftDip: number;
  /** 相对**第一帧**的最大基线位移（DIP）。 */
  readonly maxBaselineShiftDip: number;
}

/**
 * 按给定跑法跑完整段（开边沿 + 若干次重随），返回每帧的三条标签几何。
 *
 * `useLock = true` 走**局内真实路径**（`augmentTierLabelsLocked`，锁跨帧传递）；
 * `false` 走修复前的无锁形态（`augmentTierLabels`，每帧按当前卡片重算中位数）。
 */
function runFrames(
  frames: readonly ReplayFrame[],
  tiers: ReadonlyMap<number, string>,
  picks: ReadonlyMap<number, number>,
  preset: AugmentBadgePreset,
  display: DisplayScale,
  useLock: boolean,
): RunResult {
  let lock: LabelRowLock | null = null;
  const out: Array<{ label: string; rows: LabelRow[] }> = [];
  let maxShift = 0;
  let maxBaselineShift = 0;
  let first: readonly LabelRow[] | null = null;
  for (const frame of frames) {
    const input = frame.cards.map((c) => ({ rect: c.rect, augmentId: c.augmentId }));
    let labels;
    if (useLock) {
      const row = augmentTierLabelsLocked(lock, input, tiers, { preset, pickRates: picks });
      lock = row.rowLock;
      labels = row.labels;
    } else {
      labels = augmentTierLabels(input, tiers, { preset, pickRates: picks });
    }
    const rows: LabelRow[] = labels.map((l, i) => ({
      index: i,
      augmentId: l.augmentId,
      text: l.text,
      yDip: toDip(l.rect, display).y,
      yPhysical: toPhysical(l.rect.y, display),
      baselineDip: baselineOf(l.rect, preset, display, l.text),
    }));
    if (first === null && rows.length > 0) first = rows;
    if (first) {
      for (const [i, r] of rows.entries()) {
        const f = first[i];
        if (!f) continue;
        maxShift = Math.max(maxShift, Math.abs(r.yDip - f.yDip));
        maxBaselineShift = Math.max(maxBaselineShift, Math.abs(r.baselineDip - f.baselineDip));
      }
    }
    out.push({ label: frame.label, rows });
  }
  return { frames: out, maxShiftDip: maxShift, maxBaselineShiftDip: maxBaselineShift };
}

/** 打印一段回放：每帧每张卡的 y / 基线 + 与**上一帧**的位移。 */
function printRun(name: string, frames: readonly ReplayFrame[], run: RunResult): void {
  console.log(`\n【${name}】`);
  let prev: readonly LabelRow[] | null = null;
  for (const [fi, f] of run.frames.entries()) {
    const input = frames[fi]!;
    console.log(`  帧 ${fi + 1}（${input.label}）${input.origin === 'reroll' ? ' ← 单卡刷新' : ' ← 开边沿'}`);
    if (f.rows.length === 0) {
      console.log('     （这一帧一张都没画）');
      prev = f.rows;
      continue;
    }
    for (const r of f.rows) {
      const p = prev?.[r.index];
      const dy = p ? r.yDip - p.yDip : 0;
      const db = p ? r.baselineDip - p.baselineDip : 0;
      console.log(
        `    卡${r.index + 1} 字母 ${r.text.padEnd(2)} y=${r.yDip.toFixed(2)} DIP（${r.yPhysical.toFixed(1)} 物理px）` +
          `  基线 ${r.baselineDip.toFixed(2)} DIP` +
          (p ? `   Δy(上一帧) ${dy >= 0 ? '+' : ''}${dy.toFixed(3)}  Δ基线 ${db >= 0 ? '+' : ''}${db.toFixed(3)}` : ''),
      );
    }
    prev = f.rows;
  }
  console.log(
    `  ⇒ 相对开边沿的最大位移：y ${run.maxShiftDip.toFixed(6)} DIP（${(run.maxShiftDip * 1.5).toFixed(3)} 物理px）` +
      `，基线 ${run.maxBaselineShiftDip.toFixed(6)} DIP`,
  );
}

/* ------------------------------------------------------------------ */
/* 数据 ①：验收报告那一帧的矩形组合（用户给的数字，硬编码）                 */
/* ------------------------------------------------------------------ */

/** 开边沿冻结的三张卡矩形（卡 1/2/3，两张逐位相同 = 真机常态）。 */
const FROZEN: readonly Rect[] = [
  { x: 0.29735271614384085, y: 0.1917050736842105, w: 0.12501912777352715, h: 0.460610379679144 },
  { x: 0.43981637337413926, y: 0.1917050736842105, w: 0.12501912777352715, h: 0.460610379679144 },
  { x: 0.5812921053812845, y: 0.1917050736842105, w: 0.12501912777352715, h: 0.460610379679144 },
];

/** 重随那一刻检测到的矩形（**翻牌动画中间帧**）：y 更小、h 更大。 */
const ANIMATION: Rect = { x: 0.5812921053812845, y: 0.17287065943116413, w: 0.12637597349980165, h: 0.4976025273475413 };

/** 把某张卡换成"动画帧矩形"（x 用这一张卡自己的）。 */
function animated(i: number): Rect {
  return { ...ANIMATION, x: FROZEN[i]!.x };
}

const ACCEPTANCE_TIERS = new Map<number, string>([
  [1136, 'S'],
  [2073, 'A'],
  [1112, 'C'],
  [1305, 'B'],
  [1333, 'A'],
  [1386, 'S'],
]);
const ACCEPTANCE_PICKS = new Map<number, number>([
  [1136, 0.1214],
  [2073, 0.0731],
  [1112, 0.1993],
  [1305, 0.0173],
  [1333, 0.0389],
  [1386, 0.001],
]);

const ACCEPTANCE_FRAMES: readonly ReplayFrame[] = [
  {
    label: '开边沿：三张冻结矩形 → 锁定基准',
    origin: 'open',
    cards: [
      { rect: FROZEN[0]!, augmentId: 1136 },
      { rect: FROZEN[1]!, augmentId: 2073 },
      { rect: FROZEN[2]!, augmentId: 1112 },
    ],
  },
  {
    label: '卡3 刷新（重随那一刻的检测矩形是动画帧）',
    origin: 'reroll',
    cards: [
      { rect: FROZEN[0]!, augmentId: 1136 },
      { rect: FROZEN[1]!, augmentId: 2073 },
      { rect: animated(2), augmentId: 1305 },
    ],
  },
  {
    label: '卡2 也刷新（三张里两张已是动画矩形 → 中位数在这一步被带走）',
    origin: 'reroll',
    cards: [
      { rect: FROZEN[0]!, augmentId: 1136 },
      { rect: animated(1), augmentId: 1333 },
      { rect: animated(2), augmentId: 1305 },
    ],
  },
  {
    label: '卡1 也刷新（三张全换过内容）',
    origin: 'reroll',
    cards: [
      { rect: animated(0), augmentId: 1386 },
      { rect: animated(1), augmentId: 1333 },
      { rect: animated(2), augmentId: 1305 },
    ],
  },
];

/* ------------------------------------------------------------------ */
/* 数据 ②：真机产物 debug/augment/report.json（存在才回放）               */
/* ------------------------------------------------------------------ */

interface ReportJson {
  readonly display?: { readonly scaleFactor?: number; readonly bounds?: { readonly width?: number; readonly height?: number } };
  readonly windowPhysical?: { readonly width?: number; readonly height?: number };
  readonly recognized?: ReadonlyArray<{
    readonly atMs?: number;
    readonly ok?: boolean;
    readonly origin?: string;
    readonly refreshed?: readonly number[];
    readonly width?: number;
    readonly height?: number;
    readonly cards?: ReadonlyArray<{ readonly rect?: Rect; readonly augmentId?: number | null }>;
  }>;
  readonly labels?: {
    readonly preset?: { readonly size?: string };
    readonly events?: ReadonlyArray<{
      readonly atMs?: number;
      readonly origin?: string;
      readonly refreshed?: readonly number[];
      readonly items?: ReadonlyArray<{
        readonly augmentId?: number | null;
        readonly tier?: string | null;
        readonly pickRate?: number | null;
      }>;
    }>;
  };
}

interface ReportReplay {
  readonly frames: readonly ReplayFrame[];
  readonly tiers: ReadonlyMap<number, string>;
  readonly picks: ReadonlyMap<number, number>;
  readonly preset: AugmentBadgePreset;
  readonly display: DisplayScale;
  readonly file: string;
}

/** 真机报告 → 回放输入（卡片矩形的合并语义与局内 `mergeRefreshedCards()` 一致）。 */
function replayFromReport(file: string): ReportReplay | null {
  if (!existsSync(file)) return null;
  const raw = JSON.parse(readFileSync(file, 'utf8')) as ReportJson;
  const recognized = raw.recognized ?? [];
  if (recognized.length === 0) return null;

  // 档位/选取率直接取产物里那两张表（离线复盘不必再读 data/）
  const tiers = new Map<number, string>();
  const picks = new Map<number, number>();
  for (const ev of raw.labels?.events ?? []) {
    for (const it of ev.items ?? []) {
      const id = it.augmentId;
      if (typeof id !== 'number') continue;
      if (typeof it.tier === 'string' && it.tier !== '' && !tiers.has(id)) tiers.set(id, it.tier);
      if (typeof it.pickRate === 'number' && Number.isFinite(it.pickRate)) picks.set(id, it.pickRate);
    }
  }

  const first = recognized[0]!;
  const display: DisplayScale = {
    frameW: first.width ?? 3440,
    frameH: first.height ?? 1440,
    // DIP 高 = 产物里的 windowPhysical.height（真机 960）；帧高 ÷ DIP 高 = 缩放倍率
    scale: (first.height ?? 1440) / (raw.windowPhysical?.height ?? (first.height ?? 1440) / (raw.display?.scaleFactor ?? 1.5)),
  };

  const frames: ReplayFrame[] = [];
  let current: ReplayCard[] = [];
  for (const rec of recognized) {
    // ⚠️ 这里刻意用**产物里记下的检测矩形**：旧代码就是把它直接当标签矩形用的，
    //    所以这一段回放正好是"最坏输入"（动画帧矩形）—— 证明修复后也动不了。
    const fresh: ReplayCard[] = (rec.cards ?? []).flatMap((c) =>
      c.rect ? [{ rect: c.rect, augmentId: c.augmentId ?? null }] : [],
    );
    if (rec.origin === 'reroll') {
      for (const [k, idx] of (rec.refreshed ?? []).entries()) {
        const f = fresh[k];
        if (f && Number.isInteger(idx) && idx >= 0 && idx < current.length) current[idx] = f;
      }
    } else {
      current = fresh;
    }
    frames.push({
      label: `${rec.origin === 'reroll' ? `卡 ${(rec.refreshed ?? []).map((i) => i + 1).join('/')} 刷新` : '开边沿'}（@${rec.atMs ?? 0}ms，${rec.ok === false ? '未命中' : '成功'}）`,
      origin: rec.origin === 'reroll' ? 'reroll' : 'open',
      // 快照：后续帧会继续改 current，历史帧必须留自己的那一份
      cards: current.map((c) => ({ rect: c.rect, augmentId: c.augmentId })),
    });
  }

  const size = raw.labels?.preset?.size;
  const preset =
    size === 'medium' || size === 'large' || size === 'small'
      ? AUGMENT_BADGE_PRESETS[size]
      : AUGMENT_BADGE_PRESETS[AUGMENT_BADGE_DEFAULT];

  return { frames, tiers, picks, preset, display, file };
}

/* ------------------------------------------------------------------ */
/* 跑                                                                    */
/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const reportArg = argv.indexOf('--report');
if (reportArg >= 0 && !argv[reportArg + 1]) {
  console.error('✗ --report 后面要给路径（例：--report debug/augment/report.json）');
  process.exit(2);
}
const reportPath = reportArg >= 0 ? argv[reportArg + 1]! : join('debug', 'augment', 'report.json');
const reportFile = isAbsolute(reportPath) ? reportPath : join(process.cwd(), reportPath);

const preset = AUGMENT_BADGE_PRESETS[AUGMENT_BADGE_DEFAULT];
console.log('整排行基准（y / h）的**锁定**规则回放 —— 用户："某次单卡刷新后，三个标签整体下移了一点"');
console.log(
  `  默认档「${preset.name}」${preset.width}×${preset.height} 卡内、距底 ${preset.marginY}；` +
    `zone.y=${augmentBadgeZone(preset).y.toFixed(6)}（框顶占卡高）`,
);
console.log('  线上路径 = augmentTierLabelsLocked()：基准在开边沿锁一次，刷新只改内容');
console.log('  对照（修复前）= augmentTierLabels()：每帧按这一排卡片矩形的中位数重算');

let failed = false;

/* ① 验收报告那一帧的矩形组合 */
console.log('\n' + '='.repeat(78));
console.log('① 验收报告那一帧的矩形组合（用户给的数字：冻结 y=0.191705 h=0.460611 / 动画 y=0.172871 h=0.497603）');
console.log('='.repeat(78));
const accLocked = runFrames(ACCEPTANCE_FRAMES, ACCEPTANCE_TIERS, ACCEPTANCE_PICKS, preset, DEFAULT_DISPLAY, true);
printRun('修复后：行基准锁（局内真实路径）', ACCEPTANCE_FRAMES, accLocked);
const accUnlocked = runFrames(ACCEPTANCE_FRAMES, ACCEPTANCE_TIERS, ACCEPTANCE_PICKS, preset, DEFAULT_DISPLAY, false);
printRun('修复前：每帧重算中位数（对照，应当复现"整体下移"）', ACCEPTANCE_FRAMES, accUnlocked);
console.log(
  `\n  结论①：修复后位移 **${accLocked.maxShiftDip.toFixed(6)} DIP**（${(accLocked.maxShiftDip * 1.5).toFixed(3)} 物理px）` +
    `，基线位移 **${accLocked.maxBaselineShiftDip.toFixed(6)} DIP**；` +
    `修复前是 ${accUnlocked.maxShiftDip.toFixed(3)} DIP（${(accUnlocked.maxShiftDip * 1.5).toFixed(2)} 物理px）→ 这就是用户看到的下移。`,
);
if (accLocked.maxShiftDip !== 0 || accLocked.maxBaselineShiftDip !== 0) failed = true;

/* ② 真机产物 report.json */
const replay = replayFromReport(reportFile);
if (replay) {
  console.log('\n' + '='.repeat(78));
  console.log(`② 真机产物回放：${replay.file}`);
  console.log(`   输入矩形 = 产物里记下的**检测矩形**（旧代码就是把它当标签矩形用 → 最坏输入）`);
  console.log('='.repeat(78));
  const locked = runFrames(replay.frames, replay.tiers, replay.picks, replay.preset, replay.display, true);
  printRun('修复后：行基准锁（局内真实路径）', replay.frames, locked);
  const unlocked = runFrames(replay.frames, replay.tiers, replay.picks, replay.preset, replay.display, false);
  printRun('修复前：每帧重算中位数（对照）', replay.frames, unlocked);
  console.log(
    `\n  结论②：修复后位移 **${locked.maxShiftDip.toFixed(6)} DIP**（${(locked.maxShiftDip * 1.5).toFixed(3)} 物理px）` +
      `；修复前 ${unlocked.maxShiftDip.toFixed(3)} DIP（${(unlocked.maxShiftDip * 1.5).toFixed(2)} 物理px）。`,
  );
  if (locked.maxShiftDip !== 0 || locked.maxBaselineShiftDip !== 0) failed = true;
} else {
  console.log(`\n（跳过真机产物回放：找不到 ${reportPath}）`);
}

console.log(
  failed
    ? '\n❌ 修复后的路径仍出现位移 —— 别上线，把这段输出发回来。'
    : '\n✅ 修复后 0 位移：行基准在开边沿锁定后，任何刷新/动画抖动都动不了它。',
);
process.exitCode = failed ? 1 : 0;
