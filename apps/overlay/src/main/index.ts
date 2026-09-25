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
 *   详见 docs/research.md §6。
 */

import { app, BrowserWindow, ipcMain, screen, type Rectangle } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { LcuClient, detectCredentials, isBrawlSession } from '@hexbox/lcu';
import { readDataset } from '@hexbox/data-store';
import { DATA_POLICY, type Dataset } from '@hexbox/core';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// 悬浮窗状态
// ---------------------------------------------------------------------------

let win: BrowserWindow | null = null;
let client: LcuClient | null = null;
let dataset: Dataset | null = null;
let lastPhase: string | null = null;
let clickThrough = true;

const POLL_MS = 2000;

/** 推送给渲染端的状态（渲染端据此渲染，不做任何 IO）。 */
interface OverlayStateMsg {
  connected: boolean;
  phase: string;
  gameMode: string;
  queueId: number | null;
  isBrawl: boolean;
  augCount: number;
  /** 选人阶段我方已选英雄（pregame-visible，政策允许）。 */
  picks: Array<{ championId: number; name: string }>;
  clickThrough: boolean;
  /** 被禁数据类别的原因（用于在 UI 上诚实说明"为什么不显示"）。 */
  policyReason: string;
}

// ---------------------------------------------------------------------------
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

  const script = `
$sig = @'
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
'@
Add-Type -MemberDefinition $sig -Name WinApi -Namespace Hexbox -ErrorAction SilentlyContinue
$proc = Get-Process -Name 'LeagueClientUx','League of Legends' -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { exit 0 }
$r = New-Object Hexbox.RECT
[Hexbox.WinApi]::GetWindowRect($proc.MainWindowHandle, [ref]$r) | Out-Null
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
  const WIDTH = 320;
  const HEIGHT = 460;
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
    if (dataset) {
      console.log(`[hexbox] 数据集已加载: 海克斯 ${dataset.augments.length} / 英雄 ${dataset.champions.length}`);
    } else {
      console.warn(`[hexbox] 未找到数据集 (${dir})，请先运行 pnpm sync`);
    }
  } catch (e) {
    console.warn('[hexbox] 数据集读取失败:', e instanceof Error ? e.message : e);
    dataset = null;
  }
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
    const creds = await detectCredentials().catch(() => null);
    if (creds) {
      client = new LcuClient(creds);
      console.log(`[hexbox] LCU 已连接 (port ${creds.port}, via ${creds.source})`);
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
      // 会话读取失败可能意味着客户端退出
      client = null;
    }

    // 选人阶段：读取我方已选英雄（pregame-visible）
    if (phase === 'ChampSelect' && client) {
      const cs = await client
        .get<{ myTeam?: Array<{ championId?: number }> }>('/lol-champ-select/v1/session')
        .catch(() => null);
      picks = (cs?.myTeam ?? [])
        .filter((m) => typeof m.championId === 'number' && m.championId > 0)
        .map((m) => ({ championId: m.championId as number, name: championName(m.championId as number) }));
    }
  }

  // 可见性随阶段自动切换（不抢焦点）
  const show = phase === 'ChampSelect' || phase === 'InProgress';
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
    augCount: dataset?.augments.length ?? 0,
    picks,
    clickThrough,
    policyReason: DATA_POLICY['augment-performance'].allowed
      ? ''
      : DATA_POLICY['augment-performance'].reason,
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
    width: 320,
    height: 460,
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
      preload: join(__dirname, 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(clickThrough, { forward: true });

  void win.loadFile(join(__dirname, 'renderer', 'index.html'));
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
