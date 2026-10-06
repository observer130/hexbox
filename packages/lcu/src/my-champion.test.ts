/**
 * 「我的英雄」I/O 桥测试（注入假 LCU / 假 2999 报文，不碰网络）
 *
 * 重点验两件事：
 *   1. **顺序**：2999 的 `activePlayer` 优先于 LCU（旧实现反过来，于是拿到了队友）；
 *   2. **不猜**：LCU 里满是别人的 championId 时，没有"我自己的身份"就必须放弃。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Champion } from '@hexbox/core';

import { createLiveDataClient } from './live-data.ts';
import { readSelfIdentity, resolveMyChampionIdentity, type LcuReader } from './my-champion.ts';

const CHAMPIONS: readonly Champion[] = [
  { id: 11, name: '无极剑圣', alias: 'MasterYi', roles: [], iconPath: '' },
  { id: 79, name: '酒桶', alias: 'Gragas', roles: [], iconPath: '' },
  { id: 154, name: '生化魔人', alias: 'Zac', roles: [], iconPath: '' },
  { id: 43, name: '天启者', alias: 'Karma', roles: [], iconPath: '' },
];

/** 真机 2999 报文的裁剪版（含 rawChampionName / championName）。 */
function livePayload(over: {
  raw?: string;
  name?: string;
  /** `allPlayers[我].championName`（真机有；置空可模拟"2999 一个名字都给不出"）。 */
  meName?: string;
  puuid?: string;
  /** allPlayers 里我那条还能不能被 activePlayer.riotId 定位到。 */
  meVisible?: boolean;
}): unknown {
  const who = over.puuid ?? 'my-puuid-0001';
  const me = {
    puuid: who,
    riotId: who,
    championName: over.meName ?? '',
  };
  return {
    activePlayer: {
      riotId: who,
      summonerName: who,
      ...(over.raw !== undefined ? { rawChampionName: over.raw } : {}),
      ...(over.name !== undefined ? { championName: over.name } : {}),
      level: 7,
    },
    allPlayers: over.meVisible === false ? [{ riotId: '别人#0001', championName: '生化魔人' }] : [me],
    gameData: { gameMode: 'KIWI', gameTime: 100 },
  };
}

/** 假 LCU：按路径给会话，并记录被问过哪些路径。 */
function fakeLcu(routes: Record<string, unknown>): { reader: LcuReader; asked: string[] } {
  const asked: string[] = [];
  const reader: LcuReader = {
    get: <T,>(path: string): Promise<T> => {
      asked.push(path);
      const v = routes[path];
      if (v === undefined) return Promise.reject(new Error(`404 ${path}`));
      return Promise.resolve(v as T);
    },
    getOrNull: <T,>(path: string): Promise<T | null> => {
      asked.push(path);
      return Promise.resolve((routes[path] as T | undefined) ?? null);
    },
  };
  return { reader, asked };
}

/* ------------------------------------------------------------------ */
/* readSelfIdentity                                                    */
/* ------------------------------------------------------------------ */

test('readSelfIdentity：真机 current-summoner → puuid/summonerId/riotId', async () => {
  const { reader } = fakeLcu({
    '/lol-summoner/v1/current-summoner': {
      puuid: 'my-puuid-0001',
      summonerId: 2001,
      displayName: '小泥人蹲着',
      gameName: '小泥人蹲着',
      tagLine: '86079',
    },
  });
  const me = await readSelfIdentity(reader);
  assert.equal(me.puuid, 'my-puuid-0001');
  assert.equal(me.summonerId, 2001);
  assert.equal(me.riotId, '小泥人蹲着#86079');
});

test('readSelfIdentity：读不到 → 空身份（**不猜**）', async () => {
  const { reader } = fakeLcu({});
  assert.deepEqual(await readSelfIdentity(reader), {});
});

/* ------------------------------------------------------------------ */
/* 顺序：2999 优先于 LCU                                                */
/* ------------------------------------------------------------------ */

test('resolveMyChampionIdentity：2999 有 rawChampionName → 直接用，**不问 LCU**', async () => {
  const { reader, asked } = fakeLcu({
    '/lol-summoner/v1/current-summoner': { puuid: 'my-puuid-0001', summonerId: 2001 },
    '/lol-champ-select/v1/session': { localPlayerCellId: 0, myTeam: [{ cellId: 0, championId: 43 }] },
  });
  const live = createLiveDataClient({
    fetchJson: () => Promise.resolve(livePayload({ raw: 'game_character_displayname_Gragas' })),
  });
  const id = await resolveMyChampionIdentity(reader, { champions: CHAMPIONS, live });
  assert.equal(id.championId, 79);
  assert.equal(id.source, 'activePlayer-raw');
  assert.deepEqual(asked, []); // 一次 LCU 都没问
});

test('resolveMyChampionIdentity：2999 只有 allPlayers[我].championName → activePlayer-name', async () => {
  const { reader, asked } = fakeLcu({});
  const live = createLiveDataClient({ fetchJson: () => Promise.resolve(livePayload({ meName: '酒桶' })) });
  const id = await resolveMyChampionIdentity(reader, { champions: CHAMPIONS, live });
  assert.equal(id.championId, 79);
  assert.equal(id.source, 'activePlayer-name');
  assert.match(id.matchedBy, /酒桶/);
  assert.deepEqual(asked, []);
});

test('resolveMyChampionIdentity：2999 一个名字都给不出 → 走 LCU 选人会话', async () => {
  const { reader } = fakeLcu({
    '/lol-summoner/v1/current-summoner': { puuid: 'my-puuid-0001', summonerId: 2001 },
    '/lol-champ-select/v1/session': { localPlayerCellId: 1, myTeam: [{ cellId: 1, championId: 79 }] },
    '/lol-gameflow/v1/session': { gameData: { teamOne: [{ puuid: 'other', championId: 154 }] } },
  });
  // 老版本报文：activePlayer 没有 championName，allPlayers 里我那条也没有
  const live = createLiveDataClient({ fetchJson: () => Promise.resolve(livePayload({ meName: '' })) });
  const id = await resolveMyChampionIdentity(reader, { champions: CHAMPIONS, live });
  assert.equal(id.championId, 79);
  assert.equal(id.source, 'lcu-champsession');
});

test('resolveMyChampionIdentity：allPlayers 定位不到我 → **不取列表里第一个人的名字**', async () => {
  const { reader } = fakeLcu({});
  // activePlayer 没有任何名字字段，allPlayers 里只有"别人"
  const live = createLiveDataClient({
    fetchJson: () => Promise.resolve(livePayload({ meName: '', meVisible: false })),
  });
  const id = await resolveMyChampionIdentity(reader, { champions: CHAMPIONS, live });
  assert.equal(id.championId, 0);
  assert.equal(id.source, 'none');
});

test('resolveMyChampionIdentity：2999 未就绪 + 无 LCU → none（不画）', async () => {
  const id = await resolveMyChampionIdentity(null, { champions: CHAMPIONS, live: null });
  assert.equal(id.championId, 0);
  assert.equal(id.source, 'none');
});

test('resolveMyChampionIdentity：只有别人的 championId → none（真机事故的防回归）', async () => {
  const { reader } = fakeLcu({
    '/lol-summoner/v1/current-summoner': { puuid: 'my-puuid-0001', summonerId: 2001 },
    '/lol-champ-select/v1/session': { myTeam: [{ cellId: 0, championId: 154 }, { cellId: 3, championId: 43 }] },
    '/lol-gameflow/v1/session': { gameData: { teamOne: [{ puuid: 'a', championId: 154 }, { puuid: 'b', championId: 43 }] } },
  });
  const id = await resolveMyChampionIdentity(reader, { champions: CHAMPIONS, live: null });
  assert.equal(id.championId, 0);
  assert.equal(id.source, 'none');
  assert.match(id.reason, /不取队友的/);
});

test('resolveMyChampionIdentity：gameflow 里能用我的 puuid 定位 → gameflow-self', async () => {
  const { reader } = fakeLcu({
    '/lol-summoner/v1/current-summoner': { puuid: 'my-puuid-0001', summonerId: 2001 },
    '/lol-gameflow/v1/session': {
      gameData: { teamOne: [{ puuid: 'a', championId: 154 }], teamTwo: [{ puuid: 'my-puuid-0001', championId: 11 }] },
    },
  });
  const id = await resolveMyChampionIdentity(reader, { champions: CHAMPIONS, live: null });
  assert.equal(id.championId, 11);
  assert.equal(id.source, 'gameflow-self');
});

test('resolveMyChampionIdentity：调用方已取到的会话不会重复请求（省本地往返）', async () => {
  const { reader, asked } = fakeLcu({
    '/lol-summoner/v1/current-summoner': { puuid: 'my-puuid-0001', summonerId: 2001 },
  });
  const id = await resolveMyChampionIdentity(reader, {
    champions: CHAMPIONS,
    live: null,
    champSelect: { localPlayerCellId: 0, myTeam: [{ cellId: 0, championId: 11 }] },
    gameflow: null,
  });
  assert.equal(id.championId, 11);
  assert.deepEqual(asked, ['/lol-summoner/v1/current-summoner']);
});
