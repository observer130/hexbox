/**
 * `waitWritableClosed` 的回归测试
 *
 * 锁定的真实缺陷（审查 P1）：更新下载失败路径用 `once(stream,'close')` 等删除
 * 前的关闭；若流已经因错误关闭，事件早发过 → 永久挂起，菜单停在"正在下载更新…"。
 * 这里用"已销毁流"直接复现旧实现会挂住的场景。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough, Writable } from 'node:stream';

import { WRITABLE_CLOSE_TIMEOUT_MS, waitWritableClosed } from './writable-close.ts';

test('waitWritableClosed：正常 end 后可关闭（毫秒级返回）', async () => {
  const stream = new PassThrough();
  stream.resume(); // 消费掉，避免背压
  stream.end('done');
  await waitWritableClosed(stream);
  assert.equal(stream.closed, true);
});

test('waitWritableClosed：已经因错误销毁的流立即返回（旧实现会永久挂起）', async () => {
  const stream = new PassThrough();
  // 必须消费掉 'error'：否则销毁后发出的错误会变成测试进程的 uncaughtException
  stream.on('error', () => undefined);
  stream.destroy(new Error('磁盘满'));
  await waitWritableClosed(stream);
  assert.equal(stream.closed, true);
});

test('waitWritableClosed：从未关闭的流在超时后返回（不挂住调用方）', async () => {
  // write 永不回调 = 永远不 finish
  const stream = new Writable({
    write(_chunk, _encoding, _callback) {
      /* 故意不 callback */
    },
  });
  const t0 = Date.now();
  await waitWritableClosed(stream, 30);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 20, `应等满兜底超时（实际 ${elapsed}ms）`);
  assert.ok(elapsed < 1_000, `不应无限挂起（实际 ${elapsed}ms）`);
  stream.destroy();
});

test('waitWritableClosed：默认超时为正数（不能改成 0 导致文件还没关就去删）', () => {
  assert.ok(WRITABLE_CLOSE_TIMEOUT_MS > 0);
});
