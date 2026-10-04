/**
 * S2 视觉循环：截屏 → 定位卡片 → OCR 识别 → join 胜率 → 推送覆盖层
 *
 * 运行节奏（docs/SCREENSHOT-DEV.md §五）：仅选人阶段截屏,约 1.5s 一次,
 * 一次全流程 ~200ms,不影响游戏帧率。
 *
 * 合规：desktopCapturer 只读屏幕像素;GetWindowRect 只读窗口几何。
 * 不打开游戏进程句柄、不读内存、不注入、不解析封包。
 *
 * 状态机：
 *   phase=ChampSelect → 启动循环,持续截屏识别
 *   其它 phase        → 停止循环,清空覆盖层
 * 循环内部自动节流：识别失败（如加载中）不推送,保持上一次内容并降级提示。
 */

import { desktopCapturer, screen } from 'electron';

import {
  cardLabelFor,
  countOccupiedSlots,
  detectCards,
  detectTopBarCandidates,
  extractGrayRaw,
  extractNameStrip,
  findGameWindowRect,
  findGameWindowRectCached,
  makeScreenGeometry,
  matchNameCareful,
  createLabelMemory,
  slotLabelFor,
  topBarSlotRects,
  windowRectToCapture,
  NAME_STRIP,
  type Bitmap,
  type CardLabel,
  type NameFingerprint,
  type PhysicalRect,
  type PreparedTemplate,
  type Rect,
} from '@hexbox/vision';
import type { ChampSelectInfo, RankingSnapshot } from '@hexbox/core';

/** 覆盖层推送消息（renderer 只读）。 */
export interface VisionOverlayMsg {
  /** 本轮是否识别到可信布局（false = 清空绘制）。 */
  readonly active: boolean;
  readonly labels: Array<{
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
    readonly text: string;
    readonly sub: string;
    readonly hasData: boolean;
    readonly championId: number;
  }>;
  /** 诊断信息（可选,调试面板用）。 */
  readonly diag?: string;
}

export interface VisionLoopDeps {
  /** 名字指纹库（pnpm templates 产物）。getter 允许异步加载后更新。 */
  readonly nameLibrary: readonly NameFingerprint[] | (() => readonly NameFingerprint[]);
  /**
   * 头像模板（确认态顶栏逐格识别用）。
   *
   * ⚠️ 必须排除 60000+ 的「变体 ID」条目（CDragon champion-summary
   * 的静态定义占位,如 60038 = 虚空行者的变体）—— 它们与真英雄
   * 同名同图,匹配命中后 join 不到排行榜数据。getter 允许异步加载后更新。
   */
  readonly portraits?: readonly PreparedTemplate[] | (() => readonly PreparedTemplate[] | undefined);
  /** 英雄榜（胜率 join 数据源）。 */
  readonly rankings: RankingSnapshot | null | (() => RankingSnapshot | null);
  /** 英雄名映射。 */
  readonly championName: (id: number) => string;
  /**
   * 把识别到的英雄 ID 归一化到排行榜口径的基础 ID。
   *
   * 必须注入而不是直接 import：core 的 `canonicalChampionId` 需要英雄表，
   * 而英雄表在主进程里（此处只做纯计算）。
   */
  readonly canonicalId: (id: number) => number;
  /**
   * 选人阶段的两个子阶段（由 LCU 选人会话判定，比像素更可靠）。
   *
   * 用户确认的流程：
   *   · `picking`（第一阶段）—— 系统发出 2~3 张英雄卡，玩家还没选
   *     → 在**卡片下方**显示胜率；
   *   · `locked`（第二阶段）—— 玩家选中后，未选的英雄进入顶部「可用」区
   *     → 在**顶栏每个备选下方**显示胜率，且**绝不再画卡片标签**；
   *   · `unknown` —— 拿不到会话时退回像素占用启发式。
   *
   * ⚠️ 没有它时只能用"顶栏是否有头像"猜阶段：真机反馈二阶段仍画着卡片
   * 标签（像素占用判不准就会这样），所以主进程应尽量提供本字段。
   */
  readonly pickState?: () => 'picking' | 'locked' | 'unknown';
  /** 识别结果的消费方（主进程推给覆盖窗口）。 */
  readonly onResult: (msg: VisionOverlayMsg, display: Electron.Display) => void;
}

/** deps 字段可能是值或 getter,统一取值。 */
function resolveDeps<T>(v: T | (() => T)): T {
  return typeof v === 'function' ? (v as () => T)() : v;
}

/**
 * 单轮截屏（供 vision-loop 与 debug 工具复用）。
 *
 * 同时返回窗口物理矩形 —— 它和截屏必须来自**同一次**探测：
 * `findGameWindowRect()` 会起一个 PowerShell 进程（本机实测约 **1.2 秒**：
 * 启动 610ms + `Add-Type` 编译 450ms + 进程枚举 156ms），调用方再查第二次
 * 就是纯粹的双倍开销（每 1.5s 一轮，真实存在过）。
 *
 * 因此这里走 `findGameWindowRectCached`（TTL 10s）：窗口矩形在几秒内
 * 不会变，把 1.2s 的探测摊薄到 6~7 轮一次。
 */
async function captureGameBitmap(): Promise<{
  bmp: Bitmap;
  display: Electron.Display;
  windowPhysical: PhysicalRect | null;
} | null> {
  // 先找游戏窗口所在显示器 —— 游戏可能不在主显示器
  // （多显示器 + 不同 DPI 时,主显示器的 scaleFactor/尺寸全是错的）
  const windowPhysical = await findGameWindowRectCached();
  const display = windowPhysical
    ? screen.getDisplayNearestPoint({ x: windowPhysical.x + 10, y: windowPhysical.y + 10 })
    : screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: display.size.width * 2, height: display.size.height * 2 },
    fetchWindowIcons: false,
  });
  const lol =
    sources.find((s) => s.name === 'League of Legends') ??
    sources.find((s) => /League of Legends/i.test(s.name));
  if (!lol) return null;

  const size = lol.thumbnail.getSize();
  const raw = lol.thumbnail.toBitmap(); // BGRA
  const data = new Uint8ClampedArray(size.width * size.height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = raw[i + 2]!;
    data[i + 1] = raw[i + 1]!;
    data[i + 2] = raw[i]!;
    data[i + 3] = raw[i + 3]!;
  }
  return { bmp: { width: size.width, height: size.height, data }, display, windowPhysical };
}

/** 一轮识别：返回 null 表示「本轮无可信结果,应清空」。 */
export async function runVisionRound(
  deps: VisionLoopDeps,
): Promise<{ msg: VisionOverlayMsg | null; display: Electron.Display }> {
  // 窗口矩形来自 createGameBitmap 的同一次探测（勿在此再查一遍）
  const grabbed = await captureGameBitmap();
  if (!grabbed) {
    return { msg: null, display: screen.getPrimaryDisplay() };
  }
  const { bmp, display, windowPhysical } = grabbed;

  // 统一换算：自动区分「显示器快照」与「窗口快照」两种形态
  // （S2 真机验收教训：二者混淆导致标签横向错位）
  const { geo, kind, scale } = makeScreenGeometry(bmp, windowPhysical, {
    bounds: display.bounds,
    scaleFactor: display.scaleFactor,
    workArea: display.workArea,
  });
  console.log(
    `[hexbox:vision] 截屏 ${bmp.width}x${bmp.height} 窗口` +
      `${windowPhysical ? `${windowPhysical.width}x${windowPhysical.height}@${windowPhysical.x},${windowPhysical.y}` : '未知'}` +
      ` 显示器${display.bounds.width}x${display.bounds.height}@${display.scaleFactor}` +
      ` 工作区${display.workArea.width}x${display.workArea.height}@${display.workArea.x},${display.workArea.y}` +
      ` 判定=${kind} scale=${scale.toFixed(3)}` +
      ` geo=${geo.windowWidth.toFixed(0)}x${geo.windowHeight.toFixed(0)}@${geo.windowX.toFixed(0)},${geo.windowY.toFixed(0)}`,
  );

  const det = detectCards(bmp);

  // ── 先扫顶栏：它是"处于哪个阶段"的判据 ───────────────────────────
  //
  // 第一阶段：卡片刚发出来、**还没人选** → 顶栏 10 格全空 → 显示卡片胜率；
  // 第二阶段：玩家选定后，未选的英雄进顶栏「可用」区 → 顶栏有头像
  //           → 显示顶栏逐格胜率，并且**绝不再画卡片标签**。
  //
  // ⚠️ 真机 bug：第二阶段卡片已经消失，但 `detectCards` 仍会在美术图上
  // 误检出 2 张矩形，于是屏幕中间冒出两个（错误的）胜率框。
  // 用"顶栏是否有头像"来区分阶段，这个歧义就消失了。
  const portraits = (resolveDeps(deps.portraits) ?? []) as readonly PreparedTemplate[];
  const rankings = resolveDeps(deps.rankings) as RankingSnapshot | null;
  const pickState = deps.pickState?.() ?? 'unknown';
  let topBarOccupiedCount = 0;
  let cands: ReturnType<typeof detectTopBarCandidates> = [];
  let captureSlots: Rect[] = [];
  if (portraits.length > 0) {
    captureSlots = topBarSlotRects().map(
      (r) => windowRectToCapture(r, bmp, windowPhysical, display),
    );
    topBarOccupiedCount = countOccupiedSlots(bmp, captureSlots);
    if (topBarOccupiedCount > 0) {
      cands = detectTopBarCandidates(bmp, captureSlots, portraits);
    }
  }

  // 阶段判定：**顶栏有内容就是二阶段**（物理事实，真机两阶段都验证过：
  // 一阶段 10 格全空 → 占用 0；二阶段有头像 → 占用 4）。
  // LCU 的 pickState 只作为**补充**：它说 locked 就算二阶段，但它说 picking
  // **不能**推翻占用证据。
  //
  // ⚠️ 真机 bug（本行曾写错）：上一版把 pickState 当权威 →
  //   `isPhase2 = pickState==='locked' || (pickState==='unknown' && 占用>0)`
  // 一旦 LCU 会话里的 pick 动作解析不到（字段与假设不一致），pickState 就是
  // 'picking'，于是二阶段**仍走一阶段分支**：detectCards 在美术图上检出假卡片，
  // 标签被画到屏幕左侧、且每轮位置几乎不变（用户报告的第 4 条）。
  const isPhase2 = topBarOccupiedCount > 0 || pickState === 'locked';

  if (isPhase2) {
    // ── 第二阶段：顶栏备选区逐格胜率 ──
    const labels: CardLabel[] = [];
    const identified: string[] = [];
    for (const cand of cands) {
      // ⚠️ 识别可能给出高 ID（60000+），而排行榜只有基础 ID —— 必须归一化，
      // 否则顶栏每个英雄都会显示「暂无数据」（真机实测过）。
      const cid = deps.canonicalId(cand.championId);
      const row = rankings?.heroes.find((h) => h.championId === cid);
      const sub = deps.championName(cid);
      identified.push(`${sub}=${cand.score.toFixed(2)}`);
      labels.push(
        slotLabelFor(captureSlots[cand.slotIndex]!, geo, display.workArea, {
          name: sub,
          winRate: row?.winRate ?? 0,
          hasData: row !== undefined,
          championId: cid,
        }),
      );
    }
    const diag =
      `第二阶段(${pickState}): 顶栏占用 ${topBarOccupiedCount} 格, 识别成功 ${labels.length} 格` +
      (identified.length > 0 ? ` [${identified.join(' ')}]` : '') +
      (labels[0]
        ? ` 标签0@(${labels[0].x.toFixed(0)},${labels[0].y.toFixed(0)}) ${labels[0].w}x${labels[0].h}` +
          ` 槽0 x=${captureSlots[0]!.x.toFixed(3)}(归一)→CSS ${(captureSlots[0]!.x * geo.windowWidth).toFixed(0)}`
        : '');
    // 有头像但一个都没认出来：不画（宁漏勿错），诊断留给日志
    return { msg: { active: labels.length > 0, labels, diag }, display };
  }

  if (!det.confident || det.cards.length === 0) {
    return {
      msg: {
        active: false,
        labels: [],
        diag: `第一阶段(${pickState})但未检出卡片: ${det.reason ?? '?'}（顶栏占用 ${topBarOccupiedCount}）`,
      },
      display,
    };
  }

  // ── 第一阶段：卡片下方显示胜率 ──
  const workArea = display.workArea;
  const labels: CardLabel[] = [];
  const nameLibrary = resolveDeps(deps.nameLibrary);
  const perCard: string[] = [];
  for (const rect of det.cards) {
    // 名字带 OCR
    const stripRect = {
      x: rect.x + (rect.w * (1 - NAME_STRIP.width)) / 2,
      y: rect.y + (rect.h * NAME_STRIP.yCenter - (rect.h * NAME_STRIP.height) / 2),
      w: rect.w * NAME_STRIP.width,
      h: rect.h * NAME_STRIP.height,
    };
    const raw = extractGrayRaw(bmp, stripRect);
    let championId = 0;
    let score = 0;
    let margin = 0;
    if (raw) {
      const strip = extractNameStrip(raw.gray, raw.width, raw.height);
      // ⚠️ 用带区分度的匹配：第二阶段/对局内会在美术图上误检出矩形，
      // 只看最高分会给出 0.45~0.5 的假命中，于是把错误胜率画到屏幕中间。
      const m = matchNameCareful(strip, nameLibrary);
      if (m) {
        championId = m.championId;
        score = m.score;
        margin = m.margin;
      }
    }
    perCard.push(championId > 0 ? `${score.toFixed(2)}/${margin.toFixed(2)}` : '拒绝');

    if (championId <= 0) {
      // 识别不出就不画（宁漏勿错）—— 用户已确认不要「未识别」占位框
      continue;
    }

    // 胜率 join（core 纯函数）
    // ⚠️ 同顶栏：名字指纹库含高 ID（60000+）条目，而排行榜只有基础 ID，
    // 必须归一化，否则识别成功也会显示「暂无数据」（真机实测过）。
    const cid = deps.canonicalId(championId);
    const row = rankings?.heroes.find((h) => h.championId === cid);
    labels.push(
      cardLabelFor(rect, geo, workArea, {
        name: deps.championName(cid),
        winRate: row?.winRate ?? 0,
        hasData: row !== undefined,
        championId: cid,
      }),
    );
  }

  // 真机核对用：把标签坐标与它对应的卡片矩形一起报出来，
  // 这样"标签是否落在卡片下方"可以只看日志判断，不必再猜几何。
  const firstCard = det.cards[labels.length > 0 ? 0 : 0];
  return {
    msg: {
      active: true,
      labels,
      diag:
        `第一阶段(${pickState}): 卡片 ${det.cards.length} 张 → 出标签 ${labels.length} 个` +
        ` [得分/分差 ${perCard.join(' ')}]` +
        (labels[0] && firstCard
          ? ` 标签0@(${labels[0].x.toFixed(0)},${labels[0].y.toFixed(0)}) ${labels[0].w}x${labels[0].h}` +
            ` 卡0 y=${(firstCard.y + firstCard.h).toFixed(3)}(归一)→CSS ${((firstCard.y + firstCard.h) * geo.windowHeight).toFixed(0)}`
          : ''),
    },
    display,
  };
}

/**
 * 视觉循环控制器。
 *
 * `setActive(true)` 在进入 ChampSelect 时调用;离开时 `setActive(false)`。
 * 内部串行执行（上一轮完成才开始下一轮）,避免截屏堆积。
 *
 * 标签记忆（真机 bug 修复,2026-09-28）：卡片检测对动画/光效敏感,
 * 「3 张卡某轮只检出 2 张」的部分失败会以 active=true 覆盖旧结果,
 * 第三张卡片的胜率因此消失。现在每轮结果先经 `rememberLabels`
 * 按**位置**补齐 TTL 内缺失的旧标签,再推送 —— 显示连续性不受
 * 单轮检测抖动影响（TTL 6 轮 × 1.5s = 9s,足够覆盖检测闪烁）。
 */
export class VisionLoop {
  private readonly deps: VisionLoopDeps;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** 标签记忆（rememberLabels 的状态体）。 */
  private memory = createLabelMemory();
  private round = 0;
  private failCount = 0;
  /** 上一轮所处的子阶段（用于检测切换并立刻清空记忆）。 */
  private lastPickState: 'picking' | 'locked' | 'unknown' | null = null;

  constructor(deps: VisionLoopDeps, intervalMs = 1500) {
    this.deps = deps;
    this.intervalMs = intervalMs;
  }

  start(): void {
    if (this.timer) return;
    const tick = async (): Promise<void> => {
      if (this.running) return;
      this.running = true;
      try {
        // 子阶段切换（第一阶段⇄第二阶段）时**立刻**清空标签记忆 —— 否则
        // 卡片胜率会在选定后继续残留最多 6 轮（≈9 秒），真机反馈为
        // "进入二阶段还不消失"。卡片与顶栏的标签位置完全不同，不能混用。
        const pickState = this.deps.pickState?.() ?? 'unknown';
        if (this.lastPickState !== null && pickState !== this.lastPickState) {
          this.memory.reset();
        }
        this.lastPickState = pickState;

        const { msg, display } = await runVisionRound(this.deps);
        this.round++;
        const active = msg !== null && msg.active;
        // 记忆补齐:本轮识别到的标签 + TTL 内未过期的旧标签
        const labels = this.memory.update(msg?.labels ?? [], this.round, active);
        if (active) {
          this.failCount = 0;
        } else {
          this.failCount++;
        }
        const shown = active || labels.length > 0;
        this.deps.onResult(
          shown
            ? { active: true, labels, diag: msg?.diag ?? '记忆保持' }
            : { active: false, labels: [], diag: msg?.diag ?? '未找到游戏窗口' },
          display,
        );
      } catch {
        this.deps.onResult(
          { active: false, labels: [], diag: '识别异常' },
          screen.getPrimaryDisplay(),
        );
      } finally {
        this.running = false;
      }
    };
    void tick();
    this.timer = setInterval(() => void tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.memory.reset();
    this.round = 0;
    this.failCount = 0;
    this.deps.onResult({ active: false, labels: [] }, screen.getPrimaryDisplay());
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }
}
