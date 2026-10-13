/**
 * **golden（录制当时的 `report.json`）比对**：把一次回放的结论与录制现场逐项对表。
 *
 * 为什么单独成文件：这一段以前住在 `scripts/replay-session.mts` 里，`pnpm test`
 * 一行都覆盖不到 —— 而它恰恰**错了一整轮都没人发现**：录制器写的是
 * `report.json.labels = [ { atMs, origin, … } ]`（数组），比对代码读的是
 * `labels.events`（不存在）→ golden 的边沿永远是空数组，于是每次回放都打印
 * "边沿配对 命中 0 / golden 0 条" + "回放多出 N 条边沿"，而"golden 有、回放没有"
 * 这一类真问题**永远不会被报出来**（2026-10-12 拿真机会话复核时抓到）。
 *
 * 所以这里只做两件事：**宽松地读**（两代形状都认）与**双向地比**（两边多出来的都要报）。
 * 纯函数、不碰文件系统 —— 读文件是调用方的事（CLI 读会话目录，测试读字符串）。
 */

/** 录制产物里的一条"识别/标签"记录（只需要时刻与来源，用来配边沿）。 */
export interface GoldenRecognition {
  readonly atMs: number;
  readonly origin: string;
}

/** 录制产物里的一条单卡刷新事件。 */
export interface GoldenReroll {
  readonly atMs: number;
  readonly indexes: readonly number[];
}

export interface GoldenReport {
  /** golden 的来源（路径），报告里要写出来给人核实"比的是哪一份"。 */
  readonly source: string;
  readonly counts: {
    readonly foundFrames: number;
    readonly openEdges: number;
    readonly closeEdges: number;
  };
  /** 识别记录（`origin = open` 的那几条就是"整批识别"的时刻锚点）。 */
  readonly recognitions: readonly GoldenRecognition[];
  readonly rerolls: readonly GoldenReroll[];
  /** 采样数（`samples` / `counts` 都缺时给 null，用于"golden 是不是完整产物"的判断）。 */
  readonly samples: number | null;
}

function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  // ⚠️ 兼容 `{ events: [...] }` 这种包装形状：产物换过形状，比对不该跟着崩。
  if (v !== null && typeof v === 'object' && Array.isArray((v as { events?: unknown }).events)) {
    return (v as { events: unknown[] }).events;
  }
  return [];
}

function rows(v: unknown): Record<string, unknown>[] {
  return asArray(v).filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object');
}

/**
 * 解析录制当时的 `report.json`（控制器快照）。
 *
 * 只读回放对比用得上的字段；缺字段一律给空/0（**不抛**）—— 旧会话没有
 * `reroll` / `labels` 时应当退化成"这几项没法比"，而不是让整次回放失败。
 */
export function parseGoldenReport(text: string, source: string): GoldenReport {
  const o = JSON.parse(text) as Record<string, unknown>;
  const counts = (o['counts'] ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const reroll = (o['reroll'] ?? {}) as Record<string, unknown>;
  // ⚠️ 识别记录优先取 `recognized`（一定存在）；旧产物只有 `labels` 时退回它。
  const recogRows = rows(o['recognized']).length > 0 ? rows(o['recognized']) : rows(o['labels']);
  return {
    source,
    counts: {
      foundFrames: num(counts['foundFrames']),
      openEdges: num(counts['openEdges']),
      closeEdges: num(counts['closeEdges']),
    },
    recognitions: recogRows
      .filter((r) => typeof r['atMs'] === 'number')
      .map((r) => ({ atMs: r['atMs'] as number, origin: String(r['origin'] ?? '') })),
    rerolls: rows(reroll['events'])
      .filter((r) => typeof r['atMs'] === 'number')
      .map((r) => ({
        atMs: r['atMs'] as number,
        indexes: Array.isArray(r['indexes']) ? (r['indexes'] as number[]) : [],
      })),
    samples: typeof o['samples'] === 'number' ? (o['samples'] as number) : null,
  };
}

/** 回放侧的最小输入（只取比对需要的字段，方便单测直接造）。 */
export interface GoldenCompareInput {
  readonly edges: readonly { readonly atMs: number; readonly kind: 'open' | 'close' }[];
  readonly rerolls: readonly GoldenReroll[];
  readonly recognizeCalls: number;
  readonly counts: { readonly foundFrames: number; readonly openEdges: number; readonly closeEdges: number };
}

export interface GoldenCompareResult {
  readonly source: string;
  readonly toleranceMs: number;
  readonly goldenFoundFrames: number;
  readonly replayFoundFrames: number;
  readonly goldenOpenEdges: number;
  readonly replayOpenEdges: number;
  readonly goldenCloseEdges: number;
  readonly replayCloseEdges: number;
  /** golden 的识别条数 vs 回放的识别调用次数。 */
  readonly goldenRecognitions: number;
  readonly replayRecognizeCalls: number;
  readonly goldenRerolls: number;
  readonly replayRerolls: number;
  /** 时刻配上的单卡刷新条数（两边都在容差内）。 */
  readonly rerollMatched: number;
  /** golden 有、回放没有的单卡刷新（**这是硬指标**：漏检 = 玩家换了卡却没重认）。 */
  readonly rerollMissing: number;
  /** 回放多出来的单卡刷新（可能是误检，也可能是回放采样节奏更密）。 */
  readonly rerollExtra: number;
  /** 时刻配上「整批识别」记录的开边沿数。 */
  readonly openEdgeMatched: number;
  /** golden 的整批识别锚点里，回放找不到对应开边沿的条数。 */
  readonly openEdgeMissing: number;
  /** 回放有、golden 没有的开边沿条数。 */
  readonly openEdgeExtra: number;
  readonly diffs: readonly string[];
}

const mmss = (ms: number): string => {
  const s = Math.max(0, ms / 1000);
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
};

/**
 * 双向比对（**两边多出来的都要报**）。
 *
 * 「只遍历 golden」是审查发现过的假绿：回放多出来的边沿永远不会被报，
 * 于是 `diffs.length === 0` 会被误读成"两边等价"。
 *
 * 容差默认 1000ms：录制与回放的采样格点不同相（录制是门控自己的节奏，回放是
 * 帧库投递的时刻），同一个物理事件在两边的时刻天然差最多一个采样周期；
 * 再加录制侧 `report.json` 用的是**链路起点**时基、话路产物用**会话零点**时基（差
 * 一次 phase 轮询，通常 <2s）——所以这条容差只管"是不是同一个事件"，不管毫秒级对齐。
 */
export function compareGolden(
  replay: GoldenCompareInput,
  golden: GoldenReport,
  toleranceMs = 1000,
): GoldenCompareResult {
  const diffs: string[] = [];
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= toleranceMs;

  // ── 边沿：golden 的锚点是"整批识别"的那一刻（origin=open）──
  const goldenOpens = golden.recognitions.filter((r) => r.origin === 'open');
  const replayOpens = replay.edges.filter((e) => e.kind === 'open');
  let openEdgeMatched = 0;
  let openEdgeMissing = 0;
  for (const g of goldenOpens) {
    if (replayOpens.some((e) => near(e.atMs, g.atMs))) openEdgeMatched++;
    else {
      openEdgeMissing++;
      diffs.push(`golden 的整批识别 @${mmss(g.atMs)} 在回放里找不到对应开边沿（±${toleranceMs}ms）`);
    }
  }
  const openEdgeExtra = replayOpens.filter((e) => !goldenOpens.some((g) => near(g.atMs, e.atMs))).length;
  if (openEdgeExtra > 0) {
    diffs.push(
      `回放多出 ${openEdgeExtra} 条开边沿（golden 里没有）—— 没到面板就判开、或边沿时刻偏移超过容差`,
    );
  }

  // ── 单卡刷新：**这一项曾经每次都差 6392ms**（回放时基被整体平移），所以必须逐条比 ──
  let rerollMatched = 0;
  let rerollMissing = 0;
  const usedReplay = new Set<number>();
  for (const g of golden.rerolls) {
    const i = replay.rerolls.findIndex((r, idx) => !usedReplay.has(idx) && near(r.atMs, g.atMs));
    if (i >= 0) {
      usedReplay.add(i);
      rerollMatched++;
    } else {
      rerollMissing++;
      diffs.push(
        `golden 的单卡刷新 @${mmss(g.atMs)}（卡${g.indexes.join('/')}）在回放里找不到（±${toleranceMs}ms）`,
      );
    }
  }
  const rerollExtra = replay.rerolls.length - usedReplay.size;
  if (rerollExtra > 0) {
    diffs.push(`回放多出 ${rerollExtra} 次单卡刷新（golden 里没有）—— 阈值过松或基线漂移`);
  }

  // ── 计数 ──
  if (golden.counts.openEdges !== replay.counts.openEdges) {
    diffs.push(
      `面板出现次数不一致：golden ${golden.counts.openEdges} vs 回放 ${replay.counts.openEdges}` +
        '（帧库只覆盖录到的那些帧 —— 改了采样节奏时这里必然有差）',
    );
  }
  if (golden.counts.closeEdges !== replay.counts.closeEdges) {
    diffs.push(`面板消失次数不一致：golden ${golden.counts.closeEdges} vs 回放 ${replay.counts.closeEdges}`);
  }
  if (golden.counts.foundFrames !== replay.counts.foundFrames) {
    // 不必是 0：帧库覆盖不到的采样点会让回放少看/多看几帧。差得多才是问题。
    diffs.push(
      `认定面板的帧数不一致：golden ${golden.counts.foundFrames} vs 回放 ${replay.counts.foundFrames}` +
        '（±几帧是帧库格点不同相，差得多说明判据或帧库有问题）',
    );
  }

  return {
    source: golden.source,
    toleranceMs,
    goldenFoundFrames: golden.counts.foundFrames,
    replayFoundFrames: replay.counts.foundFrames,
    goldenOpenEdges: golden.counts.openEdges,
    replayOpenEdges: replay.counts.openEdges,
    goldenCloseEdges: golden.counts.closeEdges,
    replayCloseEdges: replay.counts.closeEdges,
    goldenRecognitions: golden.recognitions.length,
    replayRecognizeCalls: replay.recognizeCalls,
    goldenRerolls: golden.rerolls.length,
    replayRerolls: replay.rerolls.length,
    rerollMatched,
    rerollMissing,
    rerollExtra,
    openEdgeMatched,
    openEdgeMissing,
    openEdgeExtra,
    diffs,
  };
}
