/**
 * 「我的英雄」解析（I/O 桥）—— 判定逻辑全在 `champion-identity.ts`（纯函数 + 单测）
 *
 * 这个文件只做三件事，其它一概不做：
 *   1. 读 2999 的 `activePlayer` 名字（**最优先**：它直接就是"我自己"）；
 *   2. 读 LCU 当前召唤师身份（puuid / summonerId / 显示名）—— 供 gameflow 自我定位；
 *   3. 读 LCU 选人会话 / gameflow 会话（调用方已经拿到时可以传进来，省一次请求）。
 *
 * ⚠️ 顺序不是可调的：2999 能认出英雄就**不再问 LCU**（少两次本地请求，
 * 也避免"LCU 的旧数据覆盖 2999 的权威答案"）。旧实现恰好反过来——先跑 LCU 的
 * 有界搜索，于是 2999 里明明写着"我是酒桶"，却画出了 Karma 的强度表。
 */

import type { Champion } from '@hexbox/core';

import {
  resolveChampionIdentity,
  type ChampionIdentity,
  type SelfIdentity,
} from './champion-identity.ts';
import type { LiveDataClient } from './live-data.ts';

/** 只用到读取能力的 LCU 客户端（便于单测注入假实现）。 */
export interface LcuReader {
  get<T = unknown>(path: string): Promise<T>;
  getOrNull<T = unknown>(path: string): Promise<T | null>;
}

export interface ResolveMyChampionOptions {
  /** 图鉴英雄表（name/alias 反查的唯一依据）。 */
  readonly champions: readonly Champion[];
  /** 2999 客户端（不在对局里时为 null/不传）。 */
  readonly live?: LiveDataClient | null;
  /** 已经取到的选人会话（不传则内部再取一次）。 */
  readonly champSelect?: unknown;
  /** 已经取到的 gameflow 会话（不传则内部再取一次）。 */
  readonly gameflow?: unknown;
  /** 我自己的身份（不传则内部读 `/lol-summoner/v1/current-summoner`）。 */
  readonly me?: SelfIdentity;
}

/**
 * 读当前召唤师身份（LCU 一方接口，只读）。
 *
 * 读不到就返回空对象 —— **绝不**用"唯一登录的人""第一个召唤师"之类的东西代替。
 */
export async function readSelfIdentity(client: LcuReader): Promise<SelfIdentity> {
  const s = await client
    .getOrNull<Record<string, unknown>>('/lol-summoner/v1/current-summoner')
    .catch(() => null);
  if (s === null) return {};

  const puuid = typeof s['puuid'] === 'string' ? s['puuid'].trim() : '';
  const summonerId = typeof s['summonerId'] === 'number' ? s['summonerId'] : 0;
  const displayName = typeof s['displayName'] === 'string' ? s['displayName'].trim() : '';
  const gameName = typeof s['gameName'] === 'string' ? s['gameName'].trim() : '';
  const tagLine = typeof s['tagLine'] === 'string' ? s['tagLine'].trim() : '';
  // 国服新版客户端是 gameName#tagLine；旧版/未设置时用 displayName
  const riotId = gameName !== '' && tagLine !== '' ? `${gameName}#${tagLine}` : displayName;

  return {
    ...(puuid !== '' ? { puuid } : {}),
    ...(summonerId > 0 ? { summonerId } : {}),
    ...(riotId !== '' ? { riotId } : {}),
    ...(displayName !== '' ? { summonerName: displayName } : {}),
  };
}

/**
 * 解析"我这局用哪个英雄"（来源会写进产物，真机一眼可核）。
 *
 * `client` 可以为 null（纯看 2999 也能认出英雄；只是没有 LCU 兜底）。
 */
export async function resolveMyChampionIdentity(
  client: LcuReader | null,
  options: ResolveMyChampionOptions,
): Promise<ChampionIdentity> {
  const champions = options.champions;

  // ① 2999 activePlayer（"我自己"的权威来源）：能认出就直接返回
  const live = options.live
    ? await options.live.getChampionNames().catch(() => null)
    : null;
  const fromLive = resolveChampionIdentity({
    me: options.me ?? {},
    live,
    champSelect: null,
    gameflow: null,
    champions,
  });
  if (fromLive.championId > 0 || client === null) return fromLive;

  // ② LCU：我的身份 → 选人会话（只认"我的格子"）→ gameflow（只认定位得到的"我"）
  const me = options.me ?? (await readSelfIdentity(client).catch(() => ({})));
  const champSelect =
    options.champSelect !== undefined
      ? options.champSelect
      : await client.getOrNull('/lol-champ-select/v1/session').catch(() => null);
  const gameflow =
    options.gameflow !== undefined
      ? options.gameflow
      : await client.getOrNull('/lol-gameflow/v1/session').catch(() => null);

  return resolveChampionIdentity({ me, live, champSelect, gameflow, champions });
}
