/**
 * 「面板**仍在**」的独立廉价信号（纯函数，可单测）
 *
 * ── 为什么需要它（2026-10-06 真机回归：局内面板开着，标签却消失了）──────────
 *
 * 门控原来的关闭判据只有一条：`augment-panel.ts` 的**卡片判据**
 * （结构 + 内部暗 + 边框对比）。而**单卡重随（reroll）的翻牌动画**会让这条判据
 * 连续失效 —— 真机时间线（`debug/augment/timeline.csv`，像素模式 400ms 采样）实测：
 *
 *   ms      found cards bands  state   看什么
 *   32524     1     3     6    open    面板正常
 *   32930     0     0     4    open    翻牌开始：卡片判据失效
 *   33333     0     0     4   closed   ★ 第 2 帧失效 → 旧阈值(2 帧)判"关闭"
 *   33612     0     0     4   closed
 *   33862     0     0     4   closed
 *   34108     1     2     8    ──     ★ 面板**其实一直在**（卡片又回来了）
 *
 * 也就是说：**"卡片判据失效" ≠ "面板不在"**。翻牌动画持续约 1 秒
 *（32930 → 34108 = 1178ms），400ms 采样下 2 帧只有 0.8 秒 → 必被穿过去。
 *
 * 所以这里补一条**与卡片判据完全独立**的信号：面板是 `UI 覆盖层`，
 * 三张卡的**上/下边缘是两条横贯卡片宽度的亮线**（亮象牙白），而翻牌是
 * **绕竖轴翻转** —— 内容在动、上下缘的 y 不变。只要这两条亮线还在原来的行上，
 * 面板就还在，哪怕卡片内部的判据全废。
 *
 * ── 判据（2026-10-06 用真机帧标定，勿凭印象改）────────────────────────────
 *
 * 在**卡片行搜索区**（`PANEL_ROW_REGION`）里按行统计"亮像素占比"，然后要求
 * **同时**存在上下两条亮带：
 *
 *   ① 上半区（搜索区 y ≤ 0.45）有一行亮像素占比 ≥ 0.25；
 *   ② 下半区（搜索区 y ≥ 0.55）有一行亮像素占比 ≥ 0.25；
 *   ③ 两行之间的跨度落在 0.40~0.90（= 卡片高度那一档）；
 *   ④ 两条带都得是**细亮线**：带内占比 − 紧邻带外最高占比 ≥ 0.15。
 *
 * ⚠️ ④ 是必须的：`brightLuma=110` 能被"整片亮画面"满足（那样的帧上/下搜索区
 * 各有一行占比 1.0、跨度也恰好落在卡高档）→ 只有 ①②③ 会把亮场景误判成"面板仍在"。
 * 真面板的带外就是暗的游戏画面（实测突出 0.25~0.37），均匀亮背景的带外同样亮（≈0）。
 *
 * 实测（`node --experimental-strip-types debug/presence-check.mts <帧>`；
 * 门控分辨率 = 原生宽 1/3、至少 960px，与线上 `gateCanvasWidth()` 同一套算法；
 * 读数格式 = 上/下亮带的 行位置(占比，突出量) + 跨度）：
 *
 *   帧                                卡片判据  面板信号  读数
 *   inprogress-152509-raw.png（面板）    ✅ 3 张   ✅ 在    0.128(0.49,突0.28) / 0.834(0.47,突0.25) 跨度0.71
 *   inprogress-152515-raw.png（面板）    ✅ 3 张   ✅ 在    0.128(0.47,突0.37) / 0.841(0.46,突0.28) 跨度0.71
 *   closed-sample-2.png（局内暗场景）    ❌        ❌ 不在  上区最高 0.16 < 0.25
 *   closed-sample-3.png（局内）          ❌        ❌ 不在  上区最高 0.17 < 0.25
 *   closed-sample-6.png（局内亮场景）    ❌        ❌ 不在  上区最高 0.18 < 0.25
 *   open-1 / close-1 / close-2（探错窗口）❌       ❌ 不在  上区最高 0.03
 *   phase1 / shot1 / verify1（**选人界面**）❌     ✅ 在    ★ 已知假阳性，见下
 *   shot2 / verify2 / phase2（选人·亮画面）❌      ❌ 不在  亮带突出量不足（下带 0.13 / 0.06 < 0.15）
 *   acceptance-1 / confirmed-state         ❌       ❌ 不在  上区最高 0.19 / 突出量不足
 *
 * 区分度（阈值 **0.25** + 突出量 **0.15**，2026-10-06 定）：
 *   · 真机面板（三张卡）上/下带 0.46~0.49、突出 0.25~0.37、跨度 0.71 → 过；
 *   · **只剩两张卡的边框**（翻牌动画中间帧可能如此，真机 `timeline.csv` 里
 *     动画收尾那帧就是 `cards=2`）：一行亮带 ≈ 3 × 0.115/0.76 = 0.454 区宽，
 *     两张卡约 **0.30** → **占比**这一条仍过（×1.2 余量）；
 *   ⚠️ **但这只对占比成立**（2026-10-11 更正，别再把 ×1.2 当成整体余量）：
 *     少一张卡同时把**突出量**拉下来 —— 合成翻牌实验（抹掉一整张卡）实测
 *     上突出 **0.131** / 下突出 **0.098**，双双低于 0.15 → 该帧**判"不在"**。
 *     也就是说本信号的真实约束是**突出量**，不是占比；余量比头注原先以为的小。
 *     补办法是**滞后**（`augment-panel.ts` 的 `PANEL_PRESENCE_HYSTERESIS_FRAMES`：
 *     上一帧仍在 + 本帧只是临界失败 → 放过 1 帧），**不是**放宽 0.15
 *     （那正是拒绝"整片亮画面"误报的那条）；
 *   · 手上全部**局内**负样本被拒，且余量很大（上区最高 0.16~0.18 vs 阈值 0.25）。
 *
 * ★ **已知假阳性（必读）**：选人界面（客户端）的英雄卡也是"亮象牙白边框 + 暗底"的
 *   两张大卡，几何几乎同档（phase1：上 y0.230 占比 0.37 / 下 y0.849 占比 0.35）——
 *   本信号在选人帧上会报"在"。为什么现在可以接受：
 *     ① 局内链路**只在 `InProgress` / `Reconnect` 跑**（`AUGMENT_CHAIN_PHASES`），
 *        选人阶段的帧根本到不了这个判据；
 *     ② 就算误报，门控的托底额度（`PANEL_PRESENCE_TRUST_FRAMES`=5 帧）用完就不再托底
 *        → 最多多留 5 帧标签，不会"永远不消失"。
 *   ⚠️ 将来若把链路扩到别的阶段，**先处理这条假阳性**（例如同时要求"卡片内部近黑"，
 *   或把搜索区收紧到局内 HUD 特有的位置）。
 *
 * ⚠️ 与"整体暗底"无关：真机面板帧的区域均亮 43~49，而负样本里的夜间地图 41、
 * 选人界面 33 —— **暗不能用来分辨面板**（本项目踩过 EMA 基线那条坑，
 * 别再用亮度绝对值当判据）。
 *
 * ── 成本 ────────────────────────────────────────────────────────────────
 *
 * 每个搜索区一次按行扫描（x 方向隔点采样）。**只在卡片判据未命中的帧上算**
 *（命中帧不必算：面板当然在），正常状态一帧不额外花时间。
 *
 * ⚠️ 数据缺口（如实记录，别当成已标定）：仓库里**没有翻牌动画中间帧**
 *（`debug/augment/*.png` 那几张是"探错窗口"的客户端/桌面截图，不是动画帧）。
 * 因此"本信号能穿过翻牌"是**推理**（绕竖轴翻转 → 上下缘不动 + 实测动画帧
 * Δy 0.015 / Δh 0.028 都在 ③ 的容差内），不是实测；真正的兜底是
 * `augment-panel.ts` 的 **3 帧双信号关闭确认**。拿到动画帧后请用上面的探针重标。
 *
 * ⚠️ 本文件必须保持**浏览器安全**（渲染端截屏 worker 会 import 它）：
 * 只允许依赖 types 这类纯计算模块。
 */

import type { Bitmap, Rect } from './types.ts';

/**
 * 卡片行搜索区（**与 `augment-panel.ts` 的 `PANEL_ROW_REGION` 同一个区**）。
 *
 * 这里再写一份常量而不是 import：`augment-panel.ts` 的检测器是标定过的，
 * 本模块刻意**不依赖它的任何阈值/结构**（"独立信号"要独立到底）。
 * 若搜索区将来变了，两处都要改 —— 单测里有一条断言锁住它们相等。
 */
export const PANEL_PRESENCE_REGION: Rect = { x: 0.12, y: 0.1, w: 0.76, h: 0.66 };

export interface PanelPresenceThresholds {
  /** 亮像素阈值（边框是亮象牙白；门控分辨率实测 120~156）。 */
  readonly brightLuma: number;
  /**
   * 一条"卡片边框行"要求的亮像素占搜索区宽度比例。
   *
   * 实测：三张卡 0.46~0.49；**只剩两张卡**（翻牌动画中间帧）≈0.30 →
   * 取 0.25（两侧余量 ×1.8 / ×1.2，推导见文件头）。
   */
  readonly minBorderRowFrac: number;
  /**
   * 亮带相对"紧邻带外的行"的最小突出量（**线**判据，不是亮度判据）。
   *
   * 为什么必须有：`brightLuma=110` 已经能被"整片亮场景"满足，那种帧的上/下搜索区
   * 各有一行占比 1.0、跨度也恰好落在卡高档 → 会被误判成"面板仍在"。
   * 真面板的上下缘是**细亮线**，紧邻带外就是暗的游戏画面（实测突出量 ≈ 0.45）；
   * 均匀亮背景的带外同样亮 → 突出量 ≈ 0 → 直接否掉。
   */
  readonly minLineProminence: number;
  /** 上半区搜索上界（搜索区归一化；实测上缘 0.118~0.147）。 */
  readonly maxTopRowFrac: number;
  /** 下半区搜索下界（搜索区归一化；实测下缘 0.832~0.853）。 */
  readonly minBottomRowFrac: number;
  /** 上下亮带的跨度下界（实测 0.685；合成测试卡 0.55）。 */
  readonly minRowSpanFrac: number;
  /** 上下亮带的跨度上界（防止"两条无关亮线"也算一对）。 */
  readonly maxRowSpanFrac: number;
  /** x 方向采样步长（1 = 全采；隔点采样只是省时间，占比几乎不变）。 */
  readonly xStep: number;
}

export const PANEL_PRESENCE_THRESHOLDS: PanelPresenceThresholds = {
  brightLuma: 110,
  minBorderRowFrac: 0.25,
  minLineProminence: 0.15,
  maxTopRowFrac: 0.45,
  minBottomRowFrac: 0.55,
  minRowSpanFrac: 0.4,
  maxRowSpanFrac: 0.9,
  xStep: 2,
};

/** 一条"面板仍在"信号读数（渲染端随帧回传；主进程只读它）。 */
export interface PanelPresence {
  /** 是否认定"面板这个 UI 元素**仍在屏上**"（与卡片判据无关）。 */
  readonly present: boolean;
  /** 上亮带所在行（搜索区归一化 0~1；没有为 null）。 */
  readonly topRow: number | null;
  /** 下亮带所在行（搜索区归一化 0~1；没有为 null）。 */
  readonly bottomRow: number | null;
  /** 上亮带那一行的亮像素占比。 */
  readonly topFrac: number;
  /** 下亮带那一行的亮像素占比。 */
  readonly bottomFrac: number;
  /** 上亮带的**突出量**（带内占比 − 紧邻带外最高占比；均匀亮背景≈0）。 */
  readonly topProminence: number;
  /** 下亮带的**突出量**（同上）。 */
  readonly bottomProminence: number;
  /** 人读原因（进日志/产物；**每次判定都要能解释**）。 */
  readonly reason: string;
}

/** "这一帧没有面板信号可用"（旧渲染端 / 一次性截屏路径没算）→ 与"不在"同义。 */
export const NO_PANEL_PRESENCE: PanelPresence = {
  present: false,
  topRow: null,
  bottomRow: null,
  topFrac: 0,
  bottomFrac: 0,
  topProminence: 0,
  bottomProminence: 0,
  reason: '未提供面板信号（按"不在"处理）',
};

/** 像素亮度（Rec.601 近似；与门控其它判据同一套算法）。 */
function lumaAt(bmp: Bitmap, x: number, y: number): number {
  const i = (y * bmp.width + x) * 4;
  return 0.299 * bmp.data[i]! + 0.587 * bmp.data[i + 1]! + 0.114 * bmp.data[i + 2]!;
}

/**
 * 检测一帧里"面板这个 UI 元素是否仍在"（纯函数；只做一次按行扫描）。
 *
 * @param region 卡片行搜索区（**截屏归一化**；默认 `PANEL_PRESENCE_REGION`）
 */
export function detectPanelPresence(
  bmp: Bitmap,
  region: Rect = PANEL_PRESENCE_REGION,
  thresholds: PanelPresenceThresholds = PANEL_PRESENCE_THRESHOLDS,
): PanelPresence {
  const x0 = Math.round(region.x * bmp.width);
  const y0 = Math.round(region.y * bmp.height);
  const x1 = Math.round((region.x + region.w) * bmp.width);
  const y1 = Math.round((region.y + region.h) * bmp.height);
  if (x1 - x0 < 8 || y1 - y0 < 8 || x0 < 0 || y0 < 0 || x1 > bmp.width || y1 > bmp.height) {
    return { ...NO_PANEL_PRESENCE, reason: '搜索区越界（太小或超出帧）' };
  }
  const step = Math.max(1, Math.round(thresholds.xStep));
  const cols = Math.floor((x1 - x0) / step);
  const rows = y1 - y0;
  const topLimitIdx = Math.round(rows * thresholds.maxTopRowFrac);
  const bottomStartIdx = Math.round(rows * thresholds.minBottomRowFrac);

  /** 每一行的亮像素占比（搜索区行索引）。 */
  const rowFrac: number[] = [];
  for (let y = y0; y < y1; y++) {
    let bright = 0;
    for (let x = x0; x < x1; x += step) if (lumaAt(bmp, x, y) >= thresholds.brightLuma) bright++;
    rowFrac.push(bright / cols);
  }

  /**
   * 在 [from, to] 行区间里取占比最大的那一行。
   *
   * `takeLast` 决定并列时取哪一个，这不是细节：
   *   · 上缘取**最上**那一行、下缘取**最下**那一行 → 跨度是"卡片行的外缘到外缘"
   *     （真机 ≈0.735；合成卡 ≈0.545），对"整块卡面都亮"（翻牌时内容变亮）也成立 ——
   *     那种帧的两条带会连成一片，取带内首/末行仍然是卡片的外缘。
   */
  const peakIn = (from: number, to: number, takeLast = false): number => {
    let best = from;
    const hi = Math.min(to, rowFrac.length - 1);
    for (let i = from; i <= hi; i++) {
      const better = takeLast ? rowFrac[i]! >= rowFrac[best]! : rowFrac[i]! > rowFrac[best]!;
      if (better) best = i;
    }
    return best;
  };

  /**
   * 亮带的**突出量**：带内峰值 − 紧邻带外最高值。
   *
   * 亮带从峰值行向两侧扩展（相邻行仍然 ≥ `minBorderRowFrac` 才算同一条带），
   * 然后看带外那一行 —— 真面板的带外是暗的游戏画面，均匀亮背景的带外同样亮。
   */
  const prominenceOf = (peak: number): number => {
    const need = thresholds.minBorderRowFrac;
    let a = peak;
    let b = peak;
    while (a - 1 >= 0 && rowFrac[a - 1]! >= need) a--;
    while (b + 1 < rowFrac.length && rowFrac[b + 1]! >= need) b++;
    let outside = -1;
    if (a - 1 >= 0) outside = Math.max(outside, rowFrac[a - 1]!);
    if (b + 1 < rowFrac.length) outside = Math.max(outside, rowFrac[b + 1]!);
    if (outside < 0) return 0; // 带一直顶到搜索区边界 → 没有"带外"，不算突出
    return rowFrac[peak]! - outside;
  };

  const need = thresholds.minBorderRowFrac;
  const frac2 = (v: number): string => v.toFixed(2);
  const topRow = peakIn(0, Math.min(topLimitIdx, rowFrac.length - 1));
  const botRow = peakIn(Math.min(bottomStartIdx, rowFrac.length - 1), rowFrac.length - 1, true);
  const topFrac = rowFrac[topRow] ?? 0;
  const botFrac = rowFrac[botRow] ?? 0;
  const topProm = topFrac >= need ? prominenceOf(topRow) : 0;
  const botProm = botFrac >= need ? prominenceOf(botRow) : 0;
  const norm = (i: number): number => i / rows;
  const topN = norm(topRow);
  const botN = norm(botRow);
  const span = botN - topN;
  /** 未命中时统一带上全部读数（诊断/标定用）。 */
  const miss = (reason: string): PanelPresence => ({
    present: false,
    topRow: Number(topN.toFixed(3)),
    bottomRow: Number(botN.toFixed(3)),
    topFrac: Number(topFrac.toFixed(3)),
    bottomFrac: Number(botFrac.toFixed(3)),
    topProminence: Number(topProm.toFixed(3)),
    bottomProminence: Number(botProm.toFixed(3)),
    reason,
  });

  if (topFrac < need) {
    return miss(`上半区没有卡片上缘亮带（最高 ${frac2(topFrac)} < ${need}）`);
  }
  if (botFrac < need) {
    return miss(`下半区没有卡片下缘亮带（最高 ${frac2(botFrac)} < ${need}）`);
  }
  if (topProm < thresholds.minLineProminence || botProm < thresholds.minLineProminence) {
    return miss(
      `亮带不突出（突出量 上 ${frac2(topProm)} / 下 ${frac2(botProm)} < ` +
        `${thresholds.minLineProminence}：整片亮背景，不是两条细亮线？）`,
    );
  }
  if (span < thresholds.minRowSpanFrac || span > thresholds.maxRowSpanFrac) {
    return miss(
      `上下亮带跨度 ${span.toFixed(2)} 不在 ${thresholds.minRowSpanFrac}~` +
        `${thresholds.maxRowSpanFrac}（不像同一排卡片）`,
    );
  }
  return {
    present: true,
    topRow: Number(topN.toFixed(3)),
    bottomRow: Number(botN.toFixed(3)),
    topFrac: Number(topFrac.toFixed(3)),
    bottomFrac: Number(botFrac.toFixed(3)),
    topProminence: Number(topProm.toFixed(3)),
    bottomProminence: Number(botProm.toFixed(3)),
    reason:
      `卡片上下缘亮带仍在：y ${topN.toFixed(3)}(${frac2(topFrac)}，突出 ${frac2(topProm)}) ~ ` +
      `y ${botN.toFixed(3)}(${frac2(botFrac)}，突出 ${frac2(botProm)})，跨度 ${span.toFixed(2)}`,
  };
}

/**
 * 依次在多个候选搜索区里找"面板仍在"的信号，返回**第一个成立**的。
 *
 * 与 `augment-panel.ts` 的 `detectAugmentPanelInRegions` 同构：窗口矩形探针认错窗口时，
 * 卡片判据用的主区可能把外侧卡边框切掉，所以两个候选区都要看一遍。
 */
export function detectPanelPresenceInRegions(
  bmp: Bitmap,
  regions: readonly Rect[],
  thresholds: PanelPresenceThresholds = PANEL_PRESENCE_THRESHOLDS,
): { readonly presence: PanelPresence; readonly regionIndex: number } {
  let first: PanelPresence | null = null;
  for (const [i, region] of regions.entries()) {
    const p = detectPanelPresence(bmp, region, thresholds);
    if (p.present) return { presence: p, regionIndex: i };
    if (first === null) first = p;
  }
  return {
    presence: first ?? { ...NO_PANEL_PRESENCE, reason: '没有候选搜索区' },
    regionIndex: -1,
  };
}
