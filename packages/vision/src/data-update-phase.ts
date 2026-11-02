/**
 * 「更新数据」的用户可见文案（纯函数，可单测）
 *
 * 为什么单独成文件：
 *   悬浮窗在 CI 里跑不起来（见 AGENTS.md），而"菜单项点了之后变不变、确认框写了什么、
 *   成功/失败提示是否诚实"恰恰是这次功能**唯一能被机器证明**的部分。
 *   所以阶段类型与文案全部放在 vision（无 Electron 依赖），主进程只负责调用。
 *
 * 口径（与 `统计日期` 那一行一致）：
 *   · 日期一律显示官方统计日期 `YYYY-MM-DD`（`meta.dataDate` 是 `YYYYMMDD`，先格式化）；
 *   · 拿不到日期就说"未知"，**不猜、不用文件时间冒充官方日期**。
 */

/* ------------------------------------------------------------------ */
/* 阶段                                                                */
/* ------------------------------------------------------------------ */

/**
 * 「更新数据」的当前阶段。
 *
 * 与「检查更新」（GitHub 发版）刻意分开：两者可以同时进行、文案也不同，
 * 共用一个类型会让菜单项文案互相覆盖（"正在下载更新 42%" vs "正在更新数据 42/173"）。
 */
export type DataUpdatePhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking' }
  | {
      readonly kind: 'syncing';
      /** 当前阶段名（`拉取图鉴` / `单英雄详情` / `头像模板` …）。 */
      readonly label: string;
      readonly done?: number;
      readonly total?: number;
    };

/** 空闲态（唯一可点的阶段）。 */
export const DATA_UPDATE_PHASE_IDLE: DataUpdatePhase = { kind: 'idle' };

/** 菜单项文案前缀（自测断言与文档都看它）。 */
export const DATA_UPDATE_MENU_PREFIX = '更新数据';

/** 阶段 → 菜单项文案。 */
export function dataUpdateMenuText(phase: DataUpdatePhase): string {
  switch (phase.kind) {
    case 'idle':
      return DATA_UPDATE_MENU_PREFIX;
    case 'checking':
      return '正在检查新数据…';
    case 'syncing': {
      const progress =
        phase.done !== undefined && phase.total !== undefined && phase.total > 0
          ? ` ${phase.done}/${phase.total}`
          : '';
      return `正在更新数据…（${phase.label}${progress}）· 点此取消`;
    }
  }
}

/**
 * 菜单项是否可点。
 *
 * 空闲 → 可点（开始更新）；运行中 → **也可点**（这一下是“取消”）；
 * 只剩一个轻量探日期（`checking`）时不可点 —— 它本来就只是一次请求。
 */
export function dataUpdateMenuEnabled(phase: DataUpdatePhase): boolean {
  return phase.kind !== 'checking';
}

/* ------------------------------------------------------------------ */
/* 文案                                                                */
/* ------------------------------------------------------------------ */

/** `20261005` → `2026-10-05`；非法/空 → `null`（宁可显示"未知"也不显示错日期）。 */
export function formatStatDate(raw: string | null | undefined): string | null {
  const text = (raw ?? '').trim();
  if (!/^\d{8}$/.test(text)) return null;
  const month = Number(text.slice(4, 6));
  const day = Number(text.slice(6, 8));
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

export interface DataUpdatePromptInput {
  /** 本地当前官方统计日期（`YYYYMMDD`；没有则 null）。 */
  readonly localDate: string | null;
  /** 探测到的上游日期（`YYYYMMDD`；没探测到则 null）。 */
  readonly upstreamDate: string | null;
  /** 数据写入目录（让用户知道"更新到哪儿去了"）。 */
  readonly dataDir: string;
}

export interface DataUpdatePromptText {
  readonly message: string;
  readonly detail: string;
}

/**
 * 点「更新数据」后的确认框。
 *
 * 为什么要确认：这是一次**几分钟、要联网**的操作，而且会覆盖用户本地数据目录；
 * 静默开始会让人以为程序卡住/在偷偷下载。
 */
export function dataUpdatePromptText(input: DataUpdatePromptInput): DataUpdatePromptText {
  const local = formatStatDate(input.localDate);
  const upstream = formatStatDate(input.upstreamDate);
  const dateLine = upstream
    ? local
      ? `官方统计已更新到 ${upstream}（本地是 ${local}）。`
      : `官方统计已更新到 ${upstream}（本地还没有官方统计日期）。`
    : local
      ? `当前本地数据的官方统计日期是 ${local}。`
      : '当前本地数据没有官方统计日期。';

  return {
    message: '要更新本地数据吗？',
    detail: [
      dateLine,
      '',
      '将从官方数据源重新拉取：图鉴、排行榜、单英雄详情（约 173 个英雄），',
      '以及头像模板（仅英雄集合变化时才重建）。',
      '',
      `写入位置：${input.dataDir}`,
      '（安装目录里的快照不会被改动；失败时保留现有数据。）',
      '',
      '需要联网，可能要几分钟。过程中可以从托盘取消。',
    ].join('\n'),
  };
}

/** 启动时发现上游有更新 → 托盘气泡（只提示，不自动下载）。 */
export function newDataNoticeText(localDate: string | null, upstreamDate: string | null): string {
  const upstream = formatStatDate(upstreamDate);
  const local = formatStatDate(localDate);
  if (!upstream) return '检测到新数据，右键托盘 →「更新数据」可下载。';
  return local
    ? `官方统计已更新到 ${upstream}（本地 ${local}）。右键托盘 →「更新数据」可下载。`
    : `官方统计已更新到 ${upstream}。右键托盘 →「更新数据」可下载。`;
}

/** 同步失败但探到了上游日期时的提示（说明"不是没数据，是这次没拉到"）。 */
export function dataUpdateFailureHint(
  localDate: string | null,
  upstreamDate: string | null,
): string {
  const local = formatStatDate(localDate);
  const upstream = formatStatDate(upstreamDate);
  if (upstream && local) return `上游已有 ${upstream} 的数据，本地仍是 ${local} 的。`;
  if (upstream) return `上游已有 ${upstream} 的数据。`;
  return '没有探测到上游统计日期（可能网络不通或上游维护中）。';
}

export interface DataUpdateResultSummary {
  /** 至少写入了一个文件。 */
  readonly ok: boolean;
  readonly aborted: boolean;
  /** 写入的文件名（`dataset` / `rankings` / `builds` / `templates`）。 */
  readonly wrote: readonly string[];
  readonly failures: readonly { readonly label: string; readonly message: string }[];
  /** 本次落盘的官方统计日期（`YYYYMMDD`，拿不到为空串）。 */
  readonly dataDate: string;
  /** 跳过的阶段原因（模板未重建等；成功提示里也如实列出）。 */
  readonly skipped: readonly string[];
}

export interface DataUpdateResultText {
  readonly title: string;
  readonly message: string;
  readonly detail: string;
}

const FILE_LABELS: Record<string, string> = {
  dataset: '图鉴',
  rankings: '排行榜',
  builds: '单英雄详情',
  templates: '头像模板',
};

/** 同步结果 → 弹窗文案（成功/失败/取消三种，**都必须说清数据有没有被动过**）。 */
export function dataUpdateResultText(summary: DataUpdateResultSummary): DataUpdateResultText {
  const date = formatStatDate(summary.dataDate) ?? '未知';
  const wrote = summary.wrote.map((f) => FILE_LABELS[f] ?? f).join('、');

  // 先判"取消"：取消前可能已经写了图鉴（原子写成功），但那不是一次完成的更新 ——
  // 报成"数据已更新"会让用户以为整包都刷完了
  if (summary.aborted) {
    return {
      title: 'hexbox 数据更新',
      message: '已取消更新',
      detail:
        summary.wrote.length > 0
          ? `取消前已写入：${wrote}。未写入的文件保留原有内容。`
          : '没有写入任何文件，现有数据未被改动。',
    };
  }

  if (summary.ok) {
    return {
      title: 'hexbox 数据更新',
      message: `数据已更新（官方统计 ${date}）`,
      detail: [
        `已写入：${wrote || '（无）'}`,
        summary.skipped.length > 0 ? `跳过：${summary.skipped.join('；')}` : '',
        '',
        '局内标签与选人胜率会在下一次识别/对局时使用新数据。',
      ]
        .filter((line) => line !== '')
        .join('\n'),
    };
  }

  const reasons =
    summary.failures.length > 0
      ? summary.failures.map((f) => `· ${f.label}：${f.message}`).join('\n')
      : '· 所有数据源都没有返回可用数据';
  return {
    title: 'hexbox 数据更新',
    message: '更新失败',
    detail: [
      reasons,
      '',
      '现有数据未被改动，程序仍可继续使用旧数据。',
      '常见原因：网络不通 / 代理未开启 / 上游维护中。可以稍后再试。',
    ].join('\n'),
  };
}
