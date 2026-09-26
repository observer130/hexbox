/**
 * LcuClient 状态码语义测试
 *
 * 针对一个**真实 bug**：原实现把任何请求失败都当成「客户端没了」，
 * 于是大厅里（`/lol-gameflow/v1/session` 返回 404，属正常）每轮都丢弃
 * 有效凭证并重新探测；探测失败就显示「读不到 LCU 凭证」。
 * 表现为「没进对局时一直报读不到凭证，进选人后又正常」。
 *
 * 关键契约：
 *   - 401/403 = 鉴权失败 → 凭证真的坏了
 *   - 404/400/其它 = 资源/会话不存在 → **凭证是好的**，客户端仍在
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LcuClient, LcuHttpError } from './client.ts';

/** 用桩替掉 fetch，返回指定状态码。 */
function withFetchStatus(status: number, body = '{}'): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(body, {
      status,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function makeClient(): LcuClient {
  return new LcuClient({ port: 1356, password: 'pw', source: 'cmdline' });
}

test('get：非 2xx 抛出带状态码的 LcuHttpError', async () => {
  const restore = withFetchStatus(404);
  try {
    await assert.rejects(
      () => makeClient().get('/lol-gameflow/v1/session'),
      (err: unknown) => {
        assert.ok(err instanceof LcuHttpError);
        assert.equal(err.status, 404);
        assert.match(err.message, /HTTP 404/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('LcuHttpError.isAuthFailure：仅 401/403 为真', () => {
  assert.equal(new LcuHttpError('/x', 401).isAuthFailure, true);
  assert.equal(new LcuHttpError('/x', 403).isAuthFailure, true);
  // 404/400/500 都**不是**鉴权失败 —— 客户端仍在，凭证有效
  assert.equal(new LcuHttpError('/x', 404).isAuthFailure, false);
  assert.equal(new LcuHttpError('/x', 400).isAuthFailure, false);
  assert.equal(new LcuHttpError('/x', 500).isAuthFailure, false);
  assert.equal(new LcuHttpError('/x', 200).isAuthFailure, false);
});

test('getOrNull：404（无会话）返回 null 而不抛错', async () => {
  const restore = withFetchStatus(404);
  try {
    // 大厅里没有对局会话是**正常**的，不该被当成故障
    assert.equal(await makeClient().getOrNull('/lol-gameflow/v1/session'), null);
  } finally {
    restore();
  }
});

test('getOrNull：401（鉴权失败）仍抛出，调用方可据此重探凭证', async () => {
  const restore = withFetchStatus(401);
  try {
    await assert.rejects(
      () => makeClient().getOrNull('/lol-gameflow/v1/session'),
      (err: unknown) => {
        assert.ok(err instanceof LcuHttpError);
        assert.equal(err.status, 401);
        assert.equal(err.isAuthFailure, true);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('getOrNull：500 也返回 null（不把服务端异常当凭证问题）', async () => {
  const restore = withFetchStatus(500);
  try {
    assert.equal(await makeClient().getOrNull('/x'), null);
  } finally {
    restore();
  }
});

test('getOrNull：2xx 正常返回解析后的 JSON', async () => {
  const restore = withFetchStatus(200, '{"phase":"ChampSelect"}');
  try {
    const v = await makeClient().getOrNull<{ phase: string }>('/lol-gameflow/v1/session');
    assert.equal(v?.phase, 'ChampSelect');
  } finally {
    restore();
  }
});

test('getOrNull：网络异常仍抛出（区别于 HTTP 错误）', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  try {
    await assert.rejects(() => makeClient().getOrNull('/x'), /fetch failed/);
  } finally {
    globalThis.fetch = original;
  }
});
