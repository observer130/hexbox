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
 *   2. 同比时看**窗口占显示器的比例**：窗口物理宽 ÷ 显示器物理宽 < 0.9
 *      → 截屏若是窗口快照,其纵横比×缩放仍应等于窗口比,但真实场景中
 *      desktopCapturer 在窗口未占满屏幕时倾向返回显示器快照 ——
 *      认定 display（否则标签偏移一个窗口宽度,误差远大于翻转风险）。
 *   3. 窗口占满显示器（>0.9）→ 两者等价,归 window（无偏移直通）。
 */
export function snapshotKind(
  capture: { readonly width: number; readonly height: number },
  displayPhysical: { readonly width: number; readonly height: number },
  windowPhysical?: { readonly width: number; readonly height: number } | null,
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
  const winShare = windowPhysical.width / Math.max(1, displayPhysical.width);
  return winShare < 0.9 ? 'display' : 'window';
}

/**
 * 一步到位的换算参数构造（vision-loop 与 debug 工具共用）。
 *
 * 输入：截屏尺寸、窗口物理矩形（GetWindowRect）、显示器信息
 * （Electron display：bounds 为逻辑 DIP、scaleFactor 为 DPI 倍率）。
 * 输出：CaptureGeometry —— 归一化卡片矩形 → 屏幕逻辑坐标的唯一桥梁。
 *
 * 两种快照形态的处理：
 *   - display 快照：截屏物理 = 显示器物理 × captureScale。
 *     窗口在截屏内的偏移 = 窗口物理位置 × captureScale。
 *     屏幕逻辑 = 窗口物理 ÷ scaleFactor。
 *   - window 快照：截屏 = 窗口内容 × captureScale,无偏移。
 *     截屏内归一化坐标直接 × 窗口逻辑尺寸 + 窗口逻辑位置。
 *
 * display.bounds 已是逻辑 DIP,显示器物理尺寸 = bounds × scaleFactor。
 */
export function makeScreenGeometry(
  capture: { readonly width: number; readonly height: number },
  windowPhysical: PhysicalRect | null,
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
  const displayPhysical = {
    width: Math.round(display.bounds.width * display.scaleFactor),
    height: Math.round(display.bounds.height * display.scaleFactor),
  };
  const kind = snapshotKind(capture, displayPhysical, windowPhysical);

  if (kind === 'display' && windowPhysical) {
    // 截屏 = 显示器快照。截屏物理尺寸 ÷ 显示器物理尺寸 = captureScale
    const cs = capture.width / Math.max(1, displayPhysical.width);
    // 窗口逻辑矩形（GetWindowRect 物理 ÷ DPI）
    const winLogical = {
      x: windowPhysical.x / display.scaleFactor,
      y: windowPhysical.y / display.scaleFactor,
      width: windowPhysical.width / display.scaleFactor,
      height: windowPhysical.height / display.scaleFactor,
    };
    // 归一化坐标是相对**截屏**的;窗口在截屏内占的子矩形：
    // 物理偏移 × cs ÷ 截屏尺寸 = 物理偏移 ÷ 显示器物理尺寸（= 逻辑偏移 ÷ 显示器逻辑尺寸）
    const nx0 = (windowPhysical.x * cs) / capture.width;
    const ny0 = (windowPhysical.y * cs) / capture.height;
    const nw = (windowPhysical.width * cs) / capture.width;
    const nh = (windowPhysical.height * cs) / capture.height;
    // 换算几何:归一化(0..1 相对截屏) → 先映射进窗口子矩形 → 再到屏幕逻辑
    return {
      kind,
      scale: cs,
      estimated: false,
      geo: {
        captureWidth: capture.width,
        captureHeight: capture.height,
        // normalizedRectToScreen 的公式: screen = geo.windowX + n.x * geo.windowWidth
        // 令 n.x 相对截屏 → screen.x = winX + (n.x - nx0)/nw * winW
        //                 = (winX - nx0/nw*winW) + n.x * (winW/nw)
        windowX: winLogical.x - (nx0 / nw) * winLogical.width,
        windowY: winLogical.y - (ny0 / nh) * winLogical.height,
        windowWidth: winLogical.width / nw,
        windowHeight: winLogical.height / nh,
      },
    };
  }

  // window 快照（或无窗口矩形兜底）：截屏即窗口内容
  const cs = captureScale(capture, windowPhysical);
  const winLogical = windowPhysical
    ? {
        x: windowPhysical.x / display.scaleFactor,
        y: windowPhysical.y / display.scaleFactor,
        width: windowPhysical.width / display.scaleFactor,
        height: windowPhysical.height / display.scaleFactor,
      }
    : {
        x: display.workArea.x,
        y: display.workArea.y,
        width: capture.width / display.scaleFactor,
        height: capture.height / display.scaleFactor,
      };
  return {
    kind,
    scale: cs.scale,
    estimated: cs.estimated,
    geo: {
      captureWidth: capture.width,
      captureHeight: capture.height,
      windowX: winLogical.x,
      windowY: winLogical.y,
      windowWidth: winLogical.width,
      windowHeight: winLogical.height,
    },
  };
}
