/**
 * LCU REST 客户端
 *
 * LCU 使用自签名证书，因此必须忽略 TLS 校验（这是官方要求的做法：
 * "you should make sure your software either trusts Riot's root certificate
 *  or it ignores that error"）。
 */

import { basicAuthHeader, type LcuCredentials } from './detect.ts';

export interface LcuRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/** 一个极薄的 LCU 请求封装。 */
export class LcuClient {
  // 注意：不使用 TS 参数属性（strip-only 模式不支持）
  private readonly creds: LcuCredentials;

  constructor(creds: LcuCredentials) {
    this.creds = creds;
  }

  get port(): number {
    return this.creds.port;
  }

  get source(): string {
    return this.creds.source;
  }

  /**
   * 发送 GET 请求。ignoreHTTPSErrors 由调用方通过 NODE_TLS_REJECT_UNAUTHORIZED
   * 或 undici Agent 处理；这里只负责拼装 URL 与认证头。
   */
  async get<T = unknown>(path: string, opts: LcuRequestOptions = {}): Promise<T> {
    const url = `https://127.0.0.1:${this.creds.port}${path.startsWith('/') ? path : `/${path}`}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000);
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      const res = await fetch(url, {
        headers: {
          Authorization: basicAuthHeader(this.creds.password),
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`LCU ${path} → HTTP ${res.status}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
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
 * 为什么需要它：选人会话（`/lol-champ-select/v1/session`）在进入对局后
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
