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
  /** 当前队列（含 queueId）。 */
  queues: '/lol-game-queues/v1/queues',
} as const;

/**
 * 判断是否为海克斯乱斗（BRAWL）。
 *
 * 官方依据（已核实）：
 *   gameModes.json → { "gameMode": "BRAWL" }
 *   queues.json    → { "queueId": 2300, "map": "The Bandlewood", "description": "Brawl" }
 * 见 docs/research.md §1。
 */
export function isBrawlSession(session: GameflowSession | null): boolean {
  if (!session) return false;
  const mode = session.map?.gameMode;
  if (mode && mode.toUpperCase() === 'BRAWL') return true;
  const queueId = session.gameData?.queue?.id;
  return queueId === 2300;
}
