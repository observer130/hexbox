/**
 * 「有没有新数据」的轻量检查（不下载任何数据）
 *
 * 为什么需要它：
 *   托盘里点「更新数据」是**用户主动**的全量同步（图鉴 + 榜单 + 173 个英雄详情 +
 *   可能 245 个头像，几分钟）。但用户不会天天记得点 —— 所以启动时做一次**极小**的
 *   探测：只问上游「现在最新的官方统计日期是哪天」，和本地 `meta.dataDate` 比一下。
 *   有新日期 → 托盘气泡提示，**不自动下载**（带宽与写盘都留给用户决定）。
 *
 * 为什么不直接复用 `createTencentRankingProvider().load()`：
 *   那是**全量**榜单（两个接口 × 最多 5 天回退），还要解析上百条记录。
 *   这里只要一个日期，所以只打「海克斯榜」一个接口，取 `dtstatdate`。
 *
 * 节流：`shouldCheckNow()` 决定"今天检查过没有"，由调用方把时间戳持久化。
 */

import {
  RUNE_RANK_URL,
  extractFieldValue,
  parseDataDate,
} from '@hexbox/provider-tencent';

export interface StatDateCheckOptions {
  /** 自定义 fetch（测试注入用）。 */
  readonly fetchImpl?: typeof fetch;
  /** 覆盖上游地址（测试用）。 */
  readonly url?: string;
  /** 当前时间（测试注入用）。 */
  readonly now?: () => Date;
  /** 最多往回试几天（统计滞后一天 + 节假日可能缺天）。 */
  readonly maxLookbackDays?: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface StatDateCheck {
  /** 上游当前可用的统计日期（`YYYYMMDD`）；拿不到为 null。 */
  readonly dataDate: string | null;
  /** 实际请求过的日期（排查"为什么没提示"时看它）。 */
  readonly tried: readonly string[];
  /** 全部失败时的错误摘要（网络不可达时给用户看的一句话）。 */
  readonly error?: string;
}

/** `YYYYMMDD`（本地时间）→ 往前推 `days` 天。 */
function statDateDaysAgo(now: Date, days: number): string {
  const d = new Date(now.getTime() - days * 86_400_000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

const DEFAULT_UA = 'hexbox/0.2 (+https://github.com/)';

/**
 * 探测上游最新统计日期。
 *
 * 返回 `dataDate: null` 表示"这次没问到"（网络/上游维护），**不是**"没有新数据" ——
 * 调用方必须区分这两种情况，否则一次断网就会让用户以为数据是最新的。
 */
export async function fetchLatestStatDate(
  options: StatDateCheckOptions = {},
): Promise<StatDateCheck> {
  const doFetch = options.fetchImpl ?? fetch;
  const url = options.url ?? RUNE_RANK_URL;
  const now = options.now ?? (() => new Date());
  const lookback = Math.max(1, options.maxLookbackDays ?? 3);
  const timeoutMs = options.timeoutMs ?? 8_000;

  const tried: string[] = [];
  let lastError: string | undefined;

  for (let i = 1; i <= lookback; i++) {
    const date = statDateDaysAgo(now(), i);
    tried.push(date);
    try {
      const attempt = AbortSignal.timeout(timeoutMs);
      const combined = options.signal
        ? AbortSignal.any([attempt, options.signal])
        : attempt;
      const res = await doFetch(`${url}?augmentid_level=255&dtstatdate=${date}`, {
        headers: { 'user-agent': DEFAULT_UA },
        signal: combined,
      });
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      const raw = extractFieldValue(await res.json());
      const parsed = parseDataDate(raw);
      if (/^\d{8}$/.test(parsed)) {
        return { dataDate: parsed, tried };
      }
      // 该日期没有数据（维护/滞后）→ 继续往前找
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      // 被外部取消：不再重试
      if (options.signal?.aborted) break;
    }
  }

  return { dataDate: null, tried, ...(lastError ? { error: lastError } : {}) };
}

/**
 * 上游日期是否比本地新。
 *
 * 用**数字**比较 `YYYYMMDD`（字符串比较在跨年时也成立，但数字更直白）；
 * 本地为空（没有数据/没有官方日期）时视为"有新数据"，提示用户同步一次。
 */
export function isNewerDataDate(upstream: string | null, local: string | null): boolean {
  if (!upstream || !/^\d{8}$/.test(upstream)) return false;
  if (!local || !/^\d{8}$/.test(local)) return true;
  return Number(upstream) > Number(local);
}

/** 默认检查间隔：一天（官方统计日更，再勤也没意义）。 */
export const DATA_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * 现在该不该做启动检查。
 *
 * `lastCheckAt` 是上一次**尝试**的时间（不管成功失败）—— 失败也记，
 * 否则断网时每次启动都会再打一遍上游。
 */
export function shouldCheckNow(
  lastCheckAt: string | null | undefined,
  now: Date,
  intervalMs = DATA_CHECK_INTERVAL_MS,
): boolean {
  if (!lastCheckAt) return true;
  const last = new Date(lastCheckAt).getTime();
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= intervalMs;
}
