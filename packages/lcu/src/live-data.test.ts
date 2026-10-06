/**
 * 局内状态解析测试
 *
 * 报文形状取自**真机实采**（`debug/live-probe.json`，2026-10-05）：
 * 字段名/类型按真机抄，避免"照文档写解析器"这类错误。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLiveDataClient, parseLiveChampionNames, parseLivePlayerState } from './live-data.ts';

/** 真机报文的裁剪版（保留触发状态机要用的字段）。 */
function payload(over: Record<string, unknown> = {}): unknown {
  const activePlayer = {
    level: 7,
    riotId: '小泥人蹲着#86079',
    summonerName: '小泥人蹲着#86079',
    championName: '光辉女郎',
    ...(over['activePlayer'] as Record<string, unknown> | undefined),
  };
  const me = {
    riotId: '小泥人蹲着#86079',
    championName: '光辉女郎',
    level: 7,
    isDead: false,
    respawnTimer: 0,
    ...(over['me'] as Record<string, unknown> | undefined),
  };
  return {
    activePlayer,
    allPlayers: over['allPlayers'] ?? [me],
    events: { Events: [] },
    gameData: { gameMode: 'KIWI', gameTime: 613.4, mapNumber: 12, ...(over['gameData'] as Record<string, unknown> | undefined) },
  };
}

/* ------------------------------------------------------------------ */
/* 解析                                                                */
/* ------------------------------------------------------------------ */

test('parseLivePlayerState：真机报文 → 四个关键字段都解析出来', () => {
  const s = parseLivePlayerState(payload({ me: { level: 11, isDead: true, respawnTimer: 8.5 } }));
  assert.ok(s !== null);
  assert.equal(s.gameMode, 'KIWI');
  assert.equal(s.gameTime, 613.4);
  assert.equal(s.level, 11);
  assert.equal(s.isDead, true);
  assert.equal(s.respawnTimer, 8.5);
  assert.equal(s.riotId, '小泥人蹲着#86079');
});

test('parseLivePlayerState：等级取**玩家列表**里我的那条（与 activePlayer 可能不同步）', () => {
  const s = parseLivePlayerState(payload({ me: { level: 9 } }));
  assert.equal(s?.level, 9);
});

test('parseLivePlayerState：riotId 不一致时回落到 summonerName', () => {
  const s = parseLivePlayerState(
    payload({ activePlayer: { riotId: '' }, me: { riotId: undefined, summonerName: '小泥人蹲着#86079' } }),
  );
  assert.ok(s !== null, '应能通过 summonerName 找到自己');
  assert.equal(s?.isDead, false);
});

test('parseLivePlayerState：找不到我自己 → null（不瞎猜，宁可不开截屏）', () => {
  const s = parseLivePlayerState(payload({ allPlayers: [{ riotId: '别人#0001', isDead: true, level: 3 }] }));
  assert.equal(s, null);
});

test('parseLivePlayerState：缺 isDead / gameTime → null', () => {
  assert.equal(parseLivePlayerState(payload({ me: { isDead: undefined } })), null);
  assert.equal(parseLivePlayerState(payload({ gameData: { gameTime: undefined } })), null);
});

test('parseLivePlayerState：非局内报文（登录队列/错误页）→ null', () => {
  assert.equal(parseLivePlayerState(null), null);
  assert.equal(parseLivePlayerState({}), null);
  assert.equal(parseLivePlayerState('not json'), null);
  assert.equal(parseLivePlayerState([1, 2, 3]), null);
});

test('parseLivePlayerState：respawnTimer 缺失时按 0（不该因此整条作废）', () => {
  const s = parseLivePlayerState(payload({ me: { respawnTimer: undefined } }));
  assert.equal(s?.respawnTimer, 0);
});

/* ------------------------------------------------------------------ */
/* "我是谁"的名字（真机形状：rawChampionName / championName）            */
/* ------------------------------------------------------------------ */

test('parseLiveChampionNames：真机 rawChampionName → 可解析出英文别名', () => {
  const names = parseLiveChampionNames(
    payload({
      activePlayer: {
        rawChampionName: 'game_character_displayname_Gragas',
        championName: '酒桶',
      },
    }),
  );
  assert.equal(names?.rawChampionName, 'game_character_displayname_Gragas');
  assert.equal(names?.championName, '酒桶');
});

test('parseLiveChampionNames：老报文没有 rawChampionName 时给中文名/玩家列表名（不当成错误）', () => {
  const names = parseLiveChampionNames(
    payload({ activePlayer: { rawChampionName: undefined } }),
  );
  assert.equal(names?.rawChampionName, '');
  assert.equal(names?.championName, '光辉女郎');
  assert.equal(names?.myChampionName, '光辉女郎');
});

test('parseLiveChampionNames：allPlayers 里"我"那条按 riotId 定位（不是第一条）', () => {
  const names = parseLiveChampionNames(
    payload({
      activePlayer: { rawChampionName: '', championName: '' },
      allPlayers: [
        { riotId: '别人#0001', championName: '生化魔人' },
        { riotId: '小泥人蹲着#86079', championName: '酒桶' },
      ],
    }),
  );
  assert.equal(names?.myChampionName, '酒桶');
});

test('parseLiveChampionNames：没有 activePlayer（非局内报文）→ null', () => {
  assert.equal(parseLiveChampionNames(null), null);
  assert.equal(parseLiveChampionNames({}), null);
  assert.equal(parseLiveChampionNames({ gameData: { gameTime: 1 } }), null);
});

test('客户端：getChampionNames 同样走 allgamedata，失败返回 null 并记原因', async () => {
  let seen = '';
  const ok = createLiveDataClient({
    fetchJson: (url) => {
      seen = url;
      return Promise.resolve(
        payload({ activePlayer: { rawChampionName: 'game_character_displayname_Lux' } }),
      );
    },
  });
  assert.equal(
    (await ok.getChampionNames())?.rawChampionName,
    'game_character_displayname_Lux',
  );
  assert.equal(seen, 'https://127.0.0.1:2999/liveclientdata/allgamedata');

  const bad = createLiveDataClient({ fetchJson: () => Promise.reject(new Error('ECONNREFUSED')) });
  assert.equal(await bad.getChampionNames(), null);
  assert.match(bad.lastError ?? '', /ECONNREFUSED/);
});

/* ------------------------------------------------------------------ */
/* 客户端（注入请求实现）                                                */
/* ------------------------------------------------------------------ */

test('客户端：不在局内（连接失败）→ null 且记录原因，不抛异常', async () => {
  const client = createLiveDataClient({
    fetchJson: () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:2999')),
  });
  assert.equal(await client.getPlayerState(), null);
  assert.match(client.lastError ?? '', /ECONNREFUSED/);
});

test('客户端：成功 → 返回状态并清空 lastError', async () => {
  const client = createLiveDataClient({
    fetchJson: () => Promise.resolve(payload({ me: { isDead: true, respawnTimer: 3 } })),
  });
  const s = await client.getPlayerState();
  assert.equal(s?.isDead, true);
  assert.equal(client.lastError, null);
});

test('客户端：请求的 URL 指向 allgamedata（一次拿全量）', async () => {
  let seen = '';
  const client = createLiveDataClient({
    baseUrl: 'https://127.0.0.1:2999',
    fetchJson: (url) => {
      seen = url;
      return Promise.resolve(payload());
    },
  });
  await client.getPlayerState();
  assert.equal(seen, 'https://127.0.0.1:2999/liveclientdata/allgamedata');
});
