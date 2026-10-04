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
 * 查询游戏客户端主窗口矩形（物理像素）。
 *
 * 返回 null 表示没有**可信的**游戏窗口（见 `isPlausibleGameWindow`）。
 * （LeagueClientUx 是客户端 UI；游戏本身是 "League of Legends"。）
 */
export async function findGameWindowRect(): Promise<PhysicalRect | null> {
  const windir = process.env['windir'] ?? 'C:\\Windows';
  const ps = join(windir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

  // 注意：必须用 Add-Type -TypeDefinition（main/index.ts 有完整踩坑记录）。
  // 同时报告 IsWindowVisible 与桌面范围 —— 调用方据此排除幽灵窗口。
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
$proc = Get-Process -Name 'LeagueClientUx','League of Legends' -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { exit 0 }
$r = New-Object HEXBOX_RECT
[HexboxWinApi]::GetWindowRect($proc.MainWindowHandle, [ref]$r) | Out-Null
$sm = [System.Windows.Forms.SystemInformation]::VirtualScreen
[PSCustomObject]@{
  X=$r.Left; Y=$r.Top; W=($r.Right-$r.Left); H=($r.Bottom-$r.Top)
  Visible=[HexboxWinApi]::IsWindowVisible($proc.MainWindowHandle)
  ScreenW=$sm.Width; ScreenH=$sm.Height
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

  // 无窗口矩形兜底:假设截屏 ≈ 工作区
  return {
    kind,
    scale: capture.width / Math.max(1, dispW * display.scaleFactor),
    estimated: true,
    geo: {
      captureWidth: capture.width,
      captureHeight: capture.height,
      windowX: display.workArea.x,
      windowY: display.workArea.y,
      windowWidth: display.workArea.width,
      windowHeight: display.workArea.height,
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
