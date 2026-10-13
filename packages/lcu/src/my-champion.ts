/**
 * 「我的英雄」解析（I/O 桥）—— 判定逻辑全在 `champion-identity.ts`（纯函数 + 单测）
 *
 * 这个文件只做四件事，其它一概不做：
 *   1. 读 2999 的 `activePlayer` 名字（**最优先**：它直接就是"我自己"）；
 *   2. 读 LCU 当前召唤师身份（puuid / summonerId / 显示名）—— 供 gameflow 自我定位；
 *   3. 读 LCU 选人会话 / gameflow 会话（调用方已经拿到时可以传进来，省一次请求）；
 *   4. `resolveMyChampionIdentityWithRetry()` —— **重连专用**的带重试版本
 *      （缓存优先、2999 兜底 N 次；见该函数注释）。
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

/* ------------------------------------------------------------------ */
/* 重连恢复：缓存优先 → 2999 兜底 N 次                                  */
/* ------------------------------------------------------------------ */

export interface ChampionIdentityRetryOptions {
  /** 最多尝试几次（含第一次）。默认 **3**。 */
  readonly attempts?: number;
  /** 两次尝试之间的间隔。默认 **2000ms**（合起来 ≈ 6 秒内拿到身份）。 */
  readonly intervalMs?: number;
  /** 睡眠注入（单测用假实现；默认真 `setTimeout`）。 */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * **每次尝试之前**调用（含第一次）。
   *
   * 真机用法：重连后 2999 可能刚起来或会话还在重建 —— 在这里**重建 2999 客户端**
   * （`createLiveDataClient()`）再试，比拿着一个已经废掉的客户端重试有意义得多。
   * 单测用它计次。
   */
  readonly beforeAttempt?: (attempt: number) => Promise<void> | void;
}

export interface ChampionIdentityRetryResult {
  readonly identity: ChampionIdentity;
  /** 实际尝试了几次（成功时就是成功那一次）。 */
  readonly attempts: number;
  /** `true` = 试满次数仍未确定 → 调用方按"本局不显示该英雄数据"处理（**不许猜**）。 */
  readonly exhausted: boolean;
  /** 每一步的说明，按顺序（直接进日志；失败路径也要能看出"试了几次、每次为什么"). */
  readonly notes: readonly string[];
}

/**
 * 解析入参：**可以直接给对象，也可以给工厂**。
 *
 * 为什么允许工厂（重连路径的真实需求）：2999 的客户端在重连后可能已经废掉，
 * 需要**每次尝试前重建**，而那意味着 `live` / `champSelect` / `gameflow` 都要重新取。
 * 传对象的话第一次就固定住了，`beforeAttempt` 里再怎么重建都没用
 * （本仓库单测锁住了"工厂必须每次尝试都被调用一次"）。
 */
export type ResolveMyChampionOptionsSource =
  | ResolveMyChampionOptions
  | (() => ResolveMyChampionOptions);

/**
 * 带重试的「我这局用哪个英雄」——**只用于重连恢复**。
 *
 * ── 为什么重连才需要重试（而不是每轮都重试）────────────────────────────────
 *
 * 正常进局时第一个采样就能拿到身份（2999 或选人会话都在）。真正会"一开始拿不到"
 * 的时机只有**重连**：选人会话已消失、2999 那一刻可能还没就绪，于是身份会解析失败。
 * 如果每 2 秒轮询都对所有通道重试，代价是每轮多打几次本地请求；只在恢复路径上
 * 重试（3 次 × 2 秒）既够用又不会给正常路径加负担。
 *
 * ⚠️ 这里**只重试"读不到"**，不改变任何识别口径：仍然走
 * `resolveMyChampionIdentity`（2999 优先、绝不取"第一个 championId"）。
 * 试满仍失败就返回 `exhausted: true`，由调用方决定"这一局先不显示"。
 */
export async function resolveMyChampionIdentityWithRetry(
  client: LcuReader | null,
  source: ResolveMyChampionOptionsSource,
  retry: ChampionIdentityRetryOptions = {},
): Promise<ChampionIdentityRetryResult> {
  const attempts = Math.max(1, Math.floor(retry.attempts ?? 3));
  const intervalMs = Math.max(0, Math.floor(retry.intervalMs ?? 2000));
  const sleep = retry.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const notes: string[] = [];
  let last: ChampionIdentity = {
    championId: 0,
    source: 'none',
    matchedBy: '',
    championName: '',
    championAlias: '',
    reason: '尚未尝试',
  };

  for (let n = 1; n <= attempts; n++) {
    // ⚠️ 每轮重新取值：重连时 `live` 必须能是"刚重建的那个客户端"
    const options = typeof source === 'function' ? source() : source;

    if (retry.beforeAttempt) {
      try {
        await retry.beforeAttempt(n);
      } catch (err) {
        // 准备失败**不**中止：下一次尝试可能就好了（重连期间这很常见）
        notes.push(`第 ${n} 次尝试前的准备失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const identity = await resolveMyChampionIdentity(client, options);
    last = identity;

    if (identity.championId > 0) {
      notes.push(`第 ${n}/${attempts} 次尝试成功：来源 ${identity.source}（${identity.reason}）`);
      return { identity, attempts: n, exhausted: false, notes };
    }

    notes.push(`第 ${n}/${attempts} 次未确定：${identity.reason}`);
    if (n < attempts) await sleep(intervalMs);
  }

  notes.push(`连续 ${attempts} 次都未确定本局英雄 → 本局不显示该英雄数据（宁缺勿错）`);
  return { identity: last, attempts, exhausted: true, notes };
}
