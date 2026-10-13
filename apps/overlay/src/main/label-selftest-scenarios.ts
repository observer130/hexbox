/**
 * 覆盖窗自测的**场景序列**（按同类产品**已发货的**线上反馈分类来设计要验什么）
 *
 * 三个场景各自对应一类"真机上代价很高、但这里几秒钟就能验"的失败：
 *
 *   ① **悬停提示框**：模拟一次 mousemove（`forward: true` 送进来的那条通道），
 *      断言标签**下方**真的出现了非透明像素；鼠标移开后必须**完全没有残留**
 *      （否则会有一块"鬼提示框"永远挂在屏幕上）。
 *   ② **清空无残留**（对应"玩了几局后不显示"里最难查的一种：上一局的标签/提示框
 *      留在画布上，看起来像"这一局没画"）：推 `active:false` 后整块画布必须干净，
 *      再推回来必须能重新画出来。
 *   ③ **改尺寸后画布跟随**（对应"显示信息偏移"里最硬的一条：分辨率/缩放变化后
 *      画布尺寸没跟着窗口走 → 所有坐标都偏）：缩小窗口后重新推一帧，
 *      画布位图尺寸必须仍等于 `窗口内尺寸 × DPR`。
 *
 * ── 为什么这一段不在 `label-selftest.ts` 里直接写 ──────────────────────────
 *
 * `label-selftest.ts` 直接依赖 Electron（`app`/`screen`/`BrowserWindow`），
 * 而 Electron 在 CI 里跑不起来 —— 那么这段"判定逻辑"就永远没有测试。
 * 所以这里只依赖一个**注入的 host**（执行 JS / 读写窗口矩形 / 推一帧），
 * 于是它可以在 Node 里被单测（见 `label-selftest-scenarios.test.ts`），
 * `label-selftest.ts` 只负责把真实的 BrowserWindow 接上去。
 */

/** 一个矩形（窗口内逻辑 DIP）。 */
export interface ScenarioRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** 自测场景需要宿主提供的最小能力（真实实现是 BrowserWindow + label-overlay）。 */
export interface ScenarioHost {
  /** 在渲染端执行一段 JS（返回它 `return` 的值）。 */
  readonly run: (script: string) => Promise<unknown>;
  readonly bounds: () => { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly setBounds: (b: { x: number; y: number; width: number; height: number }) => void;
  /** 推一帧**正常标签**。 */
  readonly pushLabels: () => void;
  /** 推一帧 `active:false`（清空画布）。 */
  readonly pushEmpty: () => void;
  /**
   * 提示框**正在显示**时回调一次（可选）。
   *
   * 用途：真机自测在这里截一张图（`label-overlay-hover.png`）—— 用户/复核者
   * 直接看图就知道"悬停提示框长什么样"，不用自己动手悬停。它**不参与判定**，
   * 抛错也只记一行（截图失败不该让自测失败）。
   */
  readonly onHoverShown?: () => Promise<void> | void;
}

export interface ScenarioOptions {
  /** 中间那个标签（窗口内坐标）—— 悬停与"还在不在"都验它。 */
  readonly centerLabel: ScenarioRect;
  /** 标签所在的**屏幕**工作区原点（屏幕坐标 → 窗口内坐标要减它）。 */
  readonly originX: number;
  readonly originY: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** 各步骤之间的等待（默认值够真实 Electron 用；单测可调小）。 */
  readonly waitMs?: number;
}

export interface ScenarioResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface ScenarioReport {
  readonly results: readonly ScenarioResult[];
  readonly ok: boolean;
}

const DEFAULT_WAIT_MS = 200;

/** 提示框探针区域（比提示框实际尺寸大一圈，只判"这儿到底有没有像素"）。 */
export function tooltipProbeRect(centerLabel: ScenarioRect, originX: number, originY: number): ScenarioRect {
  const cx = centerLabel.x + centerLabel.w / 2 - originX;
  const bottom = centerLabel.y + centerLabel.h - originY;
  return { x: Math.round(cx - 180), y: Math.round(bottom + 2), w: 360, h: 220 };
}

/** 标签本体的探针区域（窗口内坐标）。 */
export function labelProbeRect(centerLabel: ScenarioRect, originX: number, originY: number): ScenarioRect {
  return {
    x: Math.round(centerLabel.x - originX),
    y: Math.round(centerLabel.y - originY),
    w: Math.round(centerLabel.w),
    h: Math.round(centerLabel.h),
  };
}

/** 数一块区域里**非透明**像素的个数（渲染端执行；DPR 由渲染端自己乘）。 */
function countPixelsScript(rect: ScenarioRect): string {
  return `(() => {
  const c = document.getElementById('vision');
  if (!c) return -1;
  const ctx = c.getContext('2d');
  if (!ctx) return -1;
  const dpr = window.devicePixelRatio || 1;
  const x = Math.max(0, Math.round(${rect.x} * dpr));
  const y = Math.max(0, Math.round(${rect.y} * dpr));
  const w = Math.max(1, Math.min(c.width - x, Math.round(${rect.w} * dpr)));
  const h = Math.max(1, Math.min(c.height - y, Math.round(${rect.h} * dpr)));
  const d = ctx.getImageData(x, y, w, h).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
  return n;
})()`;
}

/** 画布尺寸探针（渲染端）。 */
const CANVAS_PROBE = `(() => {
  const c = document.getElementById('vision');
  if (!c) return null;
  return { innerW: window.innerWidth, innerH: window.innerHeight, canvasW: c.width, canvasH: c.height, dpr: window.devicePixelRatio || 1 };
})()`;

/** 在某个窗口内坐标上派发一次 mousemove（坐标可以为负 = "移到窗口外"）。 */
function hoverScript(x: number, y: number): string {
  return `(() => {
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: ${x}, clientY: ${y}, bubbles: true }));
  return true;
})()`;
}

interface CanvasProbe {
  readonly innerW: number;
  readonly innerH: number;
  readonly canvasW: number;
  readonly canvasH: number;
  readonly dpr: number;
}

function asCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : -1;
}

/**
 * 跑完三个场景。**永不抛**：任何异常都被记成该场景的 ❌ 与原因
 * （自测的用途就是"出问题时把所有信息带回来"，半路抛掉等于什么都没验）。
 */
export async function runLabelOverlayScenarios(
  host: ScenarioHost,
  options: ScenarioOptions,
): Promise<ScenarioReport> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const wait = options.waitMs ?? DEFAULT_WAIT_MS;
  const results: ScenarioResult[] = [];

  const labelBox = labelProbeRect(options.centerLabel, options.originX, options.originY);
  const tipBox = tooltipProbeRect(options.centerLabel, options.originX, options.originY);
  const hoverX = options.centerLabel.x + options.centerLabel.w / 2 - options.originX;
  const hoverY = options.centerLabel.y + options.centerLabel.h / 2 - options.originY;

  const count = async (rect: ScenarioRect): Promise<number> => {
    try {
      return asCount(await host.run(countPixelsScript(rect)));
    } catch {
      return -1;
    }
  };

  /* ① 悬停提示框：出现 → 移开 → 不残留 --------------------------------- */
  try {
    host.pushLabels();
    await sleep(wait);
    const before = await count(tipBox);
    await host.run(hoverScript(hoverX, hoverY));
    await sleep(wait);
    const hovered = await count(tipBox);
    // 提示框正显示：给宿主一次截图/取证的机会（不参与判定）
    try {
      await host.onHoverShown?.();
    } catch {
      // 截图失败无所谓 —— 判定本身已经拿到了像素证据
    }
    await host.run(hoverScript(-50, -50)); // 移到窗口外
    await sleep(wait);
    const afterLeave = await count(tipBox);
    const ok = before === 0 && hovered > 0 && afterLeave === 0;
    results.push({
      name: '悬停提示框（forward 进来的 mousemove）',
      ok,
      detail:
        `悬停前 ${before} 像素 → 悬停中 ${hovered} 像素 → 移开后 ${afterLeave} 像素` +
        (ok ? '' : '（期望：0 → >0 → 0）'),
    });
  } catch (e) {
    results.push({ name: '悬停提示框（forward 进来的 mousemove）', ok: false, detail: `异常：${String(e)}` });
  }

  /* ② 清空无残留 + 能再画回来 ------------------------------------------- */
  try {
    host.pushEmpty();
    await sleep(wait);
    const cleared = await count(labelBox);
    const tipCleared = await count(tipBox);
    host.pushLabels();
    await sleep(wait);
    const redrawn = await count(labelBox);
    const ok = cleared === 0 && tipCleared === 0 && redrawn > 0;
    results.push({
      name: '清空无残留（长会话不累积）',
      ok,
      detail:
        `推空后标签区 ${cleared} / 提示框区 ${tipCleared} 像素，再推回后标签区 ${redrawn} 像素` +
        (ok ? '' : '（期望：0 / 0 → >0）'),
    });
  } catch (e) {
    results.push({ name: '清空无残留（长会话不累积）', ok: false, detail: `异常：${String(e)}` });
  }

  /* ③ 改窗口尺寸后画布必须跟着走 ---------------------------------------- */
  try {
    const before = host.bounds();
    const shrunk = {
      x: before.x,
      y: before.y,
      width: Math.max(320, Math.round(before.width * 0.8)),
      height: Math.max(240, Math.round(before.height * 0.8)),
    };
    host.setBounds(shrunk);
    await sleep(wait * 2); // 等 resize 事件 + 渲染端重设画布（它自己还有 50ms 延时）
    host.pushLabels();
    await sleep(wait);
    const probe = (await host.run(CANVAS_PROBE)) as CanvasProbe | null;
    let ok = false;
    let detail = '渲染端没有响应（拿不到画布尺寸）';
    if (probe) {
      const expectW = Math.max(1, Math.round(probe.innerW * (probe.dpr > 0 ? probe.dpr : 1)));
      const expectH = Math.max(1, Math.round(probe.innerH * (probe.dpr > 0 ? probe.dpr : 1)));
      const sized = probe.canvasW === expectW && probe.canvasH === expectH;
      // 标签中心还在缩小的窗口里才检查像素（否则被裁掉是对的，不该判失败）
      const inside = labelBox.x + labelBox.w / 2 <= probe.innerW && labelBox.y + labelBox.h / 2 <= probe.innerH;
      const pixels = inside ? await count(labelBox) : -2;
      ok = sized && (!inside || pixels > 0);
      detail =
        `画布 ${probe.canvasW}x${probe.canvasH} vs 期望 ${expectW}x${expectH}` +
        `（窗口内 ${probe.innerW}x${probe.innerH}，dpr ${probe.dpr}）` +
        (inside ? `；标签区 ${pixels} 像素` : '；标签中心已在新窗口外，只判尺寸');
    }
    host.setBounds(before); // 复原，免得影响后面的截图
    await sleep(wait);
    host.pushLabels();
    results.push({ name: '改尺寸后画布跟随窗口', ok, detail });
  } catch (e) {
    results.push({ name: '改尺寸后画布跟随窗口', ok: false, detail: `异常：${String(e)}` });
  }

  return { results, ok: results.every((r) => r.ok) };
}
