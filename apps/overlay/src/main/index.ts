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

import { app, BrowserWindow, ipcMain, screen, type Rectangle } from 'electron';
import { join } from 'node:path';

import { findGameWindowRect } from '@hexbox/vision';
import {
  LcuClient,
  LcuHttpError,
  detectCredentialsDetailed,
  detectPortByListener,
  isBrawlSession,
  pickChampionIdFromGameflow,
} from '@hexbox/lcu';
import { readBuilds, readDataset, readRankings, readTemplates } from '@hexbox/data-store';
import {
  base64ToBits,
  decodePack,
  denormalizeToGray,
  prepareTemplates,
  type NameFingerprint,
  type PreparedTemplate,
} from '@hexbox/vision';
import {
  augmentStrength,
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
let lastPhase: string | null = null;
let clickThrough = true;
let warnedNoCreds = false;
let credsDetail = '';
/** 本次选人中「我」选的英雄（0 = 未知）。 */
let myChampionId = 0;
/** S2 视觉循环（选人阶段启用）。 */
let visionLoop: VisionLoop | null = null;
/** 名字指纹库（视觉循环用）。 */
let nameLibrary: NameFingerprint[] = [];
/** 头像模板（确认阶段识别用）。 */
let portraits: PreparedTemplate[] = [];

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
    full: BuildSlotMsg[];
  };
  /** 数据出处（来源 + 统计日期）。 */
  meta: { dataDate: string; hasBuilds: boolean };
  credsDetail: string;
}

const EMPTY_BUILD = { start: [], shoes: [], core: [], full: [] };

/* ------------------------------------------------------------------ */
// 游戏窗口定位（只读窗口几何信息）
// ---------------------------------------------------------------------------

// findGameWindowRect 已抽取到 @hexbox/vision（win-geometry.ts），
// 与 debug-capture 共用同一份实现 —— 两处各写一份必然漂移。
// 它同样只调用 user32!GetWindowRect 读取几何信息，不触碰进程内存。

function computeOverlayBounds(game: Rectangle | null, display: Rectangle): Rectangle {
  // 高度按内容量加大：局内要放强度榜 + 出装
  const WIDTH = 340;
  const HEIGHT = 560;
  const MARGIN = 16;

  if (!game) {
    return {
      x: display.x + display.width - WIDTH - MARGIN,
      y: display.y + Math.round((display.height - HEIGHT) / 2),
      width: WIDTH,
      height: HEIGHT,
    };
  }
  return {
    x: Math.min(game.x + game.width - WIDTH - MARGIN, display.x + display.width - WIDTH),
    y: Math.max(game.y + MARGIN, display.y),
    width: WIDTH,
    height: HEIGHT,
  };
}

async function positionOverlay(): Promise<void> {
  if (!win || !win.isVisible()) return;
  const game = await findGameWindowRect();
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  win.setBounds(computeOverlayBounds(game, display.workArea));
}

// ---------------------------------------------------------------------------
// 数据
// ---------------------------------------------------------------------------

async function loadDataset(): Promise<void> {
  // electron . 的 cwd 是 apps/overlay，数据在仓库根的 data/
  const envDir = process.env['HEXBOX_DATA_DIR'];
  const dir = envDir ?? join(app.getAppPath(), '..', '..', 'data');

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
 * 对局中兜底识别「我的英雄」。
 *
 * 背景：选人会话（`/lol-champ-select/v1/session`）在进入对局后即消失，
 * 因此**冷启动直接进对局**（悬浮窗中途打开、或没经历选人）时会拿不到英雄。
 * 这里按可靠性依次尝试几个官方 LCU 端点：
 *
 *   1. `/lol-champ-select/v1/session` —— 选人尚未完全结束时仍可用
 *   2. `/lol-gameflow/v1/session`     —— 部分版本在对局内带 `championId`
 *   3. `/lol-summoner/v1/current-summoner` —— 仅作诊断，不含英雄
 *
 * ⚠️ 已知局限：这些端点在**国服对局内**是否稳定返回英雄，未经真机验证
 * （CI/无管理员环境无法复现）。因此：
 *   - 任一步失败都只是继续下一步，不抛错；
 *   - 全部失败时返回 0，UI 显示「未识别到你的英雄」而不是猜一个。
 *
 * 正常情况下**不依赖**本函数：只要经历过选人阶段，myChampionId 已被记住。
 */
async function recoverMyChampionId(client: LcuClient): Promise<number> {
  // 1) 选人会话（可能仍存在）
  const cs = await client
    .get<{
      myTeam?: Array<{ championId?: number; cellId?: number }>;
      localPlayerCellId?: number;
    }>('/lol-champ-select/v1/session')
    .catch(() => null);
  if (cs) {
    const me = (cs.myTeam ?? []).find((m) => m.cellId === cs.localPlayerCellId);
    if (typeof me?.championId === 'number' && me.championId > 0) return me.championId;
    const any = (cs.myTeam ?? []).find(
      (m) => typeof m.championId === 'number' && m.championId > 0,
    );
    if (any?.championId) return any.championId;
  }

  // 2) 游戏流会话（不同版本字段位置不一，这里广泛探测）
  const gf = await client
    .get<Record<string, unknown>>('/lol-gameflow/v1/session')
    .catch(() => null);
  const fromGf = pickChampionIdFromGameflow(gf);
  if (fromGf > 0) return fromGf;

  return 0;
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
    full: slotMsg(v.full),
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
  }

  if (client) {
    // 用 getOrNull：大厅里 `/lol-gameflow/v1/session` 返回 404 是**正常**的
    // （当前没有对局），不能当成故障。
    //
    // ⚠️ 这里原先是 `.catch(() => null)` + `else { client = null }`，
    // 于是大厅里每轮轮询都会把**有效凭证**丢掉，下一轮重新探测凭证；
    // 一旦探测失败就显示「读不到 LCU 凭证」—— 表现为「没进对局时一直报读不到凭证，
    // 进选人后又正常」（真实踩过）。
    // 现在：只有**鉴权失败**才丢弃凭证，其它情况一律视为「当前无对局」。
    let s: {
      phase?: string;
      map?: { gameMode?: string };
      gameData?: { queue?: { id?: number } };
    } | null = null;
    try {
      s = await client.getOrNull('/lol-gameflow/v1/session');
    } catch (err) {
      // getOrNull 只在 401/403（或网络异常）时抛出
      if (err instanceof LcuHttpError && err.isAuthFailure) {
        console.warn('[hexbox] LCU 鉴权失败，凭证可能已失效，将重新探测');
        client = null;
        warnedNoCreds = false; // 允许重新提示
        credsDetail = '';
      } else {
        // 网络抖动/客户端正在关停：保留 client，下轮再试
        console.warn('[hexbox] LCU 会话查询异常:', err instanceof Error ? err.message : err);
      }
    }

    if (s) {
      connected = true;
      session = s;
      phase = String(s.phase ?? 'None');
    } else if (client) {
      // 有凭证但无对局会话 —— 客户端是活的，只是当前不在对局中。
      // 这**不是**错误，UI 应显示「未在对局中」而不是诊断面板。
      connected = true;
      phase = 'None';
    }

    // 选人阶段：读取我方已选英雄（pregame-visible）
    if (phase === 'ChampSelect' && client) {
      const cs = await client
        .get<{
          myTeam?: Array<{ championId?: number; cellId?: number }>;
          localPlayerCellId?: number;
        }>('/lol-champ-select/v1/session')
        .catch(() => null);
      const team = cs?.myTeam ?? [];
      picks = team
        .filter((m) => typeof m.championId === 'number' && m.championId > 0)
        .map((m) => ({
          championId: m.championId as number,
          name: championName(m.championId as number),
        }));

      // 找出「我」选的英雄：优先按 localPlayerCellId 定位。
      // 拿不到就退回「我方唯一的已选英雄」——选人早期往往只有自己选了。
      const me = team.find((m) => m.cellId === cs?.localPlayerCellId);
      const picked =
        typeof me?.championId === 'number' && me.championId > 0
          ? me.championId
          : picks.length === 1
            ? picks[0]!.championId
            : 0;

      // ⚠️ 只在拿到有效值时更新，**不要**在这里清空：
      // 选人阶段的会话在进入对局后就没了，若离开选人时把 myChampionId 置 0，
      // 局内就会永远显示「未识别到你的英雄」（真实踩过）。
      if (picked > 0) myChampionId = picked;
    } else if (phase === 'InProgress' && client && myChampionId === 0) {
      // 进对局后选人会话已消失，从游戏会话里补一次兜底。
      // 冷启动直接进对局（悬浮窗开着但没经历选人）时会走到这里。
      const recovered = await recoverMyChampionId(client).catch(() => 0);
      if (recovered > 0) myChampionId = recovered;
    }

    // 完全离开对局后清空，避免把上一局的英雄带到下一局
    if (!IN_GAME_PHASES.has(phase) && phase !== 'ChampSelect') {
      myChampionId = 0;
    }
  }

  // 可见性随阶段自动切换（不抢焦点）
  // 注意：连不上时必须也把窗口显示出来，否则用户看到的是「什么都没有」，
  // 无法区分「没在对局」和「根本连不上客户端」。连不上时显示诊断面板。
  const show = phase === 'ChampSelect' || phase === 'InProgress' || !connected;
  if (phase !== lastPhase) {
    lastPhase = phase;
    if (win) {
      if (show) {
        win.showInactive();
        await positionOverlay();
      } else {
        win.hide();
      }
    }
    // S2 覆盖层与视觉循环：仅选人阶段启用
    if (phase === 'ChampSelect') {
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
 * 与侧边悬浮窗的区别：它**铺满整个显示器**，内容按识别到的
 * 卡片屏幕坐标绝对定位（见 vision/card-overlay.ts）。
 *
 * ⚠️ 游戏可能不在主显示器 —— 窗口必须放在**游戏所在的显示器**上
 * （display 参数由 vision-loop 每轮回报,坐标错位时先查这里）。
 */
function createOverlayWindow(): void {
  const display = screen.getPrimaryDisplay();
  overlayWin = new BrowserWindow({
    x: display.workArea.x,
    y: display.workArea.y,
    width: display.workArea.width,
    height: display.workArea.height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // 覆盖层永远穿透 —— 它只展示,不接受任何输入
  overlayWin.setIgnoreMouseEvents(true, { forward: true });
  attachOverlayDiagnostics(overlayWin);
  void overlayWin.loadFile(join(__dirname, '..', 'renderer', 'overlay.html'));
}

/** 把覆盖窗口移动/缩放到指定显示器（游戏换屏时同步）。 */
function positionOverlayOn(display: Electron.Display): void {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const target = {
    x: display.workArea.x,
    y: display.workArea.y,
    width: display.workArea.width,
    height: display.workArea.height,
  };
  const cur = overlayWin.getBounds();
  if (
    cur.x !== target.x ||
    cur.y !== target.y ||
    cur.width !== target.width ||
    cur.height !== target.height
  ) {
    overlayWin.setBounds(target);
  }
  // 覆盖层内容按窗口内逻辑坐标绘制,窗口尺寸变化后画布要重设
  overlayWin.webContents.send('overlay:resize', {
    width: target.width,
    height: target.height,
  });
}

function pushOverlayVision(msg: VisionOverlayMsg, display: Electron.Display): void {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  positionOverlayOn(display);
  overlayWin.showInactive();
  overlayWin.webContents.send('overlay:vision', msg);
  // 诊断: 覆盖层空白时,从主进程日志判断是「没推送」还是「推送了没画」
  console.log(
    `[hexbox:vision] 推送 active=${msg.active} labels=${msg.labels.length}` +
      (msg.labels[0]
        ? ` 首标签@(${msg.labels[0].x.toFixed(0)},${msg.labels[0].y.toFixed(0)}) ${msg.labels[0].text}`
        : '') +
      (msg.diag ? ` [${msg.diag}]` : ''),
  );
}

/**
 * 把覆盖窗口渲染端的 console / 加载错误转发到主进程终端。
 * 渲染端的错误（preload 失败、JS 异常）默认不可见 —— 这层转发
 * 是"覆盖层空白"类问题的唯一观察窗口（真机教训）。
 */
function attachOverlayDiagnostics(win: BrowserWindow): void {
  const fwd = (label: string, text: string): void => {
    if (text.includes('Electron Security Warning')) return; // 噪音过滤
    console.log(`[overlay:renderer] ${label}: ${text}`);
  };
  win.webContents.on('console-message', (_e, _level, message) => fwd('console', message));
  win.webContents.on('preload-error', (_e, path, err) => fwd('preload-error', `${path}: ${err}`));
  win.webContents.on('did-fail-load', (_e, code, desc) => fwd('did-fail-load', `${code} ${desc}`));
  win.webContents.on('render-process-gone', (_e, details) =>
    fwd('render-process-gone', details.reason),
  );
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
    const dataDir = join(app.getAppPath(), '..', '..', 'data');
    const encoded = await readTemplates(dataDir);
    if (!encoded) {
      console.warn('[hexbox] 无模板包（pnpm templates 生成）—— 覆盖层将无法识别英雄');
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
    portraits = prepareTemplates(
      pack.templates.map((t) => ({
        championId: t.championId,
        size: t.size,
        gray: denormalizeToGray(t.norm, t.size),
      })),
    );
    console.log(
      `[hexbox] 名字指纹 ${nameLibrary.length} 个 / 头像模板 ${portraits.length} 个已加载`,
    );
  } catch (e) {
    console.warn('[hexbox] 名字指纹加载失败:', e instanceof Error ? e.message : e);
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
