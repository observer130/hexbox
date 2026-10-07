/**
 * 选人阶段两个纯决策的测试（2026-10-11 真机：队友锁完之后顶栏抢走了生产者）
 *
 * 锁三件事：
 *   ① `parsePickState`：**找不到我的 pick 动作 = unknown**（不能默认成 picking）；
 *   ② `decideChampSelectStage`：我在 picking 时顶栏即使被队友填满，也必须走卡片分支；
 *   ③ unknown 时保留旧的顶栏兜底（不许因为修这个 bug 而丢掉"读不到 LCU 也能出标签"）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decideChampSelectStage, parsePickState } from './champ-select-stage.ts';

const action = (over: Partial<{ type: string; completed: boolean; actorCellId: number }> = {}) => ({
  type: 'pick',
  completed: false,
  actorCellId: 0,
  ...over,
});

test('pickState：我的 pick 动作未完成 → picking', () => {
  const d = parsePickState({
    localPlayerCellId: 0,
    actions: [action({ actorCellId: 0, completed: false }), action({ actorCellId: 3, completed: true })],
  });
  assert.equal(d.state, 'picking', '队友锁了不算我锁了');
});

test('pickState：我的 pick 动作已完成 → locked', () => {
  const d = parsePickState({
    localPlayerCellId: 2,
    actions: [action({ actorCellId: 2, completed: true })],
  });
  assert.equal(d.state, 'locked');
});

test('★ pickState：动作列表非空但**没有我的** pick 动作 → unknown（旧口径在这里错报 picking）', () => {
  const d = parsePickState({
    localPlayerCellId: 4,
    actions: [action({ actorCellId: 0, completed: true }), action({ actorCellId: 1, completed: true })],
  });
  assert.equal(d.state, 'unknown', '报成 picking 会让"已经锁定的界面"继续画卡片假标签');
  assert.match(d.reason, /没找到我的 pick 动作/);
});

test('pickState：没有我的格子 / 动作为空 / 动作类型不是 pick → unknown', () => {
  assert.equal(parsePickState({ localPlayerCellId: null, actions: [] }).state, 'unknown');
  assert.equal(parsePickState({ localPlayerCellId: 0, actions: [] }).state, 'unknown');
  assert.equal(
    parsePickState({
      localPlayerCellId: 0,
      actions: [action({ actorCellId: 0, type: 'ban', completed: true })],
    }).state,
    'unknown',
    '只有 pick 动作才算数（ban 完成不代表我选完了）',
  );
});

/* ------------------------------------------------------------------ */

test('★ 阶段：我还在 picking + 队友把顶栏填满（日志 701/706 那一幕）→ 仍然是卡片分支', () => {
  const d = decideChampSelectStage({ pickState: 'picking', topBarOccupiedCount: 3 });
  assert.equal(d.stage, 'cards', '顶栏占用是队友锁的，不能抢走我的三选一标签');
  assert.match(d.reason, /队友/);
  // 顶栏满格也一样
  assert.equal(decideChampSelectStage({ pickState: 'picking', topBarOccupiedCount: 10 }).stage, 'cards');
});

test('阶段：我锁定之后 → 顶栏分支（原来就这么对）', () => {
  const d = decideChampSelectStage({ pickState: 'locked', topBarOccupiedCount: 10 });
  assert.equal(d.stage, 'topbar');
});

test('阶段：unknown 时保留顶栏兜底（读不到 LCU 也能出标签）', () => {
  assert.equal(decideChampSelectStage({ pickState: 'unknown', topBarOccupiedCount: 4 }).stage, 'topbar');
  assert.equal(decideChampSelectStage({ pickState: 'unknown', topBarOccupiedCount: 0 }).stage, 'cards');
});

test('阶段：负数/小数占用不产生怪判定', () => {
  assert.equal(decideChampSelectStage({ pickState: 'unknown', topBarOccupiedCount: -3 }).stage, 'cards');
  assert.equal(decideChampSelectStage({ pickState: 'unknown', topBarOccupiedCount: 1.8 }).stage, 'topbar');
});

/* ------------------------------------------------------------------ */
/* ② 收尾：`第二阶段(picking)` 必须**构造上不可能**                     */
/* ------------------------------------------------------------------ */

test('★ 不变量：任何 pickState × 任何占用数，都不会在 picking 下走顶栏分支', () => {
  // 真机日志（打包版 0.1.0，修前）里出现过 30 行 `第二阶段(picking): 顶栏占用 N 格`
  // —— 那 30 行全部来自 `isPhase2 = 顶栏占用>0 || locked` 这个旧口径。
  // 现在 `vision-loop.ts` 只在 `stage === 'topbar'` 的分支里打印那一行，
  // 所以这条不变量成立 = `第二阶段(picking)` 在代码里不可达。
  const states = ['picking', 'locked', 'unknown'] as const;
  for (const pickState of states) {
    for (const occupied of [-1, 0, 1, 3, 9, 10, 99]) {
      const d = decideChampSelectStage({ pickState, topBarOccupiedCount: occupied });
      assert.ok(
        !(pickState === 'picking' && d.stage === 'topbar'),
        `picking + 占用 ${occupied} 竟然走了顶栏分支：${d.reason}`,
      );
    }
  }
});

test('★ 队友锁满 10 格也不能把"我还在选"翻成顶栏（与日志 701/706 同形）', () => {
  // 日志原样：`第二阶段(picking): 顶栏占用 1 格 … 3 格 … 10 格`（修前）
  for (const occupied of [0, 1, 2, 3, 9, 10]) {
    const d = decideChampSelectStage({ pickState: 'picking', topBarOccupiedCount: occupied });
    assert.equal(d.stage, 'cards', `占用 ${occupied} 格时被翻阶段了`);
    assert.equal(d.reason.includes('队友'), true, '原因必须写明"那是队友锁的"');
  }
});
