/**
 * LCU REST 客户端
 *
 * LCU 使用自签名证书，因此必须忽略 TLS 校验（这是官方要求的做法：
 * "you should make sure your software either trusts Riot's root certificate
 *  or it ignores that error"）。
 */

import { basicAuthHeader, type LcuCredentials } from './detect.ts';
import { requestInsecure, type InsecureRequestFn } from './https.ts';

export interface LcuRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/**
 * LCU 请求错误，**带 HTTP 状态码**。
 *
 * 为什么需要状态码：调用方必须能区分两类失败，否则会把
 * 「当前没有对局会话」误判成「凭证失效」：
 *   - `404` / `400` —— 会话不存在（大厅里 `/lol-gameflow/v1/session` 常见），
 *     **凭证是好的**，客户端仍在；
 *   - `401` / `403` —— 鉴权失败，凭证才是坏的。
 */
export class LcuHttpError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(path: string, status: number) {
    super(`LCU ${path} → HTTP ${status}`);
    this.name = 'LcuHttpError';
    this.status = status;
    this.path = path;
  }

  /**
   * 是否表示「凭证失效」。
   *
   * 只看 401/403。其余（含 404）都应按「会话/资源不存在」处理，
   * 而不是把客户端判死。
   */
  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/** 一个极薄的 LCU 请求封装。 */
export class LcuClient {
  // 注意：不使用 TS 参数属性（strip-only 模式不支持）
  private readonly creds: LcuCredentials;
  /** 注入点：测试替换为桩；生产走 `requestInsecure`（per-connection 关校验）。 */
  private readonly request: InsecureRequestFn;

  constructor(creds: LcuCredentials, request: InsecureRequestFn = requestInsecure) {
    this.creds = creds;
    this.request = request;
  }

  get port(): number {
    return this.creds.port;
  }

  get source(): string {
    return this.creds.source;
  }

  /** 拼 URL（LCU 只连本机回环，不跟随任何外部跳转）。 */
  private urlOf(path: string): string {
    return `https://127.0.0.1:${this.creds.port}${path.startsWith('/') ? path : `/${path}`}`;
  }

  /**
   * 发送 GET 请求。
   *
   * TLS：`requestInsecure` 对**本连接** `rejectUnauthorized:false`（LCU 自签证书），
   * 不再用进程级 `NODE_TLS_REJECT_UNAUTHORIZED` —— 后者会让并发中的其它 HTTPS
   * （数据同步、更新检查）一起失去证书校验。
   *
   * 非 2xx 抛 `LcuHttpError`（带状态码），便于调用方区分
   * 「无会话」与「鉴权失败」。
   */
  async get<T = unknown>(path: string, opts: LcuRequestOptions = {}): Promise<T> {
    const res = await this.request(this.urlOf(path), {
      headers: {
        Authorization: basicAuthHeader(this.creds.password),
        Accept: 'application/json',
      },
      ...(opts.signal ? { signal: opts.signal } : {}),
      timeoutMs: opts.timeoutMs ?? 5000,
    });
    if (!res.ok) {
      throw new LcuHttpError(path, res.status);
    }
    const text = res.text();
    if (!text) return null as T; // 204/空正文（GET 少见，保持与旧行为一致）
    return JSON.parse(text) as T;
  }

  /**
   * 同 `get`，但**把「资源/会话不存在」当作 null** 而不是抛错。
   *
   * 大厅里 `/lol-gameflow/v1/session` 返回 404 是**正常**的（当前没有对局），
   * 不应被当成故障；400 同理（请求参数/会话状态不对）。
   *
   * ⚠️ 只有 400/404 → null（审查 P2：旧实现的 `!isAuthFailure` 把 **5xx 也一起
   * 吞成 null**，调用方无法区分"没有对局"和"服务端故障"）。401/403（凭证问题）
   * 与 5xx（客户端还活着但接口报错）都会抛出，交给调用方决定重试/记录。
   */
  async getOrNull<T = unknown>(path: string, opts: LcuRequestOptions = {}): Promise<T | null> {
    try {
      return await this.get<T>(path, opts);
    } catch (err) {
      if (err instanceof LcuHttpError && (err.status === 400 || err.status === 404)) return null;
      throw err;
    }
  }

  /**
   * 发送带 JSON body 的写请求（PUT / POST）。
   *
   * ⚠️ 本项目此前只做只读；写入仅用于「配装方案」，且调用方必须
   * 遵守 `mergeItemSets` 的安全规则（只动本工具生成的方案）。
   */
  async sendJson<T = unknown>(
    method: 'PUT' | 'POST',
    path: string,
    body: unknown,
    opts: LcuRequestOptions = {},
  ): Promise<T | null> {
    const res = await this.request(this.urlOf(path), {
      method,
      headers: {
        Authorization: basicAuthHeader(this.creds.password),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      ...(opts.signal ? { signal: opts.signal } : {}),
      timeoutMs: opts.timeoutMs ?? 8000,
    });
    if (!res.ok) {
      throw new LcuHttpError(path, res.status);
    }
    // 204 No Content 是常见成功响应（写入类接口）
    if (res.status === 204) return null;
    const text = res.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      return null; // 非 JSON 响应（如纯文本 OK）也算成功
    }
  }
}

/** 游戏流阶段。 */
export type GameflowPhase =
  | 'None'
  | 'Lobby'
  | 'Matchmaking'
  | 'ReadyCheck'
  | 'ChampSelect'
  | 'GameStart'
  | 'InProgress'
  | 'Reconnect'
  | 'WaitingForStats'
  | 'PreEndOfGame'
  | 'EndOfGame'
  | 'TerminatedInError'
  | string;

export interface GameflowSession {
  readonly phase?: GameflowPhase;
  readonly map?: { readonly id?: number; readonly gameMode?: string; readonly mapStringId?: string };
  readonly gameData?: {
    readonly queue?: { readonly id?: number; readonly type?: string };
  };
}

/** 常用端点封装。 */
export const LcuEndpoints = {
  /** 当前登录召唤师。 */
  currentSummoner: '/lol-summoner/v1/current-summoner',
  /** 游戏流阶段（None/Lobby/ChampSelect/InProgress...）。 */
  gameflowPhase: '/lol-gameflow/v1/gameflow-phase',
  /** 游戏流会话，含 queueId 与 gameMode。 */
  gameflowSession: '/lol-gameflow/v1/session',
  /** 选人会话，含 myTeam 与 localPlayerCellId。 */
  champSelectSession: '/lol-champ-select/v1/session',
  /** 当前队列（含 queueId）。 */
  queues: '/lol-game-queues/v1/queues',
} as const;

/**
 * 从 gameflow session 里尽力挖出「我的英雄」championId。
 *
 * ⚠️ **不要再用它决定"我这局用哪个英雄"**（2026-10-05 真机事故）：
 * 它按"第一个命中的 `championId`"返回，而 gameflow 的队伍列表里坐着 **10 个人**
 * —— 真机上它给出的是**队友**（玩无极剑圣解析出 154  Zac、玩酒桶解析出 43 Karma），
 * 于是整局显示的都是别人英雄的强度表。请改用 `champion-identity.ts` 的
 * `resolveChampionIdentity()` / `pickMyChampionIdFromGameflow(session, me)`：
 * 后者**必须**收到"我自己的身份"（puuid/summonerId/cellId），没有身份直接放弃。
 * 本函数仅保留给诊断脚本（打印会话形状）使用。
 *
 * 为什么需要它（历史）：选人会话（`/lol-champ-select/v1/session`）在进入对局后
 * 就消失了。若悬浮窗是**中途打开**的（没经历选人），局内就拿不到英雄。
 *
 * 上游把 championId 放在哪个字段随版本变化，因此做一次**有界深度搜索**，
 * 只认键名恰为 `championId` 的正整数，避免误取无关字段（如观战/队友）。
 *
 * @param session  gameflow session（未知形状）
 * @param maxDepth 最大递归深度，默认 4
 */
export function pickChampionIdFromGameflow(
  session: unknown,
  maxDepth = 4,
): number {
  if (session === null || typeof session !== 'object') return 0;

  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number): number => {
    if (depth > maxDepth || node === null || typeof node !== 'object') return 0;
    if (seen.has(node)) return 0; // 防循环引用
    seen.add(node);

    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'championId' && typeof v === 'number' && Number.isInteger(v) && v > 0) {
        return v;
      }
      const found = walk(v, depth + 1);
      if (found > 0) return found;
    }
    return 0;
  };

  return walk(session, 0);
}

/**
 * 判断是否为海克斯乱斗（BRAWL）。
 *
 * 官方依据（Riot 开发者文档 gameModes.json / queues.json）：
 *   gameModes.json → { "gameMode": "BRAWL" }
 *   queues.json    → { "queueId": 2300, "map": "The Bandlewood", "description": "Brawl" }
 */
export function isBrawlSession(session: GameflowSession | null): boolean {
  if (!session) return false;
  const mode = session.map?.gameMode;
  if (mode && mode.toUpperCase() === 'BRAWL') return true;
  const queueId = session.gameData?.queue?.id;
  return queueId === 2300;
}
