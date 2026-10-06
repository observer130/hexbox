/**
 * 局内状态读取（Live Client Data API · `https://127.0.0.1:2999`）
 *
 * 只回答触发状态机需要的四个数字/布尔：**等级 / 是否死亡 / 复活倒计时 / 对局时间**。
 * 不读内存、不注入、不解析封包 —— 这是游戏客户端**自带的官方本地 REST 接口**
 * （Riot 文档化的 Game Client API，与 LCU 同类）。
 *
 * 真机已确认（2026-10-05，`debug/live-probe.json`）：
 *   · `activePlayer.level`            ✓
 *   · `allPlayers[我].level`          ✓
 *   · `allPlayers[我].isDead`         ✓
 *   · `allPlayers[我].respawnTimer`   ✓
 *   · `gameData.gameMode` = `KIWI`（海克斯乱斗代号）
 * ⚠️ 只有**局内**存在 2999；不在对局中时连接被拒是**正常**的，返回 null 即可。
 *
 * TLS：游戏用自签证书。这里**只对本次请求**关闭校验（`rejectUnauthorized: false`），
 * 不设 `NODE_TLS_REJECT_UNAUTHORIZED` 全局开关 —— 全局关校验是 AGENTS.md 记过的坑。
 */

import { request } from 'node:https';

/**
 * 2999 里与「我是谁」有关的名字（**真机字段**，缺字段时为空串）。
 *
 * ⚠️ 为什么要单独解析（2026-10-05 真机事故）：`activePlayer.rawChampionName`
 * （形如 `game_character_displayname_Gragas`）与 `championName`（中文名「酒桶」）
 * 是**唯一**能直接回答"我这局用哪个英雄"的官方字段 —— 旧实现没用它们，
 * 转而去 gameflow 的 10 人队伍列表里搜索 `championId`，结果拿到了队友的英雄。
 * 见 `champion-identity.ts`。
 */
export interface LiveChampionNames {
  /** `activePlayer.rawChampionName`，真机形如 `game_character_displayname_Lux`。 */
  readonly rawChampionName: string;
  /** `activePlayer.championName`，真机为**客户端语言的名字**（国服＝中文「光辉女郎」）。 */
  readonly championName: string;
  /** `allPlayers[我].championName`（与 activePlayer 可能不同步时的第二来源）。 */
  readonly myChampionName: string;
}

/** 从 API 解析出的"我"的局内状态。 */
export interface LivePlayerState {
  readonly gameMode: string;
  readonly gameTime: number;
  readonly level: number;
  readonly isDead: boolean;
  readonly respawnTimer: number;
  readonly championName: string;
  readonly riotId: string;
}

export const LIVE_DATA_URL = 'https://127.0.0.1:2999';

type Obj = Record<string, unknown>;

function asObj(v: unknown): Obj | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * 解析 `/liveclientdata/allgamedata` 的响应（**纯函数**，真机报文可直接喂进来测）。
 *
 * @returns 解析成功返回状态；报文不是局内格式（或找不到自己）返回 null。
 */
export function parseLivePlayerState(payload: unknown): LivePlayerState | null {
  const root = asObj(payload);
  if (!root) return null;
  const active = asObj(root['activePlayer']);
  const gameData = asObj(root['gameData']);
  const players = Array.isArray(root['allPlayers']) ? root['allPlayers'] : [];

  const activeLevel = num(active?.['level']);
  const gameTime = num(gameData?.['gameTime']);
  if (gameTime === null) return null;

  // 找到"我自己"那一条：优先 riotId，其次 summonerName
  const meId = str(active?.['riotId']) || str(active?.['summonerName']);
  const me = players
    .map(asObj)
    .find((p) => p !== null && meId !== '' && (str(p['riotId']) === meId || str(p['summonerName']) === meId));

  if (!me) return null;
  const isDead = me['isDead'];
  if (typeof isDead !== 'boolean') return null;
  const respawnTimer = num(me['respawnTimer']);

  // 等级优先取**玩家列表**里我的那条：与 isDead 来自同一条记录，
  // 语义上"同一时刻的同一个我"，避免两个字段跨记录不一致。
  const level = num(me['level']) ?? activeLevel;
  if (level === null) return null;

  return {
    gameMode: str(gameData?.['gameMode']),
    gameTime,
    level,
    isDead,
    respawnTimer: respawnTimer ?? 0,
    championName: str(me['championName']),
    riotId: meId,
  };
}

/**
 * 解析"我是谁"的名字（**纯函数**，真机报文可直接喂进来测）。
 *
 * 与 `parseLivePlayerState` 分开的原因（重要）：那个函数要求"能在 `allPlayers`
 * 里找到我自己 + 有 isDead/gameTime"，缺一项就返回 null；而**英雄身份不该因为
 * 触发状态机用不到的字段缺失而一起丢掉**。这里只要报文里有 `activePlayer`
 * 就返回（字段缺失＝空串），由 `champion-identity.ts` 决定能不能认出来。
 *
 * @returns 报文不是局内格式（没有 activePlayer）返回 null。
 */
export function parseLiveChampionNames(payload: unknown): LiveChampionNames | null {
  const root = asObj(payload);
  if (!root) return null;
  const active = asObj(root['activePlayer']);
  if (!active) return null;

  const players = Array.isArray(root['allPlayers']) ? root['allPlayers'] : [];
  const meId = str(active['riotId']) || str(active['summonerName']);
  const me = players
    .map(asObj)
    .find(
      (p) =>
        p !== null &&
        meId !== '' &&
        (str(p['riotId']) === meId || str(p['summonerName']) === meId),
    );

  return {
    rawChampionName: str(active['rawChampionName']),
    championName: str(active['championName']),
    myChampionName: str(me?.['championName']),
  };
}

/** 单次 GET（只对本请求跳过自签校验）。 */
function httpsGetJson(url: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: 'GET', rejectUnauthorized: false, timeout: timeoutMs },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (e) {
            reject(new Error(`JSON 解析失败：${e instanceof Error ? e.message : String(e)}`));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
    req.end();
  });
}

export interface LiveDataClientOptions {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** 注入请求实现（测试用）；默认走 node:https。 */
  readonly fetchJson?: (url: string) => Promise<unknown>;
}

export interface LiveDataClient {
  /**
   * 取一次局内状态。
   *
   * **不在对局中 / 请求失败 → null**（这是正常情况，不是错误：
   * 2999 只在局内存在，连接被拒说明还没进游戏或已经出来了）。
   */
  getPlayerState(): Promise<LivePlayerState | null>;
  /**
   * 取一次"我是谁"的名字（`activePlayer.rawChampionName` / `championName`）。
   *
   * 同一个 `allgamedata` 报文，但解析口径更宽松（不要求 isDead/gameTime）——
   * 英雄身份是**局内标签的唯一依据**，不能因为触发状态机用不到的字段缺失而丢失。
   * 不在对局中 → null（正常情况）。
   */
  getChampionNames(): Promise<LiveChampionNames | null>;
  /** 最近一次失败原因（成功时为 null），用于日志。 */
  readonly lastError: string | null;
}

export function createLiveDataClient(options: LiveDataClientOptions = {}): LiveDataClient {
  const baseUrl = options.baseUrl ?? LIVE_DATA_URL;
  const timeoutMs = options.timeoutMs ?? 3000;
  const fetchJson = options.fetchJson ?? ((url: string) => httpsGetJson(url, timeoutMs));
  let lastError: string | null = null;

  return {
    async getPlayerState() {
      try {
        const payload = await fetchJson(`${baseUrl}/liveclientdata/allgamedata`);
        const state = parseLivePlayerState(payload);
        if (!state) {
          lastError = '报文可读但不是局内格式（找不到 activePlayer/gameData/我自己）';
          return null;
        }
        lastError = null;
        return state;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        return null;
      }
    },
    async getChampionNames() {
      try {
        const payload = await fetchJson(`${baseUrl}/liveclientdata/allgamedata`);
        const names = parseLiveChampionNames(payload);
        if (!names) {
          lastError = '报文里没有 activePlayer → 拿不到"我是谁"的名字';
          return null;
        }
        lastError = null;
        return names;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        return null;
      }
    },
    get lastError() {
      return lastError;
    },
  };
}