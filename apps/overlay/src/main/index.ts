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
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  LcuClient,
  detectCredentialsDetailed,
  detectPortByListener,
  isBrawlSession,
} from '@hexbox/lcu';
import { readBuilds, readDataset, readRankings } from '@hexbox/data-store';
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

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// 悬浮窗状态
// ---------------------------------------------------------------------------

let win: BrowserWindow | null = null;
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

/**
 * 查询游戏客户端主窗口矩形。
 *
 * 只调用 user32!GetWindowRect 读取**几何信息**，
 * 不打开进程句柄、不读写内存。
 */
async function findGameWindowRect(): Promise<Rectangle | null> {
  const windir = process.env['windir'] ?? 'C:\\Windows';
  const ps = join(windir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

  // 注意：必须用 Add-Type -TypeDefinition 而不是 -MemberDefinition。
  // -MemberDefinition 会把 RECT 放进嵌套类型（Hexbox.WinApi+RECT），
  // `New-Object Hexbox.RECT` 找不到它 → GetWindowRect 静默失败 → 定位永远走兜底分支。
  const script = `
$src = @'
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)]
public struct HEXBOX_RECT { public int Left, Top, Right, Bottom; }
public static class HexboxWinApi {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out HEXBOX_RECT lpRect);
}
'@
Add-Type -TypeDefinition $src -ErrorAction SilentlyContinue
$proc = Get-Process -Name 'LeagueClientUx','League of Legends' -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { exit 0 }
$r = New-Object HEXBOX_RECT
[HexboxWinApi]::GetWindowRect($proc.MainWindowHandle, [ref]$r) | Out-Null
[PSCustomObject]@{ X=$r.Left; Y=$r.Top; W=($r.Right-$r.Left); H=($r.Bottom-$r.Top) } |
  ConvertTo-Json -Compress
`;

  try {
    const { stdout } = await execFileAsync(
      existsSync(ps) ? ps : 'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 8000 },
    );
    const text = stdout.trim();
    if (!text) return null;
    const o = JSON.parse(text) as { X?: number; Y?: number; W?: number; H?: number };
    if (typeof o.X === 'number' && typeof o.W === 'number' && o.W > 0 && (o.H ?? 0) > 0) {
      return { x: o.X, y: o.Y ?? 0, width: o.W, height: o.H ?? 0 };
    }
  } catch {
    /* 降级到默认位置 */
  }
  return null;
}

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
    const s = await client
      .get<{
        phase?: string;
        map?: { gameMode?: string };
        gameData?: { queue?: { id?: number } };
      }>('/lol-gameflow/v1/session')
      .catch(() => null);
    if (s) {
      connected = true;
      session = s;
      phase = String(s.phase ?? 'None');
    } else {
      client = null;
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
      myChampionId =
        typeof me?.championId === 'number' && me.championId > 0
          ? me.championId
          : picks.length === 1
            ? picks[0]!.championId
            : 0;
    } else {
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
      // __dirname 是 dist/main，preload/renderer 都是它的兄弟目录
      preload: join(__dirname, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(clickThrough, { forward: true });

  void win.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
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
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // LCU 自签名证书（官方要求）

  registerIpc();
  createWindow();
  void loadDataset();
  void pollLoop();

  setInterval(() => void positionOverlay(), 3000);
  screen.on('display-metrics-changed', () => void positionOverlay());

  // 冒烟测试模式：4 秒后自动退出（用于 CI/验证，不弹窗打扰）
  if (process.env['HEXBOX_SMOKE'] === '1') {
    setTimeout(() => app.quit(), 4000);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
