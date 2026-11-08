/**
 * `AugmentController` 的**纯判据**单测
 *
 * 控制器本身要 Electron/桌面前（`resolveGeometry`、常驻流、2999），CI 里跑不了；
 * 所以凡是"决定要不要继续"这类分支都抽成纯函数放在这里测 —— 这也是仓库的既有
 * 约定（"不可在 CI 测的决策 → 纯函数"）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apiPollShouldContinue } from './augment-controller.ts';

/* ------------------------------------------------------------------ */
/* 2999 轮询续命判据                                                   */
/* ------------------------------------------------------------------ */

/** 一个"正常在跑"的基线。 */
function base(over: Partial<Parameters<typeof apiPollShouldContinue>[0]> = {}) {
  const trigger = {};
  return {
    running: true,
    sessionToken: 7,
    expectedToken: 7,
    trigger,
    currentTrigger: trigger,
    ...over,
  };
}

test('apiPollShouldContinue：同一代会话 + 同一 trigger → 继续', () => {
  assert.equal(apiPollShouldContinue(base()), true);
});

test('apiPollShouldContinue：已收工（running=false）→ 停', () => {
  assert.equal(apiPollShouldContinue(base({ running: false })), false);
});

test('apiPollShouldContinue：会话令牌变了 → 停（旧实现只看 isRunning，会永续）', () => {
  // 这段就是真机风险：stop() 把 isRunning 置假，新会话又置真，
  // 旧闭包重新看到 true —— 只有令牌能把它区分出来。
  assert.equal(
    apiPollShouldContinue(base({ sessionToken: 8, expectedToken: 7 })),
    false,
  );
});

test('apiPollShouldContinue：trigger 被新一轮重建 → 停（不许用过期 trigger 下判定）', () => {
  assert.equal(
    apiPollShouldContinue(base({ trigger: {}, currentTrigger: {} })),
    false,
  );
});

test('apiPollShouldContinue：trigger 已被清空（resetSession）→ 停', () => {
  assert.equal(apiPollShouldContinue(base({ currentTrigger: null })), false);
});

test('apiPollShouldContinue：触发方式不是 api（trigger=null）→ 停', () => {
  assert.equal(
    apiPollShouldContinue(base({ trigger: null, currentTrigger: null })),
    false,
  );
});
