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
 *
 * ── 菜单形态（用户 2026-10 拍板，**别再改**）─────────────────────────────
 *   `状态：xxx` / `数据更新时间：yyyy-mm-dd`（都是灰、不可点）/ 分隔 /
 *   `检查更新` / 分隔 / `退出`。
 *   **用户明确移除了 `打开日志` 与 `打开数据目录`** —— 排查入口改由文档与
 *   启动日志承担（日志绝对路径在启动第一行打印，位置见 README / RELEASE-WINDOWS）。
 *   逐条理由见下面 `menuTemplate()` 的注释。
 *
 * ── 「检查更新」只在这里转发 ─────────────────────────────────────────────
 *   真正联网/弹窗/下载的逻辑在 `main/update-flow.ts`：**只有用户点菜单才会联网**
 *   （不在启动时检查、不后台轮询、不自动下载 —— 用户明确要求）。
 *   菜单项文案直接来自流程的实时阶段（`正在检查更新…` / `正在下载更新… 42%`），
 *   这是"点完立刻有反应"的载体，别把它换成静态文字。
 */

import { app, Menu, nativeImage, Tray } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  TRAY_TOOLTIP_HINT,
  trayTooltipText,
  updateMenuEnabled,
  updateMenuText,
  type DataUpdateStamp,
  type TrayStatus,
  type UpdatePhase,
} from '@hexbox/vision';

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
  /**
   * 数据更新时间（纯函数 `dataUpdateStamp()` 的结果）。
   *
   * ⚠️ 口径（官方 `meta.dataDate` 优先、`dataset.json` 的 mtime 回退）由
   * `@hexbox/vision/data-update-stamp.ts` 决定并在**菜单文案里标明**；
   * 这里只负责把那一行显示成灰色、不可点。
   */
  readonly dataUpdate: () => DataUpdateStamp;
  /**
   * 「检查更新」当前阶段（决定菜单项文案/是否可点）。
   *
   * 阶段文案本身就是"点了之后有反应"的载体（`正在检查更新…` / `正在下载更新… 42%`），
   * 所以它必须来自流程的**实时**状态，而不是这里自己维护一份。
   */
  readonly updatePhase: () => UpdatePhase;
  /** 点「检查更新」→ 交给 `main/update-flow.ts`（联网只在这一次点击之后发生）。 */
  readonly onCheckUpdate: () => void;
}

export interface TrayHandle {
  /** 重算状态并刷新菜单/tooltip（阶段变化时调；变没变由这里自己判断并打日志）。 */
  refresh(): void;
  /** 弹一次性气泡（返回是否真的弹了 —— 没有托盘时返回 false）。 */
  notify(title: string, content: string): boolean;
  /** 当前菜单项文字（自测把它打进日志 = "托盘存在且菜单完整"的证据）。 */
  menuLabels(): string[];
  /**
   * 当前菜单的**逐项**清单（文本 + 是否禁用 + 类型）。
   *
   * 为什么要有它：托盘菜单在自动化里点不了（机器人没有鼠标），而"菜单里到底是哪几项、
   * 哪几项是灰的"正是这次改动唯一能被机器证明的部分（见 `runTrayAutotest`）。
   */
  menuItems(): { readonly label: string; readonly enabled: boolean; readonly type: string }[];
}

/**
 * 菜单模板（用户 2026-10 拍板的**六条**，逐条对应）。
 *
 *   1. `状态：xxx`            —— 保留（灰、不可点）
 *   2. `数据更新时间：yyyy-mm-dd`—— **新增**（灰、不可点；口径写在文案里）
 *   3. ~~打开日志~~           —— **移除**（用户明确要求；日志绝对路径在启动时打印，
 *                                位置见 README/RELEASE-WINDOWS；**不新增菜单项**）
 *   4. ~~打开数据目录~~        —— **移除**（同上）
 *   5. `检查更新`             —— **新增**（可点；只在点击后才联网）
 *   6. `退出`                 —— 保留（**唯一**的真退出入口 → `quitApp()`）
 *
 * ⚠️ 移除那两项是**用户决策**，不是遗漏：它们占用了菜单里最显眼的位置，而
 * 排查用的路径（日志/数据目录）已经写在文档与启动日志里。别"顺手加回来"。
 */
function menuTemplate(deps: TrayDeps): Electron.MenuItemConstructorOptions[] {
  const status = deps.status();
  const data = deps.dataUpdate();
  const phase = deps.updatePhase();
  return [
    // 两条只读信息：用户判断"它到底在干什么 / 数据是哪天的"的唯一现场依据
    { label: `状态：${status.text}`, enabled: false },
    { label: data.label, enabled: false },
    { type: 'separator' },
    {
      label: updateMenuText(phase),
      enabled: updateMenuEnabled(phase),
      click: () => deps.onCheckUpdate(),
    },
    { type: 'separator' },
    { label: '退出', click: () => quitApp('托盘菜单') },
  ];
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
  const items = (): { label: string; enabled: boolean; type: string }[] =>
    menuTemplate(deps).map((item) => ({
      label: item.label ?? `(${item.type})`,
      // 没写 enabled 的项在 Electron 里默认是**可点**的，这里如实还原
      enabled: item.enabled ?? item.type !== 'separator',
      type: item.type ?? 'normal',
    }));
  const buildMenu = (): Electron.Menu => Menu.buildFromTemplate(menuTemplate(deps));

  const refresh = (): void => {
    const status = deps.status();
    const update = deps.updatePhase();
    tray.setToolTip(trayTooltipText(status));
    // 每 2 秒轮询都会调一次 refresh：只有内容真的变了才重建菜单并打日志
    //（Menu 对象每次都重建会白造垃圾；日志每 2 秒一行会把真机日志淹掉）
    // ⚠️ 检查更新的阶段（正在检查/正在下载 x%）也在 key 里：它一变菜单就得重建，
    //    否则用户点了「检查更新」看不到任何反应（download 进度就靠这一行）。
    const key = [
      status.text,
      status.detail,
      deps.dataUpdate().label,
      update.kind,
      updateMenuText(update),
    ].join('\u0000');
    if (key === lastKey) return;
    lastKey = key;
    tray.setContextMenu(buildMenu());
    console.log(
      `[hexbox] 托盘状态：${status.text}（${status.detail}）` +
        // 非空闲时把菜单项文案也打出来：这条日志是"点了之后菜单真的变了"的证据
        (update.kind === 'idle' ? '' : `；检查更新菜单项=${updateMenuText(update)}`),
    );
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
    menuItems: items,
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
