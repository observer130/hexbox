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

import type { CaptureGeometry } from './types.ts';

const execFileAsync = promisify(execFile);

export interface PhysicalRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * 查询游戏客户端主窗口矩形（物理像素）。
 *
 * 返回 null 表示没有可见的游戏客户端窗口
 * （ LeagueClientUx 是客户端 UI；游戏本身是 "League of Legends"）。
 */
export async function findGameWindowRect(): Promise<PhysicalRect | null> {
  const windir = process.env['windir'] ?? 'C:\\Windows';
  const ps = join(windir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

  // 注意：必须用 Add-Type -TypeDefinition（main/index.ts 有完整踩坑记录）。
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
    // 窗口在显示器逻辑坐标系中的子矩形（相对整屏）
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
