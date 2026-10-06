/**
 * 时间轴回放：**局内链路 ⇄ 标签生命周期**（2026-10-06 真机缺陷的回归锁）
 *
 * 用户报的现象：上一轮修了"阶段读取失败被当成离开对局"之后，变成
 * "**面板刚弹出、标签刚画上，随即被清掉**"（比"几秒后才消失"更严重）。
 *
 * 这一组把"阶段轮询序列 + 面板状态"喂给**线上同一份纯函数**
 * （`createStageGate` / `augmentChainTransition` / `labelProducerFor` /
 * `augmentStartIsStale` / `augmentStopClearsLabels` / `createPanelTracker`），
 * 按主进程 `pollOnce()` 的顺序逐轮跑，锁住两条硬性质：
 *
 *   ① **局内阶段稳定读到时 `stop` 必须是 0 次**（振荡 = 每次 stop 都可能清标签）；
 *   ② 标签只由「面板关闭边沿」与「确认离开对局（阶段换手）」清空 ——
 *      **链路停止本身不清标签**。
 *
 * 最后一条"改前对照"把 bug 的机制钉在测试里：`staleStartRule: 'stop-current'`
 * + `chainStopClears: true` 就是改前的两行代码，去掉修复它立刻回来。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AUGMENT_CLEAR_REASONS, type AugmentClearReason } from './augment-clear.ts';
import {
  replayAugmentTimeline,
  type AugmentTimelineOptions,
  type AugmentTimelineReport,
  type AugmentTimelineStep,
} from './augment-timeline.ts';

/** 生成 `count` 轮同样的读数。 */
function rep(sample: string | null, count: number, panelFound?: boolean): AugmentTimelineStep[] {
  return new Array(count).fill(null).map(() => ({ sample, panelFound }));
}

/**
 * **标签画上之后**发生过的清空。
 *
 * 为什么不用 `report.clears.length`：进入对局那一刻的**换手清空**是正确且必要的
 * （它清的是选人/大厅遗留的标签，那时局内一张标签都还没有）。这一组要锁的是
 * "标签在屏期间不许被清"，所以从首次出现标签那一轮开始算。
 */
function clearsAfterFirstLabel(r: AugmentTimelineReport): readonly AugmentClearReason[] {
  const first = r.rounds.findIndex((x) => x.labelsOnScreen);
  if (first < 0) return [];
  return r.rounds.slice(first).flatMap((x) => [...x.clears]);
}

/** 改前的两条规则（对照用；见文件头注）。 */
const BEFORE: AugmentTimelineOptions = { staleStartRule: 'stop-current', chainStopClears: true };

/** 一局的常规开头：大厅 2 轮 → 对局。 */
function intoGame(inGameRounds: number, panelFound?: boolean): AugmentTimelineStep[] {
  return [...rep('None', 2), ...rep('InProgress', inGameRounds, panelFound)];
}

test('回放：正常一局（大厅 → 选人 → 局内 60 轮 → 大厅）— 局内只 start 一次', () => {
  const r = replayAugmentTimeline(
    [...rep('None', 2), ...rep('ChampSelect', 3), ...rep('InProgress', 60, false), ...rep('None', 3)],
    { startRounds: 3 },
  );
  assert.equal(r.starts, 1, '局内只允许起一次链路');
  assert.equal(r.stops, 1, '只有真的离开才停一次');
  assert.equal(r.stopsWhileInGame, 0, '局内阶段上的 stop 必须是 0');
  assert.equal(r.staleStops, 0);
  // 清空：选人换手 + 进入局内换手 + 最后确认离开换手
  assert.deepEqual(r.clears, [
    AUGMENT_CLEAR_REASONS.stageHandover,
    AUGMENT_CLEAR_REASONS.stageHandover,
    AUGMENT_CLEAR_REASONS.stageHandover,
  ]);
  assert.equal(r.chainAlive, false, '离开后链路必须收工');
});

test('回放：局内穿插 1~2 次读失败（null）→ 0 stop / 0 清空（门保持阶段）', () => {
  const r = replayAugmentTimeline(
    [
      ...rep('None', 2),
      ...rep('InProgress', 3, false),
      { sample: null, panelFound: false },
      ...rep('InProgress', 1, false),
      { sample: null, panelFound: false },
      ...rep('InProgress', 4, true),
    ],
    { startRounds: 1 },
  );
  assert.equal(r.stops, 0, '读失败不是离开对局');
  assert.equal(r.stopsWhileInGame, 0);
  assert.deepEqual(clearsAfterFirstLabel(r), [], '一次读失败绝不许清标签');
  assert.equal(r.labelsOnScreen, true, '面板还开着 → 标签必须还在');
  // 那两轮的阶段被门"保持"住了（held）
  assert.equal(r.rounds.filter((x) => x.sample === null && x.held).length, 2);
});

test('回放：局内"疑似离开 1 次又回来"→ 不许 stop（离开要连续 2 次确认）', () => {
  const r = replayAugmentTimeline(
    [...rep('None', 2), ...rep('InProgress', 3, false), { sample: 'None' }, ...rep('InProgress', 3, true)],
    { startRounds: 1 },
  );
  assert.equal(r.stops, 0, '单次抖动不许停链路');
  assert.deepEqual(clearsAfterFirstLabel(r), []);
  assert.equal(r.labelsOnScreen, true);
});

test('★回归：InProgress 稳定 + 启动跨多个轮询周期 → 全程 stop = 0、标签不被清空', () => {
  // 真机冷启动要 ~10 秒（探窗口 + 建流 + 等就绪）= 5 个轮询周期；期间阶段一直
  // 读到 InProgress。改前这里没有任何问题，但它必须**继续**没有任何问题。
  const r = replayAugmentTimeline(
    [
      ...rep('None', 2),
      ...rep('InProgress', 8, false),
      ...rep('InProgress', 6, true),
    ],
    { startRounds: 5 },
  );
  assert.equal(r.starts, 1);
  assert.equal(r.stops, 0, '阶段稳定在局内时一次都不许停');
  assert.equal(r.stopsWhileInGame, 0);
  assert.deepEqual(clearsAfterFirstLabel(r), [], '标签画上之后一次都不许被清');
  assert.equal(r.labelsOnScreen, true, '面板还开着 → 标签一直在');
  assert.equal(r.chainAlive, true);
  // 启动确实跨了多个轮询周期（前 5 轮都在 starting）
  assert.equal(r.rounds.filter((x) => x.state === 'starting').length >= 5, true);
});

test('★回归：面板开着时"链路停止"不清标签；**面板关闭边沿**才清', () => {
  // ① 面板开 → ② 连续多帧未认定（关闭边沿）→ 清空，原因是「面板关闭边沿」。
  // 这里喂 6 帧「未认定」，比任何一版关闭确认帧数都多 —— 本用例要锁的是
  // "关闭边沿会清、链路停止不会清"，不是具体几帧（那是 augment-panel 的事）。
  const r = replayAugmentTimeline(
    [
      ...rep('None', 2),
      ...rep('InProgress', 2, false),
      ...rep('InProgress', 4, true), // 面板在屏（第 2 帧起开边沿）
      ...rep('InProgress', 6, false), // 连续未认定 → 关闭边沿
    ],
    { startRounds: 1 },
  );
  assert.equal(r.clears.at(-1), AUGMENT_CLEAR_REASONS.panelClosed);
  assert.equal(r.labelsOnScreen, false, '关闭边沿必须把标签清掉（底线行为）');
  // 关键：**没有任何一次**「链路停止」清空
  assert.equal(r.clears.includes(AUGMENT_CLEAR_REASONS.chainStop), false);
  assert.equal(r.stops, 0);
});

test('★回归：过期的启动回调只忽略自己那一代 → 面板开着时标签不被清', () => {
  // 冷启动很慢（跨 14 轮）+ 启动窗口内"确认离开又回来"（读失败风暴）
  // → 新一代已经就绪并画上标签时，旧一代的回调才落地。
  const steps: AugmentTimelineStep[] = [
    ...rep('None', 2),
    ...rep('InProgress', 2, false), // 第 1 次启动（冷启动：14 轮）
    ...rep(null, 5, false), // 读失败风暴 → 门认输 → 当作离开
    ...rep('InProgress', 4, false), // 第 2 次启动（热启动：4 轮）
    ...rep('InProgress', 6, true), // 面板弹出 → 开边沿 → 画标签
  ];
  const fixed = replayAugmentTimeline(steps, { startRounds: [14, 4] });
  assert.equal(fixed.staleIgnored, 1, '旧一代的回调必须被识别为过期并忽略');
  assert.equal(fixed.staleStops, 0, '**绝不**看到新世代就去 stop');
  assert.equal(fixed.stopsWhileInGame, 0, '局内阶段上不许有 stop');
  assert.equal(fixed.labelsOnScreen, true, '面板还开着 → 标签必须还在');
  assert.equal(fixed.chainAlive, true, '新一代的链路必须活着（改前会被旧一代收掉）');
  assert.equal(fixed.clears.includes(AUGMENT_CLEAR_REASONS.chainStop), false);
});

test('对照（**改前**）：过期回调"看到新世代就 stop" + 链路停止清标签 → 面板开着标签被清掉', () => {
  // 同一段时间轴，只把两条改前的规则放回去 —— 这就是真机的"闪一下就没了"。
  const steps: AugmentTimelineStep[] = [
    ...rep('None', 2),
    ...rep('InProgress', 2, false),
    ...rep(null, 5, false),
    ...rep('InProgress', 4, false),
    ...rep('InProgress', 6, true),
  ];
  const before = replayAugmentTimeline(steps, {
    ...BEFORE,
    startRounds: [14, 4],
  });
  assert.equal(before.staleStops, 1, '改前：过期回调会去 stop（把新一代一起收掉）');
  assert.equal(before.stopsWhileInGame, 1, '改前：局内阶段上出现了 stop（振荡证据）');
  assert.equal(
    before.clears.includes(AUGMENT_CLEAR_REASONS.chainStop),
    true,
    '改前：链路停止会清标签 → 用户看到"面板还开着、标签被清掉"',
  );
  // 面板在屏的那几轮里，标签被清掉了（改前就是这个症状）
  const clearedWhilePanelOpen = before.rounds.some(
    (x) =>
      x.stage === 'InProgress' &&
      x.clears.includes(AUGMENT_CLEAR_REASONS.chainStop) &&
      x.settled.some((s) => s === 'stale-stop'),
  );
  assert.equal(clearedWhilePanelOpen, true);
  // 修复后同一段时间轴：0 次 stop、0 次"链路停止"清空
  const fixed = replayAugmentTimeline(steps, { startRounds: [14, 4] });
  assert.equal(fixed.stopsWhileInGame, 0);
  assert.equal(fixed.clears.includes(AUGMENT_CLEAR_REASONS.chainStop), false);
});

test('回放：确认离开对局（连续 2 次）才换手清空 —— 第一次抖动只保持', () => {
  const r = replayAugmentTimeline(
    [...intoGame(3, true), { sample: 'None' }, ...rep('None', 2)],
    { startRounds: 1 },
  );
  const held = r.rounds.filter((x) => x.held && x.sample === 'None');
  assert.equal(held.length, 1, '第一次读到"不在对局"只保持');
  assert.equal(held[0]?.labelsOnScreen, true, '保持的那一轮标签不许被清');
  // 第二次才采纳 → 换手清空（标签在那一轮消失，链路收工）
  const confirmRound = r.rounds.find((x) => x.stage === 'None' && x.handover);
  assert.ok(confirmRound, '连续 2 次之后必须换手');
  assert.equal(confirmRound.clears.includes(AUGMENT_CLEAR_REASONS.stageHandover), true);
  assert.equal(r.labelsOnScreen, false);
  assert.equal(r.stops, 1, '确认离开才停链路（且只停一次）');
});

test('回放：面板开着期间阶段稳定不变 → 0 stop / 0 清空 / 标签一直在', () => {
  const r = replayAugmentTimeline([...intoGame(20, true)], { startRounds: 2 });
  assert.equal(r.stops, 0);
  assert.deepEqual(clearsAfterFirstLabel(r), []);
  assert.equal(r.labelsOnScreen, true);
  assert.equal(r.rounds.filter((x) => x.labelsOnScreen).length >= 15, true);
});
