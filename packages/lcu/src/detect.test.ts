/** LCU 探测的纯函数测试（不需要真实客户端）。 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseCmdline,
  parseLockfile,
  basicAuthHeader,
  findLcuPort,
  parseExplicitCredentials,
  resolveExplicitCredentials,
  probePort,
  LCU_CREDENTIALS_ENV,
  LCU_CREDENTIALS_FILE_ENV,
} from './detect.ts';

/* ------------------------------------------------------------------ */
/* 凭证探活（2026-10-05 事故：装备推荐"完全失效"）                        */
/* ------------------------------------------------------------------ */

test('probePort：端口没人监听 → false（过期缓存就是被这样判掉的）', async () => {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  assert.equal(await probePort(port, 600), false);
});

test('probePort：端口有人在听 → true', async () => {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  try {
    assert.equal(await probePort(port, 1500), true);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

test('probePort：非法端口/连不上 → false，不抛异常', async () => {
  assert.equal(await probePort(0), false);
  assert.equal(await probePort(-1), false);
  assert.equal(await probePort(Number.NaN), false);
});
import { isBrawlSession, pickChampionIdFromGameflow, type GameflowSession } from './client.ts';

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

test('findLcuPort：探测后必须还原 NODE_TLS_REJECT_UNAUTHORIZED', async () => {  const KEY = 'NODE_TLS_REJECT_UNAUTHORIZED';
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

/* ------------------------------------------------------------------ */
/* pickChampionIdFromGameflow：对局中兜底识别英雄                       */
/* ------------------------------------------------------------------ */

/**
 * 这组测试针对一个**真实 bug**：
 *
 * 原实现只在 ChampSelect 阶段读取英雄，且离开该阶段就把 myChampionId 置 0。
 * 结果「选人阶段能看到胜率，进游戏后却显示未识别到你的英雄」。
 * pickChampionIdFromGameflow 用于在局内从 gameflow session 兜底恢复。
 */

test('pickChampionIdFromGameflow：从常见位置取出 championId', () => {
  assert.equal(pickChampionIdFromGameflow({ championId: 902 }), 902);
  assert.equal(
    pickChampionIdFromGameflow({ gameData: { playerChampionId: 1, championId: 902 } }),
    902,
  );
});

test('pickChampionIdFromGameflow：深层嵌套也能找到', () => {
  const session = { a: { b: { c: { championId: 902 } } } };
  assert.equal(pickChampionIdFromGameflow(session), 902);
});

test('pickChampionIdFromGameflow：超出深度限制则放弃（避免遍历整个会话）', () => {
  const deep = { a: { b: { c: { d: { e: { championId: 902 } } } } } };
  // 默认 maxDepth=4 → 找不到
  assert.equal(pickChampionIdFromGameflow(deep), 0);
  // 放宽深度后可找到
  assert.equal(pickChampionIdFromGameflow(deep, 6), 902);
});

test('pickChampionIdFromGameflow：只认正整数 championId，忽略非法值', () => {
  assert.equal(pickChampionIdFromGameflow({ championId: 0 }), 0);
  assert.equal(pickChampionIdFromGameflow({ championId: -1 }), 0);
  assert.equal(pickChampionIdFromGameflow({ championId: 1.5 }), 0);
  assert.equal(pickChampionIdFromGameflow({ championId: '902' }), 0); // 字符串不算
  assert.equal(pickChampionIdFromGameflow({ championId: null }), 0);
});

test('pickChampionIdFromGameflow：键名必须恰为 championId（不误取相似键）', () => {
  // 这些相似键不应被当成我的英雄
  assert.equal(pickChampionIdFromGameflow({ otherChampionId: 5 }), 0);
  assert.equal(pickChampionIdFromGameflow({ championIdList: [1, 2] }), 0);
  assert.equal(pickChampionIdFromGameflow({ myChampionId: 5 }), 0);
});

test('pickChampionIdFromGameflow：无 championId 时返回 0（不猜）', () => {
  assert.equal(pickChampionIdFromGameflow(null), 0);
  assert.equal(pickChampionIdFromGameflow(undefined), 0);
  assert.equal(pickChampionIdFromGameflow({}), 0);
  assert.equal(pickChampionIdFromGameflow({ map: { gameMode: 'BRAWL' } }), 0);
  assert.equal(pickChampionIdFromGameflow('字符串'), 0);
  assert.equal(pickChampionIdFromGameflow(902), 0);
});

test('pickChampionIdFromGameflow：循环引用不会死循环', () => {
  const a: Record<string, unknown> = { name: 'a' };
  const b: Record<string, unknown> = { name: 'b', a };
  a['b'] = b; // a <-> b 互相引用
  assert.equal(pickChampionIdFromGameflow(a), 0);
});

test('pickChampionIdFromGameflow：数组里的 championId 也能找到', () => {
  assert.equal(pickChampionIdFromGameflow({ team: [{ championId: 902 }] }), 902);
});

/* ------------------------------------------------------------------ */
/* 显式凭证（免提权通道）                                              */
/* ------------------------------------------------------------------ */

test('parseExplicitCredentials：接受 `<端口>:<token>`', () => {
  const c = parseExplicitCredentials('56695:s3cr3tPass');
  assert.equal(c?.port, 56695);
  assert.equal(c?.password, 's3cr3tPass');
  assert.equal(c?.source, 'explicit');
});

test('parseExplicitCredentials：容忍 `riot:` 前缀（Basic 用户名）', () => {
  const c = parseExplicitCredentials('riot:56695:s3cr3tPass');
  assert.equal(c?.port, 56695);
  assert.equal(c?.password, 's3cr3tPass');
});

test('parseExplicitCredentials：也接受 lockfile 整行（避免用户粘错格式）', () => {
  const c = parseExplicitCredentials('LeagueClient:28932:56695:s3cr3tPass:https');
  assert.equal(c?.port, 56695);
  assert.equal(c?.password, 's3cr3tPass');
});

test('parseExplicitCredentials：密码含冒号时只切第一个（token 常含 : 与 -）', () => {
  const c = parseExplicitCredentials('56695:ab:cd:ef');
  assert.equal(c?.port, 56695);
  assert.equal(c?.password, 'ab:cd:ef');
});

test('parseExplicitCredentials：非法输入一律返回 null，不抛错', () => {
  for (const bad of ['', '   ', 'no-colon', ':token', 'abc:token', '0:token', '70000:token', '56695:', 'LeagueClient::::']) {
    assert.equal(parseExplicitCredentials(bad), null, `应拒绝: ${JSON.stringify(bad)}`);
  }
  assert.equal(parseExplicitCredentials(undefined), null);
});

test('resolveExplicitCredentials：环境变量优先于凭证文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hexbox-lcu-'));
  const file = join(dir, 'creds');
  writeFileSync(file, '1111:fromFile', 'utf8');
  const c = await resolveExplicitCredentials({
    env: {
      [LCU_CREDENTIALS_ENV]: '2222:fromEnv',
      [LCU_CREDENTIALS_FILE_ENV]: file,
    },
  });
  assert.equal(c?.port, 2222);
  assert.equal(c?.password, 'fromEnv');
});

test('resolveExplicitCredentials：无环境变量时读凭证文件，并记下来源路径', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hexbox-lcu-'));
  const file = join(dir, 'creds');
  writeFileSync(file, 'LeagueClient:1:3333:fileToken:https\n', 'utf8');
  const c = await resolveExplicitCredentials({ env: { [LCU_CREDENTIALS_FILE_ENV]: file } });
  assert.equal(c?.port, 3333);
  assert.equal(c?.password, 'fileToken');
  assert.equal(c?.lockfilePath, file); // 诊断要能指出凭证来自哪个文件
});

test('resolveExplicitCredentials：文件不存在 / 内容为空 / 内容非法时返回 null', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hexbox-lcu-'));
  const empty = join(dir, 'empty');
  writeFileSync(empty, '   \n', 'utf8');
  const missing = join(dir, 'nope');
  for (const p of [missing, empty, dir]) {
    assert.equal(
      await resolveExplicitCredentials({ env: { [LCU_CREDENTIALS_FILE_ENV]: p } }),
      null,
      p,
    );
  }
});

test('resolveExplicitCredentials：不设任何变量时只看默认路径（测试必须注入不存在的路径）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hexbox-lcu-'));
  // ⚠️ 必须显式注入 defaultPath：否则会回落到**真实机器**上的
  // ~/.hexbox/lcu-credentials —— 测试将依赖开发者本机状态，
  // 且断言失败会把真实 token 打进日志（真实发生过）。
  const c = await resolveExplicitCredentials({ env: {}, defaultPath: join(dir, 'absent') });
  assert.equal(c, null);
});
