/**
 * 游戏窗口几何信息（只读窗口矩形，不触碰进程内存）
 *
 * 合规边界（与 main/index.ts 的 findGameWindowRect 相同）：
 *   只调用 user32!GetWindowRect 读取**几何信息**；
 *   不打开进程句柄、不读写内存、不注入、不解析封包。
 *
 * 为什么从 main/index.ts 抽出来：
 *   debug-capture 与悬浮窗主进程需要**同一份**窗口矩形 ——
 *   两处各写一份必然漂移（这是坐标换算最容易出错的环节，
 *   见 docs/SCREENSHOT-DEV.md §3.1）。
 *
 * DPI 要点（实测）：
 *   - Electron 主进程默认 Per-Monitor-V2 DPI 感知，GetWindowRect
 *     返回**物理像素**；Electron 的 screen/display 使用**逻辑 DIP**。
 *   - desktopCapturer 的缩略图尺寸 = 物理像素 × 未知内部缩放。
 *   三者混用必然错位，因此换算链必须显式：
 *     截图像素 → ÷captureScale → 物理像素 → ÷scaleFactor → 逻辑 DIP
 *   - captureScale 运行时自校准：物理窗口尺寸与截屏尺寸同源
 *     （都是物理像素），比值即缩放，无需假设固定 2.0。
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { CaptureGeometry, Rect } from './types.ts';

const execFileAsync = promisify(execFile);

export interface PhysicalRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 游戏窗口的最小可信尺寸（物理像素）。 */
export const MIN_GAME_WINDOW_WIDTH = 320;
export const MIN_GAME_WINDOW_HEIGHT = 240;

/**
 * 游戏**本体**的进程名（白名单）。
 *
 * ⚠️ 为什么必须白名单而不是"找标题像 League 的窗口"：
 * 实测 `LeagueClientUx.exe`（Riot 客户端 UI）的**窗口标题就是
 * `League of Legends`**、窗口类为 `RCLIENT`、尺寸 1600×900 —— 与游戏
 * 窗口在名称上完全无法区分。此前按名字匹配，于是在**没有对局**时
 * 返回了客户端窗口：覆盖层会贴着客户端摆放，坐标换算全错。
 *
 * 客户端 UI、Riot Client、WeGame 一律不在白名单内。
 */
export const GAME_PROCESS_NAMES = ['League of Legends'] as const;

/** 已知的**非**游戏进程（Riot 客户端族）——显式排除，便于诊断与日志。 */
export const RIOT_CLIENT_PROCESS_NAMES = [
  'LeagueClientUx',
  'LeagueClient',
  'RiotClientServices',
  'Riot Client',
  'WeGame',
] as const;

export interface GameWindowCheck {
  readonly rect: PhysicalRect;
  /** `IsWindowVisible` 的结果（最小化/隐藏时为 false）。 */
  readonly visible: boolean;
  /** 桌面/虚拟屏范围（物理像素）；不传则跳过该判据。 */
  readonly screen?: {
    readonly width: number;
    readonly height: number;
    /** 允许超出屏幕外多少（窗口可部分移出屏，但不该整体离屏）。 */
    readonly slack?: number;
  };
}

/**
 * 判定一个窗口矩形是否是**可信的游戏窗口**（纯函数，可单测）。
 *
 * ⚠️ 真机教训：客户端与游戏的最小化/幽灵窗口是**真实存在的**。
 * 实测拿到过 `158x26 @ (-21333,-21333)` —— 那是被移出屏幕的残留窗口，
 * 于是 WGC 以参数错误失败（`Failed to start capture: -2147024809`），
 * 而调用方还以为是"找到了游戏窗口"，浪费一整轮排查。
 *
 * 三条判据（缺一不可）：
 *   1. `IsWindowVisible` 为真（最小化/隐藏的窗口截不到内容）；
 *   2. 尺寸不小于 `MIN_GAME_WINDOW_*`（海斗全屏/窗口化都远大于此；
 *      残留窗口往往是几十像素的退化尺寸）；
 *   3. 窗口与屏幕范围有交集（允许部分移出屏，不允许整体离屏）。
 *
 * 宁可不返回（调用方降级到主显示器），也不要返回一个截不到内容的窗口。
 */
export function isPlausibleGameWindow(check: GameWindowCheck): boolean {
  const { rect, visible, screen } = check;
  if (!visible) return false;
  if (rect.width < MIN_GAME_WINDOW_WIDTH || rect.height < MIN_GAME_WINDOW_HEIGHT) return false;
  if (screen) {
    const slack = screen.slack ?? 0;
    const right = rect.x + rect.width;
    const bottom = rect.y + rect.height;
    // 与 [0,width]x[0,height] 无交集 → 整体离屏
    const intersects =
      right > -slack && rect.x < screen.width + slack &&
      bottom > -slack && rect.y < screen.height + slack;
    if (!intersects) return false;
  }
  return true;
}

/**
 * 缓存版游戏窗口矩形查询。
 *
 * 为什么必须缓存：本机实测单次 `findGameWindowRect()` 的构成为
 *   PowerShell 启动 610ms + `Add-Type` C# 编译 450ms + 进程枚举 156ms
 *   ≈ **1.2~1.3 秒**
 * 而它每轮识别都要用一次（1.5s 一轮）—— 探测比被测量的工作本身贵得多，
 * 于是「找不到窗口」时耗时从 ~200ms 涨到 ~1.5s。窗口矩形在几秒内
 * 不可能变化，因此按 TTL 复用；只有拿到 null（可能游戏刚启动）或
 * 调用方显式要求刷新时才重新探测。
 */
export interface CachedWindowRect {
  /**
   * @param options.ttlMs 缓存有效期（默认 10s）
   * @param options.force 强制重新探测（截屏失败后调用方应传 true）
   */
  (options?: { readonly ttlMs?: number; readonly force?: boolean }): Promise<PhysicalRect | null>;
}

/** 默认缓存 10 秒：一次探测 1.2s，摊薄到 6~7 次调用。 */
export const WINDOW_RECT_TTL_MS = 10_000;

/**
 * 创建一个带缓存的窗口矩形查询器（**不是全局单例**，便于测试与多显示器场景）。
 *
 * 只缓存**成功**结果：null 意味着「当前没有游戏窗口」，
 * 而游戏可能下一秒就起来，不能把 null 缓存住。
 *
 * @param probe 实际探测函数，默认 `findGameWindowRect`（测试注入用）
 */
export function createWindowRectCache(
  probe: () => Promise<PhysicalRect | null> = findGameWindowRect,
): CachedWindowRect {
  let cached: PhysicalRect | null = null;
  let at = 0;
  let inflight: Promise<PhysicalRect | null> | null = null;

  return async (options = {}) => {
    const ttl = options.ttlMs ?? WINDOW_RECT_TTL_MS;
    const now = Date.now();
    if (!options.force && cached && now - at < ttl) return cached;
    // 并发合流：同一时刻的多个调用只起一个 PowerShell 进程
    if (!options.force && inflight) return inflight;

    const p = probe();
    inflight = p;
    try {
      const r = await p;
      cached = r;
      at = Date.now();
      return r;
    } finally {
      if (inflight === p) inflight = null;
    }
  };
}

/** 进程内共享的默认缓存（悬浮窗主进程用）。 */
export const findGameWindowRectCached: CachedWindowRect = createWindowRectCache();

/**
 * 查询游戏客户端主窗口矩形（物理像素）。
 *
 * 返回 null 表示没有**可信的**游戏窗口（见 `isPlausibleGameWindow`）。
 * （LeagueClientUx 是客户端 UI；游戏本身是 "League of Legends"。）
 *
 * ⚠️ 单次调用约 1.2 秒（PowerShell + Add-Type）。常规轮询请用
 * `findGameWindowRectCached`，只有确实需要最新值时才直接调它。
 */
export async function findGameWindowRect(): Promise<PhysicalRect | null> {
  const windir = process.env['windir'] ?? 'C:\\Windows';
  const ps = join(windir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

  // 注意：必须用 Add-Type -TypeDefinition（main/index.ts 有完整踩坑记录）。
  // 同时报告 IsWindowVisible 与桌面范围 —— 调用方据此排除幽灵窗口。
  //
  // ⚠️ 只认游戏本体进程（'League of Legends'）：客户端 UI
  // `LeagueClientUx` 的窗口标题同样是 'League of Legends'，按名字找必然误选。
  //
  // ⚠️⚠️ 真机事故（2026-10-04，标签整体错位到右下角的根因）：
  // 这里曾直接用 `[System.Windows.Forms.SystemInformation]::VirtualScreen`，
  // 却在 Windows PowerShell 5.1 下**没有先加载该程序集** —— 该类型不存在会
  // 抛终止性错误，整个脚本无输出 → 本函数返回 null → 调用方退化到
  // "截屏≈显示器"的错误假设（横向刻度差 1.34 倍），标签因此右移 + 贴底。
  // 现在：先 Add-Type 加载，并且**桌面范围只用 try/catch 取**，取不到也不能
  // 影响窗口矩形本身的输出。
  const script = `
$src = @'
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)]
public struct HEXBOX_RECT { public int Left, Top, Right, Bottom; }
public static class HexboxWinApi {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out HEXBOX_RECT lpRect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
}
'@
Add-Type -TypeDefinition $src -ErrorAction SilentlyContinue
$proc = Get-Process -Name 'League of Legends' -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { exit 0 }
$r = New-Object HEXBOX_RECT
[HexboxWinApi]::GetWindowRect($proc.MainWindowHandle, [ref]$r) | Out-Null
$sw = 0; $sh = 0
try {
  Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
  $sm = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $sw = $sm.Width; $sh = $sm.Height
} catch { $sw = 0; $sh = 0 }
[PSCustomObject]@{
  X=$r.Left; Y=$r.Top; W=($r.Right-$r.Left); H=($r.Bottom-$r.Top)
  Visible=[HexboxWinApi]::IsWindowVisible($proc.MainWindowHandle)
  ScreenW=$sw; ScreenH=$sh
} | ConvertTo-Json -Compress
`;

  try {
    const { stdout } = await execFileAsync(
      existsSync(ps) ? ps : 'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 8000 },
    );
    const text = stdout.trim();
    if (!text) return null;
    const o = JSON.parse(text) as {
      X?: number;
      Y?: number;
      W?: number;
      H?: number;
      Visible?: boolean;
      ScreenW?: number;
      ScreenH?: number;
    };
    if (typeof o.X !== 'number' || typeof o.W !== 'number') return null;
    const rect: PhysicalRect = { x: o.X, y: o.Y ?? 0, width: o.W, height: o.H ?? 0 };
    const screen =
      typeof o.ScreenW === 'number' && typeof o.ScreenH === 'number' && o.ScreenW > 0
        ? { width: o.ScreenW, height: o.ScreenH, slack: 0 }
        : undefined;
    // Visible 缺失（老版本 PowerShell 无 SystemInformation）时按可见处理，
    // 尺寸与范围判据仍然生效。
    const visible = o.Visible !== false;
    return isPlausibleGameWindow({ rect, visible, screen }) ? rect : null;
  } catch {
    /* 降级到默认位置 */
  }
  return null;
}

/**
 * 换算链第一步：截图像素 → 窗口物理像素的缩放。
 *
 * 自校准原理：GetWindowRect 与 desktopCapturer 都工作在物理像素层，
 * 二者尺寸之比即 captureScale（因 UI 主题/显示器组合而异，不假设定值）。
 * 任一来源缺失时按 1.0 处理并让调用方知情（返回值带 estimated 标记）。
 */
export function captureScale(
  capture: { readonly width: number; readonly height: number },
  windowRect: PhysicalRect | null,
): { readonly scale: number; readonly estimated: boolean } {
  if (!windowRect || windowRect.width <= 0 || capture.width <= 0) {
    return { scale: 1, estimated: true };
  }
  return { scale: capture.width / windowRect.width, estimated: false };
}

/**
 * 判断截屏内容是「窗口快照」还是「显示器快照」。
 *
 * 真机教训（S2 验收两轮）：desktopCapturer 的行为有两种实测形态，
 * 且游戏窗口与显示器常同为 16:9,纵横比判据会退化（三者同比无法区分）。
 *
 * 联合判据（按优先级）：
 *   1. 纵横比不一致时,谁与截屏同比 → 谁是快照来源；
 *   2. 同比时看**窗口占显示器的比例**（winShare,逻辑口径,
 *      由调用方传入）：占比 < 0.9 → display（desktopCapturer 在窗口
 *      未占满屏幕时倾向返回显示器快照;误判代价不对称）；
 *   3. 占比 ≥ 0.9 → 两者等价,归 window（无偏移直通）。
 */
export function snapshotKind(
  capture: { readonly width: number; readonly height: number },
  displayPhysical: { readonly width: number; readonly height: number },
  windowPhysical?: { readonly width: number; readonly height: number } | null,
  /** 窗口逻辑宽 ÷ 显示器逻辑宽（同比退化时使用）。 */
  winShare?: number,
): 'window' | 'display' {
  const capRatio = capture.width / Math.max(1, capture.height);
  const dispRatio = displayPhysical.width / Math.max(1, displayPhysical.height);
  const dispOff = Math.abs(capRatio - dispRatio) / dispRatio;

  if (!windowPhysical || windowPhysical.width <= 0) return 'window';
  const winRatio = windowPhysical.width / Math.max(1, windowPhysical.height);
  const winOff = Math.abs(capRatio - winRatio) / winRatio;

  if (Math.abs(dispOff - winOff) > 0.02) {
    return dispOff < winOff ? 'display' : 'window';
  }
  // 同比退化:窗口未占满显示器 → display 快照
  return (winShare ?? 1) < 0.9 ? 'display' : 'window';
}

/**
 * 一步到位的换算参数构造（vision-loop 与 debug 工具共用）。
 *
 * 输入：截屏尺寸、窗口矩形（GetWindowRect）、显示器信息
 * （Electron display：bounds 为逻辑 DIP、scaleFactor 为 DPI 倍率）。
 * 输出：CaptureGeometry —— 归一化卡片矩形 → 屏幕逻辑坐标的唯一桥梁。
 *
 * ⚠️ 坐标系结论（S2 验收三轮实测,2026-09-27 定稿）：
 *   - GetWindowRect 由**非 DPI 感知**的 PowerShell 进程执行，
 *     返回的是 **DPI 虚拟化(逻辑)坐标** —— 不得再除以 scaleFactor！
 *     （实测:游戏窗口 1600×900,GetWindowRect 直出 1600×900;
 *       显示器 bounds 2400×1350 亦是逻辑值。）
 *   - desktopCapturer 返回**显示器快照**（截屏 3413×1920 ≈
 *     显示器逻辑 2400×1350 的等比缩放,含窗口外桌面区域）,
 *     窗口在其中占一个子矩形。
 *
 * 换算（display 快照形态,唯一实测形态）：
 *   窗口子矩形在截屏内: nx0 = winX/dispW, nw = winW/dispW（宽高比一致）
 *   screen = winX + (n.x - nx0)/nw * winW  →  折进 CaptureGeometry:
 *     windowX' = winX - (nx0/nw)*winW
 *     windowWidth' = winW / nw   （= 显示器逻辑宽）
 */
export function makeScreenGeometry(
  capture: { readonly width: number; readonly height: number },
  windowRect: PhysicalRect | null,
  display: {
    readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
    readonly scaleFactor: number;
    readonly workArea: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  },
): {
  readonly geo: CaptureGeometry;
  readonly kind: 'window' | 'display';
  readonly scale: number;
  readonly estimated: boolean;
} {
  const dispW = display.bounds.width; // 逻辑 DIP
  const dispH = display.bounds.height;
  // GetWindowRect 直出逻辑坐标（勿除 scaleFactor）—— 窗口占比用逻辑口径
  const winShare = windowRect ? windowRect.width / dispW : 1;
  const kind = snapshotKind(capture, {
    width: Math.round(dispW * display.scaleFactor),
    height: Math.round(dispH * display.scaleFactor),
  }, windowRect, winShare);

  if (windowRect && windowRect.width > 0) {
    // GetWindowRect 直出逻辑坐标（见上函数头注,勿除 scaleFactor）
    const win = {
      x: windowRect.x,
      y: windowRect.y,
      width: windowRect.width,
      height: windowRect.height,
    };

    if (kind === 'window') {
      // 窗口快照：截屏就是窗口内容（等比缩放），无偏移直通
      return {
        kind,
        scale: capture.width / Math.max(1, win.width),
        estimated: false,
        geo: {
          captureWidth: capture.width,
          captureHeight: capture.height,
          windowX: win.x,
          windowY: win.y,
          windowWidth: win.width,
          windowHeight: win.height,
        },
      };
    }

    // 显示器快照：截屏≈显示器等比缩放，窗口是其中的子矩形。
    // nx0 = win.x/dispW, nw = win.width/dispW（截屏与显示器同比）
    const nx0 = win.x / dispW;
    const ny0 = win.y / dispH;
    const nw = win.width / dispW;
    const nh = win.height / dispH;
    return {
      kind,
      scale: capture.width / Math.max(1, dispW * display.scaleFactor),
      estimated: false,
      geo: {
        captureWidth: capture.width,
        captureHeight: capture.height,
        // normalizedRectToScreen: screen = windowX + n.x * windowWidth
        // 目标: screen = win.x + ((n.x - nx0)/nw) * win.width
        //   → windowX     = win.x - (nx0/nw) * win.width
        //     windowWidth = win.width / nw = 显示器逻辑宽（把截屏内归一化
        //     换算成窗口内归一化的系数）
        windowX: win.x - (nx0 / nw) * win.width,
        windowY: win.y - (ny0 / nh) * win.height,
        windowWidth: win.width / nw,
        windowHeight: win.height / nh,
      },
    };
  }

  // 无窗口矩形兜底。
  //
  // ⚠️ 原实现假设"截屏 ≈ 工作区"，这在真机上是**错**的：截屏是**游戏窗口**
  // 内容（实测 3413×1920 = 游戏窗口 1706×960 逻辑像素的 2 倍），而工作区是
  // 2294×960 —— 横向刻度差 1.34 倍，于是覆盖层标签整体右移并贴底
  // （用户报告"胜率跑到右下角"）。根因是 PowerShell 探针抛错返回 null，
  // 已在上方修复；这里同时把兜底改成**按截屏纵横比推断窗口**，
  // 使同类失败只产生可接受的偏移，而不是整体错位。
  //
  // 假设（仅兜底路径）：游戏窗口高度 = 显示器逻辑高、按截屏纵横比推宽度、
  // 与工作区左上角对齐。窗口矩形能正常读到时就永远不走这里。
  const winH = Math.max(1, display.bounds.height);
  const winW = Math.max(1, Math.round(winH * (capture.width / Math.max(1, capture.height))));
  console.warn(
    `[vision] ⚠ 拿不到游戏窗口矩形，按截屏纵横比推断为 ${winW}x${winH} 逻辑像素` +
      `（截屏 ${capture.width}x${capture.height}）—— 标签位置可能略有偏移`,
  );
  return {
    kind,
    scale: capture.width / Math.max(1, dispW * display.scaleFactor),
    estimated: true,
    geo: {
      captureWidth: capture.width,
      captureHeight: capture.height,
      // CSS 原点 = 覆盖层窗口左上角 = 工作区左上角 → 偏移为 0
      windowX: 0,
      windowY: 0,
      windowWidth: winW,
      windowHeight: winH,
    },
  };
}

/**
 * **窗口内归一化**矩形 → **截屏归一化**矩形（窗口 UI 元素识别用）。
 *
 * 背景：顶栏槽位等 UI 元素的几何按**窗口**归一化存储（跨分辨率稳定,
 * 两张真机截图交叉验证一致）。但截屏有两种实测形态
 * （snapshotKind）：window 形态下截屏=窗口内容,两种归一化相等;
 * display 形态下窗口只是截屏的子矩形,必须**平移缩放**。
 *
 * 两种形态的统一表达（capture 是显示器逻辑尺寸 × 同一比例）：
 *   - window 形态：nx0=0, nw=1（窗口铺满截屏）
 *   - display 形态：nx0 = win.x/dispW, nw = win.width/dispW
 * 变换：capture.x = nx0 + rect.x * nw
 * （window 形态退化为恒等;windowRect 为 null 时同样恒等。）
 *
 * ⚠️ 必须与 makeScreenGeometry 用同一份 display/window 形态判定 ——
 * 所以本函数接受与 makeScreenGeometry 相同的参数,内部复用 snapshotKind。
 */
export function windowRectToCapture(
  rect: Rect,
  capture: { readonly width: number; readonly height: number },
  windowRect: PhysicalRect | null,
  display: {
    readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
    readonly scaleFactor: number;
  },
): Rect {
  const dispW = Math.max(1, display.bounds.width);
  const dispH = Math.max(1, display.bounds.height);
  const nx0 = windowRect ? windowRect.x / dispW : 0;
  const ny0 = windowRect ? windowRect.y / dispH : 0;
  const nw = windowRect ? windowRect.width / dispW : 1;
  const nh = windowRect ? windowRect.height / dispH : 1;
  // 窗口纵横比与截屏不一致时（window 快照形态）,窗口归一化即截屏归一化
  const kind = snapshotKind(
    capture,
    { width: Math.round(dispW * display.scaleFactor), height: Math.round(dispH * display.scaleFactor) },
    windowRect,
    windowRect ? windowRect.width / dispW : 1,
  );
  if (kind === 'window' || !windowRect) {
    return rect;
  }
  return {
    x: nx0 + rect.x * nw,
    y: ny0 + rect.y * nh,
    w: rect.w * nw,
    h: rect.h * nh,
  };
}
