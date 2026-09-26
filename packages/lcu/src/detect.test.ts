/** LCU 探测的纯函数测试（不需要真实客户端）。 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseCmdline, parseLockfile, basicAuthHeader, findLcuPort } from './detect.ts';
import { isBrawlSession, type GameflowSession } from './client.ts';

test('parseCmdline 能解析标准 LCU 参数', () => {
  const cmd =
    '"C:\\Riot Games\\League of Legends\\LeagueClientUx.exe" ' +
    '--app-port=56695 --remoting-auth-token=abc123-XYZ ' +
    '--install-directory=...';
  const { port, token } = parseCmdline(cmd);
  assert.equal(port, 56695);
  assert.equal(token, 'abc123-XYZ');
});

test('parseCmdline 对空/无关命令行返回 undefined', () => {
  const r = parseCmdline('');
  assert.equal(r.port, undefined);
  assert.equal(r.token, undefined);
});

test('parseLockfile 能解析官方格式', () => {
  const { port, password } = parseLockfile('LeagueClient:28932:56695:s3cr3tPass:https');
  assert.equal(port, 56695);
  assert.equal(password, 's3cr3tPass');
});

test('parseLockfile 对空内容返回空对象（国服实测会出现）', () => {
  const r = parseLockfile('');
  assert.equal(r.port, undefined);
  assert.equal(r.password, undefined);
});

test('basicAuthHeader 使用固定用户名 riot', () => {
  const h = basicAuthHeader('pw');
  assert.ok(h.startsWith('Basic '));
  const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
  assert.equal(decoded, 'riot:pw');
});

test('isBrawlSession 通过 gameMode=BRAWL 识别', () => {
  const s: GameflowSession = { map: { gameMode: 'BRAWL' } };
  assert.equal(isBrawlSession(s), true);
});

test('isBrawlSession 通过 queueId=2300 识别（官方常量）', () => {
  const s: GameflowSession = { gameData: { queue: { id: 2300 } } };
  assert.equal(isBrawlSession(s), true);
});

test('isBrawlSession 对其它模式返回 false', () => {
  assert.equal(isBrawlSession({ map: { gameMode: 'CLASSIC' } }), false);
  assert.equal(isBrawlSession({ gameData: { queue: { id: 450 } } }), false); // ARAM
  assert.equal(isBrawlSession(null), false);
});

/* ------------------------------------------------------------------ */
/* findLcuPort：TLS 豁免与端口判定                                      */
/* ------------------------------------------------------------------ */

/**
 * 这组测试针对一个**真实踩过的 bug**：
 *
 * LCU 用自签证书，Node 的 fetch 会抛 `SELF_SIGNED_CERT_IN_CHAIN`
 * （表现为 `TypeError: fetch failed`）。原实现直接 fetch、不做 TLS 豁免，
 * 于是**即使端口完全正确也判定不出 LCU**，函数恒返回 null ——
 * 用户看到的是"检测到客户端但读不到凭证"，且极难排查。
 *
 * 这里不打真实网络：用 fetch 桩固定行为契约。
 */

/** 可注入的 fetch 桩：记录调用端口，按端口返回预设结果。 */
function stubFetch(
  handler: (port: number) => Response,
  log: number[] = [],
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const port = Number(new URL(String(input)).port);
    log.push(port);
    return handler(port);
  }) as typeof fetch;
}

test('findLcuPort：识别返回 401 的端口为 LCU', async () => {
  const original = globalThis.fetch;
  const tried: number[] = [];
  globalThis.fetch = stubFetch((port) => {
    // 只有 1356 是 LCU（401），其余连接失败
    if (port === 1356) return new Response('', { status: 401 });
    throw new TypeError('fetch failed');
  }, tried);

  try {
    const hit = await findLcuPort([
      { port: 53056, pid: 1 },
      { port: 40017, pid: 1 },
      { port: 1356, pid: 1 },
    ]);
    assert.deepEqual(hit, { port: 1356, pid: 1 });
    assert.deepEqual(tried, [53056, 40017, 1356]); // 逐个尝试直到命中
  } finally {
    globalThis.fetch = original;
  }
});

test('findLcuPort：全部不可达时返回 null（不抛错）', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = stubFetch(() => {
    throw new TypeError('fetch failed');
  });
  try {
    assert.equal(await findLcuPort([{ port: 1, pid: 1 }, { port: 2, pid: 2 }]), null);
  } finally {
    globalThis.fetch = original;
  }
});

test('findLcuPort：空候选返回 null 且不发请求', async () => {
  const original = globalThis.fetch;
  let called = 0;
  globalThis.fetch = stubFetch(() => {
    called++;
    return new Response('', { status: 401 });
  });
  try {
    assert.equal(await findLcuPort([]), null);
    assert.equal(called, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('findLcuPort：非 401 的响应不算 LCU（200/404 都应跳过）', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = stubFetch((port) =>
    new Response('', { status: port === 111 ? 200 : 404 }),
  );
  try {
    assert.equal(await findLcuPort([{ port: 111, pid: 1 }, { port: 222, pid: 2 }]), null);
  } finally {
    globalThis.fetch = original;
  }
});

test('findLcuPort：探测后必须还原 NODE_TLS_REJECT_UNAUTHORIZED', async () => {
  const KEY = 'NODE_TLS_REJECT_UNAUTHORIZED';
  const originalFetch = globalThis.fetch;
  const prev = process.env[KEY];

  globalThis.fetch = stubFetch(() => new Response('', { status: 401 }));
  try {
    // 场景 A：调用前未设置 → 调用后应仍为 undefined
    delete process.env[KEY];
    await findLcuPort([{ port: 1, pid: 1 }]);
    assert.equal(
      process.env[KEY],
      undefined,
      '不应把 TLS 豁免泄漏到全局（否则影响其它 HTTPS 请求）',
    );

    // 场景 B：调用前已有值 → 调用后应保持原值
    process.env[KEY] = '1';
    await findLcuPort([{ port: 1, pid: 1 }]);
    assert.equal(process.env[KEY], '1', '应还原为调用前的值');
  } finally {
    globalThis.fetch = originalFetch;
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
  }
});
