/**
 * 英雄身份解析测试（**真机事故的防回归网**）
 *
 * 报文/字段形状全部取自真机（2026-10-05）：
 *   · `activePlayer.rawChampionName` = `game_character_displayname_Gragas`
 *   · `activePlayer.championName`   = `光辉女郎`（客户端语言 = 中文）
 *   · 图鉴 `champions[].alias`      = `Gragas` / `MasterYi` / `Zac`（真机确认存在）
 *   · 事故结果：玩无极剑圣解析出 154（Zac）、玩酒桶解析出 43（Karma）—— 都是队友
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Champion } from '@hexbox/core';

import {
  aliasFromRawChampionName,
  findChampionByName,
  hasSelfIdentity,
  pickMyChampionIdFromChampSelect,
  pickMyChampionIdFromGameflow,
  resolveChampionIdentity,
  type SelfIdentity,
} from './champion-identity.ts';

/** 图鉴切片（真机口径：id/name/alias 三件套）。 */
const CHAMPIONS: readonly Champion[] = [
  { id: 11, name: '无极剑圣', alias: 'MasterYi', roles: [], iconPath: '' },
  { id: 79, name: '酒桶', alias: 'Gragas', roles: [], iconPath: '' },
  { id: 154, name: '生化魔人', alias: 'Zac', roles: [], iconPath: '' },
  { id: 43, name: '天启者', alias: 'Karma', roles: [], iconPath: '' },
  { id: 99, name: '光辉女郎', alias: 'Lux', roles: [], iconPath: '' },
  { id: 62, name: '齐天大圣', alias: 'MonkeyKing', roles: [], iconPath: '' },
  { id: 60001, name: '黑暗之女', alias: 'Annie', roles: [], iconPath: '' },
  { id: 1, name: '黑暗之女', alias: 'AnnieBase', roles: [], iconPath: '' },
];

/** 我自己（LCU `/lol-summoner/v1/current-summoner`）。 */
const ME: SelfIdentity = {
  puuid: 'my-puuid-0001',
  summonerId: 2001,
  riotId: '小泥人蹲着#86079',
  summonerName: '小泥人蹲着#86079',
};

/* ------------------------------------------------------------------ */
/* rawChampionName → 别名                                              */
/* ------------------------------------------------------------------ */

test('aliasFromRawChampionName：真机形状 game_character_displayname_X → X', () => {
  assert.equal(aliasFromRawChampionName('game_character_displayname_Gragas'), 'Gragas');
  assert.equal(aliasFromRawChampionName('game_character_displayname_Lux'), 'Lux');
  assert.equal(aliasFromRawChampionName('game_character_displayname_MonkeyKing'), 'MonkeyKing');
});

test('aliasFromRawChampionName：不是该形状时原样返回（中文名直接进匹配）', () => {
  assert.equal(aliasFromRawChampionName('光辉女郎'), '光辉女郎');
  assert.equal(aliasFromRawChampionName('  Gragas  '), 'Gragas');
  assert.equal(aliasFromRawChampionName(''), '');
});

test('findChampionByName：英文别名 / 中文名都能反查到 ID', () => {
  assert.equal(findChampionByName('Gragas', CHAMPIONS)?.id, 79);
  assert.equal(findChampionByName('game_character_displayname_MasterYi', CHAMPIONS)?.id, 11);
  assert.equal(findChampionByName('光辉女郎', CHAMPIONS)?.id, 99);
  assert.equal(findChampionByName('无极剑圣', CHAMPIONS)?.id, 11);
});

test('findChampionByName：大小写/撇号差异不敏感，查不到就 null（不猜）', () => {
  assert.equal(findChampionByName('gragas', CHAMPIONS)?.id, 79);
  assert.equal(findChampionByName("K'Sante", [...CHAMPIONS, { id: 897, name: '纳祖芒荣耀', alias: 'KSante', roles: [], iconPath: '' }])?.id, 897);
  assert.equal(findChampionByName('不存在的英雄', CHAMPIONS), null);
  assert.equal(findChampionByName('', CHAMPIONS), null);
});

test('findChampionByName：同一英雄的两套 ID 取**基础 ID**（榜单/详情用这一套）', () => {
  assert.equal(findChampionByName('黑暗之女', CHAMPIONS)?.id, 1);
});

/* ------------------------------------------------------------------ */
/* ① 2999 activePlayer 是权威来源                                       */
/* ------------------------------------------------------------------ */

test('resolveChampionIdentity：真机 rawChampionName → activePlayer-raw（酒桶 79，不是队友的 43）', () => {
  const id = resolveChampionIdentity({
    me: ME,
    live: {
      rawChampionName: 'game_character_displayname_Gragas',
      championName: '酒桶',
      myChampionName: '酒桶',
    },
    // 就算 LCU 那边摆着别人的 championId，也不该被采纳
    champSelect: { localPlayerCellId: 0, myTeam: [{ cellId: 3, championId: 43 }] },
    gameflow: { gameData: { teamOne: [{ puuid: 'other-puuid', championId: 154 }] } },
    champions: CHAMPIONS,
  });
  assert.equal(id.championId, 79);
  assert.equal(id.source, 'activePlayer-raw');
  assert.equal(id.championName, '酒桶');
  assert.equal(id.championAlias, 'Gragas');
  assert.match(id.matchedBy, /displayname_Gragas/);
});

test('resolveChampionIdentity：真机 championName（中文）→ activePlayer-name（光辉女郎 99）', () => {
  const id = resolveChampionIdentity({
    me: ME,
    live: { rawChampionName: '', championName: '光辉女郎', myChampionName: '' },
    champSelect: null,
    gameflow: null,
    champions: CHAMPIONS,
  });
  assert.equal(id.championId, 99);
  assert.equal(id.source, 'activePlayer-name');
});

test('resolveChampionIdentity：allPlayers[我].championName 是第二匹配键', () => {
  const id = resolveChampionIdentity({
    me: ME,
    live: { rawChampionName: '', championName: '', myChampionName: '无极剑圣' },
    champSelect: null,
    gameflow: null,
    champions: CHAMPIONS,
  });
  assert.equal(id.championId, 11);
  assert.equal(id.source, 'activePlayer-name');
});

/* ------------------------------------------------------------------ */
/* ② LCU 选人会话：只认"我的格子"                                        */
/* ------------------------------------------------------------------ */

test('pickMyChampionIdFromChampSelect：按 localPlayerCellId 取我自己那一格', () => {
  const hit = pickMyChampionIdFromChampSelect(
    {
      localPlayerCellId: 2,
      myTeam: [
        { cellId: 0, championId: 154 },
        { cellId: 2, championId: 11 },
        { cellId: 3, championId: 43 },
      ],
    },
    {},
  );
  assert.equal(hit?.championId, 11);
});

test('pickMyChampionIdFromChampSelect：**0 号位也是我的格子**（真机常见）', () => {
  const hit = pickMyChampionIdFromChampSelect(
    {
      localPlayerCellId: 0,
      myTeam: [
        { cellId: 0, championId: 79 },
        { cellId: 3, championId: 43 },
      ],
    },
    {},
  );
  assert.equal(hit?.championId, 79);
});

test('pickMyChampionIdFromChampSelect：没有"我的格子"→ null（**绝不**取队友的第一条）', () => {
  const session = {
    myTeam: [
      { cellId: 0, championId: 154 },
      { cellId: 3, championId: 43 },
    ],
  };
  assert.equal(pickMyChampionIdFromChampSelect(session, {}), null);
  // 但若有显式身份 cellId，就能定位
  assert.equal(pickMyChampionIdFromChampSelect(session, { cellId: 3 })?.championId, 43);
});

test('pickMyChampionIdFromChampSelect：我这一格还没选（championId=0）→ null', () => {
  const hit = pickMyChampionIdFromChampSelect(
    { localPlayerCellId: 0, myTeam: [{ cellId: 0, championId: 0 }, { cellId: 3, championId: 43 }] },
    {},
  );
  assert.equal(hit, null);
});

test('resolveChampionIdentity：选人阶段（2999 未就绪）→ lcu-champsession', () => {
  const id = resolveChampionIdentity({
    me: ME,
    live: null,
    champSelect: { localPlayerCellId: 1, myTeam: [{ cellId: 1, championId: 79 }] },
    gameflow: null,
    champions: CHAMPIONS,
  });
  assert.equal(id.championId, 79);
  assert.equal(id.source, 'lcu-champsession');
});

/* ------------------------------------------------------------------ */
/* ③ gameflow：必须能用"我自己的身份"定位（负例是这次事故的核心）            */
/* ------------------------------------------------------------------ */

test('pickMyChampionIdFromGameflow：没有我的身份 → null（类型上就禁止猜）', () => {
  const session = {
    gameData: {
      teamOne: [
        { puuid: 'a', championId: 154 },
        { puuid: 'b', championId: 43 },
      ],
    },
  };
  assert.equal(pickMyChampionIdFromGameflow(session, {}), null);
});

test('pickMyChampionIdFromGameflow：队伍列表里 10 个人，只有匹配我的 puuid 那条才算数', () => {
  const team = Array.from({ length: 10 }, (_v, i) => ({
    puuid: `player-${i}`,
    championId: 100 + i,
  }));
  team.push({ puuid: 'my-puuid-0001', championId: 79 });
  const hit = pickMyChampionIdFromGameflow({ gameData: { teamOne: team } }, ME);
  assert.equal(hit?.championId, 79);
  assert.match(hit?.matchedBy ?? '', /puuid=my-puuid-0001/);
});

test('pickMyChampionIdFromGameflow：我的身份在队伍里但那条没有 championId → null（不取别人）', () => {
  const session = {
    gameData: {
      teamOne: [
        { puuid: 'my-puuid-0001' },
        { puuid: 'other', championId: 154 },
      ],
    },
  };
  assert.equal(pickMyChampionIdFromGameflow(session, ME), null);
});

test('pickMyChampionIdFromGameflow：summonerId 也能定位；obfuscatedPuuid 不算我', () => {
  const session = {
    team: [
      { obfuscatedPuuid: 'my-puuid-0001', championId: 154 },
      { summonerId: 2001, championId: 11 },
    ],
  };
  const hit = pickMyChampionIdFromGameflow(session, ME);
  assert.equal(hit?.championId, 11);
  assert.match(hit?.matchedBy ?? '', /summonerId=2001/);
});

test('pickMyChampionIdFromGameflow：超过深度限制/循环引用不死循环', () => {
  const deep: Record<string, unknown> = {};
  let cur = deep;
  for (let i = 0; i < 8; i++) {
    const next: Record<string, unknown> = {};
    cur['nested'] = next;
    cur = next;
  }
  cur['puuid'] = 'my-puuid-0001';
  cur['championId'] = 79;
  assert.equal(pickMyChampionIdFromGameflow(deep, ME), null); // 默认深度 6 够不到
  assert.equal(pickMyChampionIdFromGameflow(deep, ME, 12)?.championId, 79);

  const cyclic: Record<string, unknown> = { puuid: 'other', championId: 154 };
  cyclic['self'] = cyclic;
  assert.equal(pickMyChampionIdFromGameflow(cyclic, ME), null);
});

test('resolveChampionIdentity：局内 gameflow 兜底 → gameflow-self（后面还有队友也不取）', () => {
  const id = resolveChampionIdentity({
    me: ME,
    live: { rawChampionName: '', championName: '', myChampionName: '' },
    champSelect: null,
    gameflow: {
      gameData: {
        teamOne: [{ puuid: 'x', championId: 154 }],
        teamTwo: [{ puuid: 'my-puuid-0001', championId: 11 }],
      },
    },
    champions: CHAMPIONS,
  });
  assert.equal(id.championId, 11);
  assert.equal(id.source, 'gameflow-self');
});

/* ------------------------------------------------------------------ */
/* ④ 拿不到可靠身份 → 一张不画                                          */
/* ------------------------------------------------------------------ */

test('resolveChampionIdentity：什么都没有 → championId=0 / none，且原因写清每一级', () => {
  const id = resolveChampionIdentity({
    me: {},
    live: null,
    champSelect: null,
    gameflow: { gameData: { teamOne: [{ puuid: 'a', championId: 154 }] } },
    champions: CHAMPIONS,
  });
  assert.equal(id.championId, 0);
  assert.equal(id.source, 'none');
  assert.match(id.reason, /2999 未就绪/);
  assert.match(id.reason, /无选人会话/);
  assert.match(id.reason, /gameflow 不可用/);
});

test('resolveChampionIdentity：2999 名字认不出、选人会话没有我的格子 → 不猜（这就是真机事故的形状）', () => {
  const id = resolveChampionIdentity({
    me: {},
    live: { rawChampionName: '', championName: '', myChampionName: '' },
    // 旧实现会在这里取到 154（Zac）——现在必须放弃
    champSelect: { myTeam: [{ cellId: 0, championId: 154 }] },
    gameflow: { gameData: { teamOne: [{ championId: 43 }] } },
    champions: CHAMPIONS,
  });
  assert.equal(id.championId, 0);
  assert.equal(id.source, 'none');
});

test('hasSelfIdentity：任一身份字段有效即视为有身份（cellId 0 也有效！）', () => {
  assert.equal(hasSelfIdentity({}), false);
  assert.equal(hasSelfIdentity({ puuid: '  ' }), false);
  assert.equal(hasSelfIdentity({ summonerId: 0 }), false);
  assert.equal(hasSelfIdentity({ summonerId: 7 }), true);
  // ⚠️ 0 号位是常见的"我的格子"，不能当成"没有身份"
  assert.equal(hasSelfIdentity({ cellId: 0 }), true);
  assert.equal(hasSelfIdentity({ riit: '' } as SelfIdentity), false);
  assert.equal(hasSelfIdentity({ riotId: 'a#b' }), true);
});
