/**
 * 回放 2999 **触发状态机**（不需要游戏 / Electron / 管理员 / 网络）
 *
 * 为什么需要它：`api-trigger.csv` 是录制工具在一局真实对局里逐秒记下的
 * `gameTime / level / isDead / respawnTimer / capture / pending / reason`。
 * 那份数据**能离线回答**"某一次海克斯为什么没抓到"，但在此之前没有任何脚本
 * 用过它（`diag-augment-stage-timeline.mts` 回放的是**阶段**，不是触发记账）。
 *
 * 本脚本把同一份数据喂给**线上那一份** `createAugmentTrigger()`
 * （`packages/vision/src/augment-trigger.ts`，与 `augment-controller.ts` 用的是它），
 * 打印：截屏窗口、每个 offer 的消耗时刻、结束时还欠哪几次，
 * 以及**与录制当时判定的差异清单**（改了状态机之后"哪几局会变"就看它）。
 *
 * 用法（三种输入都行）：
 *   node --experimental-strip-types scripts/replay-api-trigger.mts
 *   node --experimental-strip-types scripts/replay-api-trigger.mts debug/augment/api-trigger.csv
 *   node --experimental-strip-types scripts/replay-api-trigger.mts debug/sessions/<会话目录>
 *   … [--json] [--limit=20]
 *
 * 合规：只读本地文件。不注入、不读内存、不解析封包、不打开游戏进程句柄。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
  parseApiTraceCsv,
  parseTimelineCsv,
  replayApiTrigger,
  summarizeSession,
  type AugmentSessionApiSample,
  type AugmentSessionPanelEdge,
} from '../packages/vision/src/index.ts';

/* ------------------------------------------------------------------ */
/* 输入解析（csv 文件 或 会话目录）                                     */
/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const limitArg = argv.find((a) => a.startsWith('--limit='));
const limit = limitArg ? Math.max(1, Number(limitArg.split('=')[1]) || 20) : 20;
const targets = argv.filter((a) => !a.startsWith('--'));
const DEFAULT_CSV = 'debug/augment/api-trigger.csv';
const target = targets[0] ?? DEFAULT_CSV;

interface Loaded {
  readonly label: string;
  readonly samples: readonly AugmentSessionApiSample[];
  readonly edges: readonly AugmentSessionPanelEdge[];
  readonly notes: readonly string[];
}

/** `api.jsonl`（P2 起的新会话格式）→ 采样。 */
function parseJsonlSamples(text: string): AugmentSessionApiSample[] {
  const out: AugmentSessionApiSample[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    try {
      const o = JSON.parse(t) as AugmentSessionApiSample;
      if (typeof o.atMs === 'number' && typeof o.gameTime === 'number') out.push(o);
    } catch {
      /* 坏行跳过 */
    }
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

function parseJsonlEdges(text: string): AugmentSessionPanelEdge[] {
  const out: AugmentSessionPanelEdge[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    try {
      const o = JSON.parse(t) as AugmentSessionPanelEdge;
      if (typeof o.atMs === 'number' && (o.kind === 'open' || o.kind === 'close')) out.push(o);
    } catch {
      /* 坏行跳过 */
    }
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

function load(input: string): Loaded {
  if (!existsSync(input)) throw new Error(`找不到输入：${input}`);
  const notes: string[] = [];

  if (statSync(input).isDirectory()) {
    const apiJsonl = join(input, 'api.jsonl');
    const apiCsv = join(input, 'api-trigger.csv');
    const timelineCsv = join(input, 'timeline.csv');
    const edgesJsonl = join(input, 'edges.jsonl');

    let samples: AugmentSessionApiSample[] = [];
    if (existsSync(apiJsonl)) samples = parseJsonlSamples(readFileSync(apiJsonl, 'utf8'));
    else if (existsSync(apiCsv)) samples = parseApiTraceCsv(readFileSync(apiCsv, 'utf8'));
    else throw new Error(`${input} 里既没有 api.jsonl 也没有 api-trigger.csv`);

    let edges: AugmentSessionPanelEdge[] = [];
    if (existsSync(edgesJsonl)) {
      edges = parseJsonlEdges(readFileSync(edgesJsonl, 'utf8'));
    } else if (existsSync(timelineCsv)) {
      edges = parseTimelineCsv(readFileSync(timelineCsv, 'utf8')).edges;
      notes.push('边沿来自 timeline.csv（遗留留档；新会话请用 edges.jsonl）');
    } else {
      notes.push('**没有门控边沿** → 不会消耗任何 offer（消耗只发生在关边沿），只看窗口');
    }
    return { label: basename(input), samples, edges, notes };
  }

  if (/\.jsonl$/i.test(input)) {
    return { label: basename(input), samples: parseJsonlSamples(readFileSync(input, 'utf8')), edges: [], notes: [] };
  }
  return {
    label: basename(input),
    samples: parseApiTraceCsv(readFileSync(input, 'utf8')),
    edges: [],
    notes: ['csv 输入：没有门控边沿 → 不会消耗任何 offer（消耗只发生在关边沿），只看窗口'],
  };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

const sec = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const mmss = (ms: number): string => {
  const s = Math.max(0, ms / 1000);
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
};

const loaded = load(target);
const replay = replayApiTrigger({ samples: loaded.samples, edges: loaded.edges });

if (asJson) {
  console.log(
    JSON.stringify(
      {
        input: target,
        label: loaded.label,
        notes: loaded.notes,
        metrics: replay.metrics,
        windows: replay.windows,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

console.log(`\n──────── 触发状态机回放：${loaded.label} ────────`);
console.log(
  `采样 ${replay.metrics.samples} 条（${mmss(loaded.samples[0]?.atMs ?? 0)} ~ ` +
    `${mmss(loaded.samples.at(-1)?.atMs ?? 0)}）  门控边沿 ${replay.metrics.edges} 条`,
);
for (const n of loaded.notes) console.log(`  ⚠ ${n}`);

console.log(
  `\n截屏窗口 ${replay.metrics.windows} 个，累计开着 ${sec(replay.metrics.armedMs)}` +
    `（占整局 ${((replay.metrics.armedMs / Math.max(1, (loaded.samples.at(-1)?.atMs ?? 1))) * 100).toFixed(1)}%）` +
    `  第一次开：${replay.metrics.firstOpenAtMs === null ? '—' : mmss(replay.metrics.firstOpenAtMs)}`,
);
for (const [i, w] of replay.windows.entries()) {
  console.log(
    `  #${i + 1} ${mmss(w.openAtMs)} → ${w.closeAtMs === null ? '（到局末仍开）' : mmss(w.closeAtMs)}` +
      `  时长 ${w.closeAtMs === null ? '—' : sec(w.closeAtMs - w.openAtMs)}  面板出现 ${w.panelEdges} 次`,
  );
  console.log(`      开：${w.openReason}`);
  if (w.closeReason !== null) console.log(`      关：${w.closeReason}`);
}

console.log(`\noffer 消耗（门控关边沿 = 真的选完一次）`);
if (replay.metrics.consumed.length === 0) console.log('  （无）');
for (const c of replay.metrics.consumed) console.log(`  ${String(c.level).padStart(2)} 级 → ${mmss(c.atMs)}`);
if (replay.metrics.initDropped.length > 0) {
  console.log(
    `  中途启动丢弃：${replay.metrics.initDropped.map((d) => `${d.level} 级`).join('/')}` +
      '（工具起来晚了，那一次没看到，**不算选完**）',
  );
}
console.log(
  `  结束时仍欠：${replay.metrics.unconsumed.length === 0 ? '无（四个 offer 全部走完）' : `[${replay.metrics.unconsumed.join(', ')}] ← 这几次在本次回放里没有被消耗`}`,
);

if (replay.metrics.mismatchCount > 0) {
  console.log(
    `\n与录制判定不一致的采样：${replay.metrics.mismatchCount} 条` +
      `（**漏开** ${replay.metrics.missedRecorded} / **多开** ${replay.metrics.extraArmed}）`,
  );
  if (replay.metrics.missedRecorded > 0) {
    console.log('  ⚠ **漏开** = 录像开着截屏、回放却关着 → 会整整漏掉一次海克斯，必须查。');
  }
  if (loaded.edges.length === 0) {
    console.log(
      '  ⚠ 本次没有门控边沿 → "多开"系统性偏大（真机上关边沿会消耗并立刻关窗，这里只能靠 45s 超时）：\n' +
        '     差异清单本身不可用于评判阈值，只看**漏开**与窗口形态。',
    );
  } else {
    console.log('  （行为差异报告，不是失败：录像是历史版本的状态机跑的，改了状态机就会变）');
    for (const m of replay.metrics.mismatches.slice(0, limit)) {
      console.log(`  ${mmss(m.atMs)}  录制 capture=${m.recorded ? 1 : 0} → 回放 capture=${m.replayed ? 1 : 0}`);
    }
    if (replay.metrics.mismatchCount > limit) {
      console.log(`  …还有 ${replay.metrics.mismatchCount - limit} 条（--limit=N 看更多）`);
    }
  }
} else {
  console.log('\n与录制判定逐条一致（同一份状态机、同一份输入）。');
}

// 顺带一提会话摘要口径：目录输入时能一起报出来（数据不全就跳过）
if (statSync(target).isDirectory()) {
  try {
    const has = (f: string): boolean => existsSync(join(target, f));
    const idx = has('frames.idx.jsonl') ? readFileSync(join(target, 'frames.idx.jsonl'), 'utf8') : '';
    const frames = idx
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '')
      .flatMap((l) => {
        try {
          const o = JSON.parse(l) as { kind?: string; atMs?: number };
          return o.kind === 'gating' || o.kind === 'native'
            ? [{ kind: o.kind as 'gating' | 'native', atMs: o.atMs ?? 0 }]
            : [];
        } catch {
          return [];
        }
      });
    const s = summarizeSession({
      meta: { version: 1, trigger: 'api' },
      frames,
      api: loaded.samples,
      edges: loaded.edges,
      phase: [],
      rerolls: [],
    });
    console.log(
      `\n会话摘要：门控帧 ${s.frames.gating} / 原生帧 ${s.frames.native}，跨度 ${mmss(s.spanMs)}` +
        `（目录里还有 ${readdirSync(target).length} 个条目）`,
    );
  } catch {
    /* 摘要失败不影响主结论 */
  }
}
