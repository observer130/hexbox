/**
 * **会话闭环回放** CLI：把一局录制喂给线上同一个 `AugmentController`
 * （不需要游戏 / 管理员 / Electron；一局 20 分钟在几秒内跑完，且完全确定性）
 *
 * 用法（仓库根）：
 *   node --experimental-strip-types scripts/replay-session.mts                 # 合成会话（用入库的真机帧 + 真机 2999 采样）
 *   node --experimental-strip-types scripts/replay-session.mts debug/sessions/<会话目录>
 *   … [--json] [--golden=<report.json>] [--limit=25]
 *
 * 合成会话为什么存在：它把**已经入库的两样真机数据**（门控帧 fixture + 那一局的 2999
 * 采样）拼成一次会话，于是"门控 → 边沿 → 触发 → 节流"这条闭环在**没有任何录制**
 * 的情况下也能被跑通、被 CI 之外的人复现。真机会话（`debug/sessions/`）另外还带
 * 原生帧与身份留档，因此能一路跑到"标签"。
 *
 * 合规：只读本地文件 + 只跑本地纯函数。不注入、不读内存、不解析封包、不碰游戏进程。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import {
  parseApiTraceCsv,
  parseSessionMeta,
  replayApiTrigger,
  PANEL_ROW_REGION,
  type Rect,
} from '../packages/vision/src/index.ts';
import { loadSession, runReplaySession, type LoadedSession } from '../apps/overlay/src/replay/session-replay.ts';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const target = argv.find((a) => !a.startsWith('--'));
const goldenArg = argv.find((a) => a.startsWith('--golden='));
const limit = Number(argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? 25) || 25;

/* ------------------------------------------------------------------ */
/* 仓库根与 data/                                                      */
/* ------------------------------------------------------------------ */

function findRepoRoot(start: string): string {
  let dir = resolve(start);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return resolve(start);
}

const ROOT = findRepoRoot(process.cwd());
const DATA_DIR = join(ROOT, 'data');
const FIXTURE_DIR = join(ROOT, 'packages', 'vision', 'fixtures', 'augment-panel');
const API_FIXTURE = join(ROOT, 'packages', 'vision', 'fixtures', 'api-trace', 'kiwi-trigger-2026-10-05.csv');

const mmss = (ms: number): string => {
  const s = Math.max(0, ms / 1000);
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
};

/* ------------------------------------------------------------------ */
/* 合成会话                                                            */
/* ------------------------------------------------------------------ */

/**
 * 用入库的真机帧 + 真机 2999 采样拼一个会话（**只读**，不写任何文件）。
 *
 * 帧的时刻是刻意排的：让"面板出现 → 连续 2 帧命中 → 停留 → 消失"发生在一个
 * 死亡窗口里（与真机形态一致），这样门控边沿、触发记账、节流三件事都被走到。
 */
function syntheticSession(): LoadedSession {
  const manifestPath = join(FIXTURE_DIR, 'frames.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`缺 fixture：${manifestPath}（先跑 scripts/make-frame-fixtures.mts）`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    frames: Array<{
      file: string;
      region: Rect;
      altRegion: Rect;
      expectFound: boolean;
      reason?: string;
      builtReason: string;
      gateSize: string;
    }>;
  };
  const panelFrames = manifest.frames.filter((f) => f.expectFound);
  const closedFrame = manifest.frames.find((f) => !f.expectFound)!;
  if (panelFrames.length === 0) throw new Error('fixture 里没有正样本帧');

  // 那一局的 2999 采样（真机留档）
  const api = parseApiTraceCsv(readFileSync(API_FIXTURE, 'utf8'));
  /**
   * ⚠️ 面板帧必须排在"**触发状态机真的开了截屏**"的那个时刻之后：
   * 合成会话按 `api` 触发（常态零取帧），只有状态机开了窗才会取帧 ——
   * 排错位置就会得到"一帧都没取"的假象（第一版就踩了：把帧放在一次"等级还不够"的
   * 死亡旁边，整段回放 0 命中）。
   *
   * 所以这里先用**线上同一份触发状态机**（`replayApiTrigger`）离线算出这一局的第一个
   * 截屏窗口，再把面板帧放进窗口里。这样合成会话本身也是从真机数据推出来的。
   */
  const trig = replayApiTrigger({ samples: api });
  const win = trig.windows[0];
  if (!win) throw new Error('这份 2999 留档里没有任何截屏窗口，无法合成会话');
  const t0 = win.openAtMs + 500;

  const frames = [];
  let seq = 0;
  const cropOf = (file: string): Rect => {
    const f = manifest.frames.find((x) => x.file === file)!;
    return f.region.w < 1 ? unionRect(f.region, PANEL_ROW_REGION) : { x: 0, y: 0, w: 1, h: 1 };
  };
  const push = (atMs: number, file: string, found: boolean, reason: string): void => {
    frames.push({
      seq: seq++,
      atMs,
      kind: 'gating' as const,
      file,
      // fixture 的帧是**裁剪存档**（并集区域）→ 回放要按 crop 换算坐标
      crop: cropOf(file),
      found,
      reason,
    });
  };
  // 死亡之前：关闭态（api 模式下这些帧根本不会被取，占位而已）
  for (let i = 0; i < 3; i++) push(t0 - 3500 + i * 1000, closedFrame.file, false, closedFrame.builtReason);
  // 面板在屏：250ms 一帧（与线上"命中后高频"一致）
  for (let i = 0; i < 8; i++) {
    const f = panelFrames[i % panelFrames.length]!;
    push(t0 + i * 250, f.file, true, f.builtReason);
  }
  // 面板消失
  for (let i = 0; i < 3; i++) push(t0 + 2200 + i * 1000, closedFrame.file, false, closedFrame.builtReason);

  const first = manifest.frames[0]!;
  const [gw, gh] = first.gateSize.split('x').map(Number) as [number, number];
  const meta = parseSessionMeta(
    {
      version: 1,
      startedAt: 'synthetic',
      // **api 触发**：合成本来就要覆盖"常态零取帧 + 死亡开窗"这条主路径
      trigger: 'api',
      gating: { targetScale: 1 / 3, minWidth: 960, width: gw, height: gh },
      // 裁剪存档：帧库只覆盖并集区域
      frameCrop: unionRect(first.region, PANEL_ROW_REGION),
      region: first.region,
      altRegion: first.altRegion ?? PANEL_ROW_REGION,
      display: { width: 3441, height: 1440, scaleFactor: 1.5, workArea: { x: 0, y: 0, width: 3441, height: 1400 } },
      windowPhysical: null,
      data: null,
      champion: null,
      env: {},
    },
    { region: PANEL_ROW_REGION, altRegion: PANEL_ROW_REGION },
  );

  return {
    dir: FIXTURE_DIR,
    meta,
    frames,
    api: api.filter((s) => s.atMs >= win.openAtMs - 20_000 && s.atMs <= t0 + 40_000),
    edges: [],
    phase: [],
    notes: [
      '合成会话：门控帧取自入库真机 fixture（缩到 1/3 画布、灰度），2999 采样取自真机留档',
      '**没有原生帧** → 识别会明确报"缺原生帧"，所以这里只验证门控/触发/节流这一段',
      `面板帧排在 ${mmss(t0)}（= 线上触发状态机在这一局的第 1 个截屏窗口 +500ms，见 replayApiTrigger）`,
    ],
  };
}

function unionRect(a: Rect, b: Rect): Rect {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const session = target
    ? loadSession(isAbsolute(target) ? target : join(ROOT, target))
    : syntheticSession();

  const library = ((): readonly { augmentId: number; name: string; width: number; height: number; bits: Uint8Array }[] => {
    const path = join(DATA_DIR, 'augment-names.json');
    if (!existsSync(path)) return [];
    const arr = JSON.parse(readFileSync(path, 'utf8')) as Array<{
      id: number;
      name: string;
      width: number;
      height: number;
      bits: string;
    }>;
    return arr.map((e) => {
      const packed = Buffer.from(e.bits, 'base64');
      const bits = new Uint8Array(e.width * e.height);
      for (let i = 0; i < bits.length; i++) bits[i] = (packed[i >> 3]! >> (i & 7)) & 1;
      return { augmentId: e.id, name: e.name, width: e.width, height: e.height, bits };
    });
  })();

  const logLines: string[] = [];
  const report = await runReplaySession({
    session,
    library,
    dataDir: DATA_DIR,
    // 日志收进数组：默认不刷屏（--json 时更不该刷）；人读模式最后一起打
    log: (line) => logLines.push(line),
  });

  const snap = report.snapshot;
  const golden = goldenArg
    ? loadGolden(goldenArg.split('=')[1]!)
    : existsSync(join(session.dir, 'report.json'))
      ? loadGolden(join(session.dir, 'report.json'))
      : null;

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          session: { dir: session.dir, notes: report.notes, meta: report.meta },
          replay: {
            spanMs: report.endMs,
            elapsedRealMs: report.elapsedRealMs,
            frames: report.frames.length,
            gaps: report.gaps,
            edges: report.edges,
            recognizeCalls: report.recognizeCalls,
            labelsUnavailable: report.labelsUnavailable,
            labels: report.labels,
            counts: snap.counts,
            cadence: snap.cadence,
            trigger: snap.trigger,
            champion: snap.champion,
            reroll: { detected: snap.reroll.detected, events: snap.reroll.events },
            closeConfirm: snap.closeConfirm,
          },
          golden: golden ? compareGolden(report, golden) : null,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`\n──────── 会话闭环回放：${session.dir} ────────`);
  for (const n of report.notes) console.log(`  ⚠ ${n}`);
  console.log(
    `\n输入：门控帧 ${session.frames.filter((f) => f.kind === 'gating').length}` +
      ` / 原生帧 ${session.frames.filter((f) => f.kind === 'native').length}` +
      `、2999 采样 ${session.api.length} 条、边沿留档 ${session.edges.length} 条` +
      `、名字指纹库 ${library.length} 条` +
      `\n跨度 ${mmss(report.endMs)}，**真实耗时 ${report.elapsedRealMs}ms**（虚拟时钟：秒级跑完一局）`,
  );

  console.log(
    `\n门控：采样 ${report.frames.length} 帧（帧库唯一 ${report.uniqueFrames} 帧 / **重复投递 ${report.frameReuses} 次** / ` +
      `缺口 ${report.gaps} 次 / 过期丢弃 ${snap.counts.droppedStaleFrames} 帧）` +
      `、判定面板 ${snap.counts.foundFrames} 帧、面板出现 ${snap.counts.openEdges} 次 / 消失 ${snap.counts.closeEdges} 次`,
  );
  // ⚠️ "采样 N 帧"单独看不出其实只有 M 幅画面 —— 帧库决定保真度，所以这三个数必须一起读。
  if (report.frameReuses > 0 || report.maxFrameAgeMs > 500) {
    console.log(
      `  ℹ 帧库密度：重复投递 ${report.frameReuses} 次、最大帧龄 ${report.maxFrameAgeMs}ms` +
        `（帧库比请求的采样节奏稀疏 → **改节奏的结论要打折**）`,
    );
  }
  if (report.truncated) {
    console.log('  ⚠ 驱动器因上限提前收工（报告尾部可能少一段）—— 结论请打折');
  }
  const edgeLines = report.edges.slice(0, limit).map((e) => `${e.kind === 'open' ? '▶' : '◀'}${mmss(e.atMs)}`);
  console.log(`  边沿：${edgeLines.length > 0 ? edgeLines.join(' ') : '（无）'}`);
  console.log(
    `节流：常态 ${(snap.cadence.share.idle * 100).toFixed(0)}% / probe ${(snap.cadence.share.probe * 100).toFixed(0)}%` +
      ` / 高频 ${(snap.cadence.share.active * 100).toFixed(0)}%（常态 ${snap.cadence.idleMs}ms ↔ 高频 ${snap.cadence.activeMs}ms）`,
  );
  console.log(
    `触发：模式 ${snap.trigger.mode}、采样 ${snap.trigger.samples} 次、结束时 ${snap.trigger.captureAtEnd ? '仍开着截屏' : '常态不截屏'}` +
      `、待选 [${snap.trigger.pendingAtEnd.join(',')}]${snap.trigger.apiFallback ? '、⚠ 已退回像素节流' : ''}`,
  );
  console.log(
    `关闭确认：复检窗口 ${snap.closeConfirm.recheckMs}ms、假关闭作废 ${snap.closeConfirm.cancelled} 次` +
      `（>0 = 门控当场误判关闭并被作废，正是它该干的）`,
  );
  console.log(
    `单卡刷新：检出 ${snap.reroll.detected} 次` +
      (snap.reroll.events.length > 0
        ? `（${snap.reroll.events.map((e) => `${mmss(e.atMs)} 卡${e.indexes.join('/')} 距离 ${e.distance.join('/')}`).join('；')}）`
        : ''),
  );
  console.log(
    `识别：调用 ${report.recognizeCalls} 次` +
      (report.labelsUnavailable > 0 ? `，其中 ${report.labelsUnavailable} 次无法重跑（缺原生帧/原生帧过期）` : '') +
      (report.staleNativeFrames > 0 ? `（原生帧过期 ${report.staleNativeFrames} 次）` : ''),
  );
  console.log(
    `标签：推送 ${report.labels.filter((l) => l.active).length} 次 / 清空 ${report.labels.filter((l) => !l.active).length} 次` +
      (snap.champion.championId > 0 ? `、本局英雄 #${snap.champion.championId}（${snap.champion.source}）` : '、未认出英雄（会话无留档）'),
  );
  for (const l of report.labels.slice(0, limit)) {
    console.log(
      `    ${mmss(l.atMs)} ${l.active ? `画 ${l.texts.map((t, i) => `${t}${l.subs[i] ? `(${l.subs[i]})` : ''}`).join(' ')}` : `清空（${l.why}）`}`,
    );
  }

  if (golden) {
    const cmp = compareGolden(report, golden);
    console.log(`\n与 golden（${cmp.source}）对比：`);
    console.log(
      `  门控：golden 认定 ${cmp.goldenFoundFrames} 帧 / 回放 ${cmp.replayFoundFrames} 帧` +
        `　出现 ${cmp.goldenOpenEdges} vs ${cmp.replayOpenEdges} 次、消失 ${cmp.goldenCloseEdges} vs ${cmp.replayCloseEdges} 次`,
    );
    console.log(`  边沿配对（容差 ${cmp.toleranceMs}ms）：命中 ${cmp.edgeMatched} / golden ${cmp.goldenEdges} 条`);
    for (const d of cmp.diffs.slice(0, limit)) console.log(`    ${d}`);
  } else {
    console.log('\n（没有 golden：会话目录里放一份录制当时的 report.json 即可做逐项比对）');
  }

  console.log('\n控制器日志（前 %d 行）：', Math.min(limit, logLines.length));
  for (const line of logLines.slice(0, limit)) console.log(`    ${line}`);
}

/* ------------------------------------------------------------------ */
/* golden 比对（录制当时的 report.json）                                */
/* ------------------------------------------------------------------ */

interface Golden {
  readonly source: string;
  readonly counts: { foundFrames: number; openEdges: number; closeEdges: number };
  readonly edges: readonly { atMs: number; kind: 'open' | 'close' }[];
}

function loadGolden(path: string): Golden {
  const o = JSON.parse(readFileSync(path, 'utf8')) as {
    counts?: { foundFrames?: number; openEdges?: number; closeEdges?: number };
    labels?: { events?: Array<{ atMs: number; origin: string }> };
    samples?: number;
  };
  return {
    source: path,
    counts: {
      foundFrames: o.counts?.foundFrames ?? 0,
      openEdges: o.counts?.openEdges ?? 0,
      closeEdges: o.counts?.closeEdges ?? 0,
    },
    // 录制产物没有独立的边沿表：用"标签事件的时刻"当近似锚点（origin=open 就是开边沿）
    edges: (o.labels?.events ?? [])
      .filter((e) => e.origin === 'open')
      .map((e) => ({ atMs: e.atMs, kind: 'open' as const })),
  };
}

function compareGolden(
  report: Awaited<ReturnType<typeof runReplaySession>>,
  golden: Golden,
): {
  source: string;
  goldenFoundFrames: number;
  replayFoundFrames: number;
  goldenOpenEdges: number;
  replayOpenEdges: number;
  goldenCloseEdges: number;
  replayCloseEdges: number;
  goldenEdges: number;
  edgeMatched: number;
  toleranceMs: number;
  diffs: readonly string[];
} {
  const toleranceMs = 1000; // 录制是 1Hz 采样，边沿时刻本身有 ±1 个采样周期的粒度
  const diffs: string[] = [];
  // ⚠️ **双向**配对（审查发现）：只遍历 golden 的话，"回放多出来的边沿"永远不会被报，
  //    于是 `mismatchCount === 0` 被误读成"两边等价"。
  const near = (a: { atMs: number; kind: string }, b: { atMs: number; kind: string }): boolean =>
    a.kind === b.kind && Math.abs(a.atMs - b.atMs) <= toleranceMs;
  let matched = 0;
  for (const g of golden.edges) {
    if (report.edges.some((e) => near(e, g))) matched++;
    else diffs.push(`golden 的 ${g.kind} 边沿 @${mmss(g.atMs)} 在回放里找不到（±${toleranceMs}ms）`);
  }
  let replayOnly = 0;
  for (const e of report.edges) {
    if (!golden.edges.some((g) => near(g, e))) replayOnly++;
  }
  if (replayOnly > 0) {
    diffs.push(
      `回放多出 ${replayOnly} 条边沿（golden 里没有）—— 没到面板就判开、或边沿时刻偏移超过容差`,
    );
  }
  const counts = report.snapshot.counts;
  if (golden.counts.openEdges !== counts.openEdges) {
    diffs.push(
      `面板出现次数不一致：golden ${golden.counts.openEdges} vs 回放 ${counts.openEdges}` +
        '（帧库只覆盖录到的那些帧 —— 改了采样节奏时这里必然有差）',
    );
  }
  return {
    source: golden.source,
    goldenFoundFrames: golden.counts.foundFrames,
    replayFoundFrames: counts.foundFrames,
    goldenOpenEdges: golden.counts.openEdges,
    replayOpenEdges: counts.openEdges,
    goldenCloseEdges: golden.counts.closeEdges,
    replayCloseEdges: counts.closeEdges,
    goldenEdges: golden.edges.length,
    edgeMatched: matched,
    replayOnlyEdges: replayOnly,
    toleranceMs,
    diffs,
  };
}

/** 合成会话模式也会用到：把会话目录写出来供人工复核（`--dump=<dir>`）。 */
function dumpSession(dir: string, session: LoadedSession, frameSourceDir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.json'), JSON.stringify(session.meta, null, 2));
  writeFileSync(join(dir, 'frames.idx.jsonl'), session.frames.map((f) => JSON.stringify(f)).join('\n') + '\n');
  // 帧图也复制过去：会话格式的约定是“`file` 相对于**会话目录**”。
  // 不复制就会得到一个“看着像会话、实际拿不到帧”的目录：
  // 回放时每一帧都解码失败 → “0 帧采样”（当场踩到过）。
  for (const f of session.frames) {
    const src = join(frameSourceDir, f.file);
    if (existsSync(src)) copyFileSync(src, join(dir, basename(f.file)));
  }
  writeFileSync(join(dir, 'api.jsonl'), session.api.map((s) => JSON.stringify(s)).join('\n') + '\n');
}

const dumpArg = argv.find((a) => a.startsWith('--dump='));
if (dumpArg) {
  const dir = dumpArg.split('=')[1]!;
  const dumped = target ? loadSession(target) : syntheticSession();
  dumpSession(dir, dumped, dumped.dir);
  console.log(`会话已写出：${dir}`);
} else {
  await main();
}
