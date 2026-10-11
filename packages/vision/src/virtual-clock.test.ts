/**
 * 虚拟时钟测试（关门回放的地基：时间必须**只在显式推进时**走）
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createVirtualClock } from './virtual-clock.ts';

test('advanceTo：按到期顺序执行，且时间推进到目标', () => {
  const c = createVirtualClock(1000);
  const log: string[] = [];
  c.setTimeout(() => log.push(`a@${c.now()}`), 50);
  c.setTimeout(() => log.push(`b@${c.now()}`), 10);
  assert.equal(c.now(), 1000);
  assert.equal(c.advanceTo(1100), 2);
  assert.deepEqual(log, ['b@1010', 'a@1050']);
  assert.equal(c.now(), 1100, '即使没有任务，时间也要推进到目标');
  assert.equal(c.pending, 0);
});

test('advanceTo：不到期不执行；nextDueAt 给出下一个时刻', () => {
  const c = createVirtualClock();
  let fired = 0;
  c.setTimeout(() => fired++, 500);
  assert.equal(c.nextDueAt(), 500);
  assert.equal(c.advanceTo(499), 0);
  assert.equal(fired, 0);
  assert.equal(c.now(), 499);
  assert.equal(c.advanceTo(500), 1);
  assert.equal(fired, 1);
});

test('setInterval：周期重复，clearInterval 之后不再执行', () => {
  const c = createVirtualClock();
  let n = 0;
  const id = c.setInterval(() => {
    n++;
    if (n === 3) c.clearInterval(id);
  }, 100);
  c.advanceTo(1000);
  assert.equal(n, 3, '第三次里清掉自己之后不许再排期');
  assert.equal(c.pending, 0);
});

test('任务里再排任务：同一轮 advanceTo 内也能被看到（控制器大量依赖这个）', () => {
  const c = createVirtualClock();
  const log: number[] = [];
  c.setTimeout(() => {
    log.push(c.now());
    c.setTimeout(() => log.push(c.now()), 10);
  }, 10);
  assert.equal(c.advanceTo(100), 2);
  assert.deepEqual(log, [10, 20]);
});

test('runNext：一次只跑一个到期任务（驱动器用它让出事件循环）', () => {
  const c = createVirtualClock();
  const log: number[] = [];
  c.setTimeout(() => log.push(1), 10);
  c.setTimeout(() => log.push(2), 20);
  assert.equal(c.runNext(), true);
  assert.deepEqual(log, [1]);
  assert.equal(c.now(), 10, 'runNext 只把时间推到该任务到期时刻');
  assert.equal(c.runNext(), true);
  assert.equal(c.runNext(), false);
  assert.deepEqual(log, [1, 2]);
});

test('clearTimeout：已排的任务被取消后不执行', () => {
  const c = createVirtualClock();
  let fired = 0;
  const id = c.setTimeout(() => fired++, 10);
  c.clearTimeout(id);
  c.advanceTo(1000);
  assert.equal(fired, 0);
  assert.equal(c.pending, 0);
});

test('负数/非有限延迟按 0 处理；interval 周期下限 1ms（防死循环）', () => {
  const c = createVirtualClock();
  let a = 0;
  let b = 0;
  c.setTimeout(() => a++, -5);
  c.setInterval(() => b++, 0);
  c.advanceTo(5);
  assert.equal(a, 1);
  // period=0 → 夹到 1ms：5ms 内最多 6 次（0,1,2,3,4,5）
  assert.ok(b >= 5 && b <= 6, `b=${b}`);
});

test('install：替换全局定时器后，普通 await new Promise(setTimeout) 也走虚拟时间', async () => {
  const c = createVirtualClock();
  const uninstall = c.install();
  try {
    const log: number[] = [];
    void (async () => {
      await new Promise((r) => setTimeout(r, 300));
      log.push(c.now());
    })();
    // 驱动器：跑一个任务 → 让出给事件循环 → 再跑
    const realSetImmediate = setImmediate;
    for (let i = 0; i < 50 && log.length === 0; i++) {
      if (!c.runNext()) c.advanceTo(c.now() + 100);
      await new Promise((r) => realSetImmediate(r));
    }
    assert.deepEqual(log, [300], 'await 链必须能在虚拟时间上推进');
  } finally {
    uninstall();
  }
});
