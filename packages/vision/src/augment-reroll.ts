/**
 * 面板**保持打开**期间的「单卡刷新（reroll）」检测（纯函数，可单测）
 *
 * ── 产品事实（用户 2026-10-06 说明，已写进 docs/AUGMENT-PANEL.md §十五）──
 *
 * 局内三选一面板**不会**因为刷新而关闭：玩家可以点每张卡上的刷新按钮，
 * 把**这一张卡**换成另一颗海克斯（每张卡最多一次）。面板本身照旧开着，
 * 于是"面板开/关边沿"这个信号**看不到这次变化** —— 屏幕上的字母还停在
 * 刷新前那颗海克斯上，**显示的是错数据（比不显示更糟）**。
 *
 * 所以要在面板停留期间额外盯一件事：**每张卡的画面内容有没有被换掉**。
 *
 * ── 做法：廉价感知指纹（在门控分辨率上算）────────────────────────────
 *
 *   ① 取样区 = 卡的**上部**（整体区 y 0.06~0.74 + 图标区），
 *      **刻意不含卡底标签区**（见下）；
 *   ② 各区**面积平均**降到低分辨率灰度格（整体区 16×16、图标区 8×8；
 *      `extractGray`，与头像/名字同一套降采样）；
 *   ③ 比"去掉本区均值后的逐格差"（`fingerprintDistance`，取各区的最大值）——
 *      去均值让**整体亮度变化**（技能闪光、亮度设置、HUD 淡入淡出）不影响判定，
 *      只比**结构**；
 *   ④ 超过阈值 **且** 本帧已"成形"（std 不低到空白）**且** 与上一帧一致
 *      （画面已经稳定，不是翻转动画的中间帧）→ 判定该卡已刷新。
 *
 * 为什么不用 OCR 字串比对："上一帧认出的名字"与"这一帧的名字"都要跑 OCR
 * （一次 45~100ms），而刷新检测要能每 250~500ms 做一次；指纹是**几十微秒**级。
 *
 * ── 为什么不把标签区算进指纹（真机必踩）────────────────────────────
 *
 * 覆盖窗画的内容**会进截屏流**（屏幕流拍的就是合成后的桌面）。标签画在卡内
 * y ≈0.79~0.94（三档里最高的一档从上沿 0.788 起），如果不排除它，
 * 我们自己画上去的字母就会让指纹变化 → 触发一次"假刷新" → 白跑一次 OCR
 * （内容没变，结果只是重复画一遍）。所以整体区取 y 0.06~0.74
 * （描述实测最长到 0.713），把标签整个挡在外面。
 *
 * ⚠️ 本文件必须保持**浏览器安全**（渲染端 worker 会 import 它）：只依赖
 * `match.ts` / `types.ts` 这类纯计算模块。
 */

import { extractGray } from './match.ts';
import type { Bitmap, Rect } from './types.ts';

/* ------------------------------------------------------------------ */
/* 参数（真机标定值见 docs/AUGMENT-PANEL.md §十五）                      */
/* ------------------------------------------------------------------ */

/** 一个取样区（**卡内**归一化）+ 它降到的网格边长。 */
export interface AugmentFingerprintZone {
  /** 区名（产物/日志/单测可读）。 */
  readonly name: string;
  readonly zone: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  /** 网格边长（`cells.length = grid²`）。 */
  readonly grid: number;
}

/**
 * 取样区（**卡内**归一化）—— 两区，距离取两区的**最大值**。
 *
 * 为什么是两区而不是一个大网格（真机帧上比过几种设计，见
 * `scripts/diag-augment-reroll.mts` 与它的"压力组"）：同一张真机面板上
 * "把一张卡换成另一颗海克斯"的样本里，**图标**区的差异最大
 * （不同海克斯的图标画得完全不同），而整卡区把它平均掉了：
 *
 * | 设计 | 噪声上界* | 真变化下界 | 分离比 |
 * |---|---|---|---|
 * | 整卡 8×8 | 0.0105 | 0.036 | 3.4× |
 * | 整卡 16×16 | 0.0158 | 0.046 | 2.9× |
 * | **整卡 16×16 + 图标 8×8（采用）** | **0.0226** | **0.066** | **2.9×** |
 * | 整卡 16×16 + 名字带 16×3 | 0.0305 | 0.046 | 1.5× |
 *
 * （* 这一列的噪声**含 ±1~2px 的取样矩形抖动** —— 它是当初促使"冻结矩形"的原因；
 * 冻结之后线上真正面对的噪声上界是 **0.013**，见下面的阈值说明。）
 *
 * ⚠️ 名字带（y 0.43~0.52）**刻意不单独做一区**：门控分辨率下那几个汉字只有
 * 20 像素高，模糊/噪声会让它自己抖动，性价比反而不如图标区。
 *
 * · `body`（整体区）从卡内 0.06 到 **0.74**：上面避开卡片上边框与发光，
 *   下面**刻意停在 0.74** —— 描述实测最长到 0.713，而 0.72~1.00 是空白带、
 *   **标签就画在那里**（覆盖窗会进截屏流，见文件头注，必须排除）；
 * · `icon`（图标区）取 0.20~0.80 × 0.08~0.36：真机卡片的图标位置（实测图标 y 0.07~0.37）。
 */
export const AUGMENT_FINGERPRINT_ZONES: readonly AugmentFingerprintZone[] = [
  { name: 'body', zone: { x: 0.1, y: 0.06, w: 0.8, h: 0.68 }, grid: 16 },
  { name: 'icon', zone: { x: 0.2, y: 0.08, w: 0.6, h: 0.28 }, grid: 8 },
];

/** 主区（整体区）的索引：指纹的 mean/std/size/cells 都指它（"是否成形"也看它）。 */
export const AUGMENT_FINGERPRINT_MAIN_ZONE = 0;

/** 兼容旧名字：整体区（= 第一区）的卡内归一化范围。 */
export const AUGMENT_FINGERPRINT_ZONE = AUGMENT_FINGERPRINT_ZONES[AUGMENT_FINGERPRINT_MAIN_ZONE]!.zone;

/**
 * **结构距离阈值**（0..1，见 `fingerprintDistance`）。
 *
 * 这是"变了 / 没变"的唯一开关，两边余量都由真机帧标定
 * （`scripts/diag-augment-reroll.mts` 会打出两组分布与余量）：
 *   · 噪声（重采样相位 / ±8 灰度噪声 / 5bit 量化 / 3×3 模糊 / 亮度 ±12 /
 *     组合抖动）→ 实测上界 **0.013**；
 *   · 真变化（把槽位换成另一张真机卡 = 另一颗海克斯）→ 实测下界 **0.066**。
 * 取 **0.03**：比噪声上界高 2.3 倍、比真变化下界低 2.2 倍。
 *
 * ⚠️ 前提：**同一块面板停留期间用同一组取样矩形**（"冻结矩形"，见
 * `apps/overlay/src/capture/worker.ts` 的 `watchRects`）。检测每次重建的卡片
 * 边线会有 **±1~2px** 的抖动（内容一变、竖向投影的边线就跟着变），
 * 拿抖动后的矩形去取样会让"没变"的内容也测出 **0.031** 的距离 —— 那会把噪声
 * 顶到阈值上。矩形一冻，这一项噪声就不存在了；而面板停留期间卡片本来就不动，
 * 冻结正是对的语义。
 */
export const AUGMENT_REROLL_THRESHOLD = 0.03;

/**
 * "已成形"的最小结构强度（主区 16×16 格的灰度 std）。
 *
 * 卡片翻转/淡入的中间帧会整块发白或纯色 → std 很低；真机面板卡片的
 * 取样区 std 实测 **15~30**（图标 + 文字 + 暗底）。低于它就**不下判定**，
 * 等下一帧 —— 否则会在动画中间帧上白跑一次 OCR（还会因为认不出而先清掉标签）。
 */
export const AUGMENT_FINGERPRINT_MIN_STD = 8;

/* ------------------------------------------------------------------ */
/* 指纹                                                                */
/* ------------------------------------------------------------------ */

/** 一个取样区的指纹（面积平均灰度格 + 该区统计）。 */
export interface AugmentFingerprintPart {
  /** 区名（同 `AUGMENT_FINGERPRINT_ZONES[].name`）。 */
  readonly name: string;
  /** 网格边长（`cells.length === size²`）。 */
  readonly size: number;
  /** 逐格灰度均值（行优先，0..255）。 */
  readonly cells: Uint8Array;
  /** 该区全部格的平均灰度。 */
  readonly mean: number;
  /** 该区全部格的标准差（结构强度）。 */
  readonly std: number;
}

/**
 * 一张卡的内容指纹（两区低分辨率灰度格 + 主区统计）。
 *
 * `cells` / `mean` / `std` / `size` 是**主区（整体区）**的快捷字段
 * （"是否成形"与日志都看它）；逐区数据在 `parts` 里，距离取各区最大值。
 */
export interface AugmentCardFingerprint {
  /** 各区指纹（顺序 = `AUGMENT_FINGERPRINT_ZONES`）。 */
  readonly parts: readonly AugmentFingerprintPart[];
  /** 主区网格边长。 */
  readonly size: number;
  /** 主区逐格灰度均值。 */
  readonly cells: Uint8Array;
  readonly mean: number;
  readonly std: number;
}

export interface FingerprintOptions {
  /** 取样区覆盖（默认 `AUGMENT_FINGERPRINT_ZONES`；传单个区即只算一区）。 */
  readonly zones?: readonly AugmentFingerprintZone[];
}

/** 单个取样区在卡上的矩形（**截屏归一化**，与卡片矩形同一坐标系）。 */
export function augmentFingerprintZoneRect(
  card: Rect,
  zone: AugmentFingerprintZone['zone'],
): Rect {
  return {
    x: card.x + card.w * zone.x,
    y: card.y + card.h * zone.y,
    w: card.w * zone.w,
    h: card.h * zone.h,
  };
}

/** 主取样区（整体区）的矩形 —— 兼容旧接口。 */
export function augmentFingerprintRect(
  card: Rect,
  zone: AugmentFingerprintZone['zone'] = AUGMENT_FINGERPRINT_ZONE,
): Rect {
  return augmentFingerprintZoneRect(card, zone);
}

/**
 * 算一张卡的指纹（取不到像素返回 `null`：卡太小 / 越界 / 尺寸非法）。
 *
 * 成本：两区共 `16² + 8² = 320` 格面积平均，门控画布上一张卡约
 * 190×296 px → 合计采样约 6 万像素，三张卡 < 1ms（与门控检测同量级），
 * 所以能每帧都算。
 */
export function augmentCardFingerprint(
  bmp: Bitmap,
  card: Rect,
  options: FingerprintOptions = {},
): AugmentCardFingerprint | null {
  const zones = options.zones ?? AUGMENT_FINGERPRINT_ZONES;
  const parts: AugmentFingerprintPart[] = [];
  for (const z of zones) {
    const grid = Math.max(1, Math.round(z.grid));
    const rect = augmentFingerprintZoneRect(card, z.zone);
    // 取样区窄于 2 个像素就没意义了（格均值会退化成最近邻）
    if (rect.w * bmp.width < 2 || rect.h * bmp.height < 2) return null;
    const cells = extractGray(bmp, rect, grid);
    if (!cells || cells.length !== grid * grid) return null;
    parts.push({ name: z.name, size: grid, cells, mean: cellMean(cells), std: cellStd(cells) });
  }
  const main = parts[AUGMENT_FINGERPRINT_MAIN_ZONE];
  if (!main) return null;
  return { parts, size: main.size, cells: main.cells, mean: main.mean, std: main.std };
}

/** 门控一帧的检测结果（结构上兼容 `augment-panel.ts` 的 `PanelDetection`）。 */
export interface WatchDetection {
  /** 本帧是否认定"海克斯面板在屏"。 */
  readonly found: boolean;
  /** 本帧重建出来的卡片（只需要矩形）。 */
  readonly cards: readonly { readonly rect: Rect }[];
}

/**
 * 一帧里"**可比**"的每卡指纹（不可比时返回**空数组** = 这一帧别做判定）。
 *
 * 三个条件全满足才算可比（每一条都对应一种真实误报）：
 *   ① 已经识别过至少一次（`frozenRects` 非空）—— 取样矩形必须**冻结**在
 *      "上次识别那一帧"的卡片矩形上；否则检测每次重建的边线有 ±1~2px 抖动，
 *      "没变"的内容也会测出 0.031 的距离（真机标定，见 §十五）；
 *   ② 本帧**认定面板在屏** —— 面板正在关闭/已经被挡住时，按旧矩形取样会拿到
 *      完全不同的画面（一次假刷新 = 白跑一次 OCR + 日志里多一条假事件）；
 *   ③ 本帧重建出的**卡片数与冻结矩形数一致** —— 卡片数抖动（翻牌动画中间帧、
 *      某张卡暂时没被重建出来）时，索引会错位：拿"第 2 个冻结矩形"去量
 *      "本帧第 2 张卡"可能量的根本不是同一张卡。
 *
 * ⚠️ 这条保护是**两个入口共用**的：录制工具（`debug-augment`）与常驻覆盖层
 * （`pnpm dev:overlay`）都通过 `AugmentController` → `AugmentStream` →
 * 同一个 `capture/worker.ts` 拿帧，所以它不可能只在某一条路径上生效
 * （这也是把它抽成纯函数 + 单测的原因：这条"跳过"以前只靠读代码保证）。
 *
 * 返回 `null` 元素是允许的（某张卡太小/越界算不出指纹）—— 主进程对 `null`
 * 另有"该卡不判定，也不影响别的卡"的规则（`rerolledCardIndices`）。
 */
export function augmentWatchFingerprints(
  bmp: Bitmap,
  frozenRects: readonly Rect[] | null | undefined,
  detection: WatchDetection,
): readonly (AugmentCardFingerprint | null)[] {
  if (!frozenRects || frozenRects.length === 0) return [];
  if (!detection.found) return [];
  if (detection.cards.length !== frozenRects.length) return [];
  return frozenRects.map((r) => augmentCardFingerprint(bmp, r));
}

function cellMean(cells: Uint8Array): number {
  let sum = 0;
  for (const v of cells) sum += v;
  return cells.length > 0 ? sum / cells.length : 0;
}

function cellStd(cells: Uint8Array): number {
  const mean = cellMean(cells);
  let sum = 0;
  for (const v of cells) {
    const d = v - mean;
    sum += d * d;
  }
  return Math.sqrt(sum / Math.max(1, cells.length));
}

/** 单区结构距离（0..1）；不可比返回 1。 */
function partDistance(a: AugmentFingerprintPart, b: AugmentFingerprintPart): number {
  if (a.size !== b.size || a.cells.length !== b.cells.length || a.cells.length === 0) return 1;
  let sum = 0;
  for (let i = 0; i < a.cells.length; i++) {
    sum += Math.abs(a.cells[i]! - a.mean - (b.cells[i]! - b.mean));
  }
  return sum / a.cells.length / 255;
}

/**
 * 两个指纹的**结构距离**（0..1；0 = 结构完全一致，1 = 无共同结构或不可比）。
 *
 * 每个区各算「去掉本区均值后的逐格平均绝对差 ÷ 255」，**取最大值**：
 * 任一区的结构被换掉就算换掉（不同海克斯的图标差异最大，见
 * `AUGMENT_FINGERPRINT_ZONES` 的标定表）。
 *
 * 去均值的理由：整块变亮/变暗（技能闪光、HUD 淡出、亮度设置）不是"卡换了"，
 * 而卡真的换了时**逐格结构**必然大改。缺一侧、区数不同、网格不符 → 返回 **1**
 * （"完全无法证明相同"）；`isCardRerolled` 另有 "缺一侧就不判定" 的规则。
 */
export function fingerprintDistance(
  a: AugmentCardFingerprint | null | undefined,
  b: AugmentCardFingerprint | null | undefined,
): number {
  if (!a || !b) return 1;
  if (a.parts.length === 0 || a.parts.length !== b.parts.length) return 1;
  let worst = 0;
  for (let i = 0; i < a.parts.length; i++) {
    worst = Math.max(worst, partDistance(a.parts[i]!, b.parts[i]!));
  }
  return worst;
}

/** 这一帧是否"还没成形"（空白/纯色/动画中间帧）—— 看主区 std。 */
export function fingerprintIsFlat(
  fp: AugmentCardFingerprint | null | undefined,
  options: { readonly minStd?: number } = {},
): boolean {
  if (!fp) return true;
  return fp.std < (options.minStd ?? AUGMENT_FINGERPRINT_MIN_STD);
}

export interface RerollDecisionOptions {
  /** 结构距离阈值（默认 `AUGMENT_REROLL_THRESHOLD`）。 */
  readonly threshold?: number;
  /** "已成形"的最小 std（默认 `AUGMENT_FINGERPRINT_MIN_STD`）。 */
  readonly minStd?: number;
}

/**
 * 单卡判定：这张卡的画面**相对基线**是否已经换了内容。
 *
 * 三个条件全满足才算（每条都对应一种真实误报）：
 *   ① 两侧指纹都有（缺一侧 → 没有可比对象，**不判定**；基线由调用方维护）；
 *   ② 本帧**已成形**（卡片翻转/淡入的中间帧 std 很低 → 等下一帧再判）；
 *   ③ 结构距离 ≥ 阈值。
 *
 * 与"上一帧是否一致"（画面稳定）那条判断**不在这里**：它是跨卡/跨帧的状态，
 * 由 `rerolledCardIndices` 统一处理（这样单卡判定的语义保持最简单）。
 */
export function isCardRerolled(
  baseline: AugmentCardFingerprint | null | undefined,
  current: AugmentCardFingerprint | null | undefined,
  options: RerollDecisionOptions = {},
): boolean {
  if (!baseline || !current) return false;
  if (fingerprintIsFlat(current, options)) return false;
  const threshold = options.threshold ?? AUGMENT_REROLL_THRESHOLD;
  return fingerprintDistance(baseline, current) >= threshold;
}

/** 一次判定的输入（三帧指纹：基线 / 本帧 / 上一帧）。 */
export interface RerollSample {
  /** **上次识别（= 标签内容）对应的那一帧**的指纹；`null` = 还没建立基线。 */
  readonly baseline: readonly (AugmentCardFingerprint | null)[] | null | undefined;
  /** 本帧的指纹（按卡序）。 */
  readonly current: readonly (AugmentCardFingerprint | null)[] | null | undefined;
  /**
   * 上一帧的指纹（可选）。
   *
   * 给了就要求"本帧与上一帧也基本一致"（`< threshold`）—— 即画面**已经稳定**。
   * 卡片翻转/淡入的中间帧虽然与基线差异很大，但它**每一帧都在变**：
   * 加上这一条就能等到动画停下再判定，一次刷新只触发**一次**重识别，
   * 也不会在中间帧上认不出而先把标签清掉。代价是多等一个采样周期
   * （默认 400ms），这远小于"贴着错字母"的代价。
   */
  readonly previous?: readonly (AugmentCardFingerprint | null)[] | null;
}

/**
 * 本帧里"内容已换掉"的卡片序号（升序；空 = 没有任何卡变化）。
 *
 * 语义与边界：
 *   · 没有基线（还没识别过 / 刚开面板）→ 返回空：**基线必须来自"画上去的那一帧"**，
 *     否则第一次比较就会把开面板动画当成刷新；
 *   · 卡数不一致时只比较公共前缀（面板卡数变化由开/关边沿负责，不在这里猜）；
 *   · 某张卡本帧指纹为 null（取不到像素）→ 该卡不判定（不误报，也不漏报别的卡）。
 */
export function rerolledCardIndices(
  sample: RerollSample,
  options: RerollDecisionOptions = {},
): number[] {
  const { baseline, current, previous } = sample;
  if (!baseline || !current || baseline.length === 0) return [];
  const threshold = options.threshold ?? AUGMENT_REROLL_THRESHOLD;
  const n = Math.min(baseline.length, current.length);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!isCardRerolled(baseline[i] ?? null, current[i] ?? null, options)) continue;
    if (previous) {
      // 画面已稳定：本帧与上一帧的差异必须**小于**阈值（否则还在动画中间）
      const prev = previous[i] ?? null;
      if (!prev || fingerprintDistance(prev, current[i] ?? null) >= threshold) continue;
    }
    out.push(i);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 刷新后的卡片合并（"认不出 → 该卡标签消失"的那一半）                    */
/* ------------------------------------------------------------------ */

/**
 * 合并用的最小卡片形状（渲染端的 `RecognizedCard` 结构上兼容）。
 *
 * 只需要 `rect` + `augmentId`（`augmentTierLabels` 的输入就是这个），
 * 名字/分数是给产物与日志看的可选字段。
 */
export interface RerollCardState {
  readonly rect: Rect;
  /** `null` = 认不出/没数据 → 调用方**不画这一张**的标签。 */
  readonly augmentId: number | null;
  readonly name?: string | null;
  readonly score?: number | null;
  readonly margin?: number | null;
}

/**
 * 用"刚重认出来的那几张卡"替换旧批次里的对应卡，**其余卡原样保留**。
 *
 * 这是"刷新后只换变化的那张卡的标签、别的卡不受影响"的纯函数形态：
 *   · `only[k]` 是变化卡的序号，`next[k]` 是它重认的结果；
 *   · `next[k]` 为 `null`（没认出来 / 取不到像素）→ 该卡 **`augmentId` 置 null**，
 *     于是 `augmentTierLabels()` 会把它过滤掉 → **它的标签消失**（绝不残留旧字母）；
 *   · 越界/非整数的序号忽略（不因为一次坏数据把整批标签搞乱）。
 *
 * ⚠️ 刻意**不做**"认不出就保留旧值"的兜底：留着旧字母 = 把上一颗海克斯的强度
 * 贴到新卡上，正是用户报的那个 bug（比不显示更糟）。
 */
export function mergeRefreshedCards(
  prev: readonly RerollCardState[],
  only: readonly number[],
  next: readonly (RerollCardState | null)[],
): readonly RerollCardState[] {
  const out: RerollCardState[] = [...prev];
  for (const [k, index] of only.entries()) {
    if (!Number.isInteger(index) || index < 0 || index >= out.length) continue;
    const old = out[index]!;
    const fresh = next[k] ?? null;
    out[index] = fresh ?? { ...old, augmentId: null, name: null, score: null, margin: null };
  }
  return out;
}
