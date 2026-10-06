/**
 * 常驻覆盖层的「当前状态」文案（纯函数，可单测）
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────
 * 覆盖层本体**没有可见窗口**（透明常驻窗、无标题栏、无 X），托盘是它唯一的
 * 交互入口。托盘菜单里那一行只读状态是用户判断"它到底在干什么 / 为什么没有标签"
 * 的唯一现场依据 —— 所以它必须是**一处纯函数**：
 *   · 主进程在 CI 里跑不起来（需管理员 + 真实桌面），文案只能靠单测锁；
 *   · 阶段词汇表（`AUGMENT_CHAIN_PHASES`）已经在 `visibility.ts` 里，
 *     再写一份 `phase === 'InProgress'` 之类的判断必然漂移。
 *
 * ── 判据（与 `pollOnce()` 里的读数一一对应）────────────────────────────
 *   ① **没连上客户端** → `等待客户端`
 *      这是用户双击后最可能遇到的状态（客户端没起 / 没以管理员运行），
 *      必须排在最前：此时阶段门保持的是**上一轮的旧读数**，
 *      若拿旧阶段当状态，用户会看到"局内"却一个标签都没有，反而更难排查。
 *   ② 选人 → `选人中`；局内 → `局内`（用户点名要的三种口径）。
 *   ③ 其余阶段给出人话（大厅 / 匹配中 / 结算中…），未知阶段回落到阶段原文。
 */

import { AUGMENT_CHAIN_PHASES } from './visibility.ts';

/** 没连上客户端时的状态词（用户点名要的那一条）。 */
export const TRAY_STATUS_WAITING_CLIENT = '等待客户端';

/** tooltip 里必须写清的那句（用户要求：退出只能从托盘菜单走）。 */
export const TRAY_TOOLTIP_HINT = '退出请右键托盘图标';

/** 状态档位（给调用方做分支/日志用；菜单里只显示 `text`）。 */
export type TrayStatusCode =
  | 'waiting-client'
  | 'champ-select'
  | 'in-game'
  | 'idle'
  | 'other';

export interface TrayStatus {
  readonly code: TrayStatusCode;
  /** 菜单里那一行（短词，用户一眼能懂）。 */
  readonly text: string;
  /** 括号里的细节（阶段原文 / 面板状态；给排查用，可为空串）。 */
  readonly detail: string;
}

export interface TrayStatusInput {
  /** 是否已连上客户端（= 读到凭证；见 `pollOnce()` 的 `connected`）。 */
  readonly connected: boolean;
  /** **经过阶段门**的阶段读数（`stageGate.push()` 的输出，不是原始读数）。 */
  readonly phase: string;
  /**
   * 局内海克斯面板状态（`AugmentController.panelState`）。
   *
   * 只在局内才有意义：面板开着 = 屏幕上正被识别（标签该出来）；
   * 关着 = 常态零取帧。这是"局内为什么没标签"的第一个分叉，值得进托盘。
   */
  readonly panel?: 'closed' | 'open' | 'unknown';
}

/** 非选人/非局内的阶段 → 人话（与渲染端 `PHASE_LABEL` 同一套口径）。 */
const OTHER_PHASE_TEXT: Record<string, string> = {
  None: '不在对局',
  Lobby: '大厅',
  Matchmaking: '匹配中',
  ReadyCheck: '等待确认',
  GameStart: '对局开始',
  WaitingForStats: '结算中',
  PreEndOfGame: '即将结束',
  EndOfGame: '对局结束',
};

/** 算出"当前状态"（纯函数：同输入同输出，不改入参）。 */
export function trayStatus(input: TrayStatusInput): TrayStatus {
  const { connected, phase, panel } = input;

  // ① 连不上客户端：阶段读数是**过期的**，只说明"上一轮是什么"，所以摆在括号里
  if (!connected) {
    return {
      code: 'waiting-client',
      text: TRAY_STATUS_WAITING_CLIENT,
      detail: phase && phase !== 'None' ? `阶段读数已过期：${phase}` : '未读到客户端凭证',
    };
  }

  // ② 用户点名的两种口径
  if (phase === 'ChampSelect') {
    return { code: 'champ-select', text: '选人中', detail: '阶段 ChampSelect' };
  }
  if (AUGMENT_CHAIN_PHASES.includes(phase)) {
    const panelText =
      panel === 'open' ? '面板已开' : panel === 'closed' ? '面板未开' : '面板未知';
    return { code: 'in-game', text: '局内', detail: `阶段 ${phase} · ${panelText}` };
  }

  // ③ 其余阶段
  const known = OTHER_PHASE_TEXT[phase];
  if (known !== undefined) {
    return { code: 'idle', text: known, detail: `阶段 ${phase}` };
  }
  return {
    code: 'other',
    text: `阶段 ${phase === '' ? '（空）' : phase}`,
    detail: '未知阶段：不显示标签',
  };
}

/**
 * 托盘 tooltip（单行 —— Windows 的托盘提示是单行文本，换行不可靠）。
 *
 * 必须含 `TRAY_TOOLTIP_HINT`：用户已拍板"只有托盘菜单里的退出才真正退出"，
 * 而覆盖层没有可见窗口，把退出入口写进 tooltip 是唯一能告诉用户的地方。
 */
export function trayTooltipText(status: TrayStatus): string {
  const detail = status.detail === '' ? '' : `（${status.detail}）`;
  return `hexbox · ${status.text}${detail} —— ${TRAY_TOOLTIP_HINT}`;
}
