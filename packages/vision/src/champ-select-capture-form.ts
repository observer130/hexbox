/**
 * 选人阶段「截屏形态」的两个候选与形态选择（纯函数，可单测）
 *
 * ── 为什么必须有它（2026-10-13 本机排查复现出的整链路失效）──────────────
 *
 * 选人阶段的截屏来自 `desktopCapturer({types:['window']})`（`main/vision-loop.ts`），
 * 拿到的一定是**窗口内容**。本机真机帧三条独立证据：
 *   · 帧比例 3413×1920 = 1.7776 = **窗口**比例（1600×900），而不是显示器比例 2.389
 *     —— 若截屏含桌面，比例必然是显示器的；
 *   · 卡片行中心 1703 ≈ 帧中心 1706（客户端 UI 在**窗口**里居中）；
 *   · 逐列平均亮度没有"桌面↔窗口"跳变（`champselect-*.png` 左缘 37→30→24→…），
 *     而真正含桌面的 `debug/real/verify1.png` 在 16% 处 254→36、85% 处 35→253。
 *
 * 但 `snapshotKind()` 在"截屏 / 显示器 / 窗口三者同比"时**没有信息可用**，
 * 只能退化成 `winShare = 窗口宽/显示器宽 < 0.9 → display` 去猜。而
 * **16:9 显示器 + 默认 1600×900 客户端窗口**恰好落进这个分支（0.83 < 0.9）
 * → 明明截屏就是窗口内容，却被当成"含桌面的显示器快照" → `windowRectToCapture`
 * 把搜索区缩成 `x/y 0.0833 + w/h 0.8333` → 标定几何整体偏 **90~130 px**
 * （远超边框吸附半径 ±0.005×窗口宽 ≈ 14 px）→ 候选卡判据四边全废（`Δ7/49/1/0`）、
 * 顶栏 11 个槽位整体错位（占用读到 10 格、NCC 一个都认不出）。
 *
 * 本机实测（同一批真机帧 + 线上代码，`debug/diag-snapshot-kind.mts`）：
 *
 * | 机器 | 退化判据 | 候选卡 | 顶栏（二阶段帧，真值 1 个头像） |
 * |---|---|---|---|
 * | 3440×1440 (21:9) + 客户端 1600×900（本机） | window | 2 张 ✅ | 占用 1 / 识别 1 ✅ |
 * | 1920×1080 (16:9) + 客户端 1600×900 | **display** | **0 张** ❌ | 占用 10 / **识别 0** ❌ |
 * | 2560×1440 (16:9) + 客户端 1600×900 | **display** | **0 张** ❌ | 占用 6 / **识别 0** ❌ |
 * | 2560×1600 (16:10) + 客户端 1600×900 | window | 2 张 ✅ | 占用 1 / 识别 1 ✅ |
 *
 * 本机之所以看不到：21:9 显示器的比例（2.389）与窗口比例（1.778）不同 →
 * 走的是正确的 window 分支。**这个 bug 只在"显示器与窗口同比例"时暴露**，
 * 而那正是最常见的组合（16:9 显示器 + 默认窗口）。
 *
 * ── 修法：不猜，两个形态都试（与局内 `region` + `altRegion` 同一套 doctrine）──
 *
 * 局内链路遇到"探针/形态不可信"时的处置是**两个候选区都搜一遍**，绝不猜
 * （见 `augment-panel.ts` 的 `detectAugmentPanelInRegions`）。选人路径照同一条规矩：
 *
 *   · 主形态 = `window`（来源就是窗口源，且它不需要任何假设）；
 *   · 备形态 = `display`（真的返回了含桌面的快照时用它）；
 *   · 谁"**看出内容**"用谁，判据有强弱：顶栏认出 ≥1 格 > 候选卡判据全过 > 主形态。
 *
 * ⚠️ `region`（识别用）与 `geo`（标签坐标用）**必须同出一个形态** ——
 * 否则会出现"卡片认出来了、标签画在别处"（错形态下标签横向差 50~130 DIP）。
 */

import {
  makeScreenGeometry,
  windowRectToCapture,
  type CaptureForm,
  type PhysicalRect,
} from './win-geometry.ts';
import type { CaptureGeometry, Rect } from './types.ts';

/** 候选形态的顺序：主 = 窗口（选人截屏的来源），备 = 显示器。 */
export const CAPTURE_FORM_ORDER: readonly CaptureForm[] = ['window', 'display'] as const;

/** 显示器信息（只用到这三项，避免依赖 Electron 类型）。 */
export interface CaptureDisplayLike {
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly scaleFactor: number;
  readonly workArea: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

/** 一个候选形态下的**全部**换算结果（region 与 geo 成对给出）。 */
export interface CaptureFormView {
  readonly form: CaptureForm;
  /** 游戏窗口在**截屏**里的归一化矩形（window 形态 = 恒等 0,0,1,1）。 */
  readonly region: Rect;
  /** 同一形态下的"归一化 → 屏幕逻辑坐标"换算（标签用）。 */
  readonly geo: CaptureGeometry;
  readonly scale: number;
  readonly estimated: boolean;
}

/** 两个归一化矩形是否等价（用来把"显示器快照 ≈ 全屏"的重复候选去掉）。 */
function sameRect(a: Rect, b: Rect): boolean {
  const eps = 1e-6;
  return (
    Math.abs(a.x - b.x) < eps &&
    Math.abs(a.y - b.y) < eps &&
    Math.abs(a.w - b.w) < eps &&
    Math.abs(a.h - b.h) < eps
  );
}

/**
 * 算出选人阶段要试的**形态候选**（顺序 = 优先级，已去重）。
 *
 * 去重口径：显示器形态算出来的区域与恒等矩形等价（窗口铺满显示器，
 * 或没有窗口矩形）时只剩一个候选 —— 那种情况下两个形态本来就是一回事。
 *
 * 不抛错：没有窗口矩形时两个形态算出来的都是恒等（退化），返回单个候选。
 */
export function champSelectCaptureForms(
  capture: { readonly width: number; readonly height: number },
  windowPhysical: PhysicalRect | null,
  display: CaptureDisplayLike,
): readonly CaptureFormView[] {
  const identity: Rect = { x: 0, y: 0, w: 1, h: 1 };
  const out: CaptureFormView[] = [];
  for (const form of CAPTURE_FORM_ORDER) {
    const geoOut = makeScreenGeometry(capture, windowPhysical, display, form);
    const region = windowRectToCapture(identity, capture, windowPhysical, display, form);
    const view: CaptureFormView = {
      form,
      region,
      geo: geoOut.geo,
      scale: geoOut.scale,
      estimated: geoOut.estimated,
    };
    const prev = out[out.length - 1];
    if (prev && sameRect(prev.region, view.region) && prev.geo.windowWidth === view.geo.windowWidth) {
      continue; // 两个形态几何等价 → 没必要试第二遍
    }
    out.push(view);
  }
  return out;
}

/**
 * 一种形态在本轮的读数（都是调用方**已经算好**的量，便于单测）。
 *
 * ⚠️ 未算的量必须如实给 0/`false`，不要为了"看起来有证据"而猜
 * （`identified = 0` 就是"一个都没认出来"，那一刻它确实不是证据）。
 */
export interface CaptureFormReading {
  readonly form: CaptureForm;
  /** 顶栏"有头像"的格数（占用检测）。 */
  readonly occupied: number;
  /** 顶栏**能认出英雄**的格数（NCC 匹配成功；形态错了必为 0）。 */
  readonly identified: number;
  /** 候选卡判据是否**全过**（错形态下必不过：边框吸附半径只有 ±0.5%）。 */
  readonly cardsConfident: boolean;
}

export interface CaptureFormChoice {
  /** 本轮采用的形态（调用方据此取 `region` 与 `geo`，**必须同出一个**）。 */
  readonly form: CaptureForm;
  /** 人读原因（进诊断行）。 */
  readonly reason: string;
}

/**
 * 从各形态的读数里挑**本轮该用哪个形态**（纯函数；判据强弱分三层）。
 *
 * 1. **顶栏认出 ≥1 格** → 用那个形态。识别是最强证据：形态错了 NCC 一个都认不出
 *    （真机实测：错形态下"占用 10 格、识别 0"）—— 而同名的方头像与模板同源，
 *    正确形态下得分 0.93+，不存在"运气好认出来"。
 * 2. 否则**候选卡判据全过**的形态 → 用那个形态（边框判据很严：错形态必然全不过）。
 * 3. 都没有证据 → **主形态**（= 列表第一个 = `window`），并如实说明"没有证据"。
 *
 * 平手（两个形态都认出来了）取 **identified 更多**的那个；再平手取靠前者（主形态优先）。
 *
 * ⚠️ 它**不**决定阶段（一阶段/二阶段）—— 阶段判定在调用方用**主形态**的占用读数做，
 * 本函数只回答"这一轮该按哪个形态取 `region` 与 `geo`"。两个分支各有一条**失败后
 * 对称兜底**（顶栏没认出 → 再试卡片；卡片两形态都不过 → 再问顶栏），
 * 所以"阶段判歪"不会变成"整块空白"。
 */
export function chooseChampSelectCaptureForm(
  readings: readonly CaptureFormReading[],
): CaptureFormChoice {
  const first = readings[0];
  if (!first) {
    // 调用方保证非空；真为空时给一个"什么都不用"的保守答案（不抛错：主进程不许因它崩）
    return { form: 'window', reason: '没有形态候选（调用方未给读数）' };
  }

  let best: CaptureFormReading | null = null;
  for (const r of readings) {
    if (r.identified > 0 && (best === null || r.identified > best.identified)) best = r;
  }
  if (best) {
    return { form: best.form, reason: `顶栏认出 ${best.identified} 格 → 形态 ${best.form}` };
  }

  const cards = readings.find((r) => r.cardsConfident);
  if (cards) {
    return { form: cards.form, reason: `候选卡判据在 ${cards.form} 形态下全过 → 形态 ${cards.form}` };
  }

  return {
    form: first.form,
    reason:
      `两个形态都没有内容证据（${readings
        .map((r) => `${r.form}: 占用${r.occupied}/识别${r.identified}`)
        .join('，')}）→ 用主形态 ${first.form}`,
  };
}
