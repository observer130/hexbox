/** LCU 探测的纯函数测试（不需要真实客户端）。 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseCmdline, parseLockfile, basicAuthHeader } from './detect.ts';
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
