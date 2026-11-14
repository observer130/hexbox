/**
 * 屏幕流重建策略单测
 *
 * 锁定"退避次数有上限、到上限不是静默放弃"：流被系统结束后如果无限重试会把
 * 日志刷爆；但如果只重试一次就放弃，游戏切一次分辨率就等于整局标签失效。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  STREAM_REBUILD_BASE_DELAY_MS,
  STREAM_REBUILD_MAX_ATTEMPTS,
  STREAM_REBUILD_MAX_DELAY_MS,
  streamRebuildDelayMs,
} from './stream-retry.ts';

test('streamRebuildDelayMs：1-based 指数退避并封顶', () => {
  assert.equal(streamRebuildDelayMs(1), STREAM_REBUILD_BASE_DELAY_MS);
  assert.equal(streamRebuildDelayMs(2), STREAM_REBUILD_BASE_DELAY_MS * 2);
  assert.equal(streamRebuildDelayMs(3), STREAM_REBUILD_BASE_DELAY_MS * 4);
  // 第 4 次起触顶（1000*8=8000），第 5 次仍是上限而不是 16000
  assert.equal(streamRebuildDelayMs(4), STREAM_REBUILD_MAX_DELAY_MS);
  assert.equal(streamRebuildDelayMs(5), STREAM_REBUILD_MAX_DELAY_MS);
});

test('streamRebuildDelayMs：超过上限返回 null（调用方必须明确报错，不许静默）', () => {
  assert.equal(streamRebuildDelayMs(STREAM_REBUILD_MAX_ATTEMPTS + 1), null);
  assert.equal(streamRebuildDelayMs(99), null);
});

test('streamRebuildDelayMs：非法输入一律 null（不产生 NaN 延时）', () => {
  assert.equal(streamRebuildDelayMs(0), null);
  assert.equal(streamRebuildDelayMs(-1), null);
  assert.equal(streamRebuildDelayMs(1.5), null);
  assert.equal(streamRebuildDelayMs(Number.NaN), null);
  assert.equal(streamRebuildDelayMs(Number.POSITIVE_INFINITY), null);
});

test('streamRebuildDelayMs：上限次数是有限的正当整数', () => {
  assert.ok(Number.isInteger(STREAM_REBUILD_MAX_ATTEMPTS));
  assert.ok(STREAM_REBUILD_MAX_ATTEMPTS >= 2, '只给 1 次机会不够（切分辨率时流可能要等一瞬）');
  assert.ok(STREAM_REBUILD_MAX_DELAY_MS >= STREAM_REBUILD_BASE_DELAY_MS);
});
