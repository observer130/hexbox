/**
 * 托盘菜单「数据更新时间」的口径（纯函数，可单测）
 *
 * ── 用户要的是什么 ──────────────────────────────────────────────────────
 *   托盘的菜单里要有一行灰的、不可点的 `数据更新时间：yyyy-mm-dd`。
 *   "数据"指程序读的那份快照（`data/*.json`，见 docs/RELEASE-WINDOWS.md §三）：
 *   它决定卡片上的胜率、局内海克斯强度与出装建议是哪一天的官方统计。
 *
 * ── 为什么优先「官方统计日期」而不是文件时间 ─────────────────────────────
 *   两种口径的含义**不一样**，必须选一个并说清：
 *     · `meta.dataDate`（形如 `20261005`）= 腾讯官方那份榜单**统计的是哪一天**。
 *       程序启动日志里本来就在打它（"统计日期 20261005"），用户拿它对照
 *       官方的"数据统计日期"能对上 —— 这才是用户问"数据更新到几号了"时想要的答案；
 *     · 文件的 mtime = **这台机器**什么时候跑过 `pnpm sync`／什么时候装的包。
 *       重新同步一次、或从别处拷一份旧数据过来，mtime 都会变，
 *       所以它**不能**代表"数据是哪天的"。
 *   因此：优先 `dataDate`；拿不到才退回 `dataset.json` 的 mtime，并**在菜单里标明是回退口径**
 *   （`（文件时间）`），免得用户以为那就是官方统计日期。两个都拿不到 → `未知`。
 *
 * ⚠️ 这里只做"读到的原始值 → 菜单文案"的翻译，**不做 IO**：
 *   主进程负责读 `data/*.json` 与 `statSync`，这样判据本身在 CI 里可测
 *   （overlay 在 CI 跑不起来，见 AGENTS.md）。
 */

/** 这一行是从哪儿来的（排查"显示的不是我预期的那天"时看它）。 */
export type DataUpdateSource =
  /** 官方统计日期：`meta.dataDate`。 */
  | 'data-date'
  /** 回退：`dataset.json` 的文件修改时间。 */
  | 'file-mtime'
  /** 两个都没有 → 显示"未知"。 */
  | 'unknown';

export interface DataUpdateStamp {
  readonly source: DataUpdateSource;
  /** `yyyy-mm-dd`（`unknown` 时为空串）。 */
  readonly date: string;
  /** 菜单里那一行（灰、不可点）。 */
  readonly label: string;
  /** 口径说明（写进启动日志；用户问"这天是哪来的"时它答）。 */
  readonly detail: string;
}

export interface DataUpdateInput {
  /** `data/rankings.json` / `data/builds.json` 的 `meta.dataDate`，形如 `20261005`。 */
  readonly dataDate?: string | null;
  /** `data/dataset.json` 的 mtime（毫秒）；官方统计日期缺失时的回退口径。 */
  readonly mtimeMs?: number | null;
}

/** 菜单文案前缀（自测断言与文案漂移都看它）。 */
export const DATA_UPDATE_LABEL_PREFIX = '数据更新时间：';

/** 官方统计日期的括号说明（**必须在菜单里能看出口径**，用户就是这么要求的）。 */
export const DATA_UPDATE_OFFICIAL_NOTE = '统计日期';

/** 回退口径的括号说明（不能让它看起来像官方统计日期）。 */
export const DATA_UPDATE_FALLBACK_NOTE = '文件时间';

/**
 * 官方统计日期 `20261005` → `2026-10-05`。
 *
 * 非法（位数不对 / 月份日期越界 / 空）一律返回 `null` —— **宁可显示"未知"，
 * 也不显示一个错位的日期**：把 `2026105` 硬切成 `2026-10-5` 之类会让用户
 * 以为数据是那天的。
 */
export function parseDataDate(raw: string | null | undefined): string | null {
  const text = (raw ?? '').trim();
  if (!/^\d{8}$/.test(text)) return null;
  const month = Number(text.slice(4, 6));
  const day = Number(text.slice(6, 8));
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

/** 本地时区的 `yyyy-mm-dd`（mtime 口径用；同机同输入同输出）。 */
export function formatLocalDate(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 原始读数 → 菜单文案（纯函数：不改入参、不读时钟/文件）。 */
export function dataUpdateStamp(input: DataUpdateInput): DataUpdateStamp {
  const official = parseDataDate(input.dataDate);
  if (official !== null) {
    return {
      source: 'data-date',
      date: official,
      label: `${DATA_UPDATE_LABEL_PREFIX}${official}（${DATA_UPDATE_OFFICIAL_NOTE}）`,
      detail: `官方统计日期 meta.dataDate=${String(input.dataDate).trim()}`,
    };
  }

  const ms = input.mtimeMs;
  if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) {
    const date = formatLocalDate(new Date(ms));
    return {
      source: 'file-mtime',
      date,
      label: `${DATA_UPDATE_LABEL_PREFIX}${date}（${DATA_UPDATE_FALLBACK_NOTE}）`,
      detail: '没有官方统计日期 meta.dataDate → 退回 dataset.json 的文件修改时间（可能与数据本身不同天）',
    };
  }

  return {
    source: 'unknown',
    date: '',
    label: `${DATA_UPDATE_LABEL_PREFIX}未知`,
    detail: '既没有 meta.dataDate，也读不到 dataset.json 的文件时间（数据没同步过？见 `pnpm sync`）',
  };
}
