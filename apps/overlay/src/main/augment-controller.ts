/**
 * 局内海克斯链路**控制器**（主进程侧；录制工具与常驻覆盖层**共用同一份**）
 *
 * 这个文件是 S5.4d 的重点：把原本只长在录制工具（`debug-augment.ts`）里的
 * "与录制无关的局内链路"抽出来，让 `pnpm dev:overlay`（常驻覆盖层）与
 * `pnpm --filter @hexbox/overlay debug:augment`（录制/验证工具）跑**同一段代码**。
 * 绝不允许出现两份触发状态机、两份刷新编排 —— 那种复制迟早漂移，
 * 而这条链路的每一个坑都是花一整局真机换来的（见 docs/AUGMENT-PANEL.md）。
 *
 * ── 职责边界（本文件负责什么）────────────────────────────────────────────
 *
 *   · 采集几何：游戏窗口矩形 + 显示器 → 截屏归一化搜索区（`region` / `altRegion`）
 *   · 常驻屏幕流：`AugmentStream`（隐藏渲染窗口 + `getDisplayMedia`），
 *     **常态零取帧**（api 模式下发 `setCadence(0)`）
 *   · 2999 Live Client Data 轮询 + 触发状态机（`vision/augment-trigger.ts`）
 *   · 门控节流（`vision/augment-cadence.ts`，pixel 模式）
 *   · 门控边沿 → 全分辨率识别（渲染端做，见 `capture/worker.ts`）
 *   · 单卡刷新（reroll）检测：冻结矩形指纹 + 只重认变化的那张卡
 *   · 强度表：认英雄（`lcu/champion-identity`）→ `augment_json_irank` → tier + 选取率
 *   · 标签：`vision/augment-tier-label.ts`（含**行基准锁**）→ 屏幕坐标
 *     → 交给**注入的标签推送器**（本文件不建窗口、不碰样式）
 *   · 诊断数据：计数器 / 耗时 / 每次识别与标签 / 触发采样日志（`snapshot()`）
 *
 * ── 本文件**不**负责什么 ──────────────────────────────────────────────────
 *
 *   · 建窗口（画布由 `main/label-overlay.ts` 提供，经 `AugmentLabelSink` 注入）；
 *   · 录屏产物（timeline.csv / open-*.png / report.json / checkpoint.json）；
 *   · 生命周期策略（什么时候起、什么时候收工、Ctrl+C 哨兵、阶段等待）；
 *   · 一次性截屏兜底路径的门控循环（录制工具的对照路径；
 *     它通过 `pushExternalReading()` 把读数喂进来）。
 *
 * 上面四项是"录制"或"窗口"的专属职责，留在各自的调用方 —— 常驻覆盖层的
 * `main/index.ts` 只有：阶段判定（`vision/visibility.ts` 的纯函数）→
 * `start()` / `stop()` → 标签推送器与选人标签共用一块画布。
 *
 * ── ⚠️ 标签生命周期 ⇄ 链路生命周期（2026-10-06 真机缺陷的修法）────────────
 *
 * 用户报的现象是"**面板刚弹出、标签刚画上，随即被清掉**"（比上一轮的"几秒后
 * 才消失"更严重）。根因是两者的生命周期被绑在一起：`stop()` **无条件**清标签，
 * 于是**任何**一次停止 —— 包括"在途启动的回调把期间新起的会话一起收掉"、
 * 屏幕流判定不可用 —— 都会把**面板还开着**的标签抹掉；而局内强度标签一局只推
 * 一次（面板开边沿），链路一停那块面板再也画不出标签 → 用户看到"闪一下就没了"。
 *
 * 现在两条生命周期**分开**：
 *   · 链路：起一次、**确认离开**才停（`augmentChainTransition()`）；
 *     `stop(why, { token })` 只允许作废**自己那一代**（令牌不符直接忽略）。
 *   · 标签：只由 ① 面板**关闭边沿**、② **确认离开对局**（阶段换手）、
 *     ③ 本次（重）识别没有可画结果 决定；链路停止**默认不清**
 *     （`augmentStopClearsLabels()`，只有程序退出/录制收工显式要求才清）。
 *
 * 合规：只读屏幕像素 + 官方本地接口（LCU / 2999）。不注入、不读内存、
 * 不解析封包、不打开游戏进程句柄。
 */

import { screen } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  AUGMENT_BADGE_DEFAULT,
  AUGMENT_BADGE_PRESETS,
  AUGMENT_CLEAR_REASONS,
  AUGMENT_CLOSE_CONFIRM_MS,
  AUGMENT_REROLL_THRESHOLD,
  apiCaptureInterval,
  augmentChainStopKeepsLabelsLine,
  augmentClearLogLine,
  augmentClearReasonForEmptyLabels,
  augmentClearReasonForRefreshedCard,
  augmentPickRateTable,
  augmentStopClearsLabels,
  augmentTierLabelsLocked,
  augmentTierTable,
  createAugmentTrigger,
  createCadencePolicy,
  createCloseConfirm,
  createPanelTracker,
  decideRerollRetry,
  fingerprintDistance,
  findGameWindowRectCached,
  lookupAugmentPickRate,
  lookupAugmentTier,
  makeScreenGeometry,
  mergeRefreshedCards,
  panelGateEvidence,
  panelRowRectInCapture,
  rerolledCardIndices,
  shouldAdoptReportedBaseline,
  toScreenTierLabels,
  PANEL_ROW_REGION,
  type AugmentBadgeAlign,
  type AugmentBadgeSize,
  type AugmentCardFingerprint,
  type AugmentClearReason,
  type CadenceMode,
  type CloseConfirmDecision,
  type LabelRowLock,
  type PanelDetection,
  type PanelPresence,
  type PhysicalRect,
  type Rect,
  type RerollCardState,
  type ScreenAugmentTierLabel,
} from '@hexbox/vision';
import { findDetail, type ChampionDetailSet, type Dataset } from '@hexbox/core';
import { readBuilds, readDataset } from '@hexbox/data-store';
import {
  createLiveDataClient,
  detectCredentialsDetailed,
  LcuClient,
  resolveMyChampionIdentity,
  type ChampionIdentity,
  type LiveDataClient,
} from '@hexbox/lcu';

import { AugmentStream, type AugmentFrame } from './augment-stream.ts';
import type { LabelOverlayMsg } from './label-overlay.ts';
import type { RecognizedCard, RecognizedReport, RecognizeOrigin } from '../capture/worker.ts';

/* ------------------------------------------------------------------ */
/* 环境变量（全部是**链路**的旋钮；"怎么录制"的旋钮留在录制工具里）        */
/* ------------------------------------------------------------------ */

/** API 轮询间隔（本地 GET，成本可忽略；死亡状态持续数秒，1 秒足够）。 */
const API_POLL_MS = Number(process.env['HEXBOX_AUGMENT_API_POLL_MS'] ?? 1000);
const IDLE_MS = Number(process.env['HEXBOX_AUGMENT_IDLE_MS'] ?? 1000);
const ACTIVE_MS = Number(process.env['HEXBOX_AUGMENT_ACTIVE_MS'] ?? 250);
const PROBE_MS = Number(process.env['HEXBOX_AUGMENT_PROBE_MS'] ?? 6000);
/** 面板消失后仍高频多久（不是正确性所需，只是少一次升频延迟；见 cadence 注释）。 */
const TAIL_MS = Number(process.env['HEXBOX_AUGMENT_TAIL_MS'] ?? 20_000);
/** 面板画布缩放（相对全分辨率）。下限 1/4：真机帧实测更低就重建不出卡片。 */
const THUMB_SCALE = Math.max(0.25, Number(process.env['HEXBOX_AUGMENT_THUMB_SCALE'] ?? 0.25));

/**
 * **面板停留期间**的采样间隔（ms）——「单卡刷新（reroll）」检测靠它。
 *
 * 为什么必须另有一个更快的节奏（用户 2026-10-06 报的真实缺陷）：面板**不会**
 * 因为某张卡被刷新而关闭，所以开/关边沿看不到这件事；只能一边盯着每张卡的
 * 画面内容，一边比对。而刷新之后的等待越久，"屏幕上贴着刷新前那颗海克斯的
 * 错误字母"的时间就越长 —— 那比不显示更糟。
 *
 * 代价的边界：**只在面板停留期间**提高采样率（那时玩家正在做选择、不在战斗，
 * 每帧只有取像素 ~15ms + 检测 ~2ms）；面板一关立刻回到触发方式给的值：
 * `api` 模式回到 **0（一帧不取）**，`pixel` 模式回到节流策略的 idle/active。
 */
const REROLL_POLL_MS = ((): number => {
  const v = Number(process.env['HEXBOX_AUGMENT_REROLL_POLL_MS'] ?? 400);
  if (!Number.isFinite(v) || v <= 0) return 400;
  return Math.max(50, Math.round(v));
})();

/**
 * **关后自愈探针的总开关**（`HEXBOX_AUGMENT_CLOSE_HEAL_PROBE=1` 才打开）。
 *
 * ⚠️ 用户 2026-10-11 裁决：**保持严格常态零取帧**，所以这里是 **false**。
 * 打开它会让"确认关闭"后的 `TAIL_MS`(20s) 内以 `PROBE_MS`(6s) 采一帧，
 * 从而在"其实面板还开着却被误判关闭"时最多 6 秒自愈 —— 代价是关闭后
 * 20 秒内每 6 秒 1 帧。关掉之后误判关闭仍然无帧可自愈，靠"修 trigger 记账
 * （`augment-trigger.ts` 的开局窗口）+ 修幽灵标签（`label-memory.ts` 的容量上限）"
 * 降低误判概率。决策规则本身是纯函数（`vision/augment-cadence.ts`
 * 的 `apiCaptureInterval()`），单测里两种开关状态都锁过。
 */
const CLOSE_HEAL_PROBE = ((): boolean => {
  const v = (process.env['HEXBOX_AUGMENT_CLOSE_HEAL_PROBE'] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
})();

/**
 * 指纹**基线**建立之后，多久内不做重随判定（ms）。
 *
 * 面板刚弹出时有一段淡入/飞入动画，卡片内容还在成形；基线是"识别报告回来时"
 * 的那一帧，紧跟其后的几百毫秒仍可能有动画余波。晚 0.6 秒开始盯刷新没有任何
 * 代价（玩家看清三张卡再点刷新远超这个时间），却能挡掉一次白跑的 OCR。
 */
const REROLL_SETTLE_MS = 600;

/** 超过这个年龄的帧直接丢弃（取证阻塞期间的排队帧，画面已过期）。 */
const STALE_FRAME_MS = 1500;

/**
 * 局内强度标签档位（`HEXBOX_AUGMENT_BADGE=small|medium|large`）。
 *
 * 只影响"标签多大"这一件事：预设把宽/高/留白/字号一起换掉，局内渲染与离线预览
 * （`scripts/preview-augment-labels.mts`）**共用同一份预设**（`AUGMENT_BADGE_PRESETS`）。
 * 不认识的值 → 用默认档（`AUGMENT_BADGE_DEFAULT`，当前「小」）。
 */
const BADGE_SIZE: AugmentBadgeSize = ((): AugmentBadgeSize => {
  const v = (process.env['HEXBOX_AUGMENT_BADGE'] ?? '').trim().toLowerCase();
  return v === 'small' || v === 'medium' || v === 'large' ? v : AUGMENT_BADGE_DEFAULT;
})();
/** 本局用的徽章预设（几何 + 字号）。 */
const BADGE_PRESET = AUGMENT_BADGE_PRESETS[BADGE_SIZE];

/**
 * 节流参数（一处解析、两处使用）。
 *
 * 录制工具的**基准模式**与**节流自测**要用同一组间隔建流/下发，
 * 自己再读一遍环境变量就等于把默认值写了两份 —— 迟早漂移。
 */
export const AUGMENT_CHAIN_CADENCE = {
  idleMs: IDLE_MS,
  activeMs: ACTIVE_MS,
  probeMs: PROBE_MS,
  tailMs: TAIL_MS,
} as const;

/** 采集参数（门控画布缩放等）。 */
export const AUGMENT_CHAIN_CAPTURE = {
  /** 门控画布缩放（相对全分辨率；下限 1/4）。 */
  thumbScale: THUMB_SCALE,
} as const;

/* ------------------------------------------------------------------ */
/* 类型：注入点、事件、产物                                             */
/* ------------------------------------------------------------------ */

/**
 * 标签推送器（**唯一的绘制出口**）。
 *
 * 为什么是注入而不是在这里建窗口：那块全屏透明画布是选人标签与局内标签
 * **共用**的（`main/label-overlay.ts`，含坐标换算/置顶/心跳），常驻覆盖层
 * 启动时就建好了它；本文件只把"该画什么"算出来交出去。
 */
export interface AugmentLabelSink {
  /**
   * 画布是否已就绪（控制器拿到**游戏所在显示器**后调一次）。
   *
   * 录制工具要用它**提前**建画布：`loadFile` 是异步的，建完立刻推的第一条消息会丢
   * （面板最早也要开局后几秒出现，所以启动时建好足够）。
   */
  prepare?(display: Electron.Display): void;
  /** 整批推送（`active: false` = 清空）。 */
  push(msg: LabelOverlayMsg, display: Electron.Display): void;
  /** 清空（面板关闭边沿 / 收工 / 画布换手）。 */
  clear(why: string): void;
}

/** 采集几何（控制器算一次；录制工具的取证/基准模式复用同一份）。 */
export interface AugmentCaptureGeometry {
  /** 游戏所在显示器（多显示器时**不是**主显示器）。 */
  readonly display: Electron.Display;
  /** 游戏窗口物理矩形（探不到为 null）。 */
  readonly windowPhysical: PhysicalRect | null;
  /** 卡片行搜索区（**截屏归一化**）。 */
  readonly region: Rect;
  /** 备用搜索区（全屏恒等）：窗口探针认错窗口时渲染端再搜一次。 */
  readonly altRegion: Rect;
  /** 门控画布目标宽度（像素）。 */
  readonly targetWidth: number;
}

/** 一次门控读数（录制工具据此写 timeline.csv / 取证 / 状态行）。 */
export interface AugmentReadingEvent {
  /** 帧采集时刻（worker 时钟；与 `startedAt` 同一时基的毫秒由调用方自行换算）。 */
  readonly atMs: number;
  readonly found: boolean;
  readonly cardCount: number;
  readonly bands: number;
  /** 每张卡的内部亮度（日志/产物用）。 */
  readonly interiors: readonly number[];
  readonly state: 'closed' | 'open';
  readonly edge: 'open' | 'close' | null;
  readonly hits: number;
  /**
   * 连续多少帧"**两个信号都不在**"（关闭判定只看它）。
   *
   * ⚠️ 语义（2026-10-06 起）：旧版是"卡片判据连续未命中"，现在是
   * "卡片判据未命中 **且**「面板仍在」信号也不在（或托底额度用完）"。
   */
  readonly misses: number;
  /** 连续多少帧"卡片判据失效但「面板仍在」信号仍在"（托底计数）。 */
  readonly presenceHolds: number;
  /** 本帧的「面板仍在」信号（渲染端没给时是 null）。 */
  readonly presence: PanelPresence | null;
  readonly reason: string;
  readonly detectMs: number;
  readonly grabMs: number;
  readonly sincePrevMs: number;
  readonly luma: number;
  /** 本帧下发的采样间隔（0 = 不取帧）。 */
  readonly intervalMs: number;
  /** 人类可读的节流/触发标签（进 CSV）。 */
  readonly cadenceLabel: string;
  /** pixel 模式下的节流档位（api 模式为 null）。 */
  readonly cadenceMode: CadenceMode | null;
  readonly openEdges: number;
  readonly closeEdges: number;
}

/** 一条全分辨率识别结果（写进产物，供离线核对）。 */
export interface AugmentRecognizedRow {
  readonly atMs: number;
  readonly ok: boolean;
  readonly reason: string;
  readonly cards: readonly RecognizedCard[];
  readonly regionIndex: number | undefined;
  readonly tookMs: number;
  readonly width: number | undefined;
  readonly height: number | undefined;
  readonly origin: RecognizeOrigin;
  readonly refreshed: readonly number[];
  /** 每卡指纹主区的 std（**指纹网格本身不进产物** —— 会胖十倍且更难读）。 */
  readonly fingerprintStds: readonly (number | null)[];
}

/** 一张卡的标签结果（`drawn=false` 时给出"为什么没画"的依据字段）。 */
export interface AugmentLabelItemRow {
  readonly index: number;
  readonly augmentId: number | null;
  readonly name: string | null;
  readonly tier: string | null;
  readonly pickRate: number | null;
  readonly drawn: boolean;
  /** 标签矩形（截屏归一化）。 */
  readonly rect: Rect | null;
  /** 屏幕逻辑坐标（DIP）；算不出为 null。 */
  readonly screen: ScreenAugmentTierLabel | null;
}

/** 本帧用的整排行基准（一块面板里所有事件必须逐位相同）。 */
export interface AugmentLabelRowBandRow {
  readonly y: number;
  readonly h: number;
  readonly lockedAtMs: number;
  readonly lockedCards: number;
  /** 这条基准就是**本次**（重）识别锁定的（面板里只有开边沿那次为 true）。 */
  readonly justLocked: boolean;
}

/** 一次标签推送（与 `recognized` 一一对应；真机复盘不必截图）。 */
export interface AugmentLabelRow {
  readonly atMs: number;
  readonly championId: number;
  readonly ok: boolean;
  readonly reason: string;
  readonly origin: RecognizeOrigin;
  readonly refreshed: readonly number[];
  readonly tookMs: number;
  readonly rowBand: AugmentLabelRowBandRow | null;
  readonly items: readonly AugmentLabelItemRow[];
}

/** 一次"某张卡被刷新了"的事件。 */
export interface AugmentRerollRow {
  readonly atMs: number;
  readonly indexes: readonly number[];
  readonly distance: readonly number[];
  readonly threshold: number;
  readonly pollMs: number;
}

/** 触发方式的复盘信息（api 模式：常态是否真的一帧不取）。 */
export interface AugmentTriggerStatus {
  readonly mode: 'api' | 'pixel';
  readonly pollMs: number;
  /** API 长期不可用 → 已退回像素节流（本局仍然有效）。 */
  readonly apiFallback: boolean;
  readonly samples: number;
  readonly pendingAtEnd: readonly number[];
  readonly captureAtEnd: boolean;
  readonly lastApiError: string | null;
}

/** 本局英雄与该英雄的强度表（标签内容的来源）。 */
export interface AugmentChampionStatus {
  readonly championId: number;
  readonly source: ChampionIdentity['source'];
  readonly name: string;
  readonly alias: string;
  readonly matchedBy: string;
  readonly reason: string;
  readonly tierCount: number;
  readonly pickRateCount: number;
}

/** 标签预设（几何 + 字号一处开关）。 */
export interface AugmentPresetStatus {
  readonly size: AugmentBadgeSize;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly marginX: number;
  readonly marginY: number;
  readonly align: AugmentBadgeAlign;
  readonly fontScale: number;
}

/**
 * 一次会话的全部诊断数据（`snapshot()`）。
 *
 * 录制工具把它拼进 `report.json` / `checkpoint.json`；常驻覆盖层只打日志。
 * 这里**只有数据**，没有窗口、没有文件路径 —— 产物怎么落地由调用方决定。
 */
export interface AugmentChainSnapshot {
  readonly startedAt: number;
  readonly running: boolean;
  readonly captureState: AugmentCaptureState;
  readonly triggerMode: 'api' | 'pixel';
  readonly samples: number;
  readonly counts: {
    readonly foundFrames: number;
    readonly droppedStaleFrames: number;
    readonly openEdges: number;
    readonly closeEdges: number;
    readonly openStateFrames: number;
  };
  /** 耗时原始序列（调用方自己算 P50/min/max）。 */
  readonly timings: {
    readonly grabMs: readonly number[];
    readonly detectMs: readonly number[];
    readonly roundMs: readonly number[];
    readonly sincePrevMs: readonly number[];
  };
  /** pixel 模式的节流时长与占比。 */
  readonly cadence: {
    readonly idleMs: number;
    readonly activeMs: number;
    readonly probeMs: number;
    readonly tailMs: number;
    readonly ms: Readonly<Record<CadenceMode, number>>;
    readonly share: { readonly idle: number; readonly probe: number; readonly active: number };
  };
  readonly trigger: AugmentTriggerStatus;
  /** API 采样日志的 CSV 行（`ms,gameTime,level,isDead,respawnTimer,capture,pending,reason`）。 */
  readonly apiLog: readonly string[];
  readonly recognized: readonly AugmentRecognizedRow[];
  readonly labels: readonly AugmentLabelRow[];
  readonly reroll: {
    readonly pollMs: number;
    readonly settleMs: number;
    readonly threshold: number;
    readonly detected: number;
    readonly events: readonly AugmentRerollRow[];
  };
  readonly champion: AugmentChampionStatus;
  readonly preset: AugmentPresetStatus;
  /**
   * **关闭确认**状态机（复检窗口 / 假关闭统计）。
   *
   * 复盘"那一次关闭是真是假"只看它：`cancelled > 0` 就说明当场有假关闭被作废
   * （面板其实还在），`rechecking` 说明这一刻正处在复检窗口里（还在取帧等面板回来）。
   */
  readonly closeConfirm: {
    readonly recheckMs: number;
    readonly pendingAtMs: number | null;
    readonly rechecking: boolean;
    readonly cancelled: number;
  };
  /** 面板门控的当前状态（常驻覆盖层的画布归属判定要用它）。 */
  readonly panelState: 'closed' | 'open' | 'unknown';
  readonly geometry: AugmentCaptureGeometry | null;
}

/** 常驻流是否真的起来了（`unavailable` = 渲染端没就绪，调用方自己决定兜底策略）。 */
export type AugmentCaptureState = 'idle' | 'stream' | 'unavailable';

/**
 * `stop()` 的选项（**会话令牌 + 要不要连带清标签**）。
 *
 * ⚠️ 两个字段都是这次真机缺陷（2026-10-06"面板刚弹出、标签刚画上，随即被清掉"）的修法：
 *   · `token`：**只允许作废自己那一代** —— 与当前会话不一致的停止请求直接忽略。
 *     改前由调用方"看到新世代就 stop"，那会把期间新起的会话连流带标签一起收掉；
 *   · `clearLabels`：**默认不清** —— 标签的生命周期只由「面板关闭边沿」与
 *     「确认离开对局（阶段换手）」决定（见 `augmentStopClearsLabels()`）。
 */
export interface AugmentStopOptions {
  /** 要作废的会话令牌（`augmentChainTransition()` 的 `token`）；缺省 = 无条件收工。 */
  readonly token?: number;
  /** 明确要求"停完屏幕上不该再有标签"（程序退出 / 录制收工）。默认 false。 */
  readonly clearLabels?: boolean;
}

export interface AugmentControllerDeps {
  /** 仓库根的 `data/`（图鉴 + 英雄详情 + 海克斯名字指纹库）。 */
  readonly dataDir: string;
  /** 标签推送器；不给 = 只打印/落盘不画（`HEXBOX_AUGMENT_DRAW=0`）。 */
  readonly labels?: AugmentLabelSink;
  /**
   * 预加载的数据（常驻覆盖层启动时已经读过图鉴/英雄详情，免得再读一遍大盘）。
   * 返回都为 null 时本文件会自己去 `dataDir` 读 —— 单独用录制工具时不必传。
   */
  readonly loadData?: () => Promise<{ dataset: Dataset | null; builds: ChampionDetailSet | null }>;
  /**
   * 触发方式。缺省按 `HEXBOX_AUGMENT_TRIGGER`（不设 = `pixel`，录制工具的既有语义）；
   * **常驻覆盖层显式传 `api`** —— 常态一帧不取（用户 2026-10-05 定的方案）。
   */
  readonly trigger?: 'api' | 'pixel';
  /** 当前是否确实在对局中（api 模式只在此时计"2999 不可用"，进游戏前不计）。 */
  readonly inMatch: () => boolean;
  /**
   * 一次性截屏路径（录制工具的 `HEXBOX_AUGMENT_CAPTURE=oneshot` 对照/兜底）：
   * 不建常驻流，由调用方用 `pushExternalReading()` 喂门控读数。
   */
  readonly externalCapture?: boolean;
  /** 每次门控读数（录制工具写 timeline.csv / 取证 / 状态行；常驻 overlay 不传）。 */
  readonly onReading?: (e: AugmentReadingEvent) => void;
  /** 每一帧流报告（**未做任何过滤**；录制工具的节流自测靠它数帧）。 */
  readonly onStreamFrame?: (frame: AugmentFrame) => void;
  readonly log?: (line: string) => void;
  readonly warn?: (line: string) => void;
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function csvField(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 算一次采集几何（游戏窗口 → 截屏归一化搜索区）。
 *
 * 导出给录制工具的**基准模式**用（它自己建一次流对照两种截屏路径，
 * 不该为了拿几何再去 new 一个控制器）。
 */
export async function resolveAugmentCaptureGeometry(
  thumbScale: number = THUMB_SCALE,
): Promise<AugmentCaptureGeometry> {
  const windowPhysical = await findGameWindowRectCached();
  // ⚠️ 用**游戏窗口所在**显示器，不是主显示器（多显示器 + 不同 DPI 时全错）
  const display = windowPhysical
    ? screen.getDisplayNearestPoint({ x: windowPhysical.x + 10, y: windowPhysical.y + 10 })
    : screen.getPrimaryDisplay();
  const targetWidth = Math.round(display.size.width * 2 * thumbScale);
  const region = panelRowRectInCapture(
    { width: targetWidth, height: Math.round(display.size.height * 2 * thumbScale) },
    windowPhysical,
    display,
  );
  return { display, windowPhysical, region, altRegion: PANEL_ROW_REGION, targetWidth };
}

/**
 * 读海克斯名字指纹库（`data/augment-names.json`）。
 *
 * 由**主进程读文件**、随配置下发给渲染端 —— 渲染端没有 fs，
 * 识别必须在渲染端做（原生分辨率帧只在那边）。
 * 文件缺失时返回空库：识别会退化"认不出来"，但门控照常工作（不会崩）。
 */
export function loadAugmentLibrary(dataDir: string): readonly {
  augmentId: number;
  name: string;
  width: number;
  height: number;
  bits: Uint8Array;
}[] {
  const path = join(dataDir, 'augment-names.json');
  try {
    const arr = JSON.parse(readFileSync(path, 'utf8')) as Array<{
      id: number;
      name: string;
      width: number;
      height: number;
      bits: string;
    }>;
    console.log('[augment] 名字指纹库 ' + arr.length + ' 条（识别用）');
    return arr.map((e) => {
      const packed = Buffer.from(e.bits, 'base64');
      const bits = new Uint8Array(e.width * e.height);
      for (let i = 0; i < bits.length; i++) bits[i] = (packed[i >> 3]! >> (i & 7)) & 1;
      return { augmentId: e.id, name: e.name, width: e.width, height: e.height, bits };
    });
  } catch (e) {
    console.warn(
      `⚠ 读不到 ${path}（${e instanceof Error ? e.message : String(e)}）→ 识别会认不出任何海克斯；` +
        '先跑 scripts/render-augment-name-fingerprints.ps1',
    );
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* 控制器                                                              */
/* ------------------------------------------------------------------ */

export class AugmentController {
  private readonly deps: AugmentControllerDeps;
  private readonly logLine: (line: string) => void;
  private readonly warnLine: (line: string) => void;

  /** 触发方式（构造时定死：一个会话一种策略，绝不在中途换）。 */
  private readonly triggerMode: 'api' | 'pixel';

  private state: 'idle' | 'starting' | 'running' | 'stopped' | 'failed' = 'idle';
  private captureState: AugmentCaptureState = 'idle';
  private geo: AugmentCaptureGeometry | null = null;

  /**
   * **当前会话令牌**（`0` = 没有会话；录制工具不用令牌时由内部自增）。
   *
   * `start(token)` 一开始就把它置成本次的令牌；**每个 await 之后**都比对一次
   * （`isCurrentSession()`）—— 不一致说明这一代已经被作废/收工，本代**只收掉
   * 自己的流**并原样上报，绝不碰新会话的东西（真机缺陷：在途启动的回调把
   * 期间新起的链路连流带标签一起收掉）。
   */
  private sessionToken = 0;
  /**
   * `this.stream` 属于哪一代会话（`0` = 没有）。
   *
   * ⚠️ 两代启动可能在时间上重叠（"确认离开"又"回到对局"），而 `this.stream`
   * 只有一个：收流时**必须**按这个号判断"这条流是不是我这一代的"
   * （`dropStream()`），否则旧一代的收场会把新一代的流顺手停掉。
   */
  private streamToken = 0;

  /** 常驻流（由本文件创建/销毁；`null` = 没在跑）。 */
  private stream: AugmentStream | null = null;
  /** 渲染端是否报告"门控已就绪/已启动"（api 模式不取帧，不能用"有没有帧"判断）。 */
  private sawReady = false;
  private sawFrame = false;

  /** 一次性 api 客户端（本局英雄身份的权威来源之一）。 */
  private live: LiveDataClient | null = null;
  /** 触发状态机（api 模式；每次 `start()` 重建 = 一块新的"未选集合"）。 */
  private apiTrigger: ReturnType<typeof createAugmentTrigger> | null = null;
  /** 门控去抖状态机（纯函数，见 `vision/augment-panel.ts`）。 */
  private tracker = createPanelTracker();
  /**
   * **关闭确认**状态机（纯函数，见 `vision/augment-close-confirm.ts`）。
   *
   * 门控报"关闭"之后**不当场**告诉 API 触发状态机，而是先进一个复检窗口：
   * 窗口内面板重现 → 这次关闭是假的（不消耗待选、不关截屏，面板自己回来）；
   * 窗口到期确认 → 才走原来的"关闭边沿"路径。
   */
  private closeConfirm = createCloseConfirm();
  /** 上次已打印的"假关闭作废"次数（只在变化时打日志，避免每帧刷屏）。 */
  private lastCloseCancelled = 0;
  /** 节流策略（pixel 模式）。 */
  private cadence = createCadencePolicy({
    idleMs: IDLE_MS,
    activeMs: ACTIVE_MS,
    probeMs: PROBE_MS,
    tailMs: TAIL_MS,
  });

  private startedAt = Date.now();
  /** 本会话是否在跑（`stop()` 之后为 false；API 轮询与帧处理都看它）。 */
  private isRunning = false;
  /** api 模式的采样日志（复盘"为什么开/没开"靠它）。 */
  private apiRows: string[] = [];
  private apiMisses = 0;
  private apiFallback = false;
  /** 当前已下发的采样间隔（去重；-1 = 还没下发过）。 */
  private appliedIntervalMs = -1;
  /** 各节流档位累计时长（pixel 模式；写进产物让"省了多少"可核对）。 */
  private modeMs: Record<CadenceMode, number> = { idle: 0, probe: 0, active: 0 };
  private lastFrameAt = 0;

  /* ── 计数与耗时（产物用；也回答"常态有没有真的零取帧"） ── */
  private samples = 0;
  private foundFrames = 0;
  private openStateFrames = 0;
  private openCount = 0;
  private closeCount = 0;
  private droppedStaleFrames = 0;
  private grabMs: number[] = [];
  private detectMs: number[] = [];
  private roundMs: number[] = [];
  private sincePrevMs: number[] = [];

  /* ── 强度表与英雄身份 ── */
  private dataset: Dataset | null = null;
  private builds: ChampionDetailSet | null = null;
  private championId = 0;
  private championIdentity: ChampionIdentity = {
    championId: 0,
    source: 'none',
    matchedBy: '',
    championName: '',
    championAlias: '',
    reason: '尚未解析（链路刚启动）',
  };
  private tierTable: ReadonlyMap<number, string> = new Map();
  /**
   * 同一张 per-hero 表里的**登场率**（0..1）。与档位同源，所以两张表永远一起重建；
   * 查不到 → 标签上只少那一行（字母照画）。
   */
  private pickRateTable: ReadonlyMap<number, number> = new Map();

  /* ── 当前这一批卡片与行基准锁 ── */
  private currentCards: readonly RerollCardState[] = [];
  /**
   * **整排行基准的锁**（一块面板一把；开边沿首次 ≥1 张卡时锁定，关闭边沿丢弃）。
   *
   * 有它之后，"刷新只更新内容、不许动几何"是代码保证的：每帧把上一帧的锁传回去，
   * `augmentTierLabelsLocked()` 只会在锁为空时新建。真机二次验收的
   * "某次单卡刷新后三个标签整体下移"就是这么修的（见 augment-label.ts）。
   */
  private rowLock: LabelRowLock | null = null;
  /** 当前这把锁是哪一次（重）识别锁定的（写进产物）。 */
  private rowLockAtMs = 0;

  /* ── 单卡刷新（reroll）监视 ── */
  private baselineFingerprints: readonly (AugmentCardFingerprint | null)[] | null = null;
  private lastFrameFingerprints: readonly (AugmentCardFingerprint | null)[] | null = null;
  private watchingSinceMs = 0;
  private rerollCount = 0;
  /**
   * 本块面板里"已经重试过一次"的卡片序号（见 `decision`/`augment-reroll-retry.ts`）。
   *
   * 额度只有一次：刷新后第一次查不到强度 → 保留旧标签并排队重认；
   * 第二次仍查不到 → 真的清掉那张卡的标签（底线）。
   */
  private retriedRerollCards = new Set<number>();
  /** 排队中的"用稳定帧再认一次"的卡片序号（下一次采样 flush）。 */
  private pendingRerollRetry: number[] = [];
  /** 这次重认**之前**的基线（单调保护用；只在一次重随判定时短暂有效）。 */
  private lastRerollPreviousBaseline: readonly (AugmentCardFingerprint | null)[] | null = null;
  /** 判定"变了"那一帧的指纹（同上）。 */
  private lastRerollDetectionFingerprints: readonly (AugmentCardFingerprint | null)[] | null = null;
  /**
   * 诊断（**无行为变化**）：面板停留期间有多少帧**没有可比指纹**。
   *
   * 常驻路径没有逐帧 CSV（那是录制工具独有的 `onReading`），所以
   * "重随检测到底是不工作、还是没采样"只能靠这一行区分。
   */
  private noFingerprintFrames = 0;
  private noFingerprintLogged = false;
  /**
   * 上一次"确认关闭（`notePanelClosed` 上报）"的时刻（ms）。
   *
   * 只喂给 `apiCaptureInterval()`：自愈探针窗口从这里起算。探针默认关闭
   * （用户选择严格零取帧），所以它现在只进日志。
   */
  private lastConfirmedCloseAtMs: number | null = null;
  private rerollRows: AugmentRerollRow[] = [];

  /* ── 产物行 ── */
  private recognizedRows: AugmentRecognizedRow[] = [];
  private labelRows: AugmentLabelRow[] = [];

  constructor(deps: AugmentControllerDeps) {
    this.deps = deps;
    this.logLine = deps.log ?? ((line: string): void => console.log(line));
    this.warnLine = deps.warn ?? ((line: string): void => console.warn(line));
    const envTrigger = process.env['HEXBOX_AUGMENT_TRIGGER'] === 'api' ? 'api' : 'pixel';
    this.triggerMode = deps.trigger ?? envTrigger;
  }

  /* ---------------- 只读状态（主进程的归属判定要用） ---------------- */

  get running(): boolean {
    return this.isRunning;
  }

  /** 本次会话的起始时刻（录制工具的产物时间基准）。 */
  get sessionStartedAt(): number {
    return this.startedAt;
  }

  get capture(): AugmentCaptureState {
    return this.captureState;
  }

  /**
   * 门控当前是否认定"海克斯面板在屏"。
   *
   * 链路没在跑（没启动/已收工）时是 `'unknown'` —— 它是
   * `vision/visibility.ts` 的 `labelProducerFor()` 的入参，**绝不是**"可能有内容"。
   */
  get panelState(): 'closed' | 'open' | 'unknown' {
    if (!this.isRunning) return 'unknown';
    return this.tracker.state;
  }

  get geometry(): AugmentCaptureGeometry | null {
    return this.geo;
  }

  /**
   * 起链路（同一个令牌重复调用是幂等的）。
   *
   * 顺序与真机验证过的那条完全一致：读数据 → 认英雄 → 算几何 → 建流 → 等就绪
   * → 起 API 轮询。返回 `'unavailable'` 表示常驻流没起来（调用方决定兜底：
   * 录制工具退回一次性截屏；常驻覆盖层放弃本局的局内标签并写明原因）。
   *
   * ⚠️ 全过程要几秒钟（探窗口 ~1.2s + 建流 + 等就绪最多 8s）。这期间阶段可能
   * 已经变走（对局结束/回到选人）→ 调用方会 `stop()`；所以每个 await 之后都
   * 要检查本代还是不是当前会话，**绝不能在已经作废之后还把流建起来**
   * （否则会留下一条没人管的屏幕流）。
   *
   * **只作废自己那一代**（2026-10-06 真机缺陷的修法）：调用方在回调里用
   * `augmentStartIsStale(token, session)` 判断，过期就**什么都不做**；
   * 本代留下的流由这里的每个检查点自行收掉，所以"什么都不做"不会漏流。
   *
   * 异常也在内部兜住：返回 `'unavailable'`，不让它冒到 `whenReady` 链之外
   * （那会让 Electron 既不报错也不退出）。
   *
   * @param token 会话令牌（`vision/visibility.ts` 的 `augmentChainTransition()` 给）。
   *   缺省（录制工具/自测）= 内部自增，一调用就是一个新会话（行为与接线前一致）。
   */
  async start(token?: number): Promise<AugmentCaptureState> {
    const mine = token ?? this.sessionToken + 1;
    if (mine === this.sessionToken && (this.state === 'starting' || this.state === 'running')) {
      // 同一个令牌重复调用：幂等（阶段轮询每 2 秒一轮，绝不允许建第二条流）。
      // ⚠️ 令牌**不同**时不许在这里早退：那说明期间"确认离开又回来"起了新一代，
      //    这一代必须真的跑起来（早退会让新一代拿到 'idle' → 被记成 failed）。
      return this.captureState;
    }
    this.sessionToken = mine;
    this.state = 'starting';
    this.startedAt = Date.now();
    this.resetSession();
    this.isRunning = true;

    try {
      await this.loadTierData();
      // 本局英雄：此刻多半还在加载中，认不出来也没关系 —— 每次面板开边沿都会重试
      await this.refreshTierTable(null);
      if (!this.isCurrentSession(mine)) return this.abortStart(mine, '启动途中已作废（阶段变化/新会话）');

      this.geo = await resolveAugmentCaptureGeometry();
      if (!this.isCurrentSession(mine)) return this.abortStart(mine, '启动途中已作废（阶段变化/新会话）');
      const geo = this.geo;
      this.logLine(
        `[augment] 游戏窗口 ${
          geo.windowPhysical
            ? `${geo.windowPhysical.width}x${geo.windowPhysical.height}@${geo.windowPhysical.x},${geo.windowPhysical.y}`
            : '未知'
        } 显示器 ${geo.display.bounds.width}x${geo.display.bounds.height} 缩放${geo.display.scaleFactor}`,
      );
      this.logLine(
        `[augment] 🏷 标签档位「${BADGE_PRESET.name}」${BADGE_SIZE}：` +
          `框 ${BADGE_PRESET.width}×${BADGE_PRESET.height} 卡内（**水平居中**）、距底 ${BADGE_PRESET.marginY}、` +
          `字号 ${BADGE_PRESET.fontScale.toFixed(3)}×框高（换档：HEXBOX_AUGMENT_BADGE=medium|large）`,
      );
      // 画布提前建（loadFile 异步；渲染端有它自己的可见性自测）
      this.deps.labels?.prepare?.(geo.display);

      if (this.deps.externalCapture === true) {
        this.captureState = 'unavailable';
        this.state = 'running';
        this.logLine('[augment] 截屏路径=一次性（由调用方喂门控读数）：不建常驻流');
        return this.captureState;
      }

      const started = await this.startStream(geo, mine);
      if (!this.isCurrentSession(mine)) {
        return this.abortStart(mine, '建流完成后已作废（阶段变化/新会话）');
      }
      this.captureState = started ? 'stream' : 'unavailable';
      this.state = 'running';
      return this.captureState;
    } catch (e) {
      this.warnLine(
        `⚠ 局内海克斯链路启动异常：${e instanceof Error ? e.message : String(e)}`,
      );
      // ⚠️ 只收**本代**的流：异常发生在旧一代里时，绝不能把新一代的流一起收掉
      this.dropStream(mine);
      if (this.sessionToken === mine) {
        this.isRunning = false;
        this.state = 'failed';
        this.captureState = 'unavailable';
      }
      return this.captureState;
    }
  }

  /** 本代还是不是**当前会话**（true = 既没被作废、也没被 `stop()`）。 */
  private isCurrentSession(mine: number): boolean {
    return this.isRunning && this.sessionToken === mine;
  }

  /** 启动途中被作废/收工：**只清本代自己的流**并如实上报（绝不动新会话）。 */
  private abortStart(mine: number, why: string): AugmentCaptureState {
    this.logLine(`[augment] ${why} → 放弃本次启动（只收本代的流）`);
    this.dropStream(mine);
    if (this.sessionToken === mine) this.captureState = 'unavailable';
    return this.captureState;
  }

  /**
   * 收掉**本代自己的**屏幕流。
   *
   * ⚠️ 两条都要收（真机缺陷的两个方向）：
   *   · `streamToken !== mine` 时，`this.stream` 属于**另一代**会话 ——
   *     一个字节都不许碰（改前的 bug 就是在途启动把新一代的流一起停掉）；
   *   · 本代**局部创建**的那条（`local`）可能已经被新一代顶掉、不在 `this.stream` 里，
   *     也必须收干净，否则会留下第二条在跑的截屏流。
   *
   * `AugmentStream.stop()` 幂等，所以同一对象进两次也无害。
   */
  private dropStream(mine: number, local: AugmentStream | null = null): void {
    const registered = this.streamToken === mine ? this.stream : null;
    if (this.streamToken === mine) {
      this.stream = null;
      this.streamToken = 0;
    }
    const targets = new Set<AugmentStream>();
    if (registered) targets.add(registered);
    if (local) targets.add(local);
    for (const s of targets) s.stop();
  }

  /**
   * 收工：停流 + 复位重随监视（**幂等**，退出路径可以放心多调）。
   *
   * ⚠️ **默认不清标签**（2026-10-06 真机缺陷的修法，见 `augmentStopClearsLabels()`）：
   * 标签的生命周期只由「面板关闭边沿」与「确认离开对局（阶段换手）」决定，
   * 链路自己的起停**不再是清空来源**。需要连带清空的只有两处**明确**的调用方：
   * 程序退出、录制收工 —— 它们传 `{ clearLabels: true }`。
   *
   * @returns 是否真的收工（令牌不匹配或本来就没在跑 → false）
   */
  stop(why = '收工', options: AugmentStopOptions = {}): boolean {
    const token = options.token;
    if (token !== undefined && token !== this.sessionToken) {
      // 只允许作废自己那一代：期间可能已经有新一代在跑，收它不是这次请求的事
      this.logLine(
        `[augment] ⏹ 忽略不属于当前会话的停止请求（令牌 ${token} ≠ 当前会话 ${this.sessionToken}）：${why}`,
      );
      return false;
    }
    if (!this.isRunning && this.state !== 'starting') return false;
    this.isRunning = false;
    this.state = 'stopped';
    this.sessionToken = 0;
    this.streamToken = 0;
    if (augmentStopClearsLabels(options.clearLabels)) {
      this.clearLabels(AUGMENT_CLEAR_REASONS.chainStop, why);
    } else {
      // ⚠️ "**没清**"也要有一行：下一次真机取证时，这条能直接排除"标签是被链路
      // 停掉的"这个猜测（上一次只能靠推断，浪费了一整局）
      this.logLine(
        `[augment] ${augmentChainStopKeepsLabelsLine(why, this.tracker.state === 'open')}`,
      );
    }
    this.resetRerollWatch(why);
    this.stream?.stop();
    this.stream = null;
    this.captureState = 'idle';
    // 常驻覆盖层与录制工具都会问"现在面板在不在"；收工后再答 'open' 是错的
    this.tracker.reset();
    // 复检窗口也一起清掉：收工后不该再因为"关闭待确认"去取帧
    this.closeConfirm.reset();
    this.lastCloseCancelled = 0;
    return true;
  }

  /**
   * 一次性截屏路径：把一轮"检测结果 + 耗时"喂进来（与流路径走**同一段**边沿逻辑）。
   *
   * 由录制工具的对照/兜底循环调用；常驻覆盖层不用它
   *（对局中每帧现截一次会让系统光标卡顿，见 docs/AUGMENT-PANEL.md §六 #15）。
   */
  pushExternalReading(
    detection: PanelDetection,
    timing: { detectMs: number; grabMs: number; sincePrevMs: number; atMs: number },
    luma = Number.NaN,
    presence: PanelPresence | null = null,
  ): void {
    if (!this.isRunning) return;
    this.handleReading(detection, timing, luma, presence);
  }

  /**
   * 直接下发采样间隔（**自测/诊断专用**：绕过内部去重，也不改"已下发值"）。
   *
   * ⚠️ 为什么必须绕过 `applyInterval()` 的去重（真机自测踩过）：自测量的是
   * "主进程 → IPC → 渲染端重开定时器"这条链路本身，所以它必须**盖过**像素节流
   * 策略每帧下发的常态值；一旦把 250ms 记成"已下发"，下一次门控读数就会把它
   * 改回 1000ms，量到的是常态节奏 —— 自测会报"节流切换没生效"这种**假故障**。
   * 正常路径**不要**用它：边沿与触发逻辑统一走 `applyInterval()`。
   */
  setCadence(ms: number, why = '自测下发'): void {
    const next = Number.isFinite(ms) && ms > 0 ? Math.max(50, Math.round(ms)) : 0;
    this.stream?.setCadence(next);
    this.logLine(
      `[augment] ⏱ 采样间隔 → ${next === 0 ? '停' : `${next}ms`}（自测直发，绕过去重）：${why}`,
    );
  }

  /** 本次会话的完整诊断数据（产物 / checkpoint / 日志）。 */
  snapshot(): AugmentChainSnapshot {
    const total = Math.max(1, this.modeMs.idle + this.modeMs.probe + this.modeMs.active);
    return {
      startedAt: this.startedAt,
      running: this.isRunning,
      captureState: this.captureState,
      triggerMode: this.triggerMode,
      samples: this.samples,
      counts: {
        foundFrames: this.foundFrames,
        droppedStaleFrames: this.droppedStaleFrames,
        openEdges: this.openCount,
        closeEdges: this.closeCount,
        openStateFrames: this.openStateFrames,
      },
      timings: {
        grabMs: [...this.grabMs],
        detectMs: [...this.detectMs],
        roundMs: [...this.roundMs],
        sincePrevMs: [...this.sincePrevMs],
      },
      cadence: {
        idleMs: IDLE_MS,
        activeMs: ACTIVE_MS,
        probeMs: PROBE_MS,
        tailMs: TAIL_MS,
        ms: { ...this.modeMs },
        share: {
          idle: Number((this.modeMs.idle / total).toFixed(3)),
          probe: Number((this.modeMs.probe / total).toFixed(3)),
          active: Number((this.modeMs.active / total).toFixed(3)),
        },
      },
      trigger: {
        mode: this.triggerMode,
        pollMs: this.triggerMode === 'api' ? API_POLL_MS : 0,
        apiFallback: this.apiFallback,
        samples: this.apiRows.length,
        pendingAtEnd: this.apiTrigger?.pending ?? [],
        captureAtEnd: this.apiTrigger?.capture ?? false,
        lastApiError: this.live?.lastError ?? null,
      },
      apiLog: [...this.apiRows],
      recognized: [...this.recognizedRows],
      labels: [...this.labelRows],
      reroll: {
        pollMs: REROLL_POLL_MS,
        settleMs: REROLL_SETTLE_MS,
        threshold: AUGMENT_REROLL_THRESHOLD,
        detected: this.rerollCount,
        events: [...this.rerollRows],
      },
      champion: {
        championId: this.championId,
        source: this.championIdentity.source,
        name: this.championIdentity.championName,
        alias: this.championIdentity.championAlias,
        matchedBy: this.championIdentity.matchedBy,
        reason: this.championIdentity.reason,
        tierCount: this.tierTable.size,
        pickRateCount: this.pickRateTable.size,
      },
      preset: {
        size: BADGE_SIZE,
        name: BADGE_PRESET.name,
        width: BADGE_PRESET.width,
        height: BADGE_PRESET.height,
        marginX: BADGE_PRESET.marginX,
        marginY: BADGE_PRESET.marginY,
        align: BADGE_PRESET.align,
        fontScale: BADGE_PRESET.fontScale,
      },
      closeConfirm: {
        recheckMs: AUGMENT_CLOSE_CONFIRM_MS,
        pendingAtMs: this.closeConfirm.state.pendingAtMs,
        rechecking: this.closeConfirm.state.rechecking,
        cancelled: this.closeConfirm.state.cancelled,
      },
      panelState: this.panelState,
      geometry: this.geo,
    };
  }

  /* ------------------------------------------------------------------ */
  /* 内部：会话初始化与收尾                                               */
  /* ------------------------------------------------------------------ */

  /** 每次 `start()` 重建全部跨帧状态（一块新面板、一局新比赛）。 */
  private resetSession(): void {
    this.apiRows = [];
    this.apiMisses = 0;
    this.apiFallback = false;
    this.appliedIntervalMs = -1;
    this.modeMs = { idle: 0, probe: 0, active: 0 };
    this.lastFrameAt = this.startedAt;
    this.samples = 0;
    this.foundFrames = 0;
    this.openStateFrames = 0;
    this.openCount = 0;
    this.closeCount = 0;
    this.droppedStaleFrames = 0;
    this.grabMs = [];
    this.detectMs = [];
    this.roundMs = [];
    this.sincePrevMs = [];
    this.recognizedRows = [];
    this.labelRows = [];
    this.rerollRows = [];
    this.rerollCount = 0;
    this.currentCards = [];
    this.rowLock = null;
    this.rowLockAtMs = 0;
    this.baselineFingerprints = null;
    this.lastFrameFingerprints = null;
    this.watchingSinceMs = 0;
    this.retriedRerollCards.clear();
    this.pendingRerollRetry = [];
    this.lastRerollPreviousBaseline = null;
    this.lastRerollDetectionFingerprints = null;
    this.noFingerprintFrames = 0;
    this.noFingerprintLogged = false;
    this.lastConfirmedCloseAtMs = null;
    this.sawReady = false;
    this.sawFrame = false;
    this.tracker = createPanelTracker();
    this.closeConfirm = createCloseConfirm();
    this.cadence = createCadencePolicy({
      idleMs: IDLE_MS,
      activeMs: ACTIVE_MS,
      probeMs: PROBE_MS,
      tailMs: TAIL_MS,
    });
    this.apiTrigger = this.triggerMode === 'api' ? createAugmentTrigger() : null;
  }

  /**
   * 建常驻流并等它就绪；返回 false 表示调用方应当退回兜底路径。
   *
   * ⚠️ 全程按**令牌**检查本代还是不是当前会话：作废后建起来的流必须立刻收掉
   * （`dropStream(mine)` 只收本代的），否则会留下一条没人管的截屏流 ——
   * 而"没人管的流"比"这一局没有标签"严重得多（它会一直截屏、抢合成）。
   */
  private async startStream(geo: AugmentCaptureGeometry, mine: number): Promise<boolean> {
    // 收工/被作废后再建流 = 留下一条没人管的截屏流（启动是异步的，见 start() 的说明）
    if (!this.isCurrentSession(mine)) return false;
    const stream = new AugmentStream({
      // 起始间隔：
      //   · pixel 模式用**常态低频**（节流策略会按命中情况升到高频）；
      //   · api 模式**一帧不取**（0 = 停），等状态机触发后再起表。
      // altRegion = 全屏恒等：窗口探针认错窗口时主区会切掉外侧卡边框，
      // 渲染端会用这个再搜一次（2~4ms），避免"探针错 = 整局瞎"。
      config: {
        region: geo.region,
        altRegion: geo.altRegion,
        // 门控画布按**流原生宽度的 1/3、且不小于 960px** 取 —— 与 DPI/分辨率无关。
        // 旧算法（逻辑宽×2×0.25）隐含假设缩放倍率 1.5，在 4K@250% 上会掉到 1/5，
        // 低于标定的 1/4 下限（见 gateCanvasWidth 注释）。
        targetScale: 1 / 3,
        minWidth: 960,
        // 名字指纹库随配置下发（渲染端做识别，读文件在主进程）
        library: loadAugmentLibrary(this.deps.dataDir),
        intervalMs: this.triggerMode === 'api' ? 0 : IDLE_MS,
        targetWidth: geo.targetWidth,
      },
      onFrame: (f) => this.onStreamFrame(f),
      onStatus: (m, e) => {
        this.logLine(`[augment] ${e ? '⚠' : '·'} ${m}`);
        // api 模式下"一帧不取"是正常的，所以不能用"有没有帧"判断流是否就绪，
        // 改用渲染端的这两条日志（见 capture/worker.ts 的 start()）。
        if (m.includes('门控已就绪') || m.includes('门控已启动')) this.sawReady = true;
      },
      onRecognized: (r) => this.onRecognized(r),
    });
    this.stream = stream;
    this.streamToken = mine;

    // ⚠️ 常驻流是**新路径且无法离线验证**，所以两道保险：
    //   1. start() 抛错（路径/权限/Electron 版本问题）→ 捕获并说明；
    //   2. 8 秒内既没有帧也没有"门控已就绪"→ 判定流没起来，调用方退回兜底。
    let started = false;
    try {
      started = await stream.start(geo.display);
    } catch (e) {
      this.warnLine(
        `⚠ 常驻流启动失败：${e instanceof Error ? e.message : String(e)}\n   → 调用方应退回兜底路径`,
      );
    }
    if (!this.isCurrentSession(mine)) {
      // ⚠️ 必须把**局部**这条一起收：它可能已经被新一代顶掉（不在 `this.stream` 里），
      //    只按 `streamToken` 判归属就会漏掉它 → 多一条没人管的截屏流
      this.dropStream(mine, stream);
      return false;
    }
    if (!started) {
      this.dropStream(mine, stream);
      return false;
    }

    const t0 = Date.now();
    // api 模式不取帧，所以等的是渲染端"门控已就绪"的日志；其他模式等首帧。
    while (this.triggerMode === 'api' ? !this.sawReady : !this.sawFrame) {
      if (Date.now() - t0 > 8000) break;
      if (!this.isCurrentSession(mine)) {
        this.dropStream(mine, stream);
        return false;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (this.triggerMode === 'api' && !this.sawReady) {
      this.warnLine('⚠ 渲染端 8 秒内未报告"门控已就绪" → 常驻流判定为不可用');
      this.dropStream(mine, stream);
      return false;
    }
    if (!this.sawFrame && !this.sawReady) {
      this.warnLine('⚠ 常驻流 8 秒内没有出帧（可能被节流或不合成）→ 判定为不可用');
      this.dropStream(mine, stream);
      return false;
    }
    // 等就绪期间可能已经被作废（"确认离开又回来"）：那时绝不能起 API 轮询
    //（否则两代各跑一条轮询，接口与流都会被重复驱动）
    if (!this.isCurrentSession(mine)) {
      this.dropStream(mine, stream);
      return false;
    }
    this.logLine(
      this.triggerMode === 'api'
        ? `[augment] 常驻流已就绪（api 模式：常态**不取帧**，死亡 + 等级达标 + 该次未选才开）轮询 ${API_POLL_MS}ms`
        : '[augment] 常驻流已出帧，按流路径运行',
    );
    if (this.triggerMode === 'api' && !this.apiFallback) this.startApiPolling();
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* 内部：强度表与英雄身份                                               */
  /* ------------------------------------------------------------------ */

  /** 读 `data/`（图鉴 + 英雄详情）。读不到也**不阻断** —— 只是标签会"查不到强度"。 */
  private async loadTierData(): Promise<void> {
    const injected = await this.deps.loadData?.().catch(() => null);
    if (injected && (injected.dataset !== null || injected.builds !== null)) {
      this.dataset = injected.dataset;
      this.builds = injected.builds;
    } else {
      try {
        this.dataset = await readDataset(this.deps.dataDir);
      } catch {
        this.dataset = null;
      }
      try {
        this.builds = await readBuilds(this.deps.dataDir);
      } catch {
        this.builds = null;
      }
    }
    const details = this.builds?.details.length ?? 0;
    this.logLine(
      this.builds && this.dataset
        ? `[augment] 强度表数据源就绪：英雄详情 ${details} 个（统计日期 ${this.builds.meta.dataDate || '未知'}）、图鉴英雄 ${this.dataset.champions.length} 个`
        : `⚠ 读不到强度表数据源（英雄详情 ${this.builds ? '有' : '无'} / 图鉴 ${this.dataset ? '有' : '无'}，目录 ${this.deps.dataDir}）→ 标签只会打印"查不到强度"`,
    );
  }

  /** LCU 客户端（每次调用重新探测凭证；读不到 → null，纯 2999 也能认英雄）。 */
  private async lcuReader(): Promise<LcuClient | null> {
    try {
      const creds = await detectCredentialsDetailed();
      return creds?.credentials ? new LcuClient(creds.credentials) : null;
    } catch {
      return null;
    }
  }

  /** 2999 客户端单例（pixel 模式也要用：它是英雄身份的**权威来源**）。 */
  private liveClient(): LiveDataClient {
    this.live ??= createLiveDataClient({ timeoutMs: 2500 });
    return this.live;
  }

  /**
   * 认英雄 → 组强度表（`augmentId` → tier / pickRate）。
   *
   * 面板每次出现前调用一次即可（英雄一局不变，但链路可能在对局中途启动，
   * 那时英雄还没认出来 —— 所以每次开边沿都重试，成功后就跳过）。
   *
   * ⚠️ 认不出就**返回 false**：调用方据此一张标签都不画（宁漏勿错）。
   */
  private async refreshTierTable(live: LiveDataClient | null): Promise<boolean> {
    if (this.championId > 0) return this.tierTable.size > 0;
    const identity = await resolveMyChampionIdentity(await this.lcuReader(), {
      champions: this.dataset?.champions ?? [],
      // ⚠️ pixel 模式下 live 为 null，但**不能**因此不查 2999：它是英雄身份的权威来源
      live: live ?? this.liveClient(),
    });
    this.championIdentity = identity;
    if (identity.championId <= 0) {
      // 明确说清"为什么这次没有标签"——真机排查只看这一行
      this.warnLine(
        `[augment] 未能确定本局英雄（${identity.reason}）→ 不画标签` +
          '（宁可一张不画，也不能画别人英雄的评级）',
      );
      return false;
    }
    this.championId = identity.championId;
    const detail = findDetail(this.builds, identity.championId);
    this.tierTable = augmentTierTable(detail?.augments ?? []);
    // 登场率与档位同源（同一个 augment_json_irank），所以两张表永远一起重建
    this.pickRateTable = augmentPickRateTable(detail?.augments ?? []);
    const hero =
      identity.championName !== ''
        ? identity.championName
        : (this.dataset?.champions.find((c) => c.id === identity.championId)?.name ??
          `#${identity.championId}`);
    this.logLine(
      `[augment] 本局英雄 ${hero}（#${this.championId}，来源 ${identity.source}：${identity.reason}）` +
        ` → 强度表 ${this.tierTable.size} 条（标签的档位来源）`,
    );
    return this.tierTable.size > 0;
  }

  /* ------------------------------------------------------------------ */
  /* 内部：采样间隔下发                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * **下发采样间隔**（唯一出口，去重）。
   *
   * `0` = 停止取帧（api 模式的常态：**一帧不取**）。
   * ⚠️ 面板停留期间传 `REROLL_POLL_MS`（默认 400ms）—— 单卡刷新检测靠它；
   * 面板一关就回到触发方式给的值（api → 0、pixel → 节流策略的 idle/active），
   * 所以"面板关闭后回到常态零取帧"这条性质没有被削弱。
   */
  private applyInterval(ms: number, why: string, ctx = ''): void {
    const next = Number.isFinite(ms) && ms > 0 ? Math.max(50, Math.round(ms)) : 0;
    if (next === this.appliedIntervalMs) return;
    this.appliedIntervalMs = next;
    this.stream?.setCadence(next);
    this.logLine(
      `[augment] ⏱ 采样间隔 → ${next === 0 ? '停（常态零取帧）' : `${next}ms`}：${why}` +
        // 诊断补丁（无行为变化）：打"停"时必须能看出**三个入参**各是什么状态，
        // 否则"为什么停"只能靠前后几行日志猜（常驻路径没有逐帧 CSV）。
        (ctx === '' ? '' : `［${ctx}］`),
    );
  }

  /* ------------------------------------------------------------------ */
  /* 内部：流帧 → 边沿 → 识别 → 标签                                      */
  /* ------------------------------------------------------------------ */

  /** 流的一帧：丢弃过期帧 → 门控 → 重随检测。 */
  private onStreamFrame(f: AugmentFrame): void {
    this.sawFrame = true;
    this.deps.onStreamFrame?.(f);
    if (!this.isRunning) return;
    // ⚠️ 丢弃过期帧：取证/阻塞会让帧排队，那些帧"画面早已过去"，
    // 用它们做边沿会造出假边沿（真机实测过一次 close/open 凭空出现）。
    const age = Date.now() - f.atMs;
    if (age > STALE_FRAME_MS) {
      this.droppedStaleFrames++;
      return;
    }
    this.handleReading(
      { found: f.found, cards: f.cards, bands: f.bands, reason: f.reason },
      { detectMs: f.detectMs, grabMs: f.grabMs, sincePrevMs: f.sincePrevMs, atMs: f.atMs },
      Number.NaN,
      // 渲染端只在卡片判据**未命中**的帧上算它（`capture/worker.ts`）；
      // 旧渲染端不带 → `null` = 按"不在"处理（与接线前行为一致）。
      f.presence ?? null,
    );
    // 面板停留期间的**单卡刷新**检测：指纹来自渲染端（门控分辨率、冻结矩形）。
    // 放在 handleReading 之后：那时状态/边沿已经更新（只在 open 时判）。
    this.maybeDetectReroll(f);
    // 上一步若判定"刷新后第一次没查出强度"，这里在**下一帧**（稳定帧）补认一次
    this.flushRerollRetry(f);
  }

  /** 门控读数共有逻辑：计数 + 节流/触发 + 边沿处置（流与一次性截屏**同一段**）。 */
  private handleReading(
    detection: PanelDetection,
    timing: ReadingTiming,
    luma: number,
    presence: PanelPresence | null = null,
  ): void {
    // ⚠️ **两个信号**一起喂状态机（`vision/augment-panel.ts`）：卡片判据 +
    // "面板仍在"信号（渲染端在未命中帧上算的那条）。
    // 只凭卡片判据的话，单卡重随的**翻牌动画**（真机实测让判据失效 1178ms）
    // 会被当成"面板关了" → 清标签 + 关截屏 → 那块面板永久空白。
    const reading = this.tracker.push(detection, presence);
    this.samples++;
    if (reading.found) this.foundFrames++;
    if (reading.state === 'open') this.openStateFrames++;
    this.detectMs.push(timing.detectMs);
    this.grabMs.push(timing.grabMs);
    this.roundMs.push(timing.detectMs + timing.grabMs);
    this.sincePrevMs.push(timing.sincePrevMs);

    // 节流：api 触发模式由 API 状态机决定开/关（常态一帧不取）；
    // 其余模式用"常态低频 + 命中后高频"的像素节流。
    //
    // ⚠️ 两种模式**在面板停留期间都改用 `REROLL_POLL_MS`**（默认 400ms）：
    //    单卡刷新检测要在这个节奏上比对每张卡的指纹；面板一关就回到常态
    //    （api 模式 = 0，一帧不取；pixel 模式 = 节流策略的 idle/active）。
    const nowMs = timing.atMs;
    let cadenceLabel: string;
    let cadenceMode: CadenceMode | null = null;
    if (this.triggerMode === 'api') {
      // ── 关闭**确认**（见 `vision/augment-close-confirm.ts`）─────────────────
      //
      // ⚠️ 关闭边沿**不当场**上报触发状态机：一次误判就会消耗一次待选并
      //    `capture=false` → 采样间隔下发 0 → 一帧不取 → 面板再也回不来
      //    （真机日志：`🔌 关截屏：未见面板即关闭` 后面紧跟 `⏱ 采样间隔 → 停`）。
      // 现在：进复检窗口继续取帧；窗口内面板重现 → 作废这次关闭（不消耗、不停表）；
      // 窗口到期 → 才把"关闭"上报（`notePanelClosed`）。
      const confirm = this.closeConfirm.push({ edge: reading.edge, nowMs });
      const cancelled = this.closeConfirm.state.cancelled;
      if (cancelled !== this.lastCloseCancelled) {
        // 假关闭被作废：这是"面板其实一直在"的**硬证据**，必须留一行
        this.lastCloseCancelled = cancelled;
        this.logLine(`[augment] 🔒 假关闭作废（第 ${cancelled} 次）：${confirm.reason}`);
      }
      if (reading.edge === 'open') this.apiTrigger?.notePanelOpen(nowMs);
      if (confirm.notifyClosed) {
        this.logLine(`[augment] 🔒 关闭确认：${confirm.reason}`);
        // 自愈探针窗口从这个时刻起算（探针默认关闭，见 CLOSE_HEAL_PROBE）
        this.lastConfirmedCloseAtMs = nowMs;
        const d = this.apiTrigger?.notePanelClosed(nowMs);
        if (d?.changed) this.applyApiDecision(d);
      }
      const on = this.apiTrigger?.capture === true;
      const rechecking = confirm.rechecking;
      // 间隔决策全在**纯函数**里（`vision/augment-cadence.ts` 的
      // `apiCaptureInterval()`，有单测）：本处只负责把三个入参喂进去。
      // ⚠️ 面板状态**优先于**触发状态机：门控亲眼看到面板在屏时，哪怕 API 那边
      //    因为记账偏位说 `capture=false`，也绝不能把间隔压回 0（那会一帧不取 →
      //    面板上的标签永远不更新）。
      const api = apiCaptureInterval(
        {
          panelOpen: reading.state === 'open',
          capture: on,
          rechecking,
          lastConfirmedCloseAtMs: this.lastConfirmedCloseAtMs,
          nowMs,
        },
        {
          rerollPollMs: REROLL_POLL_MS,
          activeMs: ACTIVE_MS,
          probeMs: PROBE_MS,
          healWindowMs: TAIL_MS,
          healProbe: CLOSE_HEAL_PROBE,
        },
      );
      this.applyInterval(
        api.intervalMs,
        api.reason,
        `capture=${on} state=${reading.state} rechecking=${rechecking}` +
          (api.healProbe ? ' 探针=on' : ''),
      );
      cadenceLabel = `${on ? 'on' : 'off'}${this.appliedIntervalMs > 0 ? `@${this.appliedIntervalMs}` : ''}`;
    } else {
      const cad = this.cadence.onReading(reading, nowMs);
      cadenceMode = cad.mode;
      this.modeMs[cad.mode] += Math.max(0, nowMs - this.lastFrameAt);
      this.lastFrameAt = nowMs;
      if (cad.changed) {
        this.logLine(`[augment] ⏱ 节流 → ${cad.mode}（每 ${cad.intervalMs}ms）：${cad.reason}`);
      }
      // 面板停留 → 重随轮询（覆盖节流策略的 active 值）；否则用策略给的值
      this.applyInterval(
        reading.state === 'open' ? REROLL_POLL_MS : cad.intervalMs,
        reading.state === 'open' ? `面板停留 → 重随轮询 ${REROLL_POLL_MS}ms` : cad.reason,
      );
      cadenceLabel = reading.state === 'open' ? `${cad.mode}@${this.appliedIntervalMs}` : cad.mode;
    }

    if (reading.edge === 'open') {
      this.openCount++;
      this.logLine(
        `[augment] ▶ 面板出现 #${this.openCount} @${((nowMs - this.startedAt) / 1000).toFixed(1)}s — ${reading.reason}`,
      );
      // 顺带认一次「本局英雄」（标签的档位是以英雄为准的）：链路可能在对局中途
      // 启动，那时英雄还认不出来，所以每次开边沿都重试（认出来后就跳过）。
      void this.refreshTierTable(this.live);
      // 重随检测的基线要等**本次识别报告**回来才建立（见 onRecognized）：
      // 基线必须对应"屏幕上画的是哪颗海克斯"那一帧，不能随便取一帧。
      this.baselineFingerprints = null;
      this.lastFrameFingerprints = null;
      // "重认一次"的额度与排队也是**每块面板各自一份**（绝不许跨面板复用）
      this.retriedRerollCards.clear();
      this.pendingRerollRetry = [];
      this.noFingerprintFrames = 0;
      this.noFingerprintLogged = false;
      // 整排行基准的锁也在这里清掉：新面板 = 新的一排（"基准在**开边沿**锁定"）。
      this.rowLock = null;
      this.rowLockAtMs = 0;
      this.stream?.recognize();
    } else if (reading.edge === 'close') {
      this.closeCount++;
      // ⚠️ 关闭判定的**依据一次打全**（哪几个信号、各自连续几次、阈值多少）：
      // 用户报"面板开着标签却没了"时，唯一能回答"凭什么说面板不在"的就是这一行。
      this.logLine(
        `[augment] ◀ 面板消失 #${this.closeCount} @${((nowMs - this.startedAt) / 1000).toFixed(1)}s` +
          ` — 依据：${panelGateEvidence(reading)}` +
          (this.triggerMode === 'api' ? '（已进复检窗口：面板若还在就不会真关）' : ''),
      );
      // ⚠️ **关闭边沿立刻清空标签**：绝不复用选人阶段那套 6 轮 TTL
      //（局内每次 offer 是**不同**的三张卡，残留会把上一轮强度贴到新卡上）。
      this.clearLabels(AUGMENT_CLEAR_REASONS.panelClosed, `第 ${this.closeCount} 次`);
      // 诊断：这块面板在屏期间"没有可比指纹"的帧数（重随检测是否真的在工作）
      this.flushNoFingerprintDiag(`面板消失 #${this.closeCount}`);
      // 重随基线/冻结取样矩形也一起复位（下一块面板可能是另外三张、在别处）
      this.resetRerollWatch(`面板消失 #${this.closeCount}`);
    } else if (reading.presenceHolds === 1) {
      // 翻牌那一瞬间的第一帧：卡片判据失效但面板信号仍在 → **不判关闭**。
      // 这一行就是"刚才那几帧不是面板关了、是卡片在动"的直接证据。
      this.logLine(`[augment] 🛡 面板信号托底：${reading.reason}`);
    }

    this.deps.onReading?.({
      atMs: nowMs,
      found: reading.found,
      cardCount: reading.cards.length,
      bands: reading.bands,
      interiors: reading.cards.map((c) => c.interiorLuma),
      state: reading.state,
      edge: reading.edge,
      hits: reading.hits,
      misses: reading.misses,
      presenceHolds: reading.presenceHolds,
      presence: reading.presence,
      reason: reading.reason,
      detectMs: timing.detectMs,
      grabMs: timing.grabMs,
      sincePrevMs: timing.sincePrevMs,
      luma,
      intervalMs: this.appliedIntervalMs,
      cadenceLabel,
      cadenceMode,
      openEdges: this.openCount,
      closeEdges: this.closeCount,
    });
  }

  /**
   * 全分辨率识别结果 → 当前这批卡片 → **强度标签**（打印 + 落盘 + 画）。
   *
   * ⚠️ `cards` 是**当前整批**（不是增量）：重随之后由 `mergeRefreshedCards()`
   * 合并出完整的三张，再整批重算标签 → 推送时是**全量替换**
   * （渲染端先 `clearRect` 再逐条画）—— 所以"某张卡认不出"时它的标签会
   * **随这一次推送一起消失**，其余两张不受影响，不存在"追加"或残留旧字母。
   */
  private onRecognized(raw: unknown): void {
    // ⚠️ 收工之后绝不再画：识别是**异步**的（渲染端跑完才回传），而收工可能发生
    // 在这期间（阶段变走 / 退出）。若不拦住，这一次回调会把标签推到已经换手的
    // 画布上 —— 常驻覆盖层里就是"局内的字母盖在选人胜率标签上"。
    if (!this.isRunning) return;
    // 形状与渲染端 `capture/worker.ts` 的 RecognizedReport 一致（类型直接引用它，
    // 免得两处各写一份必然漂移）
    const rep = raw as RecognizedReport;
    const cards: readonly RecognizedCard[] = rep.cards ?? [];
    // 旧渲染端不带 origin（回退成"开边沿整批"，行为与接线前一致）
    const origin: RecognizeOrigin = rep.origin ?? 'open';
    this.logLine(
      `[augment] 🔎 ${origin === 'reroll' ? '单卡重随重识别' : '全分辨率识别'} ` +
        `${rep.ok ? '成功' : '未命中'}（${rep.tookMs.toFixed(0)}ms，` +
        `${rep.width ?? '?'}x${rep.height ?? '?'}）${rep.ok ? '' : '：' + rep.reason}`,
    );
    for (const [i, c] of cards.entries()) {
      this.logLine(
        `      卡${origin === 'reroll' ? ((rep.refreshed?.[i] ?? i) + 1) : i + 1} ${c.name ?? '（认不准，不画）'}` +
          (c.score !== null ? `  分数 ${c.score} 分差 ${c.margin}` : ''),
      );
    }

    if (origin === 'reroll') {
      // **只替换变化的那几张**：其余卡原样保留；认不出/取不到 → 该卡 augmentId 置 null
      // → 本次推送里它的标签消失（其余两张不受影响）。
      //
      // ⚠️ 但**第一次失败不清**（真机：标签闪一下又回来 —— 两次 OCR 结果一模一样，
      // 差别只在"这一次查表查不到"）：给一次重试机会、先保住上一帧的标签，
      // 用下一张稳定帧再认一次；**第二次仍失败才真的清**（底线，见
      // `vision/augment-reroll-retry.ts` 与它的单测）。
      const refreshed = rep.refreshed ?? [];
      const before = this.currentCards;
      const merged = mergeRefreshedCards(before, refreshed, cards);
      /** 本次"会掉标签"的卡：本来有标签 + 重认后查不到强度。 */
      const wouldDrop = refreshed.filter((index) => {
        const hadLabel = lookupAugmentTier(this.tierTable, before[index]?.augmentId ?? null) !== null;
        const nowNull = lookupAugmentTier(this.tierTable, merged[index]?.augmentId ?? null) === null;
        return hadLabel && nowNull;
      });
      const plan = decideRerollRetry({
        refreshed,
        wouldDrop,
        retried: [...this.retriedRerollCards],
      });
      for (const index of plan.retry) this.retriedRerollCards.add(index);
      this.currentCards =
        plan.retry.length === 0
          ? merged
          : merged.map((c, i) => (plan.retry.includes(i) ? (before[i] ?? c) : c));
      // ⚠️ **累加**而不是覆盖：两次重随在同一帧内先后被判定时，覆盖会让前一张卡的
      //    重试被丢掉 → 那张卡会一直挂着**旧字母**（"显示错数据"，绝不允许）。
      this.pendingRerollRetry = [...new Set([...this.pendingRerollRetry, ...plan.retry])];
      // 真机一眼可判的一行：卡几 → 重认成了什么
      const outcome = refreshed.map((index) => {
        if (plan.retry.includes(index)) {
          return `卡${index + 1} → 这次没查出强度（先保留上一帧标签，下一帧用稳定帧再认一次）`;
        }
        const c = this.currentCards[index];
        const tier = lookupAugmentTier(this.tierTable, c?.augmentId ?? null);
        const pick = lookupAugmentPickRate(this.pickRateTable, c?.augmentId ?? null);
        return (
          `卡${index + 1} → ${tier ?? '不画（认不出/查不到强度）'}` +
          (tier !== null && pick !== null && pick > 0 ? `（选取率 ${(pick * 100).toFixed(1)}%）` : '') +
          (c?.name ? `（${c.name}）` : '')
        );
      });
      this.logLine(
        `[augment] 检测到${refreshed.map((i) => `卡${i + 1}`).join('/')} 刷新 → 重新识别` +
          `（${rep.tookMs.toFixed(0)}ms）→ ${outcome.join('，')}`,
      );
      // **每一次"标签消失"都要有一行原因**（这是用户复现时唯一能定位的线索）：
      // 重随之后那张卡认不出（识别问题）/ 查不到强度（数据覆盖问题）必须分开写。
      // 之前那张卡本来就没有标签时不打 —— 别在日志里造出"清空"假事件。
      //（`retry` 的那些卡这里会把旧值保留着 → `augmentClearReasonForRefreshedCard`
      //  查到强度非空 → 自动跳过，不会打出假"清空"。）
      for (const index of refreshed) {
        const c = this.currentCards[index];
        const reason = augmentClearReasonForRefreshedCard(
          c?.augmentId ?? null,
          lookupAugmentTier(this.tierTable, c?.augmentId ?? null),
        );
        if (reason === null) continue;
        const hadLabel = lookupAugmentTier(this.tierTable, before[index]?.augmentId ?? null) !== null;
        if (!hadLabel) continue;
        this.logLine(`[augment] ${augmentClearLogLine(reason, `卡${index + 1}`)}`);
      }
    } else {
      // 开边沿：整批替换
      this.currentCards = cards;
    }

    // 基线 = 本次识别之后、**当前冻结取样矩形**下的每卡指纹（渲染端一起回传）。
    // 有了它，下一帧起的比对才有"屏幕上是哪颗海克斯"这个参照。
    //
    // ⚠️ 重随路径要**单调保护**（2026-10-11）：判定"变了"的那一刻基线已经推进到
    // **检测帧**（新内容），而这里回传的是渲染端"最近一帧门控画面"的指纹 ——
    // 万一它是**变化之前**那一帧，基线就被倒回旧内容 → 同一次刷新被重复检出
    //（真机日志里同一个结构距离 0.0735 出现两次）。判据是纯函数（有单测）。
    if (rep.fingerprints && rep.fingerprints.length > 0) {
      const adopt =
        origin !== 'reroll' ||
        shouldAdoptReportedBaseline({
          previous: this.lastRerollPreviousBaseline,
          detection: this.lastRerollDetectionFingerprints,
          reported: rep.fingerprints,
        });
      if (adopt) {
        this.baselineFingerprints = rep.fingerprints;
        this.lastFrameFingerprints = rep.fingerprints;
      } else {
        // 留一行：这是"同一次刷新被重复检出"的直接嫌疑（下一次真机复盘靠它定性）
        this.logLine(
          '[augment] ♻ 重认回传的指纹比检测帧更旧（像变化之前那一帧）→ **不采信**，' +
            '基线保持在新内容上（否则同一次刷新会被再检出一次）',
        );
      }
      this.watchingSinceMs = Date.now();
    }
    this.recognizedRows.push({
      atMs: Date.now() - this.startedAt,
      ok: rep.ok,
      reason: rep.reason,
      cards,
      regionIndex: rep.regionIndex,
      tookMs: rep.tookMs,
      width: rep.width,
      height: rep.height,
      origin,
      refreshed: origin === 'reroll' ? [...(rep.refreshed ?? [])] : [],
      // ⚠️ 指纹网格（每卡 320 个数）**不进产物**（会胖十倍且更难读）；
      // 留每卡主区 std —— "这批基线是不是成形的内容"一眼可判。
      fingerprintStds: (rep.fingerprints ?? []).map((x) => (x ? Number(x.std.toFixed(1)) : null)),
    });
    this.drawTierLabels({ origin, tookMs: rep.tookMs, rep });
  }

  /**
   * 识别结果 → 强度标签：**打印 + 落盘 + 交给标签推送器**。
   *
   * 三道过滤全在纯函数里（`vision/augment-tier-label.ts`）：
   * 认不准不画、查不到强度不画、只画档位字母（+ 查得到时的选取率行）。
   * 屏幕坐标复用 S2 的换算桥 `makeScreenGeometry` + `normalizedRectToScreen`。
   *
   * ⚠️ 几何走 `augmentTierLabelsLocked()`：**整排行基准在开边沿锁一次、面板存续期间
   * 复用同一条** —— 内容（字母/选取率/是否存在）随每次推送变，纵向基准一个字都不许动。
   */
  private drawTierLabels(meta: {
    readonly origin: RecognizeOrigin;
    readonly tookMs: number;
    readonly rep: RecognizedReport;
  }): void {
    const wasLocked = this.rowLock !== null;
    const row = augmentTierLabelsLocked(this.rowLock, this.currentCards, this.tierTable, {
      preset: BADGE_PRESET,
      pickRates: this.pickRateTable,
    });
    const labels = row.labels;
    if (!wasLocked && row.rowLock) {
      this.rowLockAtMs = Date.now() - this.startedAt;
      this.logLine(
        `[augment] 📐 整排行基准锁定（${row.rowLock.cards.length} 张卡）：` +
          `框顶 y=${row.rowLock.band.y.toFixed(6)} 框高 h=${row.rowLock.band.h.toFixed(6)}` +
          ' —— 面板存续期间复用同一条，刷新/抖动都不许改它',
      );
    }
    this.rowLock = row.rowLock;
    const rep = meta.rep;

    // 1) 逐卡打印（含"为什么没画"与"选取率查不到"，真机只看日志就能判断）
    const perCard: string[] = [];
    for (const [i, c] of this.currentCards.entries()) {
      const tier = lookupAugmentTier(this.tierTable, c.augmentId);
      const pick = lookupAugmentPickRate(this.pickRateTable, c.augmentId);
      const why =
        c.augmentId === null
          ? '认不准'
          : this.championId === 0
            ? '未认出本局英雄'
            : '该英雄未收录这颗海克斯';
      this.logLine(
        `[augment] 标签：卡${i + 1} → ${tier ?? `不画（${why}）`}` +
          (tier !== null
            ? `（选取率 ${pick === null ? '查不到→那一行不画' : `${(pick * 100).toFixed(1)}%`}）`
            : '') +
          (c.name !== null && c.name !== undefined ? `（${c.name}）` : ''),
      );
      perCard.push(`卡${i + 1}=${tier ?? '-'}`);
    }

    // 2) 换屏幕逻辑坐标（与 S2 同一套几何：截屏可能是显示器快照）
    const width = rep.width ?? 0;
    const height = rep.height ?? 0;
    const geo = this.geo;
    let screenLabels: ScreenAugmentTierLabel[] = [];
    if (labels.length > 0 && width > 0 && height > 0 && geo) {
      const { geo: captureGeo, kind, estimated } = makeScreenGeometry(
        { width, height },
        geo.windowPhysical,
        {
          bounds: geo.display.bounds,
          scaleFactor: geo.display.scaleFactor,
          workArea: geo.display.workArea,
        },
      );
      screenLabels = toScreenTierLabels(labels, captureGeo);
      this.logLine(
        `[augment] 🏷 ${labels.length} 个标签 → 屏幕（${kind}${estimated ? '，几何为推断值' : ''}）：` +
          screenLabels
            .map(
              (s) =>
                `${s.text}@(${s.x.toFixed(0)},${s.y.toFixed(0)}) ${s.w.toFixed(0)}x${s.h.toFixed(0)}` +
                (s.subText !== '' ? `「${s.subText}」` : ''),
            )
            .join(' '),
      );
    } else if (labels.length > 0) {
      this.warnLine('⚠ 识别报告没带帧尺寸（width/height）或几何未就绪 → 算不出屏幕坐标，本次不画');
    }

    // 3) 画（**整批替换**：没有标签时推 active=false → 清空，绝不残留上一次的字）
    if (geo) {
      this.deps.labels?.push(
        {
          active: screenLabels.length > 0,
          labels: screenLabels.map((s) => ({
            x: s.x,
            y: s.y,
            w: s.w,
            h: s.h,
            text: s.text,
            // 辅助文本 = 字母下面那一行「选取率 12.1%」（查不到/为 0 时是空串 → 不画）
            sub: s.subText,
            hasData: true,
            color: s.color,
            textScale: s.fontScale,
            // 绘制样式：大号描边字母 + 尖括号 + 选取率行（没有色块底）
            style: s.style,
          })),
          diag: `海克斯强度 ${screenLabels.length} 个：${perCard.join(' ')}`,
        },
        geo.display,
      );
      // **隐式清空**（这里没有调 `clear()`，但画布确实被清空了：`active:false`）——
      // 它也必须有一行原因，否则"重随后那张卡认不出 → 标签消失"在日志里是**静默**的。
      if (screenLabels.length === 0) {
        this.logLine(
          `[augment] ${augmentClearLogLine(
            augmentClearReasonForEmptyLabels(meta.origin),
            meta.origin === 'reroll'
              ? '整批已无可画标签'
              : `开边沿整批没有可画结果：${rep.reason}`,
          )}`,
        );
      }
    }

    this.labelRows.push({
      atMs: Date.now() - this.startedAt,
      championId: this.championId,
      ok: rep.ok,
      reason: rep.reason,
      // ⚠️ **触发原因**与**这次（重）识别的耗时**：`open` = 面板开边沿整批识别，
      // `reroll` = 面板停留期间某张卡被换掉后的单卡重识别（S5.7）。
      origin: meta.origin,
      refreshed: meta.origin === 'reroll' ? (rep.refreshed ?? []).map((i) => i + 1) : [],
      tookMs: Number(meta.tookMs.toFixed(1)),
      rowBand: row.rowLock
        ? {
            y: row.rowLock.band.y,
            h: row.rowLock.band.h,
            lockedAtMs: this.rowLockAtMs,
            lockedCards: row.rowLock.cards.length,
            justLocked: !wasLocked,
          }
        : null,
      items: this.currentCards.map((c, i) => ({
        index: i + 1,
        augmentId: c.augmentId,
        name: c.name ?? null,
        tier: lookupAugmentTier(this.tierTable, c.augmentId),
        pickRate: lookupAugmentPickRate(this.pickRateTable, c.augmentId),
        drawn: labels.some((l) => l.augmentId === c.augmentId),
        rect: labels.find((l) => l.augmentId === c.augmentId)?.rect ?? null,
        screen: screenLabels.find((s) => s.augmentId === c.augmentId) ?? null,
      })),
    });
  }

  /* ------------------------------------------------------------------ */
  /* 内部：单卡刷新（reroll）检测                                         */
  /* ------------------------------------------------------------------ */

  /**
   * 清空标签（面板**关闭边沿**、收工、画布换手都必须调）。
   *
   * ⚠️ **每一次清空都要打印原因**（`vision/augment-clear.ts` 的词表 + 一行日志）：
   * 用户报的"面板开着不动、标签几秒后自己消失"只有靠这一行才能定位是谁清的。
   * 原因必须来自词表（不是各处自己拼的字符串），否则日志格式会漂移、没法 grep。
   */
  private clearLabels(reason: AugmentClearReason, detail = ''): void {
    if (!this.deps.labels) return;
    this.deps.labels.clear(reason);
    this.logLine(`[augment] ${augmentClearLogLine(reason, detail)}`);
  }

  /** 面板消失/收工：清掉重随基线（**绝不跨面板复用**）与整排行基准的锁。 */
  private resetRerollWatch(why: string): void {
    if (this.baselineFingerprints !== null) this.logLine(`[augment] 🔄 重随监视复位：${why}`);
    if (this.rowLock !== null) {
      this.logLine(
        `[augment] 📐 整排行基准解锁（${this.rowLock.cards.length} 张卡，锁定于 ${this.rowLockAtMs}ms）：${why}` +
          ' —— 下一块面板重新锁',
      );
    }
    this.rowLock = null;
    this.rowLockAtMs = 0;
    this.baselineFingerprints = null;
    this.lastFrameFingerprints = null;
    this.watchingSinceMs = 0;
    // "重认一次"的额度/排队也随面板一起复位（跨面板复用会让新面板的第一张卡没有额度）
    this.retriedRerollCards.clear();
    this.pendingRerollRetry = [];
    this.lastRerollPreviousBaseline = null;
    this.lastRerollDetectionFingerprints = null;
    this.noFingerprintFrames = 0;
    this.noFingerprintLogged = false;
    this.stream?.unwatch();
  }

  /**
   * 诊断（**无行为变化**）：面板停留期间有多少帧"没有可比指纹"。
   *
   * 常驻路径没有逐帧 CSV，所以"重随检测不工作"以前是**无法从日志区分**的三种形态
   * （没采样 / 没报指纹 / 取到了但判据不过）。这一行把它们分开：本帧有可比指纹、
   * 或面板关闭时各打一次（每块面板只打一行）。
   */
  private flushNoFingerprintDiag(why: string): void {
    if (this.noFingerprintFrames === 0 || this.noFingerprintLogged) return;
    this.noFingerprintLogged = true;
    this.logLine(
      `[augment] 🧭 面板停留期间 ${this.noFingerprintFrames} 帧没有可比指纹` +
        `（watchRects 未登记/卡数不一致）→ 重随检测不工作（${why}）`,
    );
  }

  /**
   * 本帧是否"有卡被刷新了"（面板停留期间每帧调一次）。
   *
   * 判定全在纯函数里（`vision/augment-reroll.ts`）：
   *   ① 指纹来自**冻结的取样矩形**（渲染端 `watchRects`），不看检测抖动；
   *   ② 与基线比"去均值结构距离" ≥ 阈值 → 内容换过；
   *   ③ 本帧已成形（std 不低）+ 与**上一帧一致**（动画已停）→ 才算数。
   * 判定通过后**立刻把基线推进到本帧**（同一变化不会每帧触发），
   * 再让渲染端**只重认那几张卡**。
   */
  private maybeDetectReroll(f: AugmentFrame): void {
    // 渲染端只在"冻结矩形仍对得上"时报指纹（面板没认定/卡片数抖动时是空数组）
    const current = f.fingerprints && f.fingerprints.length > 0 ? f.fingerprints : null;
    if (!current) {
      // 诊断（无行为变化）：面板**在屏**却没有可比指纹的帧 —— 重随检测在这些帧上
      // 完全不工作（`watchRects` 没登记 / 本帧重建出的卡片数与冻结矩形数不一致）。
      if (this.tracker.state === 'open') this.noFingerprintFrames++;
      return; // 这一帧没有可比指纹 → 不判定，也不动上一帧参照
    }
    this.flushNoFingerprintDiag('又拿到可比指纹');
    const previous = this.lastFrameFingerprints;
    this.lastFrameFingerprints = current;
    if (this.tracker.state !== 'open') return;
    if (this.baselineFingerprints === null) return; // 还没识别过 → 没有可比基线
    if (f.atMs - this.watchingSinceMs < REROLL_SETTLE_MS) return; // 开面板动画余波
    const changed = rerolledCardIndices(
      { baseline: this.baselineFingerprints, current, previous },
      { threshold: AUGMENT_REROLL_THRESHOLD },
    );
    if (changed.length === 0) return;
    // 先把距离算出来（基线马上要被推进，之后就算不出"相对上次识别的差异"了）
    const baselineBefore = this.baselineFingerprints;
    const distances = changed.map((i) =>
      Number(fingerprintDistance(baselineBefore?.[i] ?? null, current[i] ?? null).toFixed(4)),
    );
    this.rerollCount++;
    const which = changed.map((i) => `卡${i + 1}`).join('/');
    this.logLine(
      `[augment] 🔄 检测到${which} 刷新（结构距离 ${distances.join('/')} ≥ 阈值 ${AUGMENT_REROLL_THRESHOLD}）` +
        ' → 只重认这几张…',
    );
    this.baselineFingerprints = current;
    // 单调保护的参照：这次重认**之前**的基线 vs 判定"变了"那一帧
    this.lastRerollPreviousBaseline = baselineBefore;
    this.lastRerollDetectionFingerprints = current;
    this.rerollRows.push({
      atMs: f.atMs - this.startedAt,
      indexes: changed.map((i) => i + 1),
      distance: distances,
      threshold: AUGMENT_REROLL_THRESHOLD,
      pollMs: REROLL_POLL_MS,
    });
    this.stream?.recognize({ only: changed });
  }

  /**
   * 把排队中的"刷新后重认一次"发出去（`decideRerollRetry` 的 `retry` 那一半）。
   *
   * ⚠️ **等到下一帧、且那一帧有可比指纹时才认**：渲染端只在"面板认定 + 卡片数与
   * 冻结矩形数一致"的帧上报指纹，而翻牌动画的中间帧会报空数组 —— 所以这个条件
   * 恰好就是"**画面已经稳定**"（与 `rerolledCardIndices` 的 settle 判据同源）。
   * 代价：最多晚一个采样周期（`REROLL_POLL_MS`，默认 400ms）出标签。
   */
  private flushRerollRetry(f: AugmentFrame): void {
    if (this.pendingRerollRetry.length === 0) return;
    if (this.tracker.state !== 'open') return;
    const current = f.fingerprints && f.fingerprints.length > 0 ? f.fingerprints : null;
    if (!current) return;
    const only = [...this.pendingRerollRetry];
    this.pendingRerollRetry = [];
    this.logLine(
      `[augment] ♻ 刷新后第一次没查出强度 → 用稳定帧再认一次（卡${only.map((i) => i + 1).join('/')}；` +
        '再失败才清那张卡的标签）',
    );
    this.stream?.recognize({ only });
  }

  /* ------------------------------------------------------------------ */
  /* 内部：API 触发（常态零取帧）                                          */
  /* ------------------------------------------------------------------ */

  /**
   * 启动 API 轮询：常态一帧不取，只有状态机说"开"才取帧。
   *
   * 失败自愈：连续 `API_MISS_LIMIT` 次拿不到状态（2999 未就绪/被防火墙拦）
   * → 退回像素节流并大声告警 —— 一次对局的代价很贵，绝不能白跑。
   */
  private startApiPolling(): void {
    const trigger = this.apiTrigger;
    if (!trigger) return;
    // 10 次（≈10 秒）已足够排除"刚开局的抖动"；进游戏前不计失败（见下）
    const API_MISS_LIMIT = 10;
    const client = this.liveClient();
    this.logLine(
      `[augment] ⏱ 触发方式=API（常态不截屏；死亡 + 等级达标 + 该次未选 → 开）轮询 ${API_POLL_MS}ms`,
    );
    const poll = async (): Promise<void> => {
      if (!this.isRunning) return;
      const state = await client.getPlayerState();
      if (state === null) {
        // ⚠️ **进游戏前 2999 一定不存在**（它只在局内存在）。链路通常在选人/加载阶段
        // 之后才起，但重连、跨局等情形仍可能问到"还没有 2999"的时刻，
        // 如果这时也计失败，就会误判"退回像素节流"并锁死整局。
        // 所以只在**已知在对局中**时才计失败。
        if (this.deps.inMatch()) this.apiMisses++;
        if (this.apiMisses === API_MISS_LIMIT && !this.apiFallback) {
          this.apiFallback = true;
          this.warnLine(
            `⚠ API 连续 ${API_MISS_LIMIT} 次不可用（${client.lastError ?? '未知'}）→ 退回像素节流（本局仍然有效）`,
          );
          this.applyInterval(IDLE_MS, 'API 不可用 → 退回像素节流常态');
        }
      } else {
        this.apiMisses = 0;
        const now = Date.now();
        const d = trigger.onSample(
          {
            gameTime: state.gameTime,
            level: state.level,
            isDead: state.isDead,
            respawnTimer: state.respawnTimer,
          },
          now,
        );
        // ⚠️ 已退回像素节流后**不再让 API 控制开关**：否则两条策略互相抢
        //（真机事故：开局前 API 不可用 → 退回像素节流 → API 恢复后又把间隔改成 0，
        //  结果面板期间一帧都不取）。此时只记录，不下发。
        if (!this.apiFallback && d.changed) this.applyApiDecision(d);
        this.apiRows.push(
          [
            String(now - this.startedAt),
            state.gameTime.toFixed(1),
            String(state.level),
            state.isDead ? '1' : '0',
            state.respawnTimer.toFixed(1),
            d.capture ? '1' : '0',
            `[${d.pending.join(',')}]`,
            (this.apiFallback ? '（已退回像素节流，未下发）' : '') + d.reason,
          ]
            .map((f) => csvField(f))
            .join(','),
        );
      }
      if (this.isRunning) setTimeout(() => void poll(), API_POLL_MS);
    };
    void poll();
  }

  /** 触发决策 → 下发（开=高频取帧，关=一帧不取）。 */
  private applyApiDecision(d: { capture: boolean; reason: string }): void {
    this.logLine(`[augment] 🔌 ${d.capture ? '开截屏' : '关截屏'}：${d.reason}`);
    this.applyInterval(d.capture ? ACTIVE_MS : 0, d.reason);
  }
}

/** 门控一帧的耗时（流路径来自 worker，一次性截屏路径来自本地测量）。 */
interface ReadingTiming {
  readonly detectMs: number;
  readonly grabMs: number;
  readonly sincePrevMs: number;
  readonly atMs: number;
}
