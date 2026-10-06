/**
 * **覆盖窗自测**（不需要游戏、不需要进入任何阶段）：`HEXBOX_LABEL_OVERLAY_TEST=1`
 *
 * 为什么必须有它（S5.4c 真机事故的直接产物）：
 *   局内标签"报告里画了、屏幕上没有"这类问题，靠一局真机验证的代价太高
 *   （一局 20 分钟、条件不可控、要管理员 + 真实桌面），而且**窗口可见性**与
 *   识别/几何无关 —— 它是独立的一层。所以把这一层单独做成开关：
 *   启动后直接在屏幕上画左/中/右三个**大字母**，5 秒后自动退出，
 *   并在终端给出可判读的结论（窗口可见 / 置顶 / 画布真的出像素了）。
 *
 * 用法（**任意时刻**，不用开游戏；见 `apps/overlay/README.md`）：
 *   ```powershell
 *   $env:HEXBOX_LABEL_OVERLAY_TEST='1'; pnpm --filter @hexbox/overlay debug:augment
 *   ```
 *   （也可以用 `pnpm dev:overlay`，画的是**同一块**画布、同一份窗口代码。）
 *
 * 可调：`HEXBOX_LABEL_OVERLAY_TEST_MS`（默认 5000，毫秒）。
 *
 * 该自测**复用 `label-overlay.ts`**（创建/定位/置顶/推送/心跳全走正式那条路），
 * 所以窗口参数一旦有问题会被它直接暴露 —— 这正是它的意义。
 */

import { app, screen } from 'electron';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { canvasBitmapSize, labelOverlaySelftestLabels } from '@hexbox/vision';

import {
  attachLabelOverlayDiagnostics,
  createLabelOverlay,
  describeLabelOverlay,
  pushLabelOverlay,
} from './label-overlay.ts';
import { packagedArtifactDir } from './user-paths.ts';

/** 开关名（写进 apps/overlay/README.md，改这里必须同步文档）。 */
export const LABEL_OVERLAY_TEST_ENV = 'HEXBOX_LABEL_OVERLAY_TEST';
/** 停留时长（默认 5 秒后自动退出）。 */
export const LABEL_OVERLAY_TEST_MS_DEFAULT = 5000;
const TEST_MS_ENV = 'HEXBOX_LABEL_OVERLAY_TEST_MS';

/** 是否处于自测模式（=1）。 */
export function isLabelOverlaySelfTest(): boolean {
  return process.env[LABEL_OVERLAY_TEST_ENV] === '1';
}

/** 自测时长（毫秒；非法值回落默认）。 */
export function labelOverlaySelfTestMs(): number {
  const raw = Number(process.env[TEST_MS_ENV] ?? 0);
  return Number.isFinite(raw) && raw > 0 ? raw : LABEL_OVERLAY_TEST_MS_DEFAULT;
}

/**
 * 自测退出前的"**我为什么退出**"提示（真机事故：用户以为"覆盖层启动完就退出了"）。
 *
 * 根因不在代码而在环境：PowerShell 的 `$env:X='1'` 是**会话级**的。自测跑完
 * 按设计退出（exit 0）后，用户在**同一个终端窗口**里再跑 `pnpm dev:overlay`，
 * 变量仍然生效 → 仍旧画三个大字母、打印 ✅、再退出。所以退出前必须把
 * "为什么退出 + 怎么清掉"打在屏幕上，否则这条日志永远缺一块。
 *
 * 两个入口（`main/index.ts`、`debug-augment.ts`）都经由本模块退出，所以只在
 * 这里打印一处即可；**只加日志**，不碰判据、退出码、窗口/画布逻辑。
 */
export function logLabelOverlaySelfTestExitNotice(): void {
  const on = process.env[LABEL_OVERLAY_TEST_ENV] ?? '（未设置）';
  const rawMs = process.env[TEST_MS_ENV] ?? '（未设置）';
  // 其余 HEXBOX_* 只列**名字**：`HEXBOX_LCU_CREDENTIALS` 这类值里带令牌，不能连值一起打。
  const others = Object.keys(process.env)
    .filter((k) => k.startsWith('HEXBOX_') && k !== LABEL_OVERLAY_TEST_ENV && k !== TEST_MS_ENV)
    .sort();

  console.log(
    `⚠ 本进程处于自测模式（${LABEL_OVERLAY_TEST_ENV}=${on}）→ 上面那段结论就是全部工作，` +
      '**按设计退出**（退出码即结论，不是崩溃、也不是"启动完就退出"）。',
  );
  console.log(
    '  要正常常驻运行：Remove-Item Env:\\HEXBOX_LABEL_OVERLAY_TEST（或开一个新终端）—— ' +
      'PowerShell 的 $env: 赋值是**会话级**的，不清掉的话之后再跑 pnpm dev:overlay 仍会走自测并自动退出。',
  );
  console.log(
    `  当前生效的自测变量：${LABEL_OVERLAY_TEST_ENV}=${on}，` +
      `${TEST_MS_ENV}=${rawMs}（默认 ${LABEL_OVERLAY_TEST_MS_DEFAULT}ms，本次停留 ${labelOverlaySelfTestMs()}ms）`,
  );
  if (others.length > 0) {
    console.log(`  其它已设置的 HEXBOX_*（只列名，值可能含令牌）：${others.join(' ')}`);
  }
}

/**
 * 产物目录（真机截图便于复核）。
 *
 * ⚠️ 不能用固定的 `..\..\..\debug`：本模块会被打进两个入口，`__dirname`
 * 一个是 `dist/main`、一个是 `dist`（同一个坑见 `label-overlay.ts`）。
 * 按**仓库根**（`pnpm-workspace.yaml` 所在目录）定位最稳。
 *
 * ⚠️ **打包后没有仓库根**：双击 exe 时 cwd 可能是 `C:\Windows\System32`，
 * 往上找也永远找不到 `pnpm-workspace.yaml` → 旧实现会写到 cwd 下（写不进去
 * 或写到莫名其妙的地方）。所以打包后统一切到用户目录
 * `%LOCALAPPDATA%\hexbox\logs\selftest`（见 main/user-paths.ts）。
 */
function resolveDebugDir(): string {
  if (app.isPackaged) return packagedArtifactDir();
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return join(dir, 'debug');
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return join(process.cwd(), 'debug');
}

/** 渲染端回传的探针结果（画布像素 = 真的画上去了）。 */
interface SelfTestProbe {
  readonly innerW: number;
  readonly innerH: number;
  readonly canvasW: number;
  readonly canvasH: number;
  readonly dpr: number;
  /** 每个标签中心的像素 RGBA（alpha=0 → 那儿什么都没画）。 */
  readonly probes: ReadonlyArray<{
    readonly text: string;
    readonly rgba: readonly number[];
  }>;
}

export function runLabelOverlaySelfTest(): void {
  const display = screen.getPrimaryDisplay();
  // `labelOverlaySelftestLabels` 给的是**屏幕**逻辑坐标（与选人/局内标签同一条口径）；
  // 屏幕绝对 → 窗口内的平移由 `pushLabelOverlay` 统一做（见 main/label-overlay.ts）。
  const originX = display.workArea.x;
  const originY = display.workArea.y;
  const labels = labelOverlaySelftestLabels(display.workArea);
  const holdMs = labelOverlaySelfTestMs();

  console.log('\n──────── 覆盖窗自测（HEXBOX_LABEL_OVERLAY_TEST=1）────────');
  for (const d of screen.getAllDisplays()) {
    console.log(
      `  显示器 #${d.id} ${d.bounds.width}x${d.bounds.height}@${d.bounds.x},${d.bounds.y}` +
        ` 缩放${d.scaleFactor}` +
        (d.id === display.id ? '  ← 自测画在这块上' : ''),
    );
  }
  console.log(
    `  画在**主显示器**工作区 ${display.workArea.width}x${display.workArea.height}` +
      `@${display.workArea.x},${display.workArea.y}，停留 ${holdMs}ms 后自动退出`,
  );
  console.log('  应该看到：屏幕中线上三个大字母方块 —— 左 L / 中 C / 右 R（三秒内出现）。');
  console.log('  若一个都看不到：请把下面这段完整日志（含 ✅/❌ 结论）发回。\n');

  const win = createLabelOverlay({ display });
  attachLabelOverlayDiagnostics(win, 'label-selftest');

  const push = (): void =>
    pushLabelOverlay(win, display, {
      active: true,
      labels,
      diag: 'label-overlay-selftest（自测，非游戏数据）',
    });

  // ⚠️ loadFile 是异步的：建完立刻推的第一条消息会丢（S2 覆盖层同样如此），
  // 所以等首帧加载完成再推，并隔 400ms 再补一次（窗口 resize 可能晚于首帧）。
  win.webContents.once('did-finish-load', () => {
    console.log('[label-selftest] 渲染端已加载，开始画 3 个假标签');
    push();
    setTimeout(push, 400);
  });

  setTimeout(() => {
    void finish(
      win,
      // 探针读的是**画布像素**（窗口内坐标），所以按同一个工作区原点平移一次
      labels.map((l) => ({
        text: l.text,
        cx: l.x + l.w / 2 - originX,
        cy: l.y + l.h / 2 - originY,
      })),
    );
  }, holdMs);
}

async function finish(
  win: Electron.BrowserWindow,
  points: ReadonlyArray<{ readonly text: string; readonly cx: number; readonly cy: number }>,
): Promise<void> {
  if (win.isDestroyed()) {
    console.error('❌ 画布窗口已被销毁（进程/渲染端异常）—— 请把这段日志发回');
    logLabelOverlaySelfTestExitNotice();
    app.exit(1);
    return;
  }

  const probe = (await win.webContents
    .executeJavaScript(buildProbeScript(points))
    .catch(() => null)) as SelfTestProbe | null;

  const visible = win.isVisible();
  const onTop = win.isAlwaysOnTop();
  const drawn = (probe?.probes ?? []).filter((p) => (p.rgba[3] ?? 0) > 0).length;

  /**
   * 画布位图尺寸是否 = 窗口内尺寸 × DPR（用**渲染端同一个纯函数**算期望值）。
   *
   * 为什么单独判这一项：画布尺寸没设（脚本没加载 / 只在某条消息里设过）时，
   * canvas 会停在 HTML 默认的 300×150 —— 那时标签像素全是"空"，
   * 但**原因**是尺寸而不是"没画"，两者排查方向完全不同（真机事故 2026-10-05）。
   */
  const expected = probe ? canvasBitmapSize(probe.innerW, probe.innerH, probe.dpr) : null;
  const sized =
    probe !== null &&
    expected !== null &&
    probe.canvasW === expected.width &&
    probe.canvasH === expected.height;

  // 截图留证：渲染端确实画了的话，图里能看到三块（注意：capturePage 只证明
  // **画布内容**，屏幕上能否看见由 visible/alwaysOnTop + 人眼决定）。
  let shot = '';
  try {
    const image = await win.webContents.capturePage();
    const dir = resolveDebugDir();
    mkdirSync(dir, { recursive: true });
    shot = join(dir, 'label-overlay-selftest.png');
    writeFileSync(shot, image.toPNG());
  } catch {
    shot = '';
  }

  const ok = visible && onTop && sized && probe !== null && drawn === points.length;
  console.log('\n──────── 自测结论 ────────');
  console.log(`  窗口：${describeLabelOverlay(win)}`);
  console.log(
    `  画布：${probe ? `${probe.canvasW}x${probe.canvasH}（窗口内 ${probe.innerW}x${probe.innerH}，dpr ${probe.dpr}）` : '未取到（渲染端无响应）'}`,
  );
  if (probe && !sized) {
    console.log(
      `  ❌ 画布位图尺寸不对：应为 ${expected?.width}x${expected?.height}` +
        `（= 窗口内 ${probe.innerW}x${probe.innerH} × dpr ${probe.dpr}）——` +
        ' 渲染端没按窗口设置 canvas.width/height（300x150 = HTML 默认值，说明画布脚本没跑到）。',
    );
  }
  console.log(
    `  三个标签中心像素：${(probe?.probes ?? []).map((p) => `${p.text}=${(p.rgba[3] ?? 0) > 0 ? '已画' : '空'}`).join(' ')}`,
  );
  if (shot !== '') console.log(`  截图（画布内容）：${shot}`);
  console.log(
    ok
      ? '  ✅ 窗口可见 + 置顶 + 画布出像素 —— 覆盖窗链路正常；' +
          '若此刻屏幕上仍看不到字母，说明是**显示器/游戏遮挡**问题（把这段日志发回）。'
      : '  ❌ 覆盖窗有问题（详见上面各项）。请把整段日志发回，按 ❌ 的那一项定位。',
  );
  console.log('──────── 自测结束 ────────\n');
  // **退出前**把"为什么退出"说清楚：用户的真实误解是"覆盖层启动完就退出了"，
  // 而原因只是同一个终端里 $env: 还留着（见本函数注释）。
  logLabelOverlaySelfTestExitNotice();
  app.exit(ok ? 0 : 1);
}

/**
 * 渲染端探针：读标签中心像素的 alpha。
 *
 * 这是"真的画上去了吗"的唯一直接证据 —— 主进程只能看到自己推送了什么，
 * 看不到画布上有没有像素（真机事故里 `drawn: true` 就是这么骗人的）。
 */
function buildProbeScript(
  points: ReadonlyArray<{ readonly text: string; readonly cx: number; readonly cy: number }>,
): string {
  return `(() => {
  const c = document.getElementById('vision');
  if (!c) return null;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const dpr = window.devicePixelRatio || 1;
  const points = ${JSON.stringify(points)};
  const probes = points.map((p) => {
    const d = ctx.getImageData(Math.round(p.cx * dpr), Math.round(p.cy * dpr), 1, 1).data;
    return { text: p.text, rgba: [d[0], d[1], d[2], d[3]] };
  });
  return {
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    canvasW: c.width,
    canvasH: c.height,
    dpr,
    probes,
  };
})()`;
}
