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
 *
 * 传输层已从全局 `fetch` 改为 per-connection 的 `requestInsecure`；
 * 这里注入桩函数，固定"URL/认证头/状态码语义"的契约（不打真实网络）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LcuClient, LcuHttpError } from './client.ts';
import type { InsecureRequestFn } from './https.ts';

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, unknown>;
  readonly body?: string;
  readonly timeoutMs?: number;
}

/** 造一个返回固定状态码/正文的传输桩，并记录调用。 */
function stubTransport(
  status: number,
  body = '{}',
  calls: Call[] = [],
): InsecureRequestFn {
  return async (url, options = {}) => {
    calls.push({
      url,
      method: options.method ?? 'GET',
      headers: (options.headers ?? {}) as Record<string, unknown>,
      ...(options.body !== undefined ? { body: options.body } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    return { status, ok: status >= 200 && status < 300, text: () => body };
  };
}

function makeClient(request: InsecureRequestFn): LcuClient {
  return new LcuClient({ port: 1356, password: 'pw', source: 'cmdline' }, request);
}

test('get：非 2xx 抛出带状态码的 LcuHttpError', async () => {
  await assert.rejects(
    () => makeClient(stubTransport(404)).get('/lol-gameflow/v1/session'),
    (err: unknown) => {
      assert.ok(err instanceof LcuHttpError);
      assert.equal(err.status, 404);
      assert.match(err.message, /HTTP 404/);
      return true;
    },
  );
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
  // 大厅里没有对局会话是**正常**的，不该被当成故障
  assert.equal(
    await makeClient(stubTransport(404)).getOrNull('/lol-gameflow/v1/session'),
    null,
  );
});

test('getOrNull：401（鉴权失败）仍抛出，调用方可据此重探凭证', async () => {
  await assert.rejects(
    () => makeClient(stubTransport(401)).getOrNull('/lol-gameflow/v1/session'),
    (err: unknown) => {
      assert.ok(err instanceof LcuHttpError);
      assert.equal(err.status, 401);
      assert.equal(err.isAuthFailure, true);
      return true;
    },
  );
});

test('getOrNull：500 也返回 null（不把服务端异常当凭证问题）', async () => {
  assert.equal(await makeClient(stubTransport(500)).getOrNull('/x'), null);
});

test('getOrNull：2xx 正常返回解析后的 JSON', async () => {
  const v = await makeClient(stubTransport(200, '{"phase":"ChampSelect"}')).getOrNull<{
    phase: string;
  }>('/lol-gameflow/v1/session');
  assert.equal(v?.phase, 'ChampSelect');
});

test('getOrNull：网络异常仍抛出（区别于 HTTP 错误）', async () => {
  const request: InsecureRequestFn = async () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(() => makeClient(request).getOrNull('/x'), /fetch failed/);
});

test('get：URL 只连本机回环、带 Basic 认证头与 JSON Accept', async () => {
  const calls: Call[] = [];
  await makeClient(stubTransport(200, '{}', calls)).get('/lol-summoner/v1/current-summoner');
  assert.equal(calls[0]?.url, 'https://127.0.0.1:1356/lol-summoner/v1/current-summoner');
  assert.equal(calls[0]?.method, 'GET');
  assert.equal(calls[0]?.headers['Accept'], 'application/json');
  assert.match(String(calls[0]?.headers['Authorization']), /^Basic /);
});

test('get：空正文/204 返回 null（不抛 JSON 解析错）', async () => {
  assert.equal(await makeClient(stubTransport(204, '')).get('/x'), null);
});

test('sendJson：PUT 带 JSON body、204 返回 null', async () => {
  const calls: Call[] = [];
  const result = await makeClient(stubTransport(204, '', calls)).sendJson('PUT', '/lol-item-sets/v1/x', {
    a: 1,
  });
  assert.equal(result, null);
  assert.equal(calls[0]?.method, 'PUT');
  assert.equal(calls[0]?.body, '{"a":1}');
  assert.equal(calls[0]?.headers['Content-Type'], 'application/json');
});

test('sendJson：非 2xx 抛 LcuHttpError；2xx 非 JSON 返回 null', async () => {
  await assert.rejects(
    () => makeClient(stubTransport(400)).sendJson('POST', '/x', {}),
    (err: unknown) => err instanceof LcuHttpError && err.status === 400,
  );
  assert.equal(await makeClient(stubTransport(200, 'OK')).sendJson('POST', '/x', {}), null);
});
