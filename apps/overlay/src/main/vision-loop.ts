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
  detectCards,
  detectTopBarCandidates,
  extractGrayRaw,
  extractNameStrip,
  findGameWindowRect,
  findGameWindowRectCached,
  makeScreenGeometry,
  matchName,
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
      ` 判定=${kind} scale=${scale.toFixed(3)}`,
  );

  const det = detectCards(bmp);
  if (!det.confident || det.cards.length === 0) {
    // 选人**确认态**（已锁定英雄）：顶栏「可用」列出未选的备选英雄,
    // 逐格识别并显示每个备选英雄的胜率（需求语义,2026-09-28 用户确认）。
    const portraits = (resolveDeps(deps.portraits) ?? []) as readonly PreparedTemplate[];
    const rankings = resolveDeps(deps.rankings) as RankingSnapshot | null;
    if (portraits.length === 0) {
      return {
        msg: { active: false, labels: [], diag: `未检出卡片: ${det.reason ?? '?'}` },
        display,
      };
    }

    // 槽位几何按窗口归一化存储 → 先变换到截屏空间再识别
    // （display 形态截屏里窗口只是子矩形,不变换会整体错位）
    const captureSlots = topBarSlotRects().map(
      (r) => windowRectToCapture(r, bmp, windowPhysical, display),
    );
    const labels: CardLabel[] = [];
    const identified: string[] = [];
    for (const cand of detectTopBarCandidates(bmp, captureSlots, portraits)) {
      const row = rankings?.heroes.find((h) => h.championId === cand.championId);
      const sub = deps.championName(cand.championId);
      identified.push(`${sub}=${cand.score.toFixed(2)}`);
      // 标签定位用截屏空间的槽位矩形（与识别同一坐标系）
      labels.push(
        slotLabelFor(captureSlots[cand.slotIndex]!, geo, display.workArea, {
          name: sub,
          winRate: row?.winRate ?? 0,
          hasData: row !== undefined,
          championId: cand.championId,
        }),
      );
    }

    // 逐格识别全部失败时降级提示（而不是无显示 —— 便于真机排查）
    if (labels.length === 0) {
      return {
        msg: {
          active: false,
          labels: [],
          diag: `确认态: 顶栏无识别成功的格子（模板 ${portraits.length}）`,
        },
        display,
      };
    }

    return {
      msg: {
        active: true,
        labels,
        diag: `确认态顶栏: ${identified.join(' ')}`,
      },
      display,
    };
  }

  const workArea = display.workArea;
  const labels = [];
  const nameLibrary = resolveDeps(deps.nameLibrary);
  const rankings = resolveDeps(deps.rankings) as RankingSnapshot | null;
  for (const rect of det.cards) {
    // 名字带 OCR
    const stripRect = {
      x: rect.x + (rect.w * (1 - NAME_STRIP.width)) / 2,
      y: rect.y + rect.h * (NAME_STRIP.yCenter - NAME_STRIP.height / 2),
      w: rect.w * NAME_STRIP.width,
      h: rect.h * NAME_STRIP.height,
    };
    const raw = extractGrayRaw(bmp, stripRect);
    let championId = 0;
    if (raw) {
      const strip = extractNameStrip(raw.gray, raw.width, raw.height);
      const m = matchName(strip, nameLibrary, { minScore: 0.45 });
      if (m) championId = m.championId;
    }

    // 胜率 join（core 纯函数）
    let info: ChampSelectInfo;
    if (championId > 0) {
      const row = rankings?.heroes.find((h) => h.championId === championId);
      info = {
        championId,
        name: deps.championName(championId),
        winRate: row?.winRate ?? 0,
        winRateChange: 0,
        hasData: row !== undefined,
      };
    } else {
      info = { championId: 0, name: '未识别', winRate: 0, winRateChange: 0, hasData: false };
    }

    labels.push(
      cardLabelFor(rect, geo, workArea, {
        name: info.name,
        winRate: info.winRate,
        hasData: info.hasData,
        championId: info.championId,
      }),
    );
  }

  return {
    msg: { active: true, labels, diag: `卡片 ${det.cards.length} 张` },
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
