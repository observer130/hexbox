/**
 * 海克斯触发状态机测试
 *
 * 这些用例逐条对应真机上会发生的场景（尤其**连选**与**自愈**），
 * 因为"什么时候开截屏"一旦错，整局就白录了。
 *
 * 注意两处约定：
 *   · 需要"干净的四次待选"时传 `midGameStartSec: Number.MAX_SAFE_INTEGER`
 *     关掉"中途启动"初始化（真机默认会剔掉"开局"那次）；
 *   · `notePanelClosed` 即使当时没在开截屏也会消耗一次（门控报过就算弹过）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAugmentTrigger, type AugmentTriggerSample } from './augment-trigger.ts';

/** 造采样：默认活着、等级 3、对局 300 秒。 */
function sample(over: Partial<AugmentTriggerSample> = {}): AugmentTriggerSample {
  return { gameTime: 300, level: 3, isDead: false, respawnTimer: 0, ...over };
}

/** 关掉"中途启动"初始化 → 保留完整的 [0,7,11,15]。 */
const NO_MIDGAME = { midGameStartSec: Number.MAX_SAFE_INTEGER } as const;

/** 走一个"死亡 → 选完"的完整回合。 */
function deathAndPick(
  t: ReturnType<typeof createAugmentTrigger>,
  nowMs: number,
  level: number,
): { armed: boolean; afterClose: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const d1 = t.onSample(sample({ level, isDead: true, respawnTimer: 8, gameTime: nowMs / 1000 }), nowMs);
  reasons.push(d1.reason);
  const armed = d1.capture;
  t.notePanelOpen(nowMs + 500);
  const d2 = t.notePanelClosed(nowMs + 3000);
  reasons.push(d2.reason);
  return { armed, afterClose: d2.capture, reasons };
}

/** 开局：弹一次并选掉（真机路径）。 */
function startOffer(t: ReturnType<typeof createAugmentTrigger>, atMs = 1000): void {
  const d = t.onSample(sample({ gameTime: 5, level: 1 }), atMs);
  assert.equal(d.capture, true, '开局应开截屏');
  t.notePanelOpen(atMs + 300);
  t.notePanelClosed(atMs + 1500);
}

/* ------------------------------------------------------------------ */
/* 常态与开局                                                          */
/* ------------------------------------------------------------------ */

test('常态：升级未跨越待选等级 → 绝不开截屏', () => {
  // 关掉开局分支（startWindowSec: 0）以便只观察"升级"这一条规则
  const t = createAugmentTrigger({ midGameStartSec: Number.MAX_SAFE_INTEGER, startWindowSec: 0 });
  for (const level of [1, 3, 5, 6, 6]) {
    const d = t.onSample(sample({ level, gameTime: 60 + level * 30 }), level * 30000 + 1);
    assert.equal(d.capture, false, `等级 ${level} 未跨待选等级不应开截屏`);
  }
  assert.deepEqual(t.pending, [0, 7, 11, 15], '不开窗就不消耗任何待选');
});

/* ------------------------------------------------------------------ */
/* 升级定向开窗（2026-10-12 用户裁决；真机证据见 augment-trigger.ts 头注）   */
/* ------------------------------------------------------------------ */

test('升级到待选等级（未死亡）→ 定向开窗，reason 明确写出待选等级', () => {
  const t = createAugmentTrigger({ midGameStartSec: Number.MAX_SAFE_INTEGER, startWindowSec: 0 });
  const before = t.onSample(sample({ level: 6, gameTime: 200 }), 1000);
  assert.equal(before.capture, false, '6 级还没到待选等级');
  const up = t.onSample(sample({ level: 7, gameTime: 210 }), 11000);
  assert.equal(up.capture, true, '升级跨过 7 级 → 必须开一次窗');
  assert.equal(up.changed, true);
  assert.match(up.reason, /升级到待选等级 7/);
  assert.match(up.reason, /6→7/);
  assert.deepEqual(t.pending, [0, 7, 11, 15], '只是看一眼，不消耗待选');
});

test('升级窗口：没见到面板 → 到点自动关，pending 一个都不少（不许误消耗）', () => {
  const t = createAugmentTrigger({
    midGameStartSec: Number.MAX_SAFE_INTEGER,
    startWindowSec: 0,
    armWindowMs: 5000,
  });
  assert.equal(t.onSample(sample({ level: 7, gameTime: 200 }), 1000).capture, true);
  const late = t.onSample(sample({ level: 8, gameTime: 260 }), 30000);
  assert.equal(late.capture, false, '窗口到点必须自愈关闭');
  assert.deepEqual(t.pending, [0, 7, 11, 15], '未见到面板绝不允许消耗待选');
});

test('升级窗口：面板还开着时继续升级 → 保持开截屏，且不重置"见过面板"', () => {
  const t = createAugmentTrigger({ midGameStartSec: Number.MAX_SAFE_INTEGER, startWindowSec: 0 });
  assert.equal(t.onSample(sample({ level: 7, gameTime: 200 }), 1000).capture, true);
  t.notePanelOpen(1500);
  // 面板还开着时又升到 11 级（跨过 11）——不得重新 startCapture（那会清掉 sawPanel）
  const more = t.onSample(sample({ level: 11, gameTime: 220 }), 2000);
  assert.equal(more.capture, true);
  assert.match(more.reason, /已在开截屏/);
  const closed = t.notePanelClosed(3000);
  assert.match(closed.reason, /^选完/, `关边沿必须报"选完"：${closed.reason}`);
  // 关边沿消耗的是**最小够格**那次（这里是 0 = 开局那次，11 级时它够格）
  assert.deepEqual(t.pending, [7, 11, 15], '只消耗最小够格那一次');
});

test('升级开窗：没有未选 offer 时永不因升级开窗', () => {
  const t = createAugmentTrigger({
    offerLevels: [],
    midGameStartSec: Number.MAX_SAFE_INTEGER,
    startWindowSec: 0,
  });
  for (const level of [7, 11, 15, 18]) {
    const d = t.onSample(sample({ level, gameTime: 300 }), level * 1000);
    assert.equal(d.capture, false, `待选为空时等级 ${level} 不该开窗`);
  }
  assert.deepEqual(t.pending, []);
});

test('升级开窗：该等级已经选完 → 升级不再开窗（只记录）', () => {
  // 用 [7,11,15]（不含开局那次）以便"7 级选掉"以后待选里真的没有 7
  const t = createAugmentTrigger({
    offerLevels: [7, 11, 15],
    midGameStartSec: Number.MAX_SAFE_INTEGER,
    startWindowSec: 0,
  });
  t.onSample(sample({ level: 7, isDead: true, gameTime: 200 }), 1000);
  t.notePanelOpen(1500);
  t.notePanelClosed(2000); // 7 级选掉
  assert.deepEqual(t.pending, [11, 15]);
  // 升到 11：跨过待选等级 11 → 照常开窗（这是"该等级"本身还没选）
  const up11 = t.onSample(sample({ level: 11, gameTime: 260 }), 10000);
  assert.equal(up11.capture, true);
  assert.match(up11.reason, /升级到待选等级 11/);
  // 窗口一直没见到面板 → 到点自愈关闭（同等级再采一次即可触发超时判定）
  const expired = t.onSample(sample({ level: 11, gameTime: 320 }), 100000);
  assert.equal(expired.capture, false);
  assert.match(expired.reason, /窗口超时/);
  assert.deepEqual(t.pending, [11, 15], '超时不得消耗待选');
  // 已选掉的等级不再制造窗口：12 级不跨任何待选等级 → 只记录
  const d = t.onSample(sample({ level: 12, gameTime: 340 }), 200000);
  assert.equal(d.capture, false, '12 级不跨任何待选等级');
  assert.match(d.reason, /未跨待选等级/);
});

test('升级开窗：中途启动首帧就已在待选等级之上 → 开一次（覆盖"工具刚起就在 11 级"）', () => {
  const t = createAugmentTrigger(); // 默认 midGameStartSec=60
  const d = t.onSample(sample({ level: 11, gameTime: 420 }), 1000);
  assert.equal(d.capture, true);
  assert.match(d.reason, /升级到待选等级 7,11/);
  assert.deepEqual(t.pending, [7, 11, 15], '开局那次按已选处理（中途启动）');
});

test('开局：对局早期直接开截屏，选完关掉且消耗"开局"那一次', () => {
  const t = createAugmentTrigger(NO_MIDGAME);
  startOffer(t);
  const closed = t.notePanelClosed(4000); // 再报一次关（幂等：不该重复消耗）
  assert.equal(closed.capture, false);
  assert.deepEqual(t.pending, [7, 11, 15]);
});

test('中途启动：对局已进行到 300 秒 → 开局那次按已选处理（避免误判连选）', () => {
  const t = createAugmentTrigger();
  const d = t.onSample(sample({ gameTime: 300, level: 4 }), 1000);
  assert.equal(d.capture, false);
  assert.deepEqual(t.pending, [7, 11, 15], '开局那次应被剔除');
});

test('中途启动 + 首帧就是死亡：死亡事件不能被初始化吞掉（回归）', () => {
  const t = createAugmentTrigger();
  const d = t.onSample(sample({ gameTime: 300, level: 7, isDead: true, respawnTimer: 9 }), 1000);
  assert.equal(d.capture, true, '首帧死亡必须触发（曾因提前 return 被吞掉）');
  assert.deepEqual(t.pending, [7, 11, 15]);
});

/* ------------------------------------------------------------------ */
/* 开局窗口内的重复采样（真机记账错位回归，2026-10-11）                    */
/* ------------------------------------------------------------------ */

test('开局窗口：重复采样不得重复报"开截屏"，也不得清掉"见过面板"（关边沿必须报"选完"且消耗开局那次）', () => {
  const t = createAugmentTrigger(NO_MIDGAME);
  // 对局 5s：第一次采样开截屏
  const d5 = t.onSample(sample({ gameTime: 5, level: 1 }), 1000);
  assert.equal(d5.capture, true, '开局应开截屏');
  assert.equal(d5.changed, true, '第一次开截屏是一次变化');
  // 门控说"面板出现了"（真机 L213：▶ 面板出现 #1）
  t.notePanelOpen(1200);
  // 开局窗口内继续按 1 秒轮询（真机 5~25s ≈ 20 次）—— 改前每次都重新 startCapture()
  const d10 = t.onSample(sample({ gameTime: 10, level: 1 }), 2000);
  const d15 = t.onSample(sample({ gameTime: 15, level: 1 }), 3000);
  assert.equal(d10.capture, true);
  assert.equal(d15.capture, true);
  assert.equal(d10.changed, false, '已经在开截屏 → 不许再报一次变化（否则会被反复下发 IPC）');
  assert.equal(d15.changed, false);
  // 改前这里会是 `开局（对局 10s）：开截屏`（startCapture 覆写了 reason）
  for (const d of [d10, d15]) {
    assert.ok(!d.reason.endsWith('：开截屏'), `重复报"开截屏"：${d.reason}`);
    assert.match(d.reason, /已在开截屏/);
  }
  // 关边沿：因为 sawPanel 没被清掉，必须报"选完…"，并消耗掉开局那一次
  const closed = t.notePanelClosed(4000);
  assert.equal(closed.capture, false, '本次待选清空 → 关截屏');
  assert.match(closed.reason, /^选完/, `关边沿必须是"选完"而不是"未见面板即关闭"：${closed.reason}`);
  assert.deepEqual(t.pending, [7, 11, 15], '开局那次必须被消耗（改前记账整体偏一位）');
});

test('开局窗口：采样间隔不会在 0/250ms 之间反复跳（capture 必须一路保持 true）', () => {
  const t = createAugmentTrigger(NO_MIDGAME);
  const seen: boolean[] = [];
  for (let sec = 1; sec <= 25; sec++) {
    const d = t.onSample(sample({ gameTime: sec, level: 1 }), sec * 1000);
    seen.push(d.capture);
  }
  assert.ok(seen.every((c) => c), '开局窗口内 capture 必须一直是 true（改前每轮被"重新打开"）');
  assert.deepEqual(t.pending, [0, 7, 11, 15], '没见到面板就绝不消耗');
});

test('开局窗口之后仍然正常：超时关闭 → 下次死亡再开（这层"意外保护"不再存在也无妨）', () => {
  const t = createAugmentTrigger({ armWindowMs: 5000, midGameStartSec: Number.MAX_SAFE_INTEGER });
  t.onSample(sample({ gameTime: 5, level: 1 }), 1000);
  assert.equal(t.capture, true);
  // 窗口超时（没见过面板）→ 自己关，pending 保留
  const late = t.onSample(sample({ gameTime: 60, level: 6 }), 20000);
  assert.equal(late.capture, false);
  assert.deepEqual(t.pending, [0, 7, 11, 15]);
  // 之后（含"连选"那样的多次弹窗）记账仍然正确：关边沿一次只消耗一次
  t.notePanelOpen(21000);
  const c1 = t.notePanelClosed(22000);
  assert.match(c1.reason, /^选完一次/, `关边沿必须如实报告"消耗了一次"：${c1.reason}`);
  assert.deepEqual(t.pending, [7, 11, 15], '每次关边沿只消耗一次（且消耗的是最小的够格那一次）');
});

/* ------------------------------------------------------------------ */
/* 死亡触发                                                            */
/* ------------------------------------------------------------------ */
test('死亡 + 等级达标 → 开截屏；选完 → 关', () => {
  const t = createAugmentTrigger(NO_MIDGAME);
  startOffer(t);
  const r = deathAndPick(t, 200000, 7);
  assert.equal(r.armed, true, '死亡且 7 级未选 → 应开');
  assert.equal(r.afterClose, false, '选完应关');
  assert.deepEqual(t.pending, [11, 15]);
});

test('死亡但等级不够 → 不开（面板要等级达标才出现）', () => {
  const t = createAugmentTrigger(NO_MIDGAME);
  startOffer(t);
  const d = t.onSample(sample({ level: 5, isDead: true, respawnTimer: 6 }), 10000);
  assert.equal(d.capture, false);
  assert.match(d.reason, /无待选/);
});

test('死亡但该次已选过 → 不开', () => {
  const t = createAugmentTrigger(NO_MIDGAME);
  startOffer(t);
  deathAndPick(t, 10000, 7); // 7 级选掉
  const d = t.onSample(sample({ level: 7, isDead: true, respawnTimer: 5 }), 40000);
  assert.equal(d.capture, false, '7 级已选，再死也不开（11 级未到）');
});

/* ------------------------------------------------------------------ */
/* 连选（用户明确要求考虑的场景）                                        */
/* ------------------------------------------------------------------ */

test('连选：开局没选、11 级才死亡 → 一次死亡连弹三次，中途不能关', () => {
  const t = createAugmentTrigger(NO_MIDGAME);
  // 开局开了截屏但玩家没选（收不到关边沿）→ 窗口超时自动关，pending 全保留
  const d1 = t.onSample(sample({ gameTime: 5, level: 1 }), 5000);
  assert.equal(d1.capture, true, '开局就应开');
  const d2 = t.onSample(sample({ gameTime: 200, level: 6 }), 100000);
  assert.equal(d2.capture, false, '超时应自动关');
  assert.deepEqual(t.pending, [0, 7, 11, 15], '未见面板不得消耗');

  // 11 级第一次死亡：开局 + 7 + 11 都还没选 → 连选
  const d3 = t.onSample(sample({ gameTime: 600, level: 11, isDead: true, respawnTimer: 12 }), 600000);
  assert.equal(d3.capture, true);
  assert.match(d3.reason, /\[0,7,11\]/);

  t.notePanelOpen(600500);
  const afterFirst = t.notePanelClosed(603000);
  assert.equal(afterFirst.capture, true, '还有 7/11 未选 → 必须保持开截屏等连选');
  assert.deepEqual(afterFirst.pending, [7, 11, 15]);

  t.notePanelOpen(604000);
  const afterSecond = t.notePanelClosed(606000);
  assert.equal(afterSecond.capture, true, '还有 11 未选 → 继续等');
  assert.deepEqual(afterSecond.pending, [11, 15]);

  t.notePanelOpen(607000);
  const afterThird = t.notePanelClosed(609000);
  assert.equal(afterThird.capture, false, '本轮够格的都选完了 → 关');
  assert.deepEqual(afterThird.pending, [15]);
});

test('连选等待不会无限开着：下一次弹窗迟迟不来 → 窗口到点自动关', () => {
  const t = createAugmentTrigger({ chainGraceMs: 5000, armWindowMs: 5000 });
  // 对局中途启动（0 被剔除）→ 死亡时待选 [7,11,15]
  t.onSample(sample({ gameTime: 300, level: 11, isDead: true }), 1000);
  t.notePanelOpen(1500);
  const afterFirst = t.notePanelClosed(2000);
  assert.equal(afterFirst.capture, true, '还有未选的 → 先保持');
  assert.deepEqual(afterFirst.pending, [11, 15]);
  // 之后一直没有面板
  const later = t.onSample(sample({ gameTime: 360, level: 11 }), 20000);
  assert.equal(later.capture, false, '等不到就该关，不能一直开着');
  assert.deepEqual(t.pending, [11, 15], '未选状态保留到下次死亡');
});

/* ------------------------------------------------------------------ */
/* 自愈                                                                */
/* ------------------------------------------------------------------ */

test('自愈：门控漏检面板（收到开边沿但没有关边沿）→ 到点自动关，pending 不丢', () => {
  const t = createAugmentTrigger({ armWindowMs: 10000 });
  t.onSample(sample({ gameTime: 300, level: 7, isDead: true }), 1000);
  assert.equal(t.capture, true);
  // 漏检：一直没收到关边沿，采样继续
  const d = t.onSample(sample({ gameTime: 330, level: 7 }), 30000);
  assert.equal(d.capture, false, '超时关闭（自愈）');
  assert.deepEqual(t.pending, [7, 11, 15], '漏检不得消耗待选（下次死亡再试）');
});

test('自愈：面板开着时绝不超时（玩家思考中）', () => {
  const t = createAugmentTrigger({ armWindowMs: 5000 });
  t.onSample(sample({ gameTime: 300, level: 7, isDead: true }), 1000);
  t.notePanelOpen(1200);
  const d = t.onSample(sample({ gameTime: 340, level: 7 }), 60000);
  assert.equal(d.capture, true, '面板还开着就不能因为超时关掉');
});

test('决策变化只报一次（changed 用于避免刷 IPC）', () => {
  const t = createAugmentTrigger(NO_MIDGAME);
  const a = t.onSample(sample({ gameTime: 5, level: 1 }), 1000);
  assert.equal(a.changed, true);
  const b = t.onSample(sample({ gameTime: 6, level: 1 }), 2000);
  assert.equal(b.changed, false, '状态没变就不该报变化');
  t.notePanelOpen(2200);
  const c = t.notePanelClosed(4000);
  assert.equal(c.changed, true, '关截屏是变化');
});

/* ------------------------------------------------------------------ */
/* 可配置                                                              */
/* ------------------------------------------------------------------ */

test('等级表可配置（默认 0/7/11/15，实测值）', () => {
  const t = createAugmentTrigger({ offerLevels: [0, 6], midGameStartSec: Number.MAX_SAFE_INTEGER });
  t.onSample(sample({ gameTime: 5, level: 1 }), 1000);
  t.notePanelOpen(1500);
  t.notePanelClosed(2500); // 开局
  const d = t.onSample(sample({ level: 6, isDead: true }), 10000);
  assert.equal(d.capture, true, '6 级也应触发（可配置）');
  assert.deepEqual(t.pending, [6]);
});

test('reset：回到初始（下次对局复用同一个实例）', () => {
  const t = createAugmentTrigger(NO_MIDGAME);
  startOffer(t);
  assert.deepEqual(t.pending, [7, 11, 15]);
  t.reset();
  assert.deepEqual(t.pending, [0, 7, 11, 15]);
  assert.equal(t.capture, false);
});
