/**
 * 常驻截屏 worker（渲染端）
 *
 * 为什么需要它：主进程的 `desktopCapturer.getSources` **每次调用**都要重建
 * 一次截屏会话 —— 真机基准实测（`debug/augment/bench.json`）：
 *
 *   方式                        P50      尺寸        枚举源数
 *   window @1.00              1032ms   4587×1920      14
 *   window @0.25               731ms   1147×480       14
 *   window @tiny(16px)         707ms   16×7           14   ← 缩到 16px 也只快 24ms
 *   screen @0.25               532ms   1147×480        1
 *   screen @1.00               584ms   4587×1920        1
 *
 * 结论：**开销与像素量无关**，是每次调用的固定开销（会话建立 + 枚举 14 个窗口）。
 * 降分辨率救不了，唯一出路是**建立一次流、之后逐帧取图** —— 那正是本文件做的事：
 * `getDisplayMedia` 由主进程用 `setDisplayMediaRequestHandler` 指定屏幕源，
 * 流建立后每帧只做"画到小画布 + 取像素 + 跑检测"。
 *
 * 分工（关键）：
 *   · **检测在这里**（检测是纯函数，见 @hexbox/vision/browser）；
 *   · **状态机在主进程**（它决定何时做全分辨率识别、何时绘制）；
 *   · 两者只传一个小 JSON（found/cards/reason/耗时），不传像素。
 *
 * ⚠️ 这里只能用 `@hexbox/vision/browser`：主入口会把 win-geometry（PowerShell）
 * 与 png（node:zlib）一起拉进来，渲染端打包会失败。
 * 搜索区（截屏归一化）由主进程算好经 IPC 下发 —— 渲染端不做坐标换算。
 */

import {
  augmentCardFingerprint,
  augmentWatchFingerprints,
  detectAugmentPanelInRegions,
  detectPanelPresenceInRegions,
  gateCanvasWidth,
  readAugmentName,
  resolveOpenRecognizeCards,
  PANEL_THRESHOLDS,
  type AugmentCardFingerprint,
  type AugmentNameFingerprint,
  type Bitmap,
  type PanelCard,
  type PanelPresence,
  type Rect,
} from '@hexbox/vision/browser';

/** 主进程下发的配置。 */
interface WorkerConfig {
  /** 卡片行搜索区（**截屏归一化**；主进程用 panelRowRectInCapture 算好）。 */
  readonly region: Rect;
  /** 每帧间隔（ms）。 */
  readonly intervalMs: number;
  /** 门控画布的目标宽度（高度按流比例算；越小越便宜）。 */
  /** 备用搜索区（全屏恒等）；主区未命中时会再搜这里。 */
  readonly altRegion?: Rect;
  /** 门控画布占**流原生宽度**的比例（默认 1/3；与 DPI/分辨率无关）。 */
  readonly targetScale?: number;
  /** 门控画布最小宽度（默认 960）。 */
  readonly minWidth?: number;
  /** 名字指纹库（主进程从 `data/augment-names.json` 读好后下发）。 */
  readonly library?: readonly AugmentNameFingerprint[];
  /** 门控画布目标宽度（像素）。 */
  readonly targetWidth: number;
}

/** 一帧的检测结果（回传主进程）。 */
interface FrameReport {
  readonly found: boolean;
  readonly cards: readonly PanelCard[];
  readonly bands: number;
  readonly reason: string;
  /**
   * 本帧的**采集时刻**（worker 时钟）。
   *
   * ⚠️ 必须带上：主进程做边沿取证时会阻塞一两秒，之后会把排队的帧一次处理完
   * —— 那些帧"当时"的画面早已过去，用它们做边沿会造出**假边沿**
   * （真机实测：一次取证 1.7s，凭空多出一对 close/open）。主进程据此丢弃过期帧。
   */
  readonly atMs: number;
  /** 本帧检测耗时（ms）。 */
  readonly detectMs: number;
  /** 从视频取像素到 ImageData 的耗时（ms）。 */
  readonly grabMs: number;
  /** 画布尺寸（诊断）。 */
  readonly width: number;
  readonly height: number;
  /** 已累计帧数（主进程用它算实际帧率）。 */
  readonly frames: number;
  /** 距上一帧的实际间隔（ms）——真实帧率是否达标看它。 */
  readonly sincePrevMs: number;
  /**
   * 每张卡的**内容指纹**（门控分辨率上算，`vision/augment-reroll.ts`）。
   *
   * 主进程拿它和"上次识别时那一帧的指纹"比 → 判断**哪张卡被刷新了**
   * （面板不会因为刷新而关闭，所以开/关边沿看不到这件事）。
   *
   * ⚠️ 取样矩形是**冻结**的（`watchRects`，上一次识别时定下），
   * 不是本帧重新检测出来的：检测每次重建的卡片边线会有 ±1~2px 抖动，
   * 拿抖动后的矩形取样会让"没变"的内容也测出 0.03+ 的距离（真机标定，见
   * `docs/AUGMENT-PANEL.md` §十五）。
   */
  readonly fingerprints: readonly (AugmentCardFingerprint | null)[];
  /**
   * "面板**仍在**"的独立信号（**只在 `found === false` 的帧上算/带**）。
   *
   * 为什么必须有它：单卡重随的**翻牌动画**会让卡片判据连续失效约 1 秒
   *（真机 `debug/augment/timeline.csv` 实测 1178ms），而面板一直在屏上。
   * 主进程据此做到"两个信号都说不在才算关闭"（`vision/augment-panel.ts` 的
   * `push(detection, presence)`）。命中帧不带（面板当然在），
   * 所以**常态零额外开销**：只有翻牌/真关闭那几帧多一次按行扫描。
   */
  readonly presence?: PanelPresence;
}

interface WorkerApi {
  readonly onConfig: (cb: (c: WorkerConfig) => void) => void;
  readonly onCommand: (
    cb: (
      cmd: 'start' | 'stop' | 'cadence' | 'recognize' | 'unwatch',
      cfg?: unknown,
    ) => void,
  ) => void;
  readonly report: (r: FrameReport) => void;
  readonly status: (s: { readonly message: string; readonly error?: boolean }) => void;
  /** 全分辨率识别结果（可能不存在：旧 preload）。 */
  readonly recognized?: (r: RecognizedReport) => void;
}

/** 一张卡的识别结果（`augmentId` 为 null = 没认出来，调用方不要画）。 */
export interface RecognizedCard {
  readonly rect: Rect;
  readonly interiorLuma: number;
  readonly edgeLuma: number;
  readonly augmentId: number | null;
  readonly name: string | null;
  readonly score: number | null;
  readonly margin: number | null;
}

/** 识别报告的触发原因：面板开边沿的整批识别 / 面板停留期间的**单卡重随**重识别。 */
export type RecognizeOrigin = 'open' | 'reroll';

/** 全分辨率识别报告。 */
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

declare global {
  interface Window {
    readonly augmentWorkerApi?: WorkerApi;
  }
}

const api = window.augmentWorkerApi;

const video = document.getElementById('video') as HTMLVideoElement | null;
const canvas = document.getElementById('stage') as HTMLCanvasElement | null;
const ctx = canvas?.getContext('2d', { willReadFrequently: true }) ?? null;

let config: WorkerConfig | null = null;
let stream: MediaStream | null = null;
let timer: number | null = null;
let frames = 0;
let lastFrameAt = 0;
/**
 * **冻结的取样矩形**（面板停留期间固定不变；§十五 的真机标定要求）。
 *
 * 由上一次**整批识别**（面板开边沿）或**单卡重随重识别**定下：那两次都以
 * "当前门控帧检出的卡片矩形"为准，之后每帧的指纹都按它取样 ——
 * 面板停留期间卡片本来就不动，冻结正是对的语义；而不冻结时检测抖动的
 * ±1~2px 会让"没变"的内容也测出 0.03+ 的距离（噪声顶到阈值上）。
 *
 * `null`/空 = 还没识别过 → 本帧用自己检出的矩形取样（主进程那时也没有基线，
 * 不会拿它做判定）。
 */
let watchRects: Rect[] | null = null;
/**
 * **冻结的卡片矩形**（上一批识别用的那几个矩形，面板存续期间不变）。
 *
 * 与 `watchRects` 的分工：`watchRects` 是**指纹取样**用的（冷启动时按门控帧检出的
 * 矩形定下，见上），这里是**裁剪与标签几何**用的 —— 也就是"上一次识别报告里
 * 那几张卡的 `rect`"，面板打开那一次定下、关闭时清掉。
 *
 * ⚠️ 为什么必须单独冻一份（2026-10-06 真机二次验收，用户："**某次单卡刷新后，
 * 三个标签整体下移了一点**"）：重随发生在**翻牌动画**里，那一刻检测出来的卡片矩形
 * 又高又靠上（真机 `report.json`：冻结 `y=0.189621 h=0.463389` → 动画帧
 * `y=0.179117 h=0.487192`）。原来路径 B 同时拿它**裁剪 OCR 区**并**当标签矩形**
 * 回传，于是那一张卡的几何被动画帧改掉、把整排基准也带走了。
 * 面板存续期间卡片不会动（翻牌是原地换内容），所以正确语义是**一律用冻结矩形**：
 * 新检测矩形只用来判断"差异有多大"并记日志，**绝不改几何**。
 */
let frozenRects: Rect[] | null = null;
/** 最近一帧检出的卡片（重随重识别要用它的矩形与亮度字段）。 */
let latestCards: readonly PanelCard[] = [];
/**
 * 最近一次**卡片判据命中**的那一帧检出的卡片（`det.found === true`）。
 *
 * 与 `latestCards`（每帧都更新）的区别：这里只在门控"确认面板在屏"的帧上更新，
 * 所以它天然是"门控验过的卡片矩形" —— 整批识别的原生重检失败时用它兜底
 * （见 `vision/augment-open-recognize.ts`；真机：门控 39 命中 / 原生 40 失败）。
 */
let lastHitCards: readonly PanelCard[] = [];
/**
 * 最近一帧的**门控画布像素**（指纹基线也在它上面算 —— 与后续帧同一分辨率，
 * 否则"原生分辨率算基线、门控分辨率比后续帧"会引入一层无谓的差异）。
 */
let latestGatingBmp: Bitmap | null = null;
/** 最近一帧算出的每卡指纹（识别报告要把基线带给主进程）。 */
let latestFingerprints: readonly (AugmentCardFingerprint | null)[] = [];

function log(message: string, error = false): void {
  api?.status({ message, error });
}

/**
 * 建立屏幕流。
 *
 * 源由**主进程**通过 `setDisplayMediaRequestHandler` 指定（本文件不能枚举源，
 * 那是主进程的能力）；这里只管要一条流。
 */
async function ensureStream(): Promise<boolean> {
  if (stream && video && video.srcObject === stream) return true;
  if (!video) return false;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 15 },
      audio: false,
    });
  } catch (e) {
    log(`取屏幕流失败：${e instanceof Error ? e.message : String(e)}`, true);
    return false;
  }
  video.srcObject = stream;
  video.muted = true;
  try {
    await video.play();
  } catch {
    /* play() 在隐藏窗口里偶尔被拒；有帧就够 */
  }
  const track = stream.getVideoTracks()[0];
  track?.addEventListener('ended', () => {
    log('屏幕流被结束（游戏切换分辨率/全屏状态时可能发生），将重建', true);
    stream = null;
  });
  log(`屏幕流已建立：${track?.label ?? '?'} ${video.videoWidth}x${video.videoHeight}`);
  return true;
}

/** 采一帧 → 画到小画布 → 取像素 → 跑检测 → 回传。 */
function tick(): void {
  if (!config || !video || !canvas || !ctx) return;
  if (video.videoWidth === 0 || video.videoHeight === 0) return;

  // 画布尺寸：按流比例，宽度取配置值（门控下限 1/4，见 augment-panel.ts 头注）
  // 画布宽度优先按**流原生分辨率的固定比例**算（分辨率/DPI 无关，见 gateCanvasWidth）；
  // 没给 targetScale 时退回旧的 targetWidth（兼容旧配置）。
  //
  // ⚠️ 旧算法是"逻辑宽 × 2 × 0.25"，隐含假设缩放倍率 = 1.5；
  // 在 4K@250% 上有效分辨率会掉到原生的 1/5，低于标定的 1/4 下限 → 检测不稳。
  const targetW = config.targetScale
    ? gateCanvasWidth(video.videoWidth, { targetScale: config.targetScale, minWidth: config.minWidth })
    : config.targetWidth;
  const scale = targetW / video.videoWidth;
  const w = Math.max(160, Math.round(video.videoWidth * scale));
  const h = Math.max(90, Math.round(video.videoHeight * scale));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }

  const t0 = performance.now();
  ctx.drawImage(video, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const t1 = performance.now();

  const bmp: Bitmap = { width: w, height: h, data: img.data };
  // 候选搜索区：主区（主进程按窗口矩形换算）+ 备用（全屏恒等）。
  //
  // ⚠️ 为什么搜两个：窗口探针认错窗口时，主区会切掉外侧卡边框 → 整局 0 命中
  //（2026-10-05 真机事故）。多搜一次只多 2~4ms，对 250ms 门控可忽略。
  const regions: Rect[] = [config.region];
  if (config.altRegion) regions.push(config.altRegion);
  const hit = detectAugmentPanelInRegions(bmp, regions);
  const det = hit.detection;
  const t2 = performance.now();

  // 每卡**内容指纹**（重随检测用）。
  //
  // ⚠️ 只在"**冻结矩形仍然对得上**"时报（已识别过 + 本帧认定面板 +
  //    重建出的卡片数与冻结矩形数一致），否则是**空数组** —— 主进程会当成
  //    "这一帧没有可比指纹"直接跳过。判定本身在纯函数
  //    `augmentWatchFingerprints()`（`vision/augment-reroll.ts`，有单测）里，
  //    这里只负责把画布像素与"本帧检测结果"喂进去 —— 两个入口
  //    （录制工具 / 常驻覆盖层）共用本文件，所以这条保护不可能只在一条路径上生效。
  latestCards = det.cards;
  // ⚠️ 只记**卡片判据命中**的那一帧：它是"门控确认过面板在屏"的证据，
  //    也是整批识别原始重检失败时的兜底矩形（`resolveOpenRecognizeCards`）。
  //    未命中帧的 `det.cards` 可能只有候选、甚至为空，不能当兜底依据。
  if (det.found && det.cards.length > 0) lastHitCards = det.cards;
  latestGatingBmp = bmp;
  latestFingerprints = augmentWatchFingerprints(bmp, watchRects, det);

  // "面板仍在"的**独立信号**：只在卡片判据**未命中**的帧上算。
  //
  // 命中帧当然在（主进程不会问），所以这条在常态是**零成本**；只有翻牌动画
  // 与真关闭那几帧才多一次按行扫描（x 方向隔点采样）。它与卡片判据**共用同一份
  // 候选搜索区**（主区 + 全屏备用区），回退语义与 `detectAugmentPanelInRegions`
  // 完全一致 —— 探针认错窗口时两边一起退化，不会出现"一个信号看得见、另一个看不见"。
  const presence = det.found ? undefined : detectPanelPresenceInRegions(bmp, regions).presence;

  frames++;
  const now = performance.now();
  const sincePrevMs = lastFrameAt === 0 ? 0 : now - lastFrameAt;
  lastFrameAt = now;

  api?.report({
    found: det.found,
    cards: det.cards,
    bands: det.bands,
    reason: det.reason,
    atMs: Date.now(),
    grabMs: t1 - t0,
    detectMs: t2 - t1,
    width: w,
    height: h,
    frames,
    sincePrevMs,
    fingerprints: latestFingerprints,
    ...(presence ? { presence } : {}),
  });
}

/**
 * **全分辨率识别**（用户方案 2026-10-05：把识别搬到渲染端，从已有的屏幕流取帧）。
 *
 * 两个目的：
 *   1. **分辨率无关**：门控画布只有原生 1/3（1080p 上卡片名字偏小，勉强能认）；
 *      识别在**原生分辨率**上做，1080p / 2K / 4K 都一样准。
 *   2. **彻底不碰 `desktopCapturer`**：那条路会让系统光标卡约 1 秒（真机事故），
 *      这里复用已经建好的流，只是"画大一点"。
 *
 * 两种触发（`opts.only`）：
 *   · **不给**（面板开边沿）：整帧 19.8MB 级 `drawImage` + `getImageData`（几十毫秒），
 *     检出三张卡后**逐卡** OCR —— 面板内容在选完之前不变，一次足够；
 *   · **给了卡片序号**（面板停留期间的**单卡刷新**，`vision/augment-reroll.ts` 判定）：
 *     只把那几张卡的**区域**按原生分辨率画出来（一张卡 ≈1.1MB，比整帧小一个量级），
 *     只 OCR 它们 —— 其余卡的识别结果由主进程原样保留（"只重认变化的那张"）。
 *
 * 两条路径结束时：
 *   · **路径 A**（开边沿）把冻结矩形更新为"当前门控帧检出的卡片矩形"，并把该矩形下
 *     的每卡指纹一起回传（主进程拿它当重随检测的基线），同时把**卡片矩形**
 *     （= 这一批识别报告的 `rect`）冻结下来；
 *   · **路径 B**（重随）**什么都不重新冻结**：裁剪区与回传的卡片矩形都用冻结矩形
 *     （面板存续期间卡片不动，本帧检测出来的那个是翻牌动画中间帧），指纹也沿用
 *     同一组冻结取样矩形 —— 这正是 `augment-reroll.ts` 阈值标定的前提。
 */
async function recognize(opts: { readonly only?: readonly number[] } = {}): Promise<void> {
  const only = opts.only && opts.only.length > 0 ? opts.only : null;
  // ⚠️ 触发原因由**调用方式**决定（带 `only` = 单卡重随）：失败路径也必须带上它，
  // 否则主进程会把"重随重认失败"当成"开边沿整批识别"，一张标签都不剩。
  const origin: RecognizeOrigin = only ? 'reroll' : 'open';
  const fail = (reason: string, tookMs: number): void => {
    api?.recognized?.({
      ok: false,
      reason,
      cards: [],
      tookMs,
      origin,
      ...(only ? { refreshed: [...only] } : {}),
      fingerprints: latestFingerprints,
    });
  };
  if (!config || !video || video.videoWidth === 0) {
    fail('流未就绪', 0);
    return;
  }
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const t0 = performance.now();

  /**
   * 以"当前门控帧检出的卡片矩形"重新**冻结**取样矩形，并回传该矩形下的指纹。
   *
   * 指纹一律在**门控画布**上算（截图与后续帧同一分辨率/同一取样矩形），
   * 基线才不会因为"原生帧算一次、门控帧算一次"而白白差出一点点距离。
   *
   * ⚠️ **只有整批识别（路径 A）才调它**：重随重识别（路径 B）不许重新冻结 ——
   * 那时卡片正在翻牌动画里，按动画帧的检测矩形取样会让后续每一帧的指纹都偏，
   * 而 `augment-reroll.ts` 的阈值标定前提正是"同一块面板停留期间用同一组取样矩形"。
   */
  const refreeze = (): readonly (AugmentCardFingerprint | null)[] => {
    if (latestCards.length === 0 || !latestGatingBmp) {
      watchRects = null;
      latestFingerprints = [];
      return latestFingerprints;
    }
    watchRects = latestCards.map((c) => c.rect);
    const bmp = latestGatingBmp;
    latestFingerprints = watchRects.map((r) => augmentCardFingerprint(bmp, r));
    return latestFingerprints;
  };

  // ── 路径 B：只重认"被刷新"的那几张卡 ─────────────────────────────────
  if (only) {
    const library = config.library ?? [];
    const cards: RecognizedCard[] = [];
    const refreshed: number[] = [];
    const frozen = frozenRects;
    for (const index of only) {
      const panelCard = latestCards[index];
      refreshed.push(index);
      // ⚠️ **一律用冻结矩形**（上一次识别报告里的那一个）：面板存续期间卡片不动，
      //    本帧检测出来的矩形在重随这一刻是**翻牌动画中间帧**，改了它 = 整排标签下移。
      const rect = frozen?.[index] ?? panelCard?.rect ?? null;
      if (!rect) {
        cards.push(emptyCard({ x: 0, y: 0, w: 0, h: 0 }));
        continue;
      }
      logRectShiftIfAny(index, rect, panelCard?.rect ?? null);
      // 只把这一张卡的区域按原生分辨率取出来（比整帧小一个量级），
      // 区域用**冻结矩形** → 与开边沿那一次裁的是同一块像素。
      const region = cropVideo(video, rect, vw, vh);
      const m = region && library.length > 0 ? readAugmentName(region, { x: 0, y: 0, w: 1, h: 1 }, library) : null;
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
    // 指纹沿用**已冻结的取样矩形**在最近一帧门控画布上的结果（`tick()` 每帧算好的）：
    // 重随只换内容、不换几何，所以基线仍然要按同一组矩形取。
    api?.recognized?.({
      ok: true,
      reason: `单卡重随：只重认卡 ${refreshed.map((i) => i + 1).join('/')}`,
      cards,
      refreshed,
      origin: 'reroll',
      tookMs: performance.now() - t0,
      width: vw,
      height: vh,
      fingerprints: latestFingerprints,
    });
    return;
  }

  // ── 路径 A：整批识别（面板开边沿）──────────────────────────────────
  const off = document.createElement('canvas');
  off.width = vw;
  off.height = vh;
  const octx = off.getContext('2d', { willReadFrequently: true });
  if (!octx) {
    fail('无法建离屏画布', performance.now() - t0);
    return;
  }
  octx.drawImage(video, 0, 0, vw, vh);
  const img = octx.getImageData(0, 0, vw, vh);
  const bmp: Bitmap = { width: vw, height: vh, data: img.data };

  // 卡片矩形在**归一化坐标**下与门控画布一致（同一画面、同一纵横比），
  // 所以可以直接在原生帧上重新检测（更精确），再逐卡认名字。
  const regions: Rect[] = [config.region];
  if (config.altRegion) regions.push(config.altRegion);
  const hit = detectAugmentPanelInRegions(bmp, regions);
  const library = config.library ?? [];
  // ⚠️ 真机回归（2026-10-11）：**同一块面板、两个分辨率、同一条阈值**会打架 ——
  //    门控在 1/3 分辨率上量到 39（< 40 → 命中，于是开出"面板出现"开边沿），
  //    原生重检在 1:1 上量到 **40**（`>= 40` → 失败）→ 整批识别"未命中"、
  //    面板在屏 25.7 秒一个标签都没有（日志：`卡片内部不够暗(40 ≥ 40)`）。
  //    门控才是"面板在屏"的权威（开边沿由它给出，且要求连续 2 帧命中），
  //    原生重检只负责**更精确的矩形** —— 它说"不"的时候退回门控刚验过的矩形继续
  //    OCR（矩形是归一化的，1/3 分辨率下同样可用），而不是把整块面板丢掉。
  const plan = resolveOpenRecognizeCards({
    native: hit.detection,
    // `lastHitCards` = 最近一次**卡片判据命中**的那一帧检出的卡片（见 `tick()`）。
    gating: lastHitCards,
    minCards: PANEL_THRESHOLDS.minCards,
  });
  if (plan.source === 'gating') log(`⚠ ${plan.reason}`);
  if (plan.source === 'none') {
    api?.recognized?.({
      ok: false,
      reason: plan.reason,
      cards: [],
      regionIndex: hit.regionIndex,
      tookMs: performance.now() - t0,
      origin: 'open',
      fingerprints: latestFingerprints,
    });
    return;
  }
  const cards = plan.cards.map((c) => {
    const m = library.length > 0 ? readAugmentName(bmp, c.rect, library) : null;
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
  //
  // 同时把**裁剪/标签几何**用的卡片矩形冻在"这一批识别报告的 rect"上：
  // 之后的重随重识别一律复用它（见 `frozenRects` 与路径 B）。
  frozenRects = cards.map((c) => c.rect);
  const fingerprints = refreeze();
  api?.recognized?.({
    ok: true,
    reason: hit.detection.reason,
    cards,
    regionIndex: hit.regionIndex,
    tookMs: performance.now() - t0,
    width: vw,
    height: vh,
    origin: 'open',
    fingerprints,
  });
}

/**
 * 把视频流里**一张卡的区域**按原生分辨率画到离屏画布并取像素。
 *
 * 为什么不是整帧：整帧 `drawImage` + `getImageData` 是 19.8MB 级开销（几十毫秒），
 * 而重随只重认**变化的那一张**，一张卡约 427×667 原生像素（≈1.1MB，小一个量级）。
 * 取不到（越界/尺寸非法）返回 `null` → 该卡按"认不出"处理（标签必须消失）。
 */
function cropVideo(videoEl: HTMLVideoElement, rect: Rect, vw: number, vh: number): Bitmap | null {
  const sx = Math.round(rect.x * vw);
  const sy = Math.round(rect.y * vh);
  const sw = Math.round(rect.w * vw);
  const sh = Math.round(rect.h * vh);
  if (sw <= 0 || sh <= 0 || sx < 0 || sy < 0 || sx + sw > vw || sy + sh > vh) return null;
  const off = document.createElement('canvas');
  off.width = sw;
  off.height = sh;
  const octx = off.getContext('2d', { willReadFrequently: true });
  if (!octx) return null;
  octx.drawImage(videoEl, sx, sy, sw, sh, 0, 0, sw, sh);
  const img = octx.getImageData(0, 0, sw, sh);
  return { width: sw, height: sh, data: img.data };
}

/**
 * 重随重识别时"本帧检测矩形 vs 冻结矩形"的相对差超过这个值就记一条日志。
 *
 * 单位是**帧宽/帧高**（归一化）；0.005 在 1440 高的真机帧上 ≈7 物理像素 ——
 * 比标定过的 ±1~2px 检测抖动大得多，所以只有"真在动画里"才报。
 * 它**只用于记日志**：几何一律以冻结矩形为准（见 `frozenRects`）。
 */
const REROLL_RECT_SHIFT_TOLERANCE = 0.005;

/**
 * 记一条"检测矩形与冻结矩形差异明显"的日志（**只记日志，不改几何**）。
 *
 * 真机复盘时这一行就是"那张卡当时正在翻牌动画里"的直接证据
 * （`report.json` 里那两帧：冻结 y=0.189621 h=0.463389 → 动画 y=0.179117 h=0.487192）。
 */
function logRectShiftIfAny(index: number, frozenRect: Rect, detected: Rect | null): void {
  if (!detected) return;
  const dy = detected.y - frozenRect.y;
  const dh = detected.h - frozenRect.h;
  const dw = detected.w - frozenRect.w;
  const dx = detected.x - frozenRect.x;
  const worst = Math.max(Math.abs(dy), Math.abs(dh), Math.abs(dw), Math.abs(dx));
  if (worst < REROLL_RECT_SHIFT_TOLERANCE) return;
  log(
    `卡${index + 1} 重随：本帧检测矩形与冻结矩形差得明显（Δy ${dy.toFixed(6)} Δh ${dh.toFixed(6)} ` +
      `Δw ${dw.toFixed(6)}）→ **仍用冻结矩形**裁剪与定位（面板存续期间卡片不动，` +
      `本帧那一个是翻牌动画中间帧）`,
  );
}

/** 认不出/取不到时的占位卡（`augmentId: null` → 调用方**清掉该卡标签**）。 */
function emptyCard(rect: Rect): RecognizedCard {
  return { rect, interiorLuma: 0, edgeLuma: 0, augmentId: null, name: null, score: null, margin: null };
}

function start(cfg: WorkerConfig): void {
  config = cfg;
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
  void ensureStream().then((ok) => {
    if (!ok) {
      log('无法开始：屏幕流不可用', true);
      return;
    }
    // intervalMs <= 0 = 只把流建好、不取帧（常态不截屏，等 API 触发后再起表）
    if (cfg.intervalMs <= 0) {
      log(`门控已就绪（不取帧）：待触发后开始，画布宽 ${cfg.targetWidth}`);
      return;
    }
    timer = window.setInterval(tick, Math.max(50, cfg.intervalMs));
    log(`门控已启动：每 ${cfg.intervalMs}ms 一帧，画布宽 ${cfg.targetWidth}`);
  });
}

/**
 * 改门控间隔。
 *
 * ⚠️ **`ms <= 0` = 停止取帧**（常态不截屏）：API 触发方案下，
 * 没有待选海克斯时**一帧都不取**（而不是"低频取几帧"），
 * 这才是用户要的"关闭常态截屏"。流本身可以留着（重启流要走
 * getDisplayMedia + 隐藏窗口合成，代价与风险都比留着高）。
 */
function setCadence(ms: number): void {
  const stopped = !Number.isFinite(ms) || ms <= 0;
  const next = stopped ? 0 : Math.max(50, Math.round(ms));
  if (config) config = { ...config, intervalMs: next };
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
  if (stopped) {
    log('门控间隔改为 停止（常态不截屏）');
    return;
  }
  // ⚠️ 必须**重开定时器**：`setInterval` 的周期在创建时就固定了，改配置变量不生效
  //（"改了配置却不生效"的常见坑）。
  // 若此前处于"停止"状态（timer === null 但流已就绪），这里也要重新起表。
  if (video) timer = window.setInterval(tick, next);
  log(`门控间隔改为 ${next}ms`);
}

function stop(): void {
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
  log('门控已停止');
}

/**
 * **取消冻结的取样矩形与卡片矩形**（面板关闭边沿由主进程下发）。
 *
 * 下一块面板的卡片可能完全在别的位置/别的三张卡，绝不能让上一块的矩形
 * （或上一块的基线）跨面板复用 —— 那会把"上一轮的卡"当成"这一轮没变"。
 */
function unwatch(): void {
  watchRects = null;
  frozenRects = null;
  latestCards = [];
  lastHitCards = [];
  latestGatingBmp = null;
  latestFingerprints = [];
}

api?.onCommand((cmd, cfg) => {
  if (cmd === 'start' && cfg) start(cfg as WorkerConfig);
  else if (cmd === 'stop') stop();
  else if (cmd === 'unwatch') unwatch();
  else if (cmd === 'recognize') {
    // 带 `only` = 面板停留期间的**单卡重随**重识别（只重认变化的那几张）
    const only = (cfg as { only?: readonly number[] } | undefined)?.only;
    void recognize(Array.isArray(only) && only.length > 0 ? { only } : {});
  } else if (cmd === 'cadence') {
    const ms = (cfg as { intervalMs?: number } | undefined)?.intervalMs;
    if (typeof ms === 'number') setCadence(ms);
  }
});
api?.onConfig((cfg) => {
  config = cfg; // 搜索区/间隔变化时热更新（窗口矩形变了会重下发）
});

// 通知主进程：worker 已就绪（主进程据此下发配置并 start）
log('worker ready');
