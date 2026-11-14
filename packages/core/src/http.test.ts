/**
 * `httpTimeoutSignal` 单测
 *
 * 锁定的契约：外部取消必须能立刻冒泡；没有外部信号时超时必须生效；
 * 非法超时值不能退化成"立即 abort"。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_HTTP_TIMEOUT_MS, httpTimeoutSignal } from './http.ts';

/** 等一个 signal abort（带兜底超时，避免测试挂住）。 */
function aborted(signal: AbortSignal, ms = 500): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error('等待 abort 超时')), ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

test('httpTimeoutSignal：外部 signal abort 会冒泡（取消立刻生效）', async () => {
  const controller = new AbortController();
  const signal = httpTimeoutSignal(controller.signal, 10_000);
  controller.abort();
  await aborted(signal);
  assert.equal(signal.aborted, true);
});

test('httpTimeoutSignal：没有外部 signal 时按超时 abort', async () => {
  const signal = httpTimeoutSignal(undefined, 10);
  assert.equal(signal.aborted, false);
  await aborted(signal);
  assert.equal(signal.aborted, true);
});

test('httpTimeoutSignal：外部已 abort 时合成信号立即 abort', () => {
  const controller = new AbortController();
  controller.abort();
  const signal = httpTimeoutSignal(controller.signal, 10_000);
  assert.equal(signal.aborted, true);
});

test('httpTimeoutSignal：非法/非正超时值不设超时（不会立刻 abort）', () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const controller = new AbortController();
    const signal = httpTimeoutSignal(controller.signal, bad);
    assert.equal(signal.aborted, false, `timeoutMs=${bad} 不应立即 abort`);
    controller.abort();
  }
});

test('默认超时是合理的正数', () => {
  assert.ok(Number.isFinite(DEFAULT_HTTP_TIMEOUT_MS));
  assert.ok(DEFAULT_HTTP_TIMEOUT_MS >= 1_000);
});
