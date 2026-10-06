/**
 * 局内链路 ⇄ 标签：**时间轴回放诊断**（不需要游戏、不需要 Electron）
 *
 * 用途（2026-10-06 真机缺陷："面板刚弹出、标签刚画上，随即被清掉"）：
 * 把"阶段轮询序列 + 面板状态"喂给**线上同一份纯函数**，打印每轮的动作与清空，
 * 并对比 **改前**（`--before`：在途启动"看到新世代就 stop" + 链路停止无条件清标签）
 * 与**现行为**（默认）。
 *
 *   node --experimental-strip-types scripts/diag-augment-stage-timeline.mts
 *   node --experimental-strip-types scripts/diag-augment-stage-timeline.mts --before
 *   node --experimental-strip-types scripts/diag-augment-stage-timeline.mts --scenario flash --before
 *
 * 关心的两条硬性质（`pnpm --filter @hexbox/vision test` 里也有断言）：
 *   ① 局内阶段稳定读到时 **stop 次数必须是 0**；
 *   ② 链路停止**不清**标签（清空只来自面板关闭边沿 / 阶段换手）。
 */

import {
  replayAugmentTimeline,
  type AugmentTimelineOptions,
  type AugmentTimelineReport,
  type AugmentTimelineStep,
} from '../packages/vision/src/augment-timeline.ts';

const before = process.argv.includes('--before');
const only = ((): string | null => {
  const i = process.argv.indexOf('--scenario');
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
})();

/** 生成 `count` 轮同样的读数。 */
function rep(sample: string | null, count: number, panelFound?: boolean): AugmentTimelineStep[] {
  return new Array(count).fill(null).map(() => ({ sample, panelFound }));
}

interface Scenario {
  readonly name: string;
  readonly what: string;
  readonly steps: readonly AugmentTimelineStep[];
  readonly options: AugmentTimelineOptions;
}

/** 改前的两条规则（对照用）。 */
const BEFORE: AugmentTimelineOptions = { staleStartRule: 'stop-current', chainStopClears: true };

const scenarios: readonly Scenario[] = [
  {
    name: 'normal',
    what: '正常一局：大厅 → 选人 → 局内（保持 60 轮）→ 大厅',
    steps: [
      ...rep('None', 2),
      ...rep('ChampSelect', 3),
      ...rep('InProgress', 60, false),
      ...rep('None', 3),
    ],
    options: { startRounds: 3 },
  },
  {
    name: 'read-fail',
    what: '局内穿插 2 次读失败（null）：门保持阶段，不许 stop / 不许清标签',
    steps: [
      ...rep('None', 2),
      ...rep('ChampSelect', 3),
      ...rep('InProgress', 3, false),
      { sample: null, panelFound: false },
      ...rep('InProgress', 1, false),
      { sample: null, panelFound: false },
      ...rep('InProgress', 3, true),
      ...rep('None', 3),
    ],
    options: { startRounds: 1 },
  },
  {
    name: 'blip-leave',
    what: '局内"疑似离开 1 次又回来"（离开要连续 2 次确认）：不许 stop',
    steps: [
      ...rep('None', 2),
      ...rep('InProgress', 3, false),
      { sample: 'None', panelFound: false },
      ...rep('InProgress', 3, true),
      ...rep('None', 3),
    ],
    options: { startRounds: 1 },
  },
  {
    name: 'slow-start',
    what: '★启动耗时跨越多个轮询周期（5 轮 = 10 秒）而阶段稳定是 InProgress',
    steps: [
      ...rep('None', 2),
      ...rep('InProgress', 8, false),
      ...rep('InProgress', 6, true),
      ...rep('None', 3),
    ],
    options: { startRounds: 5 },
  },
  {
    name: 'flash',
    what:
      '★真机症状复现：冷启动很慢（14 轮 = 28 秒）+ 启动窗口内"确认离开又回来"（读失败风暴）' +
      '→ 在途启动的回调落地时，新一代**已经画上标签**',
    steps: [
      ...rep('None', 2),
      // 第 2 轮进对局 → 第 1 次启动（冷启动很慢：14 轮）
      ...rep('InProgress', 2, false),
      // 客户端正在加载比赛：LCU 读失败风暴 → 门连输（5 次）→ 按"离开对局"处理
      ...rep(null, 5, false),
      // 读数恢复 → 重新进对局 → 第 2 次启动（热启动，快：4 轮）
      ...rep('InProgress', 4, false),
      // 面板在这里弹出（第 2 代已就绪）→ 开边沿 → 画标签
      ...rep('InProgress', 6, true),
      // 第 1 代（冷启动那条）的回调落地 → 改前：看到新世代就 stop（标签闪一下就没了）
      ...rep('None', 3, false),
    ],
    options: { startRounds: [14, 4] },
  },
  {
    name: 'panel-stable',
    what: '面板开着、阶段稳定不变：全程 0 次 stop、0 次清空；面板关闭边沿才清',
    steps: [
      ...rep('None', 2),
      ...rep('InProgress', 2, false),
      ...rep('InProgress', 4, true),
      ...rep('InProgress', 3, false),
      ...rep('InProgress', 2, false),
      ...rep('None', 3, false),
    ],
    options: { startRounds: 1 },
  },
];

function fmt(r: AugmentTimelineReport): string {
  const lines: string[] = [];
  for (const round of r.rounds) {
    const marks: string[] = [];
    if (round.held) marks.push('held');
    if (round.settled.length > 0) marks.push(`settle:${round.settled.join('+')}`);
    if (round.handover) marks.push('换手清空');
    if (round.panelEdge) marks.push(`面板${round.panelEdge === 'open' ? '开' : '关'}边沿`);
    if (round.clears.length > 0) marks.push(`🧹 ${round.clears.join('/')}`);
    if (round.labelsOnScreen) marks.push('标签在屏');
    lines.push(
      `  #${String(round.round).padStart(2)} ${(round.atMs / 1000).toFixed(0).padStart(3)}s ` +
        `读数=${String(round.sample).padEnd(11)} 阶段=${round.stage.padEnd(11)} ` +
        `动作=${round.action.padEnd(5)} 会话=${round.session} ${round.state.padEnd(8)} ` +
        `${round.chainAlive ? '链路活' : '链路停'} ${marks.join(' ')}`,
    );
  }
  return lines.join('\n');
}

let failed = 0;
for (const s of scenarios) {
  if (only !== null && only !== s.name) continue;
  const options: AugmentTimelineOptions = before ? { ...s.options, ...BEFORE } : s.options;
  const r = replayAugmentTimeline(s.steps, options);
  console.log(`\n════ ${s.name} ${before ? '（改前）' : '（现行为）'} ════`);
  console.log(`  ${s.what}`);
  console.log(fmt(r));
  console.log(
    `  ── 汇总：start=${r.starts} stop=${r.stops}（局内阶段上的 stop=${r.stopsWhileInGame}` +
      `，其中过期回调引发的=${r.staleStops}）被忽略的过期回调=${r.staleIgnored}` +
      ` 清空=${r.clearCount}${r.clearCount > 0 ? `（${r.clears.join(' → ')}）` : ''}` +
      ` 结束时标签${r.labelsOnScreen ? '在屏' : '不在屏'} 链路${r.chainAlive ? '活' : '停'}`,
  );
  // 硬性质：局内阶段稳定读到时不许 stop（改前会红，正是要证明的振荡）
  if (r.stopsWhileInGame > 0) {
    console.log(`  ⛔ 局内阶段上 stop 了 ${r.stopsWhileInGame} 次 —— 这就是"标签闪一下就没了"的来源`);
    failed++;
  }
}

console.log(
  `\n${before ? '【改前】' : '【现行为】'}` +
    (failed === 0
      ? ' ✅ 没有任何一次"局内阶段稳定读到时 stop"'
      : ` ⛔ ${failed} 个情形出现"局内阶段上的 stop"`),
);
process.exitCode = 0; // 诊断脚本永远返回 0（结论看输出）
