/**
 * 视觉循环驱动层的**时序**测试（不需要 Electron / 桌面 / 游戏）
 *
 * 这条缝是 2026-11 审查里唯一"高危但 CI 完全测不到"的：`stop()` 以前只清定时器，
 * **不作废已经飞出去的那一轮**（截屏 + OCR 要 1~2 秒）。迟到的结果会
 * `onResult(active:true)` → `pushLabelOverlay` → `raiseLabelOverlay` 把
 * 已经 `hide()` 的画布重新 `showInactive()`，于是选人阶段的胜率标签留在整局画面上。
 *
 * 所以这里用"可控的假 round + 假 display"把那个时序钉死。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Display } from 'electron';

import type { VisionOverlayMsg } from './vision-loop.ts';
import { VisionLoop, type VisionLoopDriverDeps } from './vision-loop-driver.ts';

/** 驱动器只把 display 原样转交，测试里给个最小对象即可。 */
const DISPLAY = { id: 1 } as unknown as Display;

/** 让出一轮微任务/宏任务，等 `tick` 跑完。 */
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

interface Recorder {
  readonly deps: VisionLoopDriverDeps;
  readonly sent: VisionOverlayMsg[];
}

/** 造一套驱动 deps；`round` 由调用方给（这里是唯一的时序控制点）。 */
function recorder(round: VisionLoopDriverDeps['round']): Recorder {
  const sent: VisionOverlayMsg[] = [];
  return {
    sent,
    deps: {
      pickState: () => 'picking',
      round,
      primaryDisplay: () => DISPLAY,
      onResult: (msg) => sent.push(msg),
    },
  };
}

test('驱动：一轮正常返回 → 照常推送 active', async () => {
  const { deps, sent } = recorder(async () => ({
    msg: { active: true, labels: [] },
    display: DISPLAY,
    stage: 'cards',
  }));
  const loop = new VisionLoop(deps, 10_000);
  loop.start();
  await flush();
  loop.stop();

  assert.ok(sent.some((m) => m.active === true), '正常轮次要推送');
});

test('驱动：stop() 后迟到的轮次**不许**再推送（真机"标签留一整局"的根因）', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const { deps, sent } = recorder(async () => {
    await gate;
    return { msg: { active: true, labels: [] }, display: DISPLAY, stage: 'cards' };
  });

  const loop = new VisionLoop(deps, 10_000);
  loop.start();
  // 此时这一轮已经进入 await（截屏 + OCR 的模拟），调用方离开选人阶段：
  loop.stop();
  const afterStop = sent.length;
  assert.equal(sent.at(-1)?.active, false, 'stop 自己要先清一次画布');

  release();
  await flush();

  assert.equal(sent.length, afterStop, '作废的轮次一个字都不许再推');
  assert.equal(
    sent.some((m) => m.active === true),
    false,
    '否则会把已经 hide() 的画布重新显示出来',
  );
});

test('驱动：stop → start 之后，旧一代的轮次也不许推送', async () => {
  let releaseOld!: () => void;
  const oldGate = new Promise<void>((r) => {
    releaseOld = r;
  });
  let first = true;
  const { deps, sent } = recorder(async () => {
    if (first) {
      first = false;
      await oldGate;
      return { msg: { active: true, labels: [] }, display: DISPLAY, stage: 'cards' };
    }
    return { msg: { active: false, labels: [] }, display: DISPLAY, stage: 'cards' };
  });

  const loop = new VisionLoop(deps, 10_000);
  loop.start(); // 第一轮卡在 oldGate
  loop.stop();
  loop.start(); // 新一代
  await flush(); // 新一代那一轮照常完成
  const beforeOld = sent.length;

  releaseOld(); // 旧一代那一轮现在才回来
  await flush();
  loop.stop();

  // 旧轮次回来后只允许"已经被作废"——消息数不变
  assert.equal(sent.slice(0, beforeOld).length, beforeOld);
  assert.equal(
    sent.some((m) => m.active === true),
    false,
    '旧一代的 active 结果绝不能被采纳',
  );
});

test('驱动：作废的轮次即使抛错也不推"识别异常"（它描述的是已经过去的一屏）', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const { deps, sent } = recorder(async () => {
    await gate;
    throw new Error('boom');
  });

  const loop = new VisionLoop(deps, 10_000);
  loop.start();
  loop.stop();
  const afterStop = sent.length;

  release();
  await flush();

  assert.equal(sent.length, afterStop);
  assert.equal(
    sent.some((m) => m.diag === '识别异常'),
    false,
  );
});

test('驱动：仍在当前代次时，异常照常报"识别异常"（不许把真错误也吞掉）', async () => {
  const { deps, sent } = recorder(async () => {
    throw new Error('boom');
  });
  const loop = new VisionLoop(deps, 10_000);
  loop.start();
  await flush();
  loop.stop();

  assert.ok(
    sent.some((m) => m.diag === '识别异常'),
    '当前代次的异常必须让用户看见（这是唯一没被 catch 吞掉的去处）',
  );
});
