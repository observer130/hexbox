/**
 * **托盘图标**：常驻覆盖层唯一的交互入口
 *
 * ── 为什么托盘是必需品，不是锦上添花（用户决策）────────────────────────
 *   覆盖层本体**没有可见窗口**（全屏透明、点击穿透、无标题栏、无 X），
 *   `decideVisible()` 里 `showPanel` 恒为 false。所以：
 *     · 用户没有任何"点一下就看到它"的地方 → 托盘图标是唯一的入口；
 *     · 「关窗口不退出、只有托盘菜单的退出才真退出」这条语义，
 *       **只能**由托盘菜单承担（tooltip 里必须写清，见 `TRAY_TOOLTIP_HINT`）。
 *
 * ── 关闭窗口 = 最小化到托盘（`attachCloseToTrayHide`）────────────────────
 *   所有属于常驻覆盖层的窗口都挂它：非退出状态下 `preventDefault()` + `hide()`。
 *   `quitApp()` 是**唯一**把 `quitting` 置真的地方（托盘菜单 / 冒烟 / 自测），
 *   之后 `app.quit()` → `main/index.ts` 的 `before-quit` 跑**既有**那套清理
 *   （停屏幕流 + 销毁 worker 窗口 + 清标签）——**没有第二套退出清理**。
 *
 * ⚠️ 三个都踩过的坑，别"顺手优化"掉：
 *   ① **Tray 必须被长期持有**：局部变量被 GC 掉之后图标会突然消失；
 *   ② Windows 关机/注销时 `before-quit` **不会**触发（Electron 文档），
 *      若不认这件事就会"阻止系统关机"，所以监听 `session-end` 放行关窗口；
 *   ③ `app.quit()` 期间若还有窗口 `preventDefault()`，退出会被**中止** ——
 *      所以 `quitting` 必须在 `app.quit()` **之前**置真（`quitApp()` 就是干这个的），
 *      冒烟模式那种"直接 app.quit()"的老写法必须改走 `quitApp()`。
 */

import { app, Menu, nativeImage, shell, Tray } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { TRAY_TOOLTIP_HINT, trayTooltipText, type TrayStatus } from '@hexbox/vision';

/* ------------------------------------------------------------------ */
/* 托盘图标：开发/打包两条路径都要能找到                                  */
/* ------------------------------------------------------------------ */

/** 图标文件名（优先级从高到低；ICO 带多尺寸，最清晰）。 */
const ICON_FILES = ['tray.ico', 'tray-32.png', 'tray-16.png'] as const;

/** 托盘图标目录（相对各自根）：打包版 `resources/tray`，开发版 `apps/overlay/build/tray`。 */
const ICON_DIR = 'tray';

export interface TrayIconSource {
  /** 实际加载的图标文件绝对路径（打进日志 = "用的哪一张"可复核）。 */
  readonly path: string;
  /** 从哪个候选来的（人读；排查"打包版托盘空白"时看它）。 */
  readonly note: string;
  readonly image: Electron.NativeImage;
}

/**
 * 候选目录（顺序 = 优先级）。**两套环境都要工作**是硬要求：
 *   1. `HEXBOX_TRAY_ICON`（显式指定目录；排查用，不必重新打包）
 *   2. 打包版：`process.resourcesPath/tray/`（`extraResources` 打进去的那份）
 *   3. 开发版：`__dirname/../../build/tray/`（`dist/main` → `apps/overlay/build`）
 *   4. 兜底：与源码同级的 `build/tray/`（`tsc` 直出的目录布局）
 */
export function trayIconDirs(): { readonly dir: string; readonly note: string }[] {
  const out: { dir: string; note: string }[] = [];
  const explicit = process.env['HEXBOX_TRAY_ICON'];
  if (explicit) out.push({ dir: explicit, note: 'HEXBOX_TRAY_ICON 显式指定' });
  out.push({ dir: join(process.resourcesPath, ICON_DIR), note: '打包版 resources/tray' });
  out.push({ dir: join(__dirname, '..', '..', 'build', ICON_DIR), note: '开发版 build/tray（dist/main 上两级）' });
  out.push({ dir: join(app.getAppPath(), 'build', ICON_DIR), note: 'app 目录下的 build/tray' });
  return out;
}

/** 512² 的源图（`win.icon` 用的那张）—— 兜底缩到 16，远不如托盘版清晰。 */
function fallbackIconPath(): string | null {
  const candidates = [
    join(__dirname, '..', '..', 'build', 'icon.png'),
    join(process.resourcesPath, 'icon.png'),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * 加载托盘图标。
 *
 * ⚠️ **必须有兜底**：图标文件一旦没打进包，`new Tray(空图)` 会失败 →
 * 没有托盘 = 没有退出入口 = 只能去任务管理器杀进程（比"图标糊一点"糟得多）。
 * 所以逐级退：多尺寸 ICO → 32px PNG → 16px PNG → `icon.png` 现场缩到 16。
 */
export function loadTrayIcon(): TrayIconSource {
  for (const { dir, note } of trayIconDirs()) {
    for (const file of ICON_FILES) {
      const path = join(dir, file);
      if (!existsSync(path)) continue;
      const image = nativeImage.createFromPath(path);
      if (image.isEmpty()) {
        console.warn(`[hexbox] ⚠ 托盘图标读取失败（空图）：${path} —— 继续找下一张`);
        continue;
      }
      return { path, note, image };
    }
  }

  const fallback = fallbackIconPath();
  if (fallback !== null) {
    const image = nativeImage.createFromPath(fallback).resize({ width: 16, height: 16 });
    if (!image.isEmpty()) {
      console.warn(
        `[hexbox] ⚠ 没找到托盘专用图标（${ICON_FILES.join(' / ')}）→ 退回 ${fallback} 缩到 16px` +
          '（可能偏糊；跑一遍 scripts/make-tray-icon.py 生成，并确认 electron-builder 的 extraResources）',
      );
      return { path: fallback, note: '兜底：源图缩到 16px', image };
    }
  }

  console.error(
    '[hexbox] ⚠ 找不到任何图标文件 → 托盘图标会是**空白**。' +
      '请跑 node scripts/make-tray-icon.py 生成 apps/overlay/build/tray/*，' +
      '并确认 electron-builder.yml 的 extraResources 里有它（打包版）',
  );
  return { path: '（无）', note: '没有图标可用', image: nativeImage.createEmpty() };
}

/* ------------------------------------------------------------------ */
/* 退出状态：唯一真源（关闭窗口只 hide，·只有这里能真退出）                 */
/* ------------------------------------------------------------------ */

/** 是否已经在退出流程里（`true` 之后 `close` 一律放行）。 */
let quitting = false;

/** 是否已经在退出（窗口的 `close` 处理器读它决定 hide 还是放行）。 */
export function isQuitting(): boolean {
  return quitting;
}

/**
 * **唯一的真退出入口**（托盘菜单「退出」/ 冒烟模式 / 自测）。
 *
 * 顺序不能反：先把 `quitting` 置真，`app.quit()` 才不会被
 * `attachCloseToTrayHide()` 的 `preventDefault()` 中止；清理逻辑不在
 * 这里重复一份 —— `main/index.ts` 的 `before-quit` 就是那唯一一份。
 */
export function quitApp(reason: string): void {
  if (quitting) return;
  quitting = true;
  console.log(
    `[hexbox] 退出（${reason}）→ 走与关窗口同一条路径：app.quit() → before-quit 停屏幕流 / 销毁 worker / 清标签`,
  );
  app.quit();
}

/**
 * Windows 关机 / 注销：Electron 的 `before-quit` **不会**触发（文档明说），
 * 若此时仍 `preventDefault()` 关窗口，就会变成"此程序阻止关机"。
 *
 * ⚠️ `session-end` 是 **BrowserWindow** 的事件（不是 `app` 的 —— 见 Electron 33 的
 * `electron.d.ts`：`BaseWindow` 上有，`App` 上没有），所以挂在每个窗口上，
 * 正好也是"要放行哪一扇窗"的粒度。
 */
function allowCloseOnSessionEnd(win: Electron.BrowserWindow): void {
  win.on('session-end', () => {
    if (!quitting) console.warn('[hexbox] 系统正在关机/注销 → 放行窗口关闭（不再拦截 close）');
    quitting = true;
  });
}

/**
 * 给一个窗口挂上「关闭 = 最小化到托盘」。
 *
 * ⚠️ 只挂在**常驻覆盖层自己的窗口**上（侧边面板 + 全屏标签画布）：
 * 截屏 worker 窗口是**故意**用 `destroy()` 收掉的（`augment-stream.ts`），
 * 而 `destroy()` 不触发 `close`，所以它本来就不受影响 —— 不要给它加这一层。
 */
export function attachCloseToTrayHide(win: Electron.BrowserWindow, what: string): void {
  allowCloseOnSessionEnd(win);
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
    console.log(
      `[hexbox] ${what}：收到关闭请求 → 已最小化到托盘（**不退出**；${TRAY_TOOLTIP_HINT}）`,
    );
  });
}

/* ------------------------------------------------------------------ */
/* 托盘本体                                                             */
/* ------------------------------------------------------------------ */

export interface TrayDeps {
  /** 当前状态（纯函数 `trayStatus()` 的结果；只读菜单项与 tooltip 同一个源）。 */
  readonly status: () => TrayStatus;
  /** 日志文件绝对路径（`null` = 本次运行不落日志 → 菜单项禁用）。 */
  readonly logFile: () => string | null;
  /** 数据目录（`resolveDataDir()` 的结果 = 现有解析口径）。 */
  readonly dataDir: () => string;
}

export interface TrayHandle {
  /** 重算状态并刷新菜单/tooltip（阶段变化时调；变没变由这里自己判断并打日志）。 */
  refresh(): void;
  /** 弹一次性气泡（返回是否真的弹了 —— 没有托盘时返回 false）。 */
  notify(title: string, content: string): boolean;
  /** 当前菜单项文字（自测把它打进日志 = "托盘存在且菜单完整"的证据）。 */
  menuLabels(): string[];
}

/** 菜单项文字（自测/日志用；顺序与真实菜单一致）。 */
function menuTemplate(deps: TrayDeps): Electron.MenuItemConstructorOptions[] {
  const status = deps.status();
  const logPath = deps.logFile();
  return [
    // 只读状态项：用户判断"它到底在干什么 / 为什么没有标签"的唯一现场依据
    { label: `状态：${status.text}`, enabled: false },
    { type: 'separator' },
    {
      label: logPath === null ? '打开日志（本次未落盘）' : '打开日志',
      enabled: logPath !== null,
      click: () => openLogs(logPath),
    },
    { label: '打开数据目录', click: () => openDataDir(deps.dataDir()) },
    { type: 'separator' },
    { label: '退出', click: () => quitApp('托盘菜单') },
  ];
}

/** 资源管理器定位到日志（文件在 = 选中它；还没生成 = 打开目录）。 */
function openLogs(logPath: string | null): void {
  if (logPath === null) {
    console.warn('[hexbox] 托盘菜单「打开日志」：本次运行没有日志文件（开发模式未设 HEXBOX_LOG_FILE）');
    return;
  }
  const dir = dirname(logPath);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* 建不出来就按原路径试 */
  }
  if (existsSync(logPath)) {
    shell.showItemInFolder(logPath);
    console.log(`[hexbox] 托盘菜单「打开日志」→ 资源管理器定位到 ${logPath}`);
    return;
  }
  console.log(`[hexbox] 托盘菜单「打开日志」→ 打开目录 ${dir}（日志文件尚未生成）`);
  void shell.openPath(dir).then((err) => {
    if (err !== '') console.warn(`[hexbox] ⚠ 打开日志目录失败：${err}`);
  });
}

/** 打开数据目录（不存在就建出来 —— 用户往里放数据覆盖时要先有它）。 */
function openDataDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* 打不开也不影响功能 */
  }
  console.log(`[hexbox] 托盘菜单「打开数据目录」→ ${dir}`);
  void shell.openPath(dir).then((err) => {
    if (err !== '') console.warn(`[hexbox] ⚠ 打开数据目录失败：${err}`);
  });
}

/**
 * 创建托盘（必须 `app.whenReady()` 之后）。
 *
 * 失败时返回 `null` 而**不抛**：没有托盘时程序仍能跑（只是没有退出入口），
 * 而"启动即崩"会让用户连日志都拿不到。
 */
export function createTray(deps: TrayDeps): TrayHandle | null {
  const icon = loadTrayIcon();
  let tray: Electron.Tray;
  try {
    tray = new Tray(icon.image);
  } catch (e) {
    console.error(
      `[hexbox] ⚠ 托盘创建失败：${e instanceof Error ? e.message : String(e)}` +
        '（没有托盘 = 没有退出入口；请把这段日志发回）',
    );
    return null;
  }

  let lastKey: string | null = null;
  const labels = (): string[] => menuTemplate(deps).map((item) => item.label ?? `(${item.type})`);
  const buildMenu = (): Electron.Menu => Menu.buildFromTemplate(menuTemplate(deps));

  const refresh = (): void => {
    const status = deps.status();
    tray.setToolTip(trayTooltipText(status));
    // 每 2 秒轮询都会调一次 refresh：只有内容真的变了才重建菜单并打日志
    //（Menu 对象每次都重建会白造垃圾；日志每 2 秒一行会把真机日志淹掉）
    const key = `${status.text}\u0000${status.detail}\u0000${deps.logFile() ?? ''}`;
    if (key === lastKey) return;
    lastKey = key;
    tray.setContextMenu(buildMenu());
    console.log(`[hexbox] 托盘状态：${status.text}（${status.detail}）`);
  };

  // 左键也给菜单（Windows 上左键默认什么都不做，用户会以为图标是死的）
  tray.on('click', () => tray.popUpContextMenu());

  console.log(
    `[hexbox] 托盘已创建：图标=${icon.path}（${icon.note}，` +
      `${icon.image.getSize().width}x${icon.image.getSize().height}）\n` +
      `         托盘菜单：${labels().join(' / ')}`,
  );
  refresh();

  return {
    refresh,
    menuLabels: labels,
    notify: (title, content) => {
      try {
        tray.displayBalloon({ title, content, iconType: 'info', noSound: true, largeIcon: false });
      } catch (e) {
        console.warn(`[hexbox] ⚠ 托盘气泡失败：${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
      console.log(
        `[hexbox] 🔔 托盘气泡：${title}｜${content}` +
          '（若系统通知被关闭/专注助手开着，气泡可能不显示 —— 托盘图标与 tooltip 不受影响）',
      );
      return true;
    },
  };
}
