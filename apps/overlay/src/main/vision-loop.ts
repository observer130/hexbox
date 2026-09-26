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
  captureScale,
  cardLabelFor,
  detectCards,
  extractGrayRaw,
  extractNameStrip,
  findGameWindowRect,
  matchName,
  NAME_STRIP,
  type Bitmap,
  type NameFingerprint,
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
  /** 头像模板（阶段 2 预留,当前不参与认定）。 */
  readonly portraits?: readonly PreparedTemplate[];
  /** 英雄榜（胜率 join 数据源）。 */
  readonly rankings: RankingSnapshot | null | (() => RankingSnapshot | null);
  /** 英雄名映射。 */
  readonly championName: (id: number) => string;
  /** 识别结果的消费方（主进程推给覆盖窗口）。 */
  readonly onResult: (msg: VisionOverlayMsg) => void;
}

/** deps 字段可能是值或 getter,统一取值。 */
function resolveDeps<T>(v: T | (() => T)): T {
  return typeof v === 'function' ? (v as () => T)() : v;
}

/** 单轮识别（供 vision-loop 与 debug 工具复用）。 */
async function captureGameBitmap(): Promise<{
  bmp: Bitmap;
} | null> {
  const display = screen.getPrimaryDisplay();
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
  return { bmp: { width: size.width, height: size.height, data } };
}

/** 一轮识别：返回 null 表示「本轮无可信结果,应清空」。 */
export async function runVisionRound(
  deps: VisionLoopDeps,
): Promise<VisionOverlayMsg | null> {
  const windowPhysical = await findGameWindowRect();
  const grabbed = await captureGameBitmap();
  if (!grabbed) return null;
  const { bmp } = grabbed;

  const display = screen.getPrimaryDisplay();
  const scale = captureScale(
    { width: bmp.width, height: bmp.height },
    windowPhysical,
  );
  const geo = {
    captureWidth: bmp.width,
    captureHeight: bmp.height,
    windowX: (windowPhysical?.x ?? display.workArea.x) / display.scaleFactor,
    windowY: (windowPhysical?.y ?? display.workArea.y) / display.scaleFactor,
    windowWidth:
      (windowPhysical?.width ?? bmp.width / scale.scale) / display.scaleFactor,
    windowHeight:
      (windowPhysical?.height ?? bmp.height / scale.scale) / display.scaleFactor,
  };

  const det = detectCards(bmp);
  if (!det.confident || det.cards.length === 0) {
    return {
      active: false,
      labels: [],
      diag: `未检出卡片: ${det.reason ?? '?'}`,
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

  return { active: true, labels, diag: `卡片 ${det.cards.length} 张` };
}

/**
 * 视觉循环控制器。
 *
 * `setActive(true)` 在进入 ChampSelect 时调用;离开时 `setActive(false)`。
 * 内部串行执行（上一轮完成才开始下一轮）,避免截屏堆积。
 */
export class VisionLoop {
  private readonly deps: VisionLoopDeps;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

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
        const msg = await runVisionRound(this.deps);
        this.deps.onResult(
          msg ?? { active: false, labels: [], diag: '未找到游戏窗口' },
        );
      } catch {
        this.deps.onResult({ active: false, labels: [], diag: '识别异常' });
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
    this.deps.onResult({ active: false, labels: [] });
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }
}
