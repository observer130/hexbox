/**
 * 局内**全分辨率识别**的纯函数核心（渲染端 worker 与离线回放**共用同一份**）
 *
 * 为什么要有这个文件（2026-10-12）：识别此前只长在渲染端 `capture/worker.ts` 里，
 * 而它是**唯一没有注入缝的一段** —— 离线回放能驱动门控、能驱动触发状态机，却到不了
 * "认名字 → 查强度 → 画标签"这一段（`externalCapture` 路径下 `stream.recognize()`
 * 是空操作）。把它抽成纯函数有三个直接好处：
 *
 *   1. **回放能跑到标签**：会话回放把帧库里的原生帧喂给同一个函数；
 *   2. **它能被单测**：以前 `pnpm test` 一行都碰不到这段（真机才能验）；
 *   3. **不会漂移**：worker 与回放调的是这一份 —— 这个项目踩过
 *      "诊断脚本与主流程两份实现"的坑，绝不允许再有第二份。
 *
 * 纯到什么程度：**不碰 DOM、不碰 fs、不碰时钟**。像素通过 `RecognizePixels` 注入
 * （worker 用 `drawImage`+`getImageData`，回放用 `cropBitmap` 从解码好的帧里裁），
 * 跨调用的状态（冻结矩形 / 指纹基线）**显式进出**（`input` 给入、返回值给出）。
 * 这样"单卡重随不重新冻结几何"那类时间相关的不变量才可能被测试锁住。
 *
 * ⚠️ 语义细节**一个字都不能改**（每一条都有真机事故作背景，见 docs/AUGMENT-PANEL.md
 * §十五与 `augment-controller.ts` 的注释）：
 *   · 取样矩形在面板停留期间**冻结**（否则检测抖动的 ±1~2px 会让"没变"的内容也测出距离）；
 *   · 重随（reroll）路径**什么都不重新冻结**：裁剪与回传几何一律用冻结矩形
 *     （面板存续期间卡片不动，本帧检测出来的是翻牌动画中间帧 —— 真机"三个标签整体下移"）；
 *   · 指纹一律在**门控画布**上算（与后续帧同一分辨率），且基线只在整批识别时推进。
 */

import {
  cropBitmap,
  detectAugmentPanelInRegions,
  PANEL_THRESHOLDS,
  type PanelCard,
} from './augment-panel.ts';
import {
  readAugmentName,
  type AugmentNameFingerprint,
} from './augment-ocr.ts';
import { resolveOpenRecognizeCards } from './augment-open-recognize.ts';
import {
  augmentCardFingerprint,
  type AugmentCardFingerprint,
} from './augment-reroll.ts';
import type { Bitmap, Rect } from './types.ts';

/* ------------------------------------------------------------------ */
/* 类型（**规范定义在这里**；worker 只是再导出，避免两处各写一份）        */
/* ------------------------------------------------------------------ */

/** 一张卡的识别结果（`augmentId` 为 null = 没认出来，调用方**不要画**）。 */
export interface RecognizedCard {
  readonly rect: Rect;
  readonly interiorLuma: number;
  readonly edgeLuma: number;
  readonly augmentId: number | null;
  readonly name: string | null;
  readonly score: number | null;
  readonly margin: number | null;
}

/** 识别报告的触发原因：面板开边沿的整批识别 / 面板停留期间的**单卡刷新**重识别。 */
export type RecognizeOrigin = 'open' | 'reroll';

/** 全分辨率识别报告（回传主进程的小 JSON）。 */
export interface RecognizedReport {
  readonly ok: boolean;
  readonly reason: string;
  readonly cards: readonly RecognizedCard[];
  readonly regionIndex?: number;
  readonly tookMs: number;
  readonly width?: number;
  readonly height?: number;
  /** 触发原因（`open` = 开边沿整批；`reroll` = 面板停留期间某张卡被换掉）。 */
  readonly origin: RecognizeOrigin;
  /** `origin === 'reroll'`：这次重认的卡片序号（与 `cards` 一一对应）。 */
  readonly refreshed?: readonly number[];
  /**
   * 本次（重）识别之后、**当前冻结取样矩形**下的每卡指纹。
   *
   * 主进程把它当作**重随检测的基线**：基线必须来自"这一帧画的是哪颗海克斯"，
   * 而不是随便一帧 —— 否则开面板动画或一次抖动就会被当成刷新。
   */
  readonly fingerprints: readonly (AugmentCardFingerprint | null)[];
}

/**
 * 原生帧像素来源（**注入**：worker 从屏幕流取、回放从文件解码）。
 *
 * 为什么不是"直接给一个整幅 Bitmap"：单卡重随只重认变化的那一张卡，
 * 真机上整帧 `drawImage`+`getImageData` 是 19.8MB 级开销（几十毫秒），
 * 而一张卡只有约 1.1MB。`readRect` 让 worker 能只取那一块，
 * 回放侧则从已经解码好的整帧上裁 —— 两边行为一致、成本各自最优。
 */
export interface RecognizePixels {
  readonly width: number;
  readonly height: number;
  /** 整幅原生帧（开边沿整批识别用）；拿不到返回 null。 */
  readFull(): Bitmap | null;
  /** 只取一个**归一化**区域（单卡重随用）；越界/取不到返回 null。 */
  readRect(rect: Rect): Bitmap | null;
}

/** 形如 `{ augmentedId, name, width, height, bits }` 的识别库（主进程下发）。 */
export type AugmentRecognizeLibrary = readonly AugmentNameFingerprint[];

/* ------------------------------------------------------------------ */
/* 开边沿：整批识别                                                     */
/* ------------------------------------------------------------------ */

export interface RecognizeOpenInput {
  /** 像素来源；null = 流未就绪（会走"未命中"报告）。 */
  readonly pixels: RecognizePixels | null;
  /** 候选搜索区（主区 + 备用区，**归一化**，与线上同一份）。 */
  readonly regions: readonly Rect[];
  readonly library: AugmentRecognizeLibrary;
  /**
   * 最近一次**卡片判据命中**那一帧检出的卡片（线上 `lastHitCards`）。
   *
   * 原生重检失败时用它兜底（真机：门控在 1/3 分辨率上量到 39 命中、
   * 原生 1:1 量到 40 失败 → 整块面板 25.7 秒一个标签都没有）。
   */
  readonly gatingCards: readonly PanelCard[];
  /**
   * **指纹取样基底**：`bitmap` 与 `rects` 必须**同一坐标系**。
   *
   * 为什么单独拆出来（2026-10-12 审查发现）：线上的门控画布就是**整幅**，两者天然同基底；
   * 而帧库可以是**裁剪存档**（`augment-session.ts` 的 `crop`）—— 那时"卡片矩形"在画布坐标下、
   * "帧像素"在裁剪坐标下，拿画布矩形去采裁剪位图的像素会**静默地取错位置**（基线指纹全错，
   * 而表现只是"重随检测不灵"）。把它变成显式输入后，两边各自传自己基底的矩形，不再有暗契。
   */
  readonly fingerprintBasis: {
    /** 算指纹用的位图（线上 = 门控画布；回放 = 帧库里的那一帧）。 */
    readonly bitmap: Bitmap | null;
    /** 取样矩形（**与 `bitmap` 同基底**；`null`/空 = 还没识别过）。 */
    readonly rects: readonly Rect[] | null;
  };
  /** 已冻结的卡片矩形（失败路径要**原样保留**，所以进也要出）。 */
  readonly frozenRects: readonly Rect[] | null;
  /** 已冻结的指纹取样矩形（失败路径原样保留）。 */
  readonly watchRects: readonly Rect[] | null;
  /** 最近一次算出的每卡指纹（失败路径原样回传）。 */
  readonly fingerprints: readonly (AugmentCardFingerprint | null)[];
  readonly tookMs: number;
}

export interface RecognizeOpenOutput {
  readonly report: RecognizedReport;
  readonly frozenRects: readonly Rect[] | null;
  readonly watchRects: readonly Rect[] | null;
  readonly fingerprints: readonly (AugmentCardFingerprint | null)[];
  /** 需要调用方打日志的一行（例如"原生重检失败 → 用门控矩形"）；无则 null。 */
  readonly note: string | null;
}

/**
 * 开边沿整批识别：原生帧重检 → 矩形来源决策（原生 / 门控兜底）→ 逐卡 OCR → 冻结几何。
 */
export function recognizeOpen(input: RecognizeOpenInput): RecognizeOpenOutput {
  const origin: RecognizeOrigin = 'open';
  const echo = {
    frozenRects: input.frozenRects,
    watchRects: input.watchRects,
    fingerprints: input.fingerprints,
  };
  const fail = (reason: string, regionIndex?: number): RecognizeOpenOutput => ({
    report: {
      ok: false,
      reason,
      cards: [],
      ...(regionIndex !== undefined ? { regionIndex } : {}),
      tookMs: input.tookMs,
      origin,
      fingerprints: input.fingerprints,
    },
    ...echo,
    note: null,
  });

  const pixels = input.pixels;
  if (!pixels || pixels.width === 0 || pixels.height === 0) return fail('流未就绪');
  const full = pixels.readFull();
  if (!full) return fail('原生帧取像素失败');

  const regions = input.regions.length > 0 ? input.regions : [{ x: 0, y: 0, w: 1, h: 1 }];
  const hit = detectAugmentPanelInRegions(full, regions);

  // 卡片矩形的**来源决策**：原生重检成功用原生（更精确），失败退回门控验过的矩形。
  // 纯函数在 `augment-open-recognize.ts`（有单测），这里只调它。
  const plan = resolveOpenRecognizeCards({
    native: hit.detection,
    gating: input.gatingCards,
    minCards: PANEL_THRESHOLDS.minCards,
  });
  if (plan.source === 'none') {
    return {
      ...fail(plan.reason, hit.regionIndex),
      note: null,
    };
  }
  const note = plan.source === 'gating' ? `⚠ ${plan.reason}` : null;

  const cards: RecognizedCard[] = plan.cards.map((c) => {
    const m = input.library.length > 0 ? readAugmentName(full, c.rect, input.library) : null;
    return {
      rect: c.rect,
      interiorLuma: Math.round(c.interiorLuma),
      edgeLuma: Math.round(c.edgeLuma),
      augmentId: m?.augmentId ?? null,
      name: m?.name ?? null,
      score: m ? Number(m.score.toFixed(3)) : null,
      margin: m ? Number(m.margin.toFixed(3)) : null,
    };
  });

  // 整批识别之后把取样矩形**冻结**在"当前门控帧检出的卡片矩形"上，
  // 并用同一张门控画布算基线指纹（与后续帧同一分辨率 —— 否则会白差一点点距离）。
  // 同时把**裁剪/标签几何**用的卡片矩形冻在"这一批识别报告的 rect"上。
  const frozenRects = cards.map((c) => c.rect);
  const refrozen = refreeze(input.fingerprintBasis);
  return {
    report: {
      ok: true,
      reason: hit.detection.reason,
      cards,
      ...(hit.regionIndex !== undefined ? { regionIndex: hit.regionIndex } : {}),
      tookMs: input.tookMs,
      width: pixels.width,
      height: pixels.height,
      origin,
      fingerprints: refrozen.fingerprints,
    },
    frozenRects,
    watchRects: refrozen.watchRects,
    fingerprints: refrozen.fingerprints,
    note,
  };
}

/**
 * 重新**冻结**取样矩形并算基线指纹（只有整批识别才调）。
 *
 * 门控帧里检不出卡片（或还没拿到门控画布）→ 清空取样矩形：下一块面板必须重新定，
 * 绝不能让上一块的矩形跨面板复用。
 *
 * ⚠️ 返回的 `watchRects` 与 `fingerprintBasis.bitmap` **同基底**（调用方之后每帧取指纹时必须用同一张位图）。
 */
function refreeze(basis: {
  readonly bitmap: Bitmap | null;
  readonly rects: readonly Rect[] | null;
}): {
  watchRects: readonly Rect[] | null;
  fingerprints: readonly (AugmentCardFingerprint | null)[];
} {
  if (!basis.bitmap || !basis.rects || basis.rects.length === 0) {
    return { watchRects: null, fingerprints: [] };
  }
  const watchRects = [...basis.rects];
  return {
    watchRects,
    fingerprints: watchRects.map((r) => augmentCardFingerprint(basis.bitmap!, r)),
  };
}

/* ------------------------------------------------------------------ */
/* 面板停留：单卡刷新（reroll）重识别                                    */
/* ------------------------------------------------------------------ */

export interface RecognizeRerollInput {
  readonly pixels: RecognizePixels | null;
  /** 要重认的卡片序号（主进程按指纹结构距离判出来的）。 */
  readonly only: readonly number[];
  /** 最近一帧门控检出的卡片（拿它的亮度字段；几何一律用冻结矩形）。 */
  readonly latestCards: readonly PanelCard[];
  /** 冻结的卡片矩形（上一次整批识别报告的 `rect`）。 */
  readonly frozenRects: readonly Rect[] | null;
  readonly library: AugmentRecognizeLibrary;
  /** 沿用已冻结取样矩形在最近一帧门控画布上的结果（重随不重新冻结几何）。 */
  readonly fingerprints: readonly (AugmentCardFingerprint | null)[];
  readonly tookMs: number;
}

export interface RecognizeRerollOutput {
  readonly report: RecognizedReport;
  /** 需要调用方打日志的行（检测矩形与冻结矩形差得明显 = 正在翻牌动画里）。 */
  readonly notes: readonly string[];
}

/**
 * 单卡重随：只重认被换掉的那几张卡。
 *
 * 最终产物见 `apps/overlay/src/capture/worker.ts`（渲染端入口），这里保持逐字一致：
 * 冻结矩形优先、取不到就按"认不出"处理（标签必须消失，绝不能留旧字母）。
 */
export function recognizeReroll(input: RecognizeRerollInput): RecognizeRerollOutput {
  const origin: RecognizeOrigin = 'reroll';
  const only = input.only;
  const fail = (reason: string): RecognizeRerollOutput => ({
    report: {
      ok: false,
      reason,
      cards: [],
      tookMs: input.tookMs,
      origin,
      refreshed: [...only],
      fingerprints: input.fingerprints,
    },
    notes: [],
  });

  const pixels = input.pixels;
  if (!pixels || pixels.width === 0) return fail('流未就绪');

  const notes: string[] = [];
  const cards: RecognizedCard[] = [];
  const refreshed: number[] = [];
  for (const index of only) {
    refreshed.push(index);
    const panelCard = input.latestCards[index];
    // ⚠️ **只认冻结矩形**：面板存续期间卡片不动，本帧检测出来的是翻牌动画中间帧，
    //    拿它当几何 = 整排标签下移（真机二次验收的缺陷就是这么来的）。
    //
    // 没有冻结矩形时**绝不回退到本帧检测矩形**（那正好是动画帧）：宁可这一轮不画，
    // 也不能把中间的几何/内容当成结果 —— 这是"宁漏勿错"在单卡刷新上的落地。
    const rect = input.frozenRects?.[index] ?? null;
    if (!rect) {
      notes.push(`卡${index}：没有冻结矩形 → 跳过识别（不许用本帧检测矩形兜底）`);
      cards.push(emptyCard({ x: 0, y: 0, w: 0, h: 0 }));
      continue;
    }
    const shift = describeRectShift(index, rect, panelCard?.rect ?? null);
    if (shift !== null) notes.push(shift);
    // 只把这一张卡的区域按原生分辨率取出来（比整帧小一个量级）
    const region = pixels.readRect(rect);
    const m =
      region && input.library.length > 0
        ? readAugmentName(region, { x: 0, y: 0, w: 1, h: 1 }, input.library)
        : null;
    cards.push({
      rect,
      interiorLuma: panelCard ? Math.round(panelCard.interiorLuma) : 0,
      edgeLuma: panelCard ? Math.round(panelCard.edgeLuma) : 0,
      augmentId: m?.augmentId ?? null,
      name: m?.name ?? null,
      score: m ? Number(m.score.toFixed(3)) : null,
      margin: m ? Number(m.margin.toFixed(3)) : null,
    });
  }

  return {
    report: {
      ok: true,
      reason: `单卡重随：只重认卡 ${refreshed.map((i) => i + 1).join('/')}`,
      cards,
      refreshed,
      origin,
      tookMs: input.tookMs,
      width: pixels.width,
      height: pixels.height,
      fingerprints: input.fingerprints,
    },
    notes,
  };
}

/** 认不出/取不到时的占位卡（`augmentId: null` → 调用方**清掉该卡标签**）。 */
export function emptyCard(rect: Rect): RecognizedCard {
  return { rect, interiorLuma: 0, edgeLuma: 0, augmentId: null, name: null, score: null, margin: null };
}

/**
 * 重随重识别时"本帧检测矩形 vs 冻结矩形"的相对差超过这个值就报一行日志。
 *
 * 单位是**帧宽/帧高**（归一化）；0.005 在 1440 高的真机帧上 ≈7 物理像素 ——
 * 比标定过的 ±1~2px 检测抖动大得多，所以只有"真在动画里"才报。
 * 它**只用于记日志**：几何一律以冻结矩形为准。
 */
export const REROLL_RECT_SHIFT_TOLERANCE = 0.005;

/**
 * 记一条"检测矩形与冻结矩形差异明显"的日志（**只记日志，不改几何**）。
 *
 * 真机复盘时这一行就是"那张卡当时正在翻牌动画里"的直接证据
 * （`report.json` 里那两帧：冻结 y=0.189621 h=0.463389 → 动画 y=0.179117 h=0.487192）。
 */
export function describeRectShift(index: number, frozenRect: Rect, detected: Rect | null): string | null {
  if (!detected) return null;
  const dy = detected.y - frozenRect.y;
  const dh = detected.h - frozenRect.h;
  const dw = detected.w - frozenRect.w;
  const dx = detected.x - frozenRect.x;
  const worst = Math.max(Math.abs(dy), Math.abs(dh), Math.abs(dw), Math.abs(dx));
  if (worst < REROLL_RECT_SHIFT_TOLERANCE) return null;
  return (
    `卡${index + 1} 重随：本帧检测矩形与冻结矩形差得明显（Δy ${dy.toFixed(6)} Δh ${dh.toFixed(6)} ` +
    `Δw ${dw.toFixed(6)}）→ **仍用冻结矩形**裁剪与定位（面板存续期间卡片不动，` +
    '本帧那一个是翻牌动画中间帧）'
  );
}

/** `Bitmap` → `RecognizePixels` 的简单实现（回放与测试用：从整帧上裁）。 */
export function bitmapPixels(bmp: Bitmap): RecognizePixels {
  return {
    width: bmp.width,
    height: bmp.height,
    readFull: () => bmp,
    readRect: (rect) => cropBitmap(bmp, rect),
  };
}
