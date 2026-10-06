/**
 * 「这一局我用的是哪个英雄」——身份解析（**纯函数**，有单测）
 *
 * ⚠️ 为什么值得单独抽一个模块（真机事故 2026-10-05，两次）：
 *   局内强度标签的档位是**以英雄为准**的（同一颗海克斯在不同英雄身上等级不同），
 *   所以"我是谁"认错一次，整局的标签就变成了**别人英雄的强度表** ——
 *   表现是"看起来对、其实错"，比画不出来危险得多（用户 13 张卡 0 命中 / 9 张
 *   全命中都是巧合，前者因为拿的是 Zac 的表、后者全是每张表都有的泛用海克斯）。
 *
 *   旧实现（`debug-augment.ts` 的 `resolveChampionId`）依次试：
 *     ① 选人会话 `myTeam` 里 `cellId === localPlayerCellId` 的**那条**（正确）
 *        → 但**拿不到"我的格子"时就取 `myTeam` 里第一个有 championId 的人**（错：队友）；
 *     ② gameflow 会话里**有界搜索** `championId`（错：10 人队伍列表里取第一个命中的）。
 *   真机证据：玩**无极剑圣**解析出 `154`（生化魔人 Zac）、玩**酒桶**（79）解析出
 *   `43`（天启者 Karma）—— 两个都是队友。
 *
 * 现在的口径（**以"我自己"为唯一权威来源**；逐级退让，任一级不确定就换下一级，
 * 全部不确定 → `source='none'`、`championId=0`、**一张标签都不画**）：
 *
 *   ① `activePlayer-raw`   2999 `activePlayer.rawChampionName`
 *                          （真机形如 `game_character_displayname_Gragas`）→ 取英文别名
 *                          → 与图鉴 `champions[].alias` 匹配（真机确认 alias 存在）；
 *   ② `activePlayer-name`  2999 `activePlayer.championName`（真机＝中文名「光辉女郎」）
 *                          或 `allPlayers[我].championName` → 与图鉴 `name`/`alias` 匹配；
 *   ③ `lcu-champsession`   LCU 选人会话：**必须**有"我的格子"
 *                          （`localPlayerCellId`，或显式传入的 `me.cellId`）→
 *                          `myTeam` 里**那一格**的 championId（绝不取第一个）；
 *   ④ `gameflow-self`      gameflow 会话：**必须**能用"我自己的身份"
 *                          （puuid / summonerId / 我自己的 cellId）定位到那条记录；
 *   ⑤ `none`               拿不到可靠身份 → 不画（宁可一张不画，也不画别人的）。
 *
 * 防回归靠**类型**：解析入口一律要求显式传入 `SelfIdentity`，
 * `pickMyChampionIdFromGameflow` 在没有身份时直接返回 null ——
 * "遍历队伍列表取第一个 championId"在类型上就写不出来。
 */

import type { Champion } from '@hexbox/core';

import type { LiveChampionNames } from './live-data.ts';

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

/**
 * 身份来源（**写进 `report.json` 的 `labels` 段**，真机一眼可核）。
 *
 * `gameflow-self` 不在最初约定的四个值里，但它是"能用我自己的身份定位"的
 * 合法通道（见本文件顶部 ④），单独命名而不是混进 `lcu-champsession`，
 * 免得复盘时分不清"选人会话"与"局内 gameflow 兜底"。
 */
export const CHAMPION_IDENTITY_SOURCES = [
  'activePlayer-raw',
  'activePlayer-name',
  'lcu-champsession',
  'gameflow-self',
  'none',
] as const;

export type ChampionIdentitySource = (typeof CHAMPION_IDENTITY_SOURCES)[number];

/**
 * **我自己的身份** —— 在 gameflow 的队伍列表里定位"我"的唯一依据。
 *
 * ⚠️ 字段全可选，但解析函数**必须**显式收到这个对象（不是内部去猜），
 * 且全空时 gameflow 通道直接放弃：这是"禁止取第一个 championId"的类型级保证。
 */
export interface SelfIdentity {
  readonly puuid?: string;
  readonly summonerId?: number;
  /** 我自己的 cellId（选人会话的 `localPlayerCellId` 之外的兜底）。 */
  readonly cellId?: number;
  readonly riotId?: string;
  readonly summonerName?: string;
}

/** 解析结果：ID + 来源 + 命中依据（可直接落盘/打日志）。 */
export interface ChampionIdentity {
  /** 0 = 未确定（调用方**必须**不画）。 */
  readonly championId: number;
  readonly source: ChampionIdentitySource;
  /** 命中时实际用到的原始字符串（`rawChampionName` / 名字 / `puuid=…`）。 */
  readonly matchedBy: string;
  /** 图鉴里的英雄名（中文；查不到时为空串）。 */
  readonly championName: string;
  /** 图鉴里的英文别名（查不到时为空串）。 */
  readonly championAlias: string;
  /** 人类可读的原因（日志与产物直接用，不画时要能看出为什么）。 */
  readonly reason: string;
}

/** 「未确定」的规范结果（初始值 / 失败原因都用它）。 */
export function championIdentityNone(reason: string): ChampionIdentity {
  return {
    championId: 0,
    source: 'none',
    matchedBy: '',
    championName: '',
    championAlias: '',
    reason,
  };
}

/** 一次成功命中（不猜：拿不到就是 null）。 */
export interface ChampionIdHit {
  readonly championId: number;
  readonly matchedBy: string;
}

/* ------------------------------------------------------------------ */
/* 小工具（未知形状报文的安全取值）                                      */
/* ------------------------------------------------------------------ */

type Obj = Record<string, unknown>;

function asObj(v: unknown): Obj | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** 只认正整数 ID（0/负数/小数/字符串一律不算）。 */
function posInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
}

/**
 * cellId 判据：**从 0 开始**（真机 `localPlayerCellId` 常见就是 0）。
 *
 * ⚠️ 这里不能用 `posInt`：0 号位是合法且常见的"我的格子"，
 * 用正整数判据会把它当"没有格子"，于是退化成"取队友第一个"——正是真机事故的形状。
 */
function cellInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

/* ------------------------------------------------------------------ */
/* 名字 → 英雄                                                         */
/* ------------------------------------------------------------------ */

/**
 * `game_character_displayname_Lux` → `Lux`（**真机形状**）。
 *
 * 不用"固定前缀截断"而是取最后一个 `displayname_` 之后的部分：
 * 前缀在版本间变过（`game_character_displayname_`、`game_character_displayname_`
 * 之外还见过带模块名的写法），这样两种都能吃。不是该形状时原样返回
 * （`activePlayer.championName` 就是中文名，直接进匹配）。
 */
export function aliasFromRawChampionName(raw: string): string {
  const s = raw.trim();
  if (s === '') return '';
  const marker = 'displayname_';
  const i = s.lastIndexOf(marker);
  return i >= 0 ? s.slice(i + marker.length) : s;
}

/**
 * 名字归一化：只留字母/数字/汉字并小写 ——
 * `K'Sante` / `KSante` / `ksante` 视为同一个键（真机别名与图鉴别名的写法差异）。
 */
function nameKey(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
}

/**
 * 按名字找图鉴英雄：**先 alias（英文/内部名），再 name（中文名）**。
 *
 * 图鉴 245 条英雄记录的 alias **互不重复**（实测；= 173 个真实英雄 + 72 条同一英雄的变体条目），所以 alias 命中即唯一答案；
 * `activePlayer.championName` 是真机实测的中文名，走第二键。
 * 同一英雄存在两套 ID（基础 1..999 / 60000+）时取**基础 ID**，
 * 与排行榜、英雄详情（builds）的口径一致。
 */
export function findChampionByName(
  name: string,
  champions: readonly Champion[],
): Champion | null {
  const alias = aliasFromRawChampionName(name);
  const key = nameKey(alias);
  if (key === '') return null;
  const hit =
    champions.find((c) => nameKey(c.alias) === key) ??
    champions.find((c) => nameKey(c.name) === key);
  if (!hit) return null;
  if (hit.id >= 60000) {
    const base = champions.find((c) => c.id < 60000 && nameKey(c.name) === nameKey(hit.name));
    return base ?? hit;
  }
  return hit;
}

/** 是否有任何一种"我自己的身份"（全空则 gameflow 通道不可用）。 */
export function hasSelfIdentity(me: SelfIdentity): boolean {
  return (
    str(me.puuid) !== '' ||
    posInt(me.summonerId) !== null ||
    cellInt(me.cellId) !== null ||
    str(me.riotId) !== '' ||
    str(me.summonerName) !== ''
  );
}

/* ------------------------------------------------------------------ */
/* 选人会话                                                            */
/* ------------------------------------------------------------------ */

/**
 * 选人会话里**我那一格**的 championId。
 *
 * ⚠️ 没有"我的格子"（`localPlayerCellId` 与 `me.cellId` 都没有）时返回 null，
 * **绝不**退化成"取 myTeam 里第一个有 championId 的人" —— 那正是真机事故。
 */
export function pickMyChampionIdFromChampSelect(
  session: unknown,
  me: SelfIdentity,
): ChampionIdHit | null {
  const root = asObj(session);
  if (!root) return null;
  const cell = cellInt(root['localPlayerCellId']) ?? cellInt(me.cellId);
  if (cell === null) return null;
  const team = Array.isArray(root['myTeam']) ? root['myTeam'] : [];
  const mine = team.map(asObj).find((m) => m !== null && cellInt(m['cellId']) === cell);
  const id = posInt(mine?.['championId']);
  if (id === null) return null;
  return { championId: id, matchedBy: `myTeam[cellId=${cell}]` };
}

/* ------------------------------------------------------------------ */
/* gameflow 会话（必须"我自己"定位得到才认）                             */
/* ------------------------------------------------------------------ */

/** 队伍条目上可能承载"我是谁"的字段（按可靠性排序）。 */
const SELF_NAME_KEYS = ['riotId', 'summonerName', 'displayName', 'gameName'] as const;

/**
 * 这个节点是不是"我"（返回命中依据与优先级；优先级越小越可靠）。
 *
 * 只做**具体字段的等值比较**：puuid 最可靠（`obfuscatedPuuid` 不算），
 * 其次 summonerId，再其次我自己的 cellId，最后才是显示名。
 */
function matchSelf(
  node: Obj,
  me: SelfIdentity,
): { readonly matchedBy: string; readonly priority: number } | null {
  const myPuuid = str(me.puuid);
  if (myPuuid !== '' && str(node['puuid']) === myPuuid) {
    return { matchedBy: `puuid=${myPuuid}`, priority: 1 };
  }
  const mySummonerId = posInt(me.summonerId);
  if (mySummonerId !== null && posInt(node['summonerId']) === mySummonerId) {
    return { matchedBy: `summonerId=${mySummonerId}`, priority: 2 };
  }
  const myCell = cellInt(me.cellId);
  if (myCell !== null && cellInt(node['cellId']) === myCell) {
    return { matchedBy: `cellId=${myCell}`, priority: 3 };
  }
  const names = [str(me.riotId), str(me.summonerName)]
    .filter((n) => n !== '')
    .map((n) => n.toLowerCase());
  for (const n of names) {
    for (const k of SELF_NAME_KEYS) {
      if (str(node[k]).toLowerCase() === n) return { matchedBy: `${k}=${n}`, priority: 4 };
    }
  }
  return null;
}

/**
 * gameflow 会话里**我自己**那条记录的 championId（有界深度 + 防环）。
 *
 * ⚠️ 与旧的 `pickChampionIdFromGameflow` 的区别就是**多了一个"我是谁"的门槛**：
 * 没有身份 → 直接 null；有身份 → 只认"既带 championId 又匹配我"的节点。
 * 队友（不匹配我）无论排在第几都取不到。
 */
export function pickMyChampionIdFromGameflow(
  session: unknown,
  me: SelfIdentity,
  maxDepth = 6,
): ChampionIdHit | null {
  if (!hasSelfIdentity(me)) return null;

  const seen = new Set<unknown>();
  const walk = (
    node: unknown,
    depth: number,
  ): { readonly championId: number; readonly matchedBy: string; readonly priority: number } | null => {
    if (depth > maxDepth || node === null || typeof node !== 'object') return null;
    if (seen.has(node)) return null; // 防循环引用
    seen.add(node);

    let found: { readonly championId: number; readonly matchedBy: string; readonly priority: number } | null =
      null;
    const consider = (
      r: { readonly championId: number; readonly matchedBy: string; readonly priority: number } | null,
    ): void => {
      if (r !== null && (found === null || r.priority < found.priority)) found = r;
    };

    if (Array.isArray(node)) {
      for (const item of node) consider(walk(item, depth + 1));
      return found;
    }

    const obj = node as Obj;
    const id = posInt(obj['championId']);
    if (id !== null) {
      const m = matchSelf(obj, me);
      if (m) found = { championId: id, matchedBy: m.matchedBy, priority: m.priority };
    }
    for (const v of Object.values(obj)) consider(walk(v, depth + 1));
    return found;
  };

  const hit = walk(session, 0);
  return hit === null ? null : { championId: hit.championId, matchedBy: hit.matchedBy };
}

/* ------------------------------------------------------------------ */
/* 总入口（纯函数）                                                     */
/* ------------------------------------------------------------------ */

export interface ChampionIdentityInput {
  /** ⚠️ 必填：我自己的身份（没有它就没有 gameflow 通道）。 */
  readonly me: SelfIdentity;
  /** 2999 `activePlayer` 的名字（局内才有；不在对局里就是 null）。 */
  readonly live: LiveChampionNames | null;
  /** LCU 选人会话（局内已消失 → 通常只有选人阶段有）。 */
  readonly champSelect: unknown;
  /** LCU gameflow 会话（只有能用 `me` 定位"我"时才会被采纳）。 */
  readonly gameflow: unknown;
  /** 图鉴英雄表（name/alias 反查的**唯一**依据）。 */
  readonly champions: readonly Champion[];
}

function identityOf(
  champion: Champion,
  source: ChampionIdentitySource,
  matchedBy: string,
  reason: string,
): ChampionIdentity {
  return {
    championId: champion.id,
    source,
    matchedBy,
    championName: champion.name,
    championAlias: champion.alias,
    reason,
  };
}

/** 认不出来时说清**每一级**为什么失败（真机排查只看这行）。 */
function explainNone(input: ChampionIdentityInput): string {
  const parts: string[] = [];
  const raw = str(input.live?.rawChampionName);
  const name = str(input.live?.championName) || str(input.live?.myChampionName);
  if (input.live === null) {
    parts.push('2999 未就绪（未进对局/被拦）');
  } else if (raw === '' && name === '') {
    parts.push('2999 activePlayer 无 rawChampionName 也无 championName');
  } else {
    parts.push(`2999 的名字（${[raw, name].filter((s) => s !== '').join(' / ')}）在图鉴里查不到`);
  }
  if (asObj(input.champSelect) === null) {
    parts.push('LCU 无选人会话（局内已消失）');
  } else {
    parts.push('选人会话里没有"我的格子"（localPlayerCellId/cellId）→ 不取队友的');
  }
  if (!hasSelfIdentity(input.me)) {
    parts.push('也没有我自己的身份（puuid/summonerId/cellId）→ gameflow 不可用');
  } else {
    parts.push('gameflow 里定位不到"我"那条记录');
  }
  return parts.join('；');
}

/**
 * 解析"我这局用哪个英雄"。**逐级退让、任一级不确定就换下一级、全不确定就不猜。**
 *
 * 优先级：`activePlayer-raw` → `activePlayer-name` → `lcu-champsession` → `gameflow-self`。
 */
export function resolveChampionIdentity(input: ChampionIdentityInput): ChampionIdentity {
  const { me, live, champSelect, gameflow, champions } = input;

  // ① activePlayer.rawChampionName（真机形状 game_character_displayname_Gragas）
  const raw = str(live?.rawChampionName);
  if (raw !== '') {
    const alias = aliasFromRawChampionName(raw);
    const hit = findChampionByName(alias, champions);
    if (hit) {
      return identityOf(
        hit,
        'activePlayer-raw',
        raw,
        `2999 activePlayer.rawChampionName=${raw} → 别名 ${alias}`,
      );
    }
  }

  // ② activePlayer.championName（真机＝中文名）/ allPlayers 里我那条的 championName
  const nameCandidates: ReadonlyArray<readonly [string, string]> = [
    [str(live?.championName), 'activePlayer.championName'],
    [str(live?.myChampionName), 'allPlayers[我].championName'],
  ];
  for (const [name, from] of nameCandidates) {
    if (name === '') continue;
    const hit = findChampionByName(name, champions);
    if (hit) {
      return identityOf(hit, 'activePlayer-name', name, `2999 ${from}=${name}`);
    }
  }

  // ③ LCU 选人会话：只认"我的格子"
  const cs = pickMyChampionIdFromChampSelect(champSelect, me);
  if (cs) {
    const hit = champions.find((c) => c.id === cs.championId) ?? null;
    const reason = `LCU 选人会话 ${cs.matchedBy}`;
    if (hit) return identityOf(hit, 'lcu-champsession', cs.matchedBy, reason);
    // 会话给了官方 ID 但图鉴里没有这个英雄：ID 本身仍可用（只是没有名字）
    return {
      championId: cs.championId,
      source: 'lcu-champsession',
      matchedBy: cs.matchedBy,
      championName: '',
      championAlias: '',
      reason: `${reason}（图鉴无此 ID）`,
    };
  }

  // ④ gameflow：必须能用"我自己的身份"定位
  const gf = pickMyChampionIdFromGameflow(gameflow, me);
  if (gf) {
    const hit = champions.find((c) => c.id === gf.championId) ?? null;
    const reason = `gameflow 用我自己的身份定位到 ${gf.matchedBy}`;
    if (hit) return identityOf(hit, 'gameflow-self', gf.matchedBy, reason);
    return {
      championId: gf.championId,
      source: 'gameflow-self',
      matchedBy: gf.matchedBy,
      championName: '',
      championAlias: '',
      reason: `${reason}（图鉴无此 ID）`,
    };
  }

  // ⑤ 不猜
  return championIdentityNone(explainNone(input));
}
