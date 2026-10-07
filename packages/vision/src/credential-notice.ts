/**
 * 「读不到 LCU 凭证」的**一次性气泡**判定（纯函数，可单测）
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────
 * 覆盖层本体没有可见窗口：用户双击之后，如果客户端没起（或没以管理员运行），
 * 屏幕上**什么都没有**（连诊断侧边窗都已按用户决策关掉）。用户会以为程序坏了。
 * 所以要在这种情况下**主动弹一次托盘气泡**，内容必须可操作。
 *
 * 反过来，**绝不能反复弹**：这是个游戏内常驻程序，一次对局里弹十次气泡比不弹更糟。
 * 于是"什么时候弹、弹几次"必须是**一处纯函数**（主进程在 CI 里跑不起来）。
 *
 * ── 规则（用户要的"只提示一次"的明确口径）──────────────────────────────
 *
 *   · 连续 `noticeAfterFailures`（默认 **3**）轮读不到凭证 → 弹**一次**；
 *     之后只要还在失败就一直不弹（`shown` 是粘住的，不会因为失败轮数变大而复弹）。
 *   · 读到凭证 → 失败连续计数归零；**连续成功** `rearmAfterSuccesses`（默认 **6**）
 *     轮之后才重新武装 —— 也就是"**每个连接会话最多一次**"：
 *        - 客户端重启/掉线再来一次 → 还能再提示一次（真的又要用户动手了）；
 *        - 探针**抖动**（成功一两轮又失败）→ 不重新武装 → **不会反复打扰**。
 *   · 阈值取这两个数是因为轮询是 2 秒一轮（`POLL_MS`）：
 *     3 轮 ≈ 6 秒后就能看到提示；6 轮 ≈ 12 秒的稳定连接才算"真的连上了"。
 *
 * ⚠️ 文案与判定分开：`credentialNoticeText()` 只管说人话，判定只管"弹不弹"，
 *    两者都有单测（文案里那几条排查动作是用户手动验证时要照着做的）。
 */

/** 连续多少轮读不到凭证才提示（2s/轮 → 约 6 秒内可见）。 */
export const CREDENTIAL_NOTICE_AFTER_FAILURES = 3;
/** 连续多少轮读到凭证才**重新武装**（防抖动 → 反复弹气泡）。 */
export const CREDENTIAL_NOTICE_REARM_AFTER_SUCCESSES = 6;

export interface CredentialNoticeThresholds {
  readonly noticeAfterFailures: number;
  readonly rearmAfterSuccesses: number;
}

export const DEFAULT_CREDENTIAL_NOTICE_THRESHOLDS: CredentialNoticeThresholds = {
  noticeAfterFailures: CREDENTIAL_NOTICE_AFTER_FAILURES,
  rearmAfterSuccesses: CREDENTIAL_NOTICE_REARM_AFTER_SUCCESSES,
};

export interface CredentialNoticeState {
  /** 连续读不到凭证的轮数。 */
  readonly failStreak: number;
  /** 连续读到凭证的轮数。 */
  readonly successStreak: number;
  /** **本连接会话**内是否已经提示过（粘住；只有重新武装才清）。 */
  readonly shown: boolean;
}

/** 初始状态（进程启动）。 */
export const INITIAL_CREDENTIAL_NOTICE_STATE: CredentialNoticeState = {
  failStreak: 0,
  successStreak: 0,
  shown: false,
};

export interface CredentialNoticeSample {
  /** 本轮是否读到了 LCU 凭证。 */
  readonly credsAvailable: boolean;
  /** 是否检测到英雄联盟客户端进程（**只影响文案**，不参与判定）。 */
  readonly clientRunning: boolean;
}

export interface CredentialNoticeDecision {
  /** 此刻是否该弹气泡（true 只会出现在"刚越过阈值"的那一轮）。 */
  readonly show: boolean;
  /** 是否发生了"重新武装"（调用方值得打一行日志）。 */
  readonly rearmed: boolean;
  /** 新状态（调用方存回去，下轮再传进来）。 */
  readonly state: CredentialNoticeState;
  /** 人读原因（进日志；**每一轮都要能解释**）。 */
  readonly reason: string;
}

/**
 * 推进一步（纯函数：不改入参，返回新状态）。
 *
 * 调用方每轮把上一轮的状态与"本轮读没读到凭证"传进来即可，
 * 不需要自己维护任何计数（免得主进程里出现第二份判定）。
 */
export function decideCredentialNotice(
  state: CredentialNoticeState,
  sample: CredentialNoticeSample,
  thresholds: CredentialNoticeThresholds = DEFAULT_CREDENTIAL_NOTICE_THRESHOLDS,
): CredentialNoticeDecision {
  const noticeAfter = Math.max(1, Math.round(thresholds.noticeAfterFailures));
  const rearmAfter = Math.max(1, Math.round(thresholds.rearmAfterSuccesses));

  if (sample.credsAvailable) {
    const successStreak = state.successStreak + 1;
    const rearmed = state.shown && successStreak >= rearmAfter;
    return {
      show: false,
      rearmed,
      state: { failStreak: 0, successStreak, shown: rearmed ? false : state.shown },
      reason: rearmed
        ? `已连上客户端并稳定 ${successStreak} 轮 → 重新武装提示（下次真的读不到时会再提示一次）`
        : `已读到凭证（连续 ${successStreak} 轮）`,
    };
  }

  const failStreak = state.failStreak + 1;
  const show = !state.shown && failStreak >= noticeAfter;
  return {
    show,
    rearmed: false,
    state: { failStreak, successStreak: 0, shown: state.shown || show },
    reason: show
      ? `连续 ${failStreak} 轮读不到 LCU 凭证 → 首次提示（本连接会话内只提示这一次）`
      : state.shown
        ? `连续 ${failStreak} 轮读不到凭证；本连接会话内已提示过 → 不再打扰`
        : `连续 ${failStreak} 轮读不到凭证（未到 ${noticeAfter} 轮，先不打扰）`,
  };
}

/** 气泡文案（标题 + 正文；**可操作**是硬要求）。 */
export interface CredentialNoticeText {
  readonly title: string;
  readonly content: string;
}

/**
 * 气泡正文（两种情形给不同的第一句，排查动作一致）。
 *
 * 用户看到的是"双击之后什么都没有"，所以第一句必须先回答"为什么没东西"，
 * 再给**照做就能好**的三步（与 `pollOnce()` 里那段 `warnedNoCreds` 终端提示同一口径，
 * 但这里更短 —— 气泡放不下长文）。
 *
 * ⚠️ **不要再指向托盘菜单里的「打开日志」**：那一项已按用户要求移除
 * （用户 2026-10 的菜单决定，见 `apps/overlay/src/main/tray.ts`）。
 * 现在指向**日志文件本身**（调用方把解析后的绝对路径传进来；打包版默认
 * `%LOCALAPPDATA%\hexbox\logs\overlay.log`，开发版没设 `HEXBOX_LOG_FILE` 时没有文件）。
 */
export function credentialNoticeText(
  clientRunning: boolean,
  logFile?: string | null,
): CredentialNoticeText {
  const head = clientRunning
    ? '检测到客户端，但读不到 LCU 凭证。'
    : '未检测到英雄联盟客户端。';
  const where =
    typeof logFile === 'string' && logFile.trim() !== ''
      ? `详见日志文件：${logFile}`
      : '详见日志文件（本次运行未落盘；打包版默认 %LOCALAPPDATA%\\hexbox\\logs\\overlay.log，' +
        '开发时用 HEXBOX_LOG_FILE 指定）。';
  return {
    title: 'hexbox 未读取到客户端凭证',
    content:
      `${head}请确认已以管理员身份运行、且客户端（含 WeGame）已启动；` +
      `否则选人/局内标签都不会显示。${where}`,
  };
}
