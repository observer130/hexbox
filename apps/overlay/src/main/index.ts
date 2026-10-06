/**
 * Electron 主进程：悬浮窗
 *
 * 职责划分（重要）：
 *   - 主进程：所有需要 Node 的工作 —— LCU 探测/轮询、数据集读取、
 *             窗口创建/定位、穿透切换
 *   - 渲染端：纯浏览器环境，只接收主进程推送的状态并渲染
 *
 * ⚠️ 安全边界（本项目核心承诺）：
 *   只创建自己的窗口、只读取**进程元数据/窗口几何**，
 *   绝不打开游戏进程句柄、不读内存、不注入、不解析封包。
 *
 * 分阶段设计（见 docs/OVERLAY-STAGES.md）：
 *   不同阶段玩家在做的决策不同，因此显示内容也不同 ——
 *   - 选人：在**选英雄** → 只给该英雄胜率
 *   - 局内：在**选海克斯 / 出装** → 给该英雄口径的海克斯强度与出装建议
 */

import { app, BrowserWindow, ipcMain, screen } from 'electron';
import { appendFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inspect } from 'node:util';

/**
 * 把 console 输出同时写入日志文件（UTF-8），供真机排查。
 *
 * ⚠️ 为什么不用 PowerShell 的 `*>` 重定向（真实浪费时间的事故）：
 * 本机 PowerShell 5.1 会按控制台 OEM 代码页（GBK/936）解码 node 的 UTF-8
 * 输出，中文全变成"鎴睆/鎺ㄩ€"这类乱码，写盘时再转一次 UTF-16 —— 读日志
 * 得反解两层编码。而且脚本本身若丢了 UTF-8 BOM，PowerShell 连脚本都
 * **解析失败**（中文字符串被拆坏）。
 *
 * 这里由 Node 直接以 UTF-8 写文件：编码完全可控，与 PowerShell 无关。
 * 未设置 `HEXBOX_LOG_FILE` 时不写文件（默认行为不变）。
 *
 * ⚠️ **相对路径的坑（真实浪费时间）**：`pnpm dev:overlay` 会把 cwd 设成
 * `apps/overlay`，所以 `HEXBOX_LOG_FILE=debug/overlay.log` 落在
 * `apps/overlay/debug/overlay.log`，而用户会去仓库根的 `debug/` 找 → "日志文件呢？"。
 * 因此启动第一行就把**解析后的绝对路径**与 **cwd** 都打出来（见下面的调用点），
 * 文档里也一律建议写绝对路径。
 */
function teeConsoleToFile(path: string): void {
  const orig = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  const fmt = (args: unknown[]): string =>
    args.map((a) => (typeof a === 'string' ? a : inspect(a))).join(' ');
  const write = (line: string): void => {
    try {
      appendFileSync(path, line + '\n', 'utf8');
    } catch {
      // 日志写入失败绝不影响功能
    }
  };
  console.log = (...a: unknown[]): void => {
    write(fmt(a));
    orig.log(...a);
  };
  console.warn = (...a: unknown[]): void => {
    write(fmt(a));
    orig.warn(...a);
  };
  console.error = (...a: unknown[]): void => {
    write(fmt(a));
    orig.error(...a);
  };
}

const logFile = process.env['HEXBOX_LOG_FILE'];
if (logFile) {
  teeConsoleToFile(logFile);
  // 启动第一行：**绝对路径**（用户按相对路径找不到文件是真实踩过的坑）+
  // 当前 cwd（`pnpm` 会把 cwd 设成 `apps/overlay`，相对路径就从那里算）。
  console.log(
    `[hexbox] 日志文件（绝对路径）：${resolve(logFile)}\n` +
      `         当前工作目录 cwd=${process.cwd()}` +
      `（HEXBOX_LOG_FILE 写相对路径时**相对它**解析 —— 建议直接写绝对路径）`,
  );
}

import {
  LcuClient,
  LcuHttpError,
  createLiveDataClient,
  detectCredentialsDetailed,
  hasSelfIdentity,
  isBrawlSession,
  readSelfIdentity,
  resolveMyChampionIdentity,
  type LiveDataClient,
  type SelfIdentity,
} from '@hexbox/lcu';
import { readBuilds, readDataset, readRankings, readTemplates } from '@hexbox/data-store';
import {
  base64ToBits,
  computePanelBounds,
  decodePack,
  decideVisible,
  denormalizeToGray,
  findGameWindowRect,
  findGameWindowRectCached,
  prepareTemplates,
  sameVisibleState,
  augmentChainTransition,
  augmentStartIsStale,
  createStageGate,
  labelProducerFor,
  overlayAugmentEnabled,
  stageSampleFromSession,
  AUGMENT_CLEAR_REASONS,
  AUGMENT_CHAIN_PHASES,
  augmentClearLogLine,
  type AugmentChainState,
  type LabelProducer,
  type NameFingerprint,
  type PreparedTemplate,
  type VisibleState,
} from '@hexbox/vision';
import {
  augmentStrength,
  canonicalChampionId,
  champSelectInfo,
  championBuild,
  findDetail,
  hasBuildData,
  type BuildSlotRow,
  type ChampionDetailSet,
  type Dataset,
  type RankingSnapshot,
} from '@hexbox/core';
import { VisionLoop, type VisionOverlayMsg } from './vision-loop.ts';
import {
  attachLabelOverlayDiagnostics,
  clearLabelOverlay,
  createLabelOverlay,
  pushLabelOverlay,
} from './label-overlay.ts';
import { isLabelOverlaySelfTest, runLabelOverlaySelfTest } from './label-selftest.ts';
import { AugmentController, type AugmentLabelSink } from './augment-controller.ts';

// ---------------------------------------------------------------------------
// 悬浮窗状态
// ---------------------------------------------------------------------------

let win: BrowserWindow | null = null;
/** S2 全屏透明覆盖窗口（选人阶段显示卡片胜率标签）。 */
let overlayWin: BrowserWindow | null = null;
let client: LcuClient | null = null;
let dataset: Dataset | null = null;
let rankings: RankingSnapshot | null = null;
let builds: ChampionDetailSet | null = null;
/**
 * 上一次**已应用**的可见性判定（null = 还没应用过）。
 *
 * ⚠️ 不能只比较 phase：中途掉线时 phase 可能不变而 connected 变了，
 * 那就不会再应用一次，诊断面板永远不出现（真实 bug）。
 * 判定本身在 `@hexbox/vision` 的 decideVisible（纯函数、有单测）。
 */
let lastVisible: VisibleState | null = null;
let clickThrough = true;
let warnedNoCreds = false;
let credsDetail = '';
/** 本次选人中「我」选的英雄（0 = 未知）。 */
let myChampionId = 0;
/**
 * 我自己的身份（puuid / summonerId / 显示名）—— 用于在 gameflow 里定位"我"。
 *
 * 读一次就够（一局内不变）；读不到就是空对象：此时 gameflow 通道**直接放弃**
 * （宁可不显示，也不能像旧实现那样"取队伍列表里第一个 championId"）。
 */
let selfIdentity: SelfIdentity | null = null;
/** 2999 局内客户端（懒建；不在对局里时请求失败返回 null 即可）。 */
let liveData: LiveDataClient | null = null;
/**
 * 选人子阶段（供视觉循环决定画卡片还是画顶栏）。
 *
 * `picking` = 卡片已发出、还没选；`locked` = 已选定（未选的英雄已进顶栏）；
 * `unknown` = 选人会话里没有 actions 字段（版本差异）→ 视觉循环退回像素启发式。
 */
let champSelectPickState: 'picking' | 'locked' | 'unknown' = 'unknown';
/** S2 视觉循环（选人阶段启用）。 */
let visionLoop: VisionLoop | null = null;
/** 名字指纹库（视觉循环用）。 */
let nameLibrary: NameFingerprint[] = [];
/** 头像模板（确认阶段识别用）。 */
let portraits: PreparedTemplate[] = [];
/**
 * **局内海克斯链路**（S5.4d）：与录制工具 `debug:augment` **同一份控制器**
 * （`main/augment-controller.ts`）—— 触发状态机、采样节奏、识别、强度表、
 * 标签几何与行基准锁、单卡刷新编排都在那边，这里只做阶段启停与画布注入。
 */
let augment: AugmentController | null = null;
/**
 * 局内链路的启动状态（纯函数 `augmentChainTransition()` 的输入与输出）。
 *
 * `failed` 只表示"这一局起不来了"（屏幕流没就绪）—— 不再重试，
 * 免得每 2 秒轮询都去建一次流；离开对局会回到 `idle`，下一局重新试。
 */
let augmentState: AugmentChainState = 'idle';
/**
 * 每次"起链路"的**会话令牌**。
 *
 * ⚠️ `start()` 是异步的（探窗口 ~1.2s + 建流 + 等就绪最多 8s）。若期间阶段已经
 * 变走（比如对局结束），回调不能把它标成 running —— 用**令牌**作废在途结果，
 * 而不是靠猜时序：
 *   · `augmentChainTransition()` 的 `generation` 就是当前会话号（一次启动一个号，
 *     单调递增、绝不重号）；`token` 是本轮动作要带上的号（`stop` 带的是**要作废
 *     的那一代**）；
 *   · 回调里只允许用 `augmentStartIsStale(token, augmentSession)` 判断"我这一代
 *     还在不在"，过期就**什么都不做** —— 绝不可以"看到新世代就 `stop()`"
 *     （那会把期间新起的那一代连流带标签一起收掉，正是"标签闪一下就没了"）。
 *     本代自己的屏幕流由控制器在每个 await 检查点按令牌自行收干净，
 *     所以"什么都不做"不会留下没人管的流。
 */
let augmentSession = 0;
/**
 * 上一次已应用的**画布生产者**（`null` = 还没判定过）。
 *
 * 判定本身是纯函数（`@hexbox/vision` 的 `labelProducerFor()`，有单测）：
 * 选人阶段归选人视觉循环，局内归海克斯链路，两者**互斥**。
 */
let lastLabelProducer: LabelProducer | null = null;
/**
 * 局内海克斯链路的降级开关（`HEXBOX_OVERLAY_AUGMENT=0` → 整体关闭）。
 *
 * ⚠️ 关掉它**只**影响局内那一条链路：选人阶段的胜率标签照常工作
 * （两个生产者的判定在 `vision/visibility.ts` 里是分开的）。
 */
const AUGMENT_ENABLED = overlayAugmentEnabled(process.env['HEXBOX_OVERLAY_AUGMENT']);
/**
 * 是否把局内强度标签画到屏幕上（与录制工具同一个开关：`HEXBOX_AUGMENT_DRAW=0`）。
 *
 * 关掉 = 链路照跑（识别、日志、判据都在），只是不画 —— 排查"标签是不是把
 * 面板判据挡住了 / 是不是标签本身有问题"时用；常驻覆盖层的选人标签不受影响。
 */
const AUGMENT_DRAW = process.env['HEXBOX_AUGMENT_DRAW'] !== '0';
/**
 * 最后一次 LCU 轮询到的阶段（`inMatch` 判定用；画布归属由本轮 `phase` 决定）。
 *
 * 为什么单独留一份：控制器的 API 轮询是**异步**的，它需要在"本轮采样时刻"
 * 知道"现在是不是确实在对局中"（否则进游戏前的 2999 不可用会被误记成失败）。
 *
 * ⚠️ 这里是**经过阶段门**的值（`stageGate.push()` 的输出），不是原始读数。
 */
let lastPhase = 'None';

/**
 * LCU 阶段读数的**去抖门**（纯函数 `vision/visibility.ts` 的 `createStageGate()`）。
 *
 * ⚠️ 为什么必须有它（真机缺陷 2026-10-06：局内面板开着不动、标签几秒后自己消失）：
 * `/lol-gameflow/v1/session` 的读取有**三种**结果，而旧实现把后两种都写成 `'None'`：
 *   · 读到会话 → `phase` = 会话里的阶段；
 *   · **确实没有会话**（404/400，大厅里很正常）→ `'None'`；
 *   · **读失败**（5 秒超时 / 网络抖动 / 5xx / 鉴权失效）→ 旧实现也写 `'None'`。
 * 于是**一次偶发失败**就同时触发两条不可逆的清空：
 *   ① `labelProducerFor('None', …, 'augment')` → `handover` → `clearLabelOverlay()`；
 *   ② `augmentChainTransition('running', gen, 'None')` → `stop` → 控制器也清标签，
 *      并且重新起链路时 API 触发状态机是新的（`capture=false`）→ 那一块面板
 *      **再也画不出标签**。
 *
 * 门只做一件事：**读取失败不算离开、离开要连续 `AUGMENT_STAGE_LEAVE_CONFIRM` 次**。
 */
const stageGate = createStageGate();

/**
 * 上一轮阶段门**已打印过的结论**（原因原文 + 采纳的阶段），用于去重。
 *
 * 为什么要它：门现在**每次结论变化都要打一行**（包括"连续 2 次读到 None → 确认
 * 离开对局"那一轮 —— 旧代码那一轮是静默的，导致日志看起来自相矛盾）。
 * 没有去重的话，`保持 InProgress` 这类结论会在每 2 秒轮询里各打一次。
 */
let lastStageGateReason = '';
let lastStageGateStage = '';

/**
 * 「对局进行中」的阶段集合。
 *
 * 这些阶段内选人会话已消失（或即将消失），因此**不能**清空 myChampionId；
 * 只有完全离开对局才清空，否则会把上一局的英雄带到下一局。
 */
const IN_GAME_PHASES = new Set([
  'ChampSelect',
  'GameStart',
  'InProgress',
  'Reconnect',
  'WaitingForStats',
  'PreEndOfGame',
]);

const POLL_MS = 2000;

/** 一条海克斯强度（渲染端直接可用）。 */
interface AugmentRowMsg {
  name: string;
  icon: string;
  tier: string;
  pickRate: number;
  rarity: string;
}

/** 一个出装槽位。 */
interface BuildSlotMsg {
  names: string[];
  pickRate: number;
  winRate: number;
}

interface OverlayStateMsg {
  connected: boolean;
  phase: string;
  gameMode: string;
  queueId: number | null;
  isBrawl: boolean;
  picks: Array<{ championId: number; name: string }>;
  clickThrough: boolean;
  /** 我选的英雄（选人阶段）。 */
  me: {
    championId: number;
    name: string;
    /** 海斗模式胜率（0..1）。 */
    winRate: number;
    /** 是否有官方统计。 */
    hasData: boolean;
  };
  /** 该英雄的海克斯强度（局内；按官方排名）。 */
  augments: AugmentRowMsg[];
  /** 出装建议（局内）。 */
  build: {
    start: BuildSlotMsg[];
    shoes: BuildSlotMsg[];
    core: BuildSlotMsg[];
  };
  /** 数据出处（来源 + 统计日期）。 */
  meta: { dataDate: string; hasBuilds: boolean };
  credsDetail: string;
}

const EMPTY_BUILD = { start: [], shoes: [], core: [] };

/* ------------------------------------------------------------------ */
// 游戏窗口定位（只读窗口几何信息）
// ---------------------------------------------------------------------------

// findGameWindowRect 已抽取到 @hexbox/vision（win-geometry.ts），
// 与 debug-capture 共用同一份实现 —— 两处各写一份必然漂移。
// 它同样只调用 user32!GetWindowRect 读取几何信息，不触碰进程内存。

async function positionOverlay(): Promise<void> {
  if (!win || !win.isVisible()) return;
  // 走缓存：本函数由 3 秒定时器与 display-metrics-changed 触发，
  // 而单次探测要 ~1.2s（PowerShell + Add-Type）——不能每次都探。
  const game = await findGameWindowRectCached();
  // ⚠️ 用**游戏窗口所在**显示器，而不是光标所在显示器：
  // 玩家把鼠标移到副屏时，原实现会把面板摆到副屏去（游戏在另一块屏上）。
  const display = game
    ? screen.getDisplayNearestPoint({ x: game.x + 10, y: game.y + 10 })
    : screen.getPrimaryDisplay();
  // 定位算式抽到 @hexbox/vision/panel-geometry.ts（纯函数 + 单测）：
  // 全屏游戏时"外侧右边"没有空间，必须退到内侧/工作区右缘，否则面板跑到屏幕外。
  win.setBounds(computePanelBounds(game, display.workArea));
}

// ---------------------------------------------------------------------------
// 数据
// ---------------------------------------------------------------------------

/**
 * 解析数据目录（仓库根的 `data/`）。
 *
 * ⚠️ 真机教训（覆盖层"永远是暂无数据"的根因）：原实现只用
 * `join(app.getAppPath(), '..', '..', 'data')`。它解析成
 * `apps/overlay/data`（不存在）→ dataset/rankings/templates 全部读不到：
 *   · rankings = null  → 所有英雄都显示「暂无数据」
 *   · 名字指纹 = 空    → 卡片名字永远识别不出
 * 而 `debug:capture` 用的是另一套算法（`debug/..` = 仓库根），
 * 于是出现"调试工具能识别、实时运行不能"的诡异现象。
 *
 * ⚠️ 也不要用固定的 `..\..\` 层级：打包后 `__dirname` 是 `dist/main`，
 * 而 `process.cwd()` 取决于启动方式（`electron .` 与直接跑 bundle 不同）。
 * 唯一稳妥的做法是**向上遍历、以 `data/dataset.json` 是否存在为准**。
 */
function resolveDataDir(): string {
  const envDir = process.env['HEXBOX_DATA_DIR'];
  if (envDir) return envDir;

  const tried: string[] = [];
  const seen = new Set<string>();
  const starts = [__dirname, app.getAppPath(), process.cwd()];
  for (const start of starts) {
    let dir = start;
    for (let depth = 0; depth < 6; depth++) {
      const cand = join(dir, 'data');
      if (!seen.has(cand)) {
        seen.add(cand);
        tried.push(cand);
        if (existsSync(join(cand, 'dataset.json'))) return cand;
      }
      const parent = join(dir, '..');
      if (parent === dir) break; // 已到盘根
      dir = parent;
    }
  }
  console.warn(
    `[hexbox] ⚠ 未找到 data/dataset.json（已尝试 ${tried.length} 个候选目录，例如：\n` +
      `         ${tried.slice(0, 4).join('\n         ')}\n` +
      '         请先运行 pnpm sync；或用 HEXBOX_DATA_DIR 显式指定数据目录）',
  );
  return join(process.cwd(), 'data');
}

async function loadDataset(): Promise<void> {
  const dir = resolveDataDir();
  console.log(`[hexbox] 数据目录: ${dir}`);

  try {
    dataset = await readDataset(dir);
    console.log(
      dataset
        ? `[hexbox] 图鉴已加载: 海克斯(cn) ${dataset.hextechs.length} / 英雄 ${dataset.champions.length} / 装备 ${dataset.items.length}`
        : `[hexbox] 未找到图鉴 (${dir})，请先运行 pnpm sync`,
    );
  } catch (e) {
    console.warn('[hexbox] 图鉴读取失败:', e instanceof Error ? e.message : e);
    dataset = null;
  }

  try {
    rankings = await readRankings(dir);
    console.log(
      rankings
        ? `[hexbox] 排行榜已加载: 英雄榜 ${rankings.heroes.length} / 海克斯榜 ${rankings.augments.length}  统计日期 ${rankings.meta.dataDate || '未知'}`
        : `[hexbox] 未找到排行榜 (${dir}) —— 卡片标签会全部显示「暂无数据」`,
    );
  } catch (e) {
    console.warn('[hexbox] 排行榜读取失败:', e instanceof Error ? e.message : e);
    rankings = null;
  }

  try {
    builds = await readBuilds(dir);
    console.log(
      builds
        ? `[hexbox] 英雄详情已加载: ${builds.details.length} 个英雄  统计日期 ${builds.meta.dataDate || '未知'}`
        : `[hexbox] 未找到英雄详情 (${dir})，出装建议不可用`,
    );
  } catch (e) {
    console.warn('[hexbox] 英雄详情读取失败:', e instanceof Error ? e.message : e);
    builds = null;
  }
}

/** 把出装槽位转为推送结构。 */
function slotMsg(rows: readonly BuildSlotRow[]): BuildSlotMsg[] {
  return rows.map((r) => ({
    names: [...r.names],
    pickRate: r.pickRate,
    winRate: r.winRate,
  }));
}

/**
 * 局内 2999 客户端（懒建一次即可；只读官方本地接口）。
 *
 * 英雄身份**最权威**的来源就在这里（`activePlayer.rawChampionName` /
 * `championName`）—— 它是"我自己"，而 gameflow 的队伍列表里坐着 10 个人。
 */
function liveClient(): LiveDataClient {
  liveData ??= createLiveDataClient({ timeoutMs: 2500 });
  return liveData;
}

/** 组装「我」这个英雄的全部阶段数据。 */
function buildMeMsg(championId: number): OverlayStateMsg['me'] {
  const info = champSelectInfo(championId, {
    heroes: rankings?.heroes ?? [],
    champions: dataset?.champions ?? [],
  });
  return {
    championId: info.championId,
    name: info.name,
    winRate: info.winRate,
    hasData: info.hasData,
  };
}

function buildAugmentMsg(championId: number): AugmentRowMsg[] {
  const detail = findDetail(builds, championId);
  if (!detail) return [];
  return augmentStrength({
    detail,
    hextechs: dataset?.hextechs ?? [],
    limit: 10,
  }).map((r) => ({
    name: r.name,
    icon: r.icon,
    tier: r.tier,
    pickRate: r.pickRate,
    rarity: r.rarity,
  }));
}

function buildBuildMsg(championId: number): OverlayStateMsg['build'] {
  const detail = findDetail(builds, championId);
  if (!detail) return EMPTY_BUILD;
  const v = championBuild({
    detail,
    items: dataset?.items ?? [],
    limit: 3,
  });
  return {
    start: slotMsg(v.start),
    shoes: slotMsg(v.shoes),
    core: slotMsg(v.core),
  };
}

// ---------------------------------------------------------------------------
// LCU 轮询 → 推送状态
// ---------------------------------------------------------------------------

function championName(id: number): string {
  return dataset?.champions.find((c) => c.id === id)?.name ?? (id > 0 ? `#${id}` : '—');
}

async function pollOnce(): Promise<void> {
  let connected = false;
  let phase = 'None';
  let session: unknown = null;
  let picks: OverlayStateMsg['picks'] = [];
  /**
   * 本轮的**阶段读数**：`null` = "这一轮读不到"（**不是**"不在对局"）。
   *
   * 只有两种东西能写出确定的阶段：**读到的会话**（`s.phase`）与
   * **确定的没有会话**（404/400）。凭证探测失败、超时、网络抖动、5xx、
   * 鉴权失效都只能写 `null` —— 交给阶段门保持上一阶段（见 `stageGate`）。
   */
  let stageSample: string | null = null;

  if (!client) {
    const res = await detectCredentialsDetailed().catch(() => null);
    if (res?.credentials) {
      client = new LcuClient(res.credentials);
      console.log(`[hexbox] LCU 已连接 (port ${res.credentials.port}, ${res.detail})`);
      credsDetail = '';
    } else if (!warnedNoCreds) {
      // 凭证探测失败是「悬浮窗永不出现」最常见的原因，必须显式报出来，
      // 否则表现为「程序在跑但什么都不显示」，极难排查。
      warnedNoCreds = true;
      const running = res?.clientRunning ?? false;
      const detail = res?.detail ?? '探测未返回结果';
      credsDetail = detail;
      const hint = running
        ? [
            '[hexbox] 检测到英雄联盟客户端，但读不到 LCU 凭证。',
            `         探测详情: ${detail}`,
            '         排查顺序（逐项尝试，不必全部满足）：',
            '           1. 确认本工具以**管理员身份**运行（否则读不到进程命令行）',
            '           2. 若已用管理员仍失败：客户端可能是 WeGame 启动，',
            '              其 lockfile 常为 0 字节 —— 属已知现象，',
            '              此时令牌只能从进程命令行获取',
            '           3. 完全退出客户端（含 WeGame 托盘）后重启，再启动本工具',
          ].join('\n')
        : [
            '[hexbox] 未检测到英雄联盟客户端。',
            `         探测详情: ${detail}`,
            '         请先启动客户端（含 WeGame）进入大厅，再启动本工具。',
          ].join('\n');
      console.warn(hint);
    }
    // ⚠️ 凭证**读不到**也只是"这一轮不知道阶段"，不是"不在对局"：
    // 探测要读客户端进程命令行（WMI/PowerShell），真机上偶发失败过；
    // 旧实现会让 `phase` 保持 `'None'` → 一次探测失败 = 清掉整排强度标签 + 停链路。
    stageSample = null;
  }

  if (client) {
    // ⚠️ 三种结果必须分开（真机缺陷 2026-10-06：一次偶发失败清掉整排强度标签）：
    //   · 读到会话            → `stageSample = 会话里的 phase`；
    //   · **确实没有会话**（404/400，大厅里这是正常的）→ `'None'`；
    //   · **读失败**（5 秒超时 / 网络抖动 / 5xx / 鉴权失效）→ `null`
    //     = "这一轮不知道"，交给阶段门**保持**上一阶段。
    // 旧实现用 `getOrNull()`，它把 404 与 5xx **一起**变成 null，调用方再写成
    // `'None'` —— 那正是"读不到 = 不在对局"这个错误的来源（超时也会走到这里）。
    let s: {
      phase?: string;
      map?: { gameMode?: string };
      gameData?: { queue?: { id?: number } };
    } | null = null;
    try {
      const read = await client.get<{
        phase?: string;
        map?: { gameMode?: string };
        gameData?: { queue?: { id?: number } };
      }>('/lol-gameflow/v1/session');
      s = read;
      // ⚠️ 读到了会话、但 `phase` 字段不可用 → **`null`（这一轮不知道）**，
      // 不能写成 `'None'`：`'None'` 是"**确定的**不在对局"，连续两次就会确认离开
      // → 停链路 + 清整排标签（而面板可能还开着）。判定在纯函数
      // `stageSampleFromSession()`（`@hexbox/vision`，有单测）里。
      const read_sample = stageSampleFromSession(read);
      stageSample = read_sample.sample;
      if (stageSample === null && s !== null) {
        console.warn(`[hexbox] ⚠ ${read_sample.reason}`);
      }
    } catch (err) {
      if (err instanceof LcuHttpError) {
        if (err.isAuthFailure) {
          console.warn('[hexbox] LCU 鉴权失败，凭证可能已失效，将重新探测');
          client = null;
          warnedNoCreds = false; // 允许重新提示
          credsDetail = '';
          stageSample = null; // 读失败：这一轮不知道阶段（不是"不在对局"）
        } else if (err.status === 404 || err.status === 400) {
          // 当前没有对局会话 —— 这是**确定的**"不在对局"，不是故障
          stageSample = 'None';
        } else {
          console.warn(`[hexbox] LCU 会话查询异常（HTTP ${err.status}）：保留凭证，下轮再试`);
          stageSample = null;
        }
      } else {
        // 网络抖动/客户端正在关停（含 5 秒超时）：保留 client，下轮再试
        console.warn('[hexbox] LCU 会话查询异常:', err instanceof Error ? err.message : err);
        stageSample = null;
      }
    }

    if (s) {
      connected = true;
      session = s;
    } else if (client) {
      // 有凭证但没读到会话 —— 客户端是活的（或这一轮读失败），UI 不该显示诊断面板
      connected = true;
    }
  }

  // ── 阶段门（**两条入口都要过**：读到会话 / 读失败 / 连凭证都没有）────────
  // 读取失败保持上一阶段；"离开对局"要连续 N 次才认（见 `stageGate` 与
  // docs/AUGMENT-PANEL.md §十六 7）。
  //
  // ⚠️ **门的每一次结论都要有日志**（2026-10-06 真机复盘）：
  // 旧代码只在 `held && 本来在局内` 时打印，于是"疑似离开 1/2 → 保持 InProgress"
  // 之后**第 2 次确认离开那一轮是静默的** —— 日志上一行还在"保持 InProgress"，
  // 下一行却是"阶段换手（augment → none）+ 链路停止（离开对局）"，看起来
  // **自相矛盾**（实际是门的第二轮结论，只是没打）。现在：门给出的
  // `stage` 或"是否在局内"一变就打一行（同一句不重复）。
  const gated = stageGate.push(stageSample);
  const wasInGame = AUGMENT_CHAIN_PHASES.includes(phase);
  const nowInGame = AUGMENT_CHAIN_PHASES.includes(gated.stage);
  if (
    gated.reason !== lastStageGateReason &&
    (gated.held || gated.stage !== lastStageGateStage || wasInGame !== nowInGame)
  ) {
    const mark = gated.held ? '⚠ 保持' : nowInGame ? '✔ 采纳' : '✔ 采纳（离开对局）';
    console.warn(`[hexbox] ${mark} ${gated.reason}`);
  }
  lastStageGateReason = gated.reason;
  lastStageGateStage = gated.stage;
  phase = gated.stage;

  if (client) {
    // 选人阶段：读取我方已选英雄（pregame-visible）—— 会话本身留给下面的身份解析
    let champSelectSession: unknown = null;
    if (phase === 'ChampSelect' && client) {
      const cs = await client
        .get<{
          myTeam?: Array<{ championId?: number; cellId?: number }>;
          localPlayerCellId?: number;
          /** 选人动作：外层是回合，内层是本回合各玩家的动作。 */
          actions?: Array<
            Array<{ actorCellId?: number; type?: string; completed?: boolean }>
          >;
        }>('/lol-champ-select/v1/session')
        .catch(() => null);
      champSelectSession = cs;
      const team = cs?.myTeam ?? [];
      picks = team
        .filter((m) => typeof m.championId === 'number' && m.championId > 0)
        .map((m) => ({
          championId: m.championId as number,
          name: championName(m.championId as number),
        }));

      // 两个子阶段的判据（用户确认的流程）：
      //   第一阶段：卡片已发出、还没选 → 卡片下方显示胜率
      //   第二阶段：选中后未选的英雄进顶栏 → 顶栏逐格显示，且不再画卡片标签
      // 用「我方 pick 动作是否 completed」判定，比像素占用可靠得多。
      const localCell = cs?.localPlayerCellId;
      const acts = (cs?.actions ?? []).flat();
      if (acts.length === 0 || typeof localCell !== 'number') {
        champSelectPickState = 'unknown';
      } else {
        const done = acts.some(
          (a) =>
            a.type === 'pick' &&
            a.completed === true &&
            (typeof localCell !== 'number' || a.actorCellId === localCell),
        );
        champSelectPickState = done ? 'locked' : 'picking';
      }
    }

    // ── 「我这局用哪个英雄」：以"我自己"为唯一权威来源 ──────────────────
    //
    // ⚠️ 真机 bug（2026-10-05，两处都错在同一个念头"随便取一个 championId"）：
    //   旧实现在选人会话里匹配不到 `localPlayerCellId` 时**取 myTeam 里第一个
    //   有 championId 的人**；局内又去 gameflow 的 **10 人队伍列表**里有界搜索
    //   `championId`。结果：玩无极剑圣解析出 154（生化魔人 Zac）、玩酒桶解析出
    //   43（天启者 Karma）—— 都是**队友**，于是整局显示别人英雄的强度表。
    //
    // 现在只认（纯函数 + 单测在 @hexbox/lcu 的 champion-identity.ts）：
    //   activePlayer-raw → activePlayer-name → lcu-champsession → gameflow-self
    // 全都不确定 → **不显示**（宁缺勿错），并打印具体原因。
    if (client && myChampionId === 0 && (phase === 'ChampSelect' || phase === 'InProgress')) {
      // 身份读不到就**不缓存空值**（客户端刚起/正在关停时读不到是常见的），下一轮再试。
      if (selfIdentity === null) {
        const read = await readSelfIdentity(client).catch(() => ({}));
        if (hasSelfIdentity(read)) selfIdentity = read;
      }
      // 只在换成有效值时更新，**不要**在这里清空：
      // 选人会话在对局开始后就没了，若离开选人时置 0，局内就永远认不出英雄（真机踩过）。
      const identity = await resolveMyChampionIdentity(client, {
        champions: dataset?.champions ?? [],
        live: phase === 'InProgress' ? liveClient() : null,
        champSelect: champSelectSession,
        // `session` = 本轮**读到的** gameflow 会话（读失败时为 null：
        // 身份解析的 gameflow 通道自己会放弃，不会拿旧会话猜英雄）
        gameflow: session,
        me: selfIdentity ?? {},
      });
      if (identity.championId > 0) {
        myChampionId = identity.championId;
        console.log(
          `[hexbox] 本局英雄 #${identity.championId} ${identity.championName || '(图鉴无此 ID)'}` +
            `（来源 ${identity.source}：${identity.reason}）`,
        );
      } else {
        console.warn(`[hexbox] 未能确定本局英雄（${identity.reason}）→ 不显示该英雄数据`);
      }
    }

    // 完全离开对局后清空，避免把上一局的英雄带到下一局
    if (!IN_GAME_PHASES.has(phase) && phase !== 'ChampSelect') {
      myChampionId = 0;
    }
  }

  // 可见性随「阶段 + 连接状态」自动切换（不抢焦点）
  //
  // ⚠️ 必须比较**两份判定结果**而不是只比较 phase：
  //   注释一直写着「连不上时必须也把窗口显示出来」（否则用户看到的是
  //   「什么都没有」，无法区分「没在对局」和「根本连不上客户端」），
  //   但原实现写成 `if (phase !== lastPhase)`，于是**中途掉线**时
  //   （connected 由 true→false、phase 可能仍停在非对局值）不会再应用一次，
  //   诊断面板只在冷启动时出现过一次 —— 真实 bug，已由 visibility.ts 的
  //   单测锁住。判定逻辑本身是纯函数，放在 CI 覆盖得到的包里。
  const want = decideVisible(phase, connected);

  // ── 画布归属：选人胜率标签 vs 局内海克斯标签（同一块画布，绝不同时写）──
  //
  // 判定全在纯函数 `labelProducerFor()` 里（各阶段 / 面板开与关 / 阶段切换瞬间 /
  // 未知阶段 / 降级开关都有单测）。这里只做两件事：
  //   ① 换手时立刻清掉对方遗留的标签（**复用现成的 clearLabelOverlay()**，
  //      不新写一套清空逻辑）—— 真实场景：上一局面板还开着时对局结束，
  //      局内字母会一直挂在屏幕上；"确认离开对局"也是靠这里清空的；
  //   ② 打印一行归属日志（真机排查"谁把标签盖掉了"只看它）。
  //
  // ⚠️ 这是局内强度标签**仅有的两个"阶段驱动"清空**之一（另一个是控制器内部的
  // 面板关闭边沿）：链路的启停**不再清标签**（2026-10-06 真机缺陷的修法 ——
  // 改前 `stop()` 无条件清，面板还开着也会被抹掉，表现是"标签闪一下就没了"）。
  //
  // ⚠️ 这一步**不能**只在 `sameVisibleState()` 变化时做：大厅 ⇄ 对局的
  // `VisibleState` 完全相同（局内也不要侧边窗），归属却变了。
  lastPhase = phase;
  const ownership = labelProducerFor(phase, augment?.panelState ?? 'unknown', lastLabelProducer, {
    augmentEnabled: AUGMENT_ENABLED,
  });
  if (ownership.handover) {
    const from = lastLabelProducer ?? 'none';
    // 与控制器用**同一行格式**（`vision/augment-clear.ts`）：用户 grep
    // `🧹 清空强度标签：原因=` 就能看到每一次清空（含这一处换手）。
    const detail = `${from} → ${ownership.producer}；面板在屏=${ownership.shouldDraw}`;
    clearLabelOverlay(overlayWin, detail);
    console.log(`[hexbox] ${augmentClearLogLine(AUGMENT_CLEAR_REASONS.stageHandover, detail)}`);
  }
  lastLabelProducer = ownership.producer;

  // 局内海克斯链路的启停（与上面的归属判定分开：一个是"谁能画"，一个是"跑不跑"）
  applyAugmentChain(phase);

  if (!sameVisibleState(lastVisible, want)) {
    lastVisible = want;
    if (win) {
      if (want.showPanel) {
        win.showInactive();
        await positionOverlay();
      } else {
        win.hide();
      }
    }
    // S2 覆盖层与视觉循环：仅选人阶段启用
    if (want.visionActive) {
      overlayWin?.showInactive();
      visionLoop?.start();
    } else {
      visionLoop?.stop();
      overlayWin?.hide();
    }
  }

  const msg: OverlayStateMsg = {
    connected,
    phase,
    gameMode:
      typeof (session as { map?: { gameMode?: string } } | null)?.map?.gameMode === 'string'
        ? (session as { map: { gameMode: string } }).map.gameMode
        : '—',
    queueId:
      (session as { gameData?: { queue?: { id?: number } } } | null)?.gameData?.queue?.id ?? null,
    isBrawl: isBrawlSession(session as Parameters<typeof isBrawlSession>[0]),
    picks,
    clickThrough,
    me: buildMeMsg(myChampionId),
    augments: myChampionId > 0 ? buildAugmentMsg(myChampionId) : [],
    build: myChampionId > 0 ? buildBuildMsg(myChampionId) : EMPTY_BUILD,
    meta: {
      dataDate: builds?.meta.dataDate ?? rankings?.meta.dataDate ?? '',
      hasBuilds: hasBuildData(builds),
    },
    credsDetail,
  };

  if (win && !win.isDestroyed()) {
    win.webContents.send('overlay:state', msg);
  }
}

async function pollLoop(): Promise<void> {
  for (;;) {
    try {
      await pollOnce();
    } catch (e) {
      console.warn('[hexbox] poll error:', e instanceof Error ? e.message : e);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

function createWindow(): void {
  win = new BrowserWindow({
    width: 340,
    height: 560,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    focusable: false, // 不抢焦点，否则游戏丢输入
    skipTaskbar: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    show: false, // 由阶段驱动显示
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(clickThrough, { forward: true });

  // 路径口径（S2 真机教训,勿改）:
  //   esbuild outbase=src → __dirname = dist/main
  //   preload   = dist/preload/index.cjs  = join(__dirname, '..', 'preload')
  //   renderer  = dist/renderer/*.html    = join(__dirname, '..', 'renderer')
  void win.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
}

/**
 * preload 绝对路径。
 *
 * ⚠️ dist 结构（S2 教训,勿改）: esbuild outbase=src 打包后
 * __dirname = dist/main,因此:
 *   preload  = dist/preload  = join(__dirname, '..', 'preload')
 *   renderer = dist/renderer = join(__dirname, '..', 'renderer')
 * 任何一层写成 join(__dirname, 'preload') 都会解析到
 * dist/main/preload（不存在）→ "Unable to load preload script" →
 * window.overlay 未定义 → 两个窗口都收不到推送（真机踩过两次）。
 */
const PRELOAD_PATH = join(__dirname, '..', 'preload', 'index.cjs');

/**
 * S2 覆盖窗口：全屏透明、点击穿透、绝不抢焦点。
 *
 * 窗口创建/定位/推送已抽到 `main/label-overlay.ts` —— **局内海克斯标签
 * （S5.4c，`debug-augment.ts`）用的是同一份**：一处创建、两处使用，
 * 免得两条并行的窗口代码各自漂移（`__dirname`/DPI/显示器定位都是踩过的坑）。
 *
 * ⚠️ 游戏可能不在主显示器 —— 窗口必须放在**游戏所在的显示器**上
 * （display 参数由 vision-loop 每轮回报,坐标错位时先查这里）。
 */
function createOverlayWindow(): void {
  overlayWin = createLabelOverlay({
    display: screen.getPrimaryDisplay(),
    // 主入口的 preload 路径是确定的（见上方 PRELOAD_PATH 的注释），显式传入
    preload: PRELOAD_PATH,
  });
  // 渲染端的错误（preload 失败、JS 异常）默认不可见 —— 这层转发是"覆盖层空白"
  // 类问题的唯一观察窗口（真机教训）。实现与局内标签共用一份。
  attachLabelOverlayDiagnostics(overlayWin, 'overlay:renderer');
}

function pushOverlayVision(msg: VisionOverlayMsg, display: Electron.Display): void {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  // 定位（可能换显示器）+ 显示 + 推送，全在 label-overlay 里（与局内海克斯标签同一份）
  pushLabelOverlay(overlayWin, display, msg);
  // 诊断: 覆盖层空白时,从主进程日志判断是「没推送」还是「推送了没画」
  console.log(
    `[hexbox:vision] 推送 active=${msg.active} labels=${msg.labels.length}` +
      (msg.labels[0]
        ? ` 首标签@(${msg.labels[0].x.toFixed(0)},${msg.labels[0].y.toFixed(0)}) ${msg.labels[0].text}`
        : '') +
      (msg.diag ? ` [${msg.diag}]` : ''),
  );
}

/* ------------------------------------------------------------------ */
/* 局内海克斯链路（S5.4d）：与录制工具同一份控制器，这里只做启停与注入      */
/* ------------------------------------------------------------------ */

/**
 * 局内海克斯标签的**推送器**（控制器唯一的绘制出口）。
 *
 * `overlayWin` 就是选人标签那块画布 —— **一处创建、两处使用**：局内标签
 * 绝不再建一块平行窗口（`label-overlay.ts` 里的 `__dirname`/DPI/显示器定位
 * 每个都是踩过的坑）。`prepare()` 不需要：这块画布启动时就建好了。
 *
 * ⚠️ 画布的显隐由 `pushLabelOverlay()` 保证（首次推送会 `showInactive()` +
 * 重申置顶）；主进程这边不再重复管它 —— 两个生产者都只往同一条通道推。
 */
const augmentLabelSink: AugmentLabelSink = {
  push: (msg, display) => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    pushLabelOverlay(overlayWin, display, msg);
    console.log(
      `[hexbox:augment] 推送 active=${msg.active} labels=${msg.labels.length}` +
        (msg.labels[0]
          ? ` 首标签@(${msg.labels[0].x.toFixed(0)},${msg.labels[0].y.toFixed(0)}) ${msg.labels[0].text}` +
            (msg.labels[0].sub !== '' ? `「${msg.labels[0].sub}」` : '')
          : '') +
        (msg.diag ? ` [${msg.diag}]` : ''),
    );
  },
  clear: (why) => {
    clearLabelOverlay(overlayWin, why);
  },
};

/** 懒建控制器（构造很轻；真正建流的是 `start()`）。 */
function ensureAugmentController(): AugmentController {
  if (augment) return augment;
  augment = new AugmentController({
    dataDir: resolveDataDir(),
    // `HEXBOX_AUGMENT_DRAW=0` → 不画（只识别 + 打日志），与录制工具同一个语义
    labels: AUGMENT_DRAW ? augmentLabelSink : undefined,
    // 常驻覆盖层启动时已经读过图鉴与英雄详情（builds.json 4.5MB）—— 复用，
    // 不再读一遍大盘；两者都拿不到时控制器会自己去 dataDir 读。
    loadData: async () => ({ dataset, builds }),
    // ⚠️ 常驻覆盖层**固定 api 触发**（用户 2026-10-05 的方案）：
    // 常态**一帧不取**，只在「死亡 + 等级达标 + 该次未选」时开截屏。
    // 录制工具保留 `HEXBOX_AUGMENT_TRIGGER` 的 pixel 对照路径。
    trigger: 'api',
    // api 模式只在"已知确实在对局中"时计 2999 的失败（进游戏前一定没有 2999）
    inMatch: () => AUGMENT_CHAIN_PHASES.includes(lastPhase),
  });
  return augment;
}

/**
 * 阶段 → 局内链路启停。
 *
 * ⚠️ "什么时候起、什么时候停"本身是**纯函数**（`augmentChainTransition()`，有单测）：
 * 局内只起一次、离开立刻停、在途启动**只作废自己那一代**、失败本局不重试。
 * 这里只负责执行动作 + 把状态存回去 —— 主进程里**不写第二份启停判断**。
 *
 * ⚠️ 停止**不再清标签**（真机缺陷 2026-10-06 的修法）：标签的生命周期只由
 * 「面板关闭边沿」与「确认离开对局（本轮画布换手 → `clearLabelOverlay()`）」
 * 决定。这样即使链路因为任何原因停掉，**面板还开着**时标签也不会被抹掉
 *（代价：极端边界下可能多留一个轮询周期，见 docs/AUGMENT-PANEL.md §十六 6）。
 */
function applyAugmentChain(stage: string): void {
  const t = augmentChainTransition(augmentState, augmentSession, stage, {
    augmentEnabled: AUGMENT_ENABLED,
  });
  augmentSession = t.generation;
  augmentState = t.state;

  if (t.action === 'stop') {
    // 离开对局：停流 + 丢行基准锁与重随基线（控制器内部一次做完，幂等）。
    // ⚠️ 令牌 = **要作废的那一代**：期间若已经起了新一代，这条请求会被忽略
    //（绝不允许旧一代的收工把新一代的流一起收掉）
    augment?.stop('离开对局', { token: t.token });
    return;
  }
  if (t.action !== 'start') return;

  const controller = ensureAugmentController();
  const token = t.token;
  console.log(
    `[hexbox] 进入对局（${stage}）→ 启动局内海克斯链路（常态零取帧：API 触发 + 常驻屏幕流）`,
  );
  void controller
    .start(token)
    .then((state) => {
      if (augmentStartIsStale(token, augmentSession)) {
        // 这一代已经作废（期间确认离开又回来 / 退出）：**什么都不做**。
        // 它自己的屏幕流已由控制器在每个 await 检查点按令牌收干净。
        console.log(
          `[hexbox] ⏹ 忽略已作废的启动结果（令牌 ${token} ≠ 当前会话 ${augmentSession}）` +
            ' —— 不碰当前会话的流与标签',
        );
        return;
      }
      if (state === 'stream') {
        augmentState = 'running';
        console.log('[hexbox] 局内海克斯链路已就绪（面板开边沿才取帧；关闭边沿立刻清空标签）');
        return;
      }
      augmentState = 'failed';
      console.warn(
        '⚠ 局内海克斯链路未能启动（常驻屏幕流不可用，详见上面带 ⚠ 的日志）\n' +
          '         → 本局只显示选人标签；下一局会重试',
      );
      controller.stop('屏幕流不可用', { token });
    })
    .catch((e: unknown) => {
      if (augmentStartIsStale(token, augmentSession)) return;
      augmentState = 'failed';
      console.warn('[hexbox] 局内海克斯链路启动异常：', e instanceof Error ? e.message : e);
      // 控制器内部已兜住异常（返回 unavailable），这里是双保险：
      // 绝不允许异常之后还留着一条在跑的屏幕流
      controller.stop('启动异常', { token });
    });
}

function applyClickThrough(on: boolean): void {
  clickThrough = on;
  win?.setIgnoreMouseEvents(on, { forward: true });
  win?.webContents.send('overlay:click-through', on);
}

function registerIpc(): void {
  ipcMain.handle('overlay:set-click-through', (_e, on: unknown) => {
    applyClickThrough(Boolean(on));
    return clickThrough;
  });
  ipcMain.handle('overlay:close', () => app.quit());
}

app.whenReady().then(() => {
  // 注意：**不要**在这里全局设置 NODE_TLS_REJECT_UNAUTHORIZED。
  // LcuClient 内部已用 withInsecureTls() 按请求豁免自签证书，
  // 全局关闭会顺带让所有其它 HTTPS 请求（含外部数据源）失去校验。

  // ── 覆盖窗自测（`HEXBOX_LABEL_OVERLAY_TEST=1`）────────────────────────
  // 不需要游戏、不需要 LCU：直接在屏幕上画左/中/右三个大字母并自动退出。
  // 用途：把"局内标签画了但看不见"的**窗口可见性**单独隔离出来验证
  // （见 main/label-selftest.ts 与 apps/overlay/README.md）。
  if (isLabelOverlaySelfTest()) {
    runLabelOverlaySelfTest();
    return;
  }

  registerIpc();
  createWindow();
  createOverlayWindow();
  void loadDataset();
  void loadNameLibrary();
  visionLoop = new VisionLoop({
    // getter 形式:指纹/榜单是异步加载的,每轮识别取最新值
    nameLibrary: () => nameLibrary,
    portraits: () => portraits,
    rankings: () => rankings,
    championName: (id) => championName(id),
    // 识别可能给出 60000+ 的高 ID，而排行榜/LCU 用基础 ID —— 归一化后再 join
    canonicalId: (id) => canonicalChampionId(id, dataset?.champions ?? []),
    pickState: () => champSelectPickState,
    onResult: pushOverlayVision,
  });
  void pollLoop();

  setInterval(() => void positionOverlay(), 3000);
  screen.on('display-metrics-changed', () => void positionOverlay());

  // 冒烟测试模式：4 秒后自动退出（用于 CI/验证，不弹窗打扰）
  if (process.env['HEXBOX_SMOKE'] === '1') {
    setTimeout(() => app.quit(), 4000);
  }
});

/**
 * 加载名字指纹库（OCR 阶段 1）。
 * 读不到不阻断 —— 视觉循环会降级为「定位成功但识别不出」。
 */
async function loadNameLibrary(): Promise<void> {
  try {
    // 与 loadDataset 共用同一份路径解析 —— 两处各算一次正是"读错目录"的温床
    const dataDir = resolveDataDir();
    const encoded = await readTemplates(dataDir);
    if (!encoded) {
      console.warn(`[hexbox] 无模板包 (${dataDir})，请运行 pnpm templates —— 覆盖层将无法识别英雄`);
      return;
    }
    const pack = decodePack(encoded);
    nameLibrary = (pack.names ?? []).map((n) => ({
      championId: n.championId,
      name: n.name,
      width: n.width,
      height: n.height,
      bits: base64ToBits(n.bits, n.width * n.height),
    }));
    // ⚠️ 曾经这里过滤掉所有 60000+ 的模板，理由是"变体 ID、join 不到数据"。
    // 真机核实后是**错的**：模板包 245 条里有 **72 条是同一英雄的变体条目**
    // （60001 = `Jade_Annie` 黑暗之女、60002 = `Jade_Olaf` 狂战士…，第二套 ID），
    // 它们与真实英雄**共用同一个名字**，过滤一次就会让这 72 条模板永远匹配不到
    // （第二阶段顶栏识别不出）。同一位英雄的两套编号问题应该在 **ID 归一化**
    // （core/canonicalChampionId）里解决，而不是丢模板。
    const realPortraits = pack.templates.filter((t) => t.championId > 0);
    const skipped = pack.templates.length - realPortraits.length;
    portraits = prepareTemplates(
      realPortraits.map((t) => ({
        championId: t.championId,
        size: t.size,
        gray: denormalizeToGray(t.norm, t.size),
      })),
    );
    console.log(
      `[hexbox] 名字指纹 ${nameLibrary.length} 个 / 头像模板 ${portraits.length} 个已加载` +
        (skipped > 0 ? `（跳过 ${skipped} 个非法 ID）` : ''),
    );
  } catch (e) {
    console.warn('[hexbox] 名字指纹加载失败:', e instanceof Error ? e.message : e);
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/**
 * 退出前把局内链路收干净（S5.4d 的硬要求）。
 *
 * 关闭覆盖层时**不许留下**：屏幕流（隐藏 worker 窗口 + 正在跑的门控定时器）、
 * 还在屏上的标签（透明画布本身不抢焦点、点击穿透，但内容要清掉）。
 * `AugmentController.stop()` 一次做完这些事（停流 + 销毁 worker 窗口 +
 * 丢行基准锁/重随基线），而且**幂等** —— 所以退出路径可以放心调。
 *
 * ⚠️ 标签是**显式**要求才清的（`{ clearLabels: true }`）：局内正常的"离开对局"
 * 停止**不清标签**（清空由面板关闭边沿 / 阶段换手负责，见
 * `vision/augment-clear.ts` 的 `augmentStopClearsLabels()`）。退出是少数几个
 * "明确要清"的地方 —— 窗口马上销毁，不留残留字母。
 *
 * 为什么放在 `before-quit` 而不是只靠 `window-all-closed`：用户也可能从
 * 侧边面板的关闭按钮（IPC `overlay:close` → `app.quit()`）或冒烟模式退出，
 * 这些都走 `before-quit`。
 */
app.on('before-quit', () => {
  try {
    // 令牌前移：任何在途启动的回调都会被判为过期（它们只自己收场，不碰当前会话）
    augmentSession++;
    augmentState = 'idle';
    // ⚠️ 这里是**少数几个明确要求清标签**的地方之一（窗口马上销毁，
    // 不留残留字母）；局内正常的"离开对局"停止**不清标签**
    augment?.stop('程序退出', { clearLabels: true });
  } catch {
    /* 退出路径里不再抛 */
  }
});
