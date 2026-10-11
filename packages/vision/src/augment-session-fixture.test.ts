/**
 * **真机留档回放**（不需要游戏 / Electron / 管理员）：`fixtures/` 里的真实数据
 *
 * 为什么要把真机数据入库当 fixture：`pnpm test` 至今只能覆盖纯函数，而局内链路
 * 的每一个坑都是"一整局真机"换来的。这里放的是**不含任何个人信息**的那一类产物
 * —— 只读接口的数值（等级/死亡/复活计时/对局时间）与门控判定，不含玩家名、
 * 不含帧图。有了它，"2999 触发记账"这一段的回归可以从"再打一局"变成"跑一次测试"。
 *
 * ⚠️ 断言的是**不变量**而不是"与录像逐条相同"：录像是历史版本的状态机跑出来的
 * （`kiwi-trigger-2026-10-05.csv` 早于 2026-10-12 的"升级定向开窗"），
 * 所以"回放多开了一些窗口"是**预期的行为差异**；真正不能接受的是
 * **漏开**（录像开着截屏、回放却关着 = 整整漏掉一次海克斯）。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseApiTraceCsv } from './augment-session.ts';
import { replayApiTrigger } from './augment-session-replay.ts';

function readFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8');
}

test('真机留档：一局海克斯乱斗的 2999 采样能完整解析（含未转义的 pending）', () => {
  const samples = parseApiTraceCsv(readFixture('api-trace/kiwi-trigger-2026-10-05.csv'));
  assert.equal(samples.length, 1095);
  // 时间单调、字段有值、capture 全部可读
  for (let i = 1; i < samples.length; i++) {
    assert.ok(samples[i]!.atMs >= samples[i - 1]!.atMs, `第 ${i} 条时间倒退`);
  }
  assert.equal(samples.filter((s) => s.capture === undefined).length, 0);
  assert.ok(samples.every((s) => s.level >= 1 && s.gameTime >= 0));
  // 真机事实：开局那次必然开截屏，且这是"等级 1、待选含 0"的开局窗口
  assert.equal(samples[0]!.capture, true);
  assert.deepEqual(samples[0]!.pending, [0, 7, 11, 15]);
  // 这一局最后四个 offer 全部走完（pending 清空）—— 录像是"好的那一局"
  assert.deepEqual(samples.at(-1)!.pending, []);
});

test('真机留档回放：**不许漏开**（录像开着截屏的每一刻，回放也必须开着）', () => {
  const samples = parseApiTraceCsv(readFixture('api-trace/kiwi-trigger-2026-10-05.csv'));
  const r = replayApiTrigger({ samples });

  // 这一条是这个 fixture 的核心价值：改了 2999 触发状态机之后，
  // "回放漏开录像里开过的窗口"会立刻红 —— 那正是"整整漏掉一次海克斯"的形态。
  assert.equal(r.metrics.missedRecorded, 0, '回放漏开了录像里开着截屏的时刻');

  // 窗口形态：都从死亡/开局/升级触发，且都靠超时收场（本份留档没有门控边沿）
  assert.ok(r.metrics.windows >= 5, `窗口太少：${r.metrics.windows}`);
  assert.equal(r.metrics.firstOpenAtMs, samples[0]!.atMs);
  assert.match(r.windows[0]!.openReason, /开局/);
  // 每一窗都靠超时收场（没有面板边沿 → 没有"选完就关"这条路）
  // ⚠️ **不**断言"每窗 ≤ 45 秒"：窗口内再死一次会重新 arm（`startCapture` 推
  //    `captureUntil`），所以窗口时长可以合法地超过 `armWindowMs`（本份留档里
  //    第 6 窗就是 69.4 秒）。真正要防的是"关不掉"，那由下面的收场原因锁住。
  for (const w of r.windows.slice(0, -1)) {
    assert.ok(w.closeReason !== null && /超时/.test(w.closeReason), `窗口未按超时关闭：${w.closeReason}`);
    assert.ok(w.closeAtMs! > w.openAtMs, '窗口关闭时刻必须晚于开启时刻');
  }
  // 没有门控边沿 → 一次都没消耗；中途启动也没有丢弃（首帧就对局 0s）
  assert.deepEqual(r.metrics.consumed, []);
  assert.deepEqual(r.metrics.initDropped, []);
  assert.deepEqual(r.metrics.unconsumed, [0, 7, 11, 15]);
  // "开着截屏"的累计时长 ≈ 各窗口之和，且**远小于**整局（api 模式的价值就在这条）
  const windowSum = r.windows.reduce(
    (n, w) => n + ((w.closeAtMs ?? samples.at(-1)!.atMs) - w.openAtMs),
    0,
  );
  assert.ok(Math.abs(r.metrics.armedMs - windowSum) < 2000, `armedMs ${r.metrics.armedMs} vs 窗口和 ${windowSum}`);
});

test('真机留档回放：开着截屏的时长有上界（一局最多 4 个 offer，不该常开）', () => {
  const samples = parseApiTraceCsv(readFixture('api-trace/kiwi-trigger-2026-10-05.csv'));
  const r = replayApiTrigger({ samples });
  const span = samples.at(-1)!.atMs;
  // 这一份没有边沿 → 窗口只能靠超时关，所以占比偏高（真机上是 5 秒级就关）。
  // 但即便这样也不能"整局常开"：每个窗口都受 armWindowMs 约束。
  assert.ok(r.metrics.armedMs < span * 0.6, `开着截屏占比过高：${r.metrics.armedMs}/${span}`);
  // 窗口之间必须有"常态零取帧"的空档
  assert.ok(r.metrics.windows > 1);
});
