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
  // 悬停提示框文案（纯函数：统计口径/日期措辞在 vision 里单测锁死）
  championLabelTip,
  chooseChampSelectCaptureForm,
  chooseChampSelectCards,
  champSelectCaptureForms,
  countOccupiedSlots,
  decideChampSelectStage,
  detectCards,
  detectChampSelectCards,
  detectTopBarCandidates,
  extractGrayRaw,
  extractNameStrip,
  findGameWindowRect,
  findGameWindowRectCached,
  makeScreenGeometry,
  matchNameCareful,
  createLabelMemory,
  probeTopLevelWindows,
  slotLabelFor,
  topBarSlotRects,
  windowRectToCapture,
  NAME_STRIP,
  type Bitmap,
  type CaptureFormReading,
  type CaptureFormView,
  type CaptureGeometry,
  type CardLabel,
  type ChampSelectCardMode,
  type ChampSelectCardsResult,
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
    /**
     * 强调色（描边 + 文字）。
     *
     * 选人标签不用它（按 `hasData` 取绿/灰）；局内海克斯强度标签用它画
     * **档位配色**（S/A/B/C，由 `vision/augmentTierColor()` 给出），
     * 与选人标签共用同一块画布（见 main/label-overlay.ts）。
     */
    readonly color?: string;
    /**
     * 悬停提示框内容（可选；`forward: true` 送进来的 mousemove 用它出详情）。
     *
     * 文案在**主进程**拼好（这里才有图鉴/榜单/统计日期），渲染端只负责画 ——
     * 见 `label-overlay.ts` 的 `LabelOverlayLabel.tipTitle` 注释。
     */
    readonly tipTitle?: string;
    readonly tip?: readonly string[];
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
  /**
   * 第一阶段卡片几何的来源（`HEXBOX_CHAMP_SELECT_CARDS`）。
   *
   * 不传 = `geometry`（真机标定布局 + 边框判据，见 `vision/champ-select-cards.ts`）。
   * 为什么默认换掉旧的 `detectCards`：真机帧上它在同一套"选择你的英雄"界面上
   * 0 张 / 2 张 / 3 张之间抖动（宽度 ±2% 聚桶遇上边框带合并差异），
   * 且在第二阶段大立绘帧上会给出**位置错误**的 2 个矩形。
   */
  readonly champSelectCards?: () => ChampSelectCardMode;
  /** 识别结果的消费方（主进程推给覆盖窗口）。 */
  readonly onResult: (msg: VisionOverlayMsg, display: Electron.Display) => void;
}

/** deps 字段可能是值或 getter,统一取值。 */
function resolveDeps<T>(v: T | (() => T)): T {
  return typeof v === 'function' ? (v as () => T)() : v;
}

/**
 * 拿不到游戏窗口时，把当前可见顶层窗口打进日志（限流 15 秒一次）。
 *
 * 为什么需要：真机上曾长期只看到 `窗口未知`，无从判断是探针坏了、进程名
 * 不匹配、还是游戏确实没开。枚举一次就能看清（进程名/类名/标题/尺寸都在），
 * 而不是再靠猜。额外开销一次约 1.5 秒，且只在失败路径上发生。
 */
let lastCandidateLogAt = 0;
async function logWindowCandidatesOnce(): Promise<void> {
  const now = Date.now();
  if (now - lastCandidateLogAt < 15_000) return;
  lastCandidateLogAt = now;
  try {
    const cands = await probeTopLevelWindows();
    const top = [...cands]
      .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height)
      .slice(0, 10);
    console.log(
      `[hexbox:vision] ⚠ 没找到游戏窗口，可见顶层窗口 ${cands.length} 个（按面积前 10）： ` +
        top
          .map(
            (c) =>
              `${c.process || '?'}/${c.className} ${c.rect.width}x${c.rect.height}@${c.rect.x},${c.rect.y}` +
              ` "${c.title.slice(0, 24)}"`,
          )
          .join(' | '),
    );
  } catch {
    console.log('[hexbox:vision] ⚠ 枚举顶层窗口失败');
  }
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

/** 一轮识别落在哪个子阶段（`null` = 这一轮没有可用的阶段证据，别拿它下结论）。 */
export type VisionStage = 'cards' | 'topbar';

/**
 * 一轮识别：返回 null 消息表示「本轮无可信结果,应清空」。
 *
 * @param pickState LCU 给的子阶段。⚠️ **必须是调用方每 tick 只读一次的那个值**：
 *   本函数内部再读一次的话，tick 用于"换阶段就清记忆"的那次读取与阶段判定用的
 *   这次读取会落在截屏 await 的两侧（1.5 秒），LCU 每 2 秒轮询足以在此期间把
 *   picking 翻成 locked —— 真机日志 L86 就是这样（本轮报第二阶段却仍推 3 个卡片标签）。
 */
export async function runVisionRound(
  deps: VisionLoopDeps,
  pickState: 'picking' | 'locked' | 'unknown',
): Promise<{ msg: VisionOverlayMsg | null; display: Electron.Display; stage: VisionStage | null }> {
  // 窗口矩形来自 createGameBitmap 的同一次探测（勿在此再查一遍）
  const grabbed = await captureGameBitmap();
  if (!grabbed) {
    // 连图都没有 → 没有任何阶段证据（`null`：调用方不要拿它去改记忆状态）
    return { msg: null, display: screen.getPrimaryDisplay(), stage: null };
  }
  const { bmp, display, windowPhysical } = grabbed;

  // ── 截屏形态：**不猜**，两个形态都算出来（真机复现的整链路失效，见
  //    `vision/champ-select-capture-form.ts` 的头注）────────────────────────
  //
  // 选人截屏来自 `desktopCapturer({types:['window']})` → 一定是**窗口内容**；
  // 而 `makeScreenGeometry` 的自动判据在"截屏/显示器/窗口三者同比"时会退化成
  // `winShare < 0.9 → display` —— **16:9 显示器 + 默认 1600×900 客户端窗口**
  // 正好落进它 → 搜索区被缩到 0.083+0.833、标定几何偏 90~130px →
  // 候选卡 0 张、顶栏一格认不出（本机用真机帧复现）。
  // 处置与局内 `region` + `altRegion` 同一套规矩：两个形态都试，谁看出内容用谁，
  // 且 `region`（识别）与 `geo`（标签坐标）**必须同出一个形态**。
  const forms = champSelectCaptureForms(bmp, windowPhysical, display);
  const primaryForm = forms[0]!;
  const formOf = (form: string): CaptureFormView =>
    forms.find((f) => f.form === form) ?? primaryForm;
  console.log(
    `[hexbox:vision] 截屏 ${bmp.width}x${bmp.height} 窗口` +
      `${windowPhysical ? `${windowPhysical.width}x${windowPhysical.height}@${windowPhysical.x},${windowPhysical.y}` : '未知'}` +
      ` 显示器${display.bounds.width}x${display.bounds.height}@${display.scaleFactor}` +
      ` 工作区${display.workArea.width}x${display.workArea.height}@${display.workArea.x},${display.workArea.y}` +
      ` 形态候选=${forms.map((f) => f.form).join('/')}` +
      ` 主形态(${primaryForm.form}) scale=${primaryForm.scale.toFixed(3)}` +
      ` geo=${primaryForm.geo.windowWidth.toFixed(0)}x${primaryForm.geo.windowHeight.toFixed(0)}` +
      `@${primaryForm.geo.windowX.toFixed(0)},${primaryForm.geo.windowY.toFixed(0)}` +
      (forms.length > 1
        ? ` 备形态(${forms[1]!.form}) region=${forms[1]!.region.x.toFixed(4)},` +
          `${forms[1]!.region.y.toFixed(4)} ${forms[1]!.region.w.toFixed(4)}x${forms[1]!.region.h.toFixed(4)}`
        : ' 备形态=（几何等价，无需再试）'),
  );
  if (!windowPhysical) void logWindowCandidatesOnce();

  // ⚠️ 卡片检出**不在这里**做：它要等阶段判定（顶栏占用 + LCU 的 pickState）
  //    决定"这一轮到底该不该看卡片"之后再跑 —— 二阶段跑它纯属浪费
  //    （旧的 `detectCards` 在这里无条件跑了一次，真机上每轮多花几十毫秒）。

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

  /** 某个形态下顶栏 11 格的**截屏归一化**矩形（形态必须显式传入）。 */
  const slotsOfForm = (f: CaptureFormView): Rect[] =>
    topBarSlotRects().map((r) => windowRectToCapture(r, bmp, windowPhysical, display, f.form));

  /**
   * 逐形态扫顶栏（**早退**：认出 ≥1 格的形态立刻停 —— 常态只付主形态的成本）。
   *
   * 形态错了会怎样（真机实测）：占用检测读到 6~10 格噪声，但 NCC **一个都认不出**
   * —— 所以"认出格数"是判形态的**最强证据**，占用格数不是。
   */
  const scanTopBar = (): {
    readonly readings: CaptureFormReading[];
    readonly slots: Rect[];
    readonly cands: ReturnType<typeof detectTopBarCandidates>;
  } => {
    const readings: CaptureFormReading[] = [];
    let slots = slotsOfForm(primaryForm);
    let cands: ReturnType<typeof detectTopBarCandidates> = [];
    if (portraits.length === 0) return { readings, slots: [], cands: [] };
    for (const f of forms) {
      slots = slotsOfForm(f);
      const occupied = countOccupiedSlots(bmp, slots);
      cands = occupied > 0 ? detectTopBarCandidates(bmp, slots, portraits) : [];
      readings.push({ form: f.form, occupied, identified: cands.length, cardsConfident: false });
      if (cands.length > 0) break;
    }
    return { readings, slots, cands };
  };

  /**
   * 逐形态试候选卡（**早退**：第一个判据全过的形态）。返回的 `view` 就是
   * 标签该用的 `geo` 的来源 —— 两者绝不许分家。
   */
  const scanCards = (): {
    readonly readings: CaptureFormReading[];
    readonly results: readonly { readonly form: string; readonly result: ChampSelectCardsResult }[];
    readonly chosen: { readonly view: CaptureFormView; readonly result: ChampSelectCardsResult } | null;
  } => {
    const readings: CaptureFormReading[] = [];
    const results: { form: string; result: ChampSelectCardsResult }[] = [];
    for (const f of forms) {
      const result = detectChampSelectCards(bmp, { region: f.region });
      results.push({ form: f.form, result });
      readings.push({ form: f.form, occupied: 0, identified: 0, cardsConfident: result.confident });
      if (result.confident) return { readings, results, chosen: { view: f, result } };
    }
    return { readings, results, chosen: null };
  };

  // 阶段判定用**主形态**的占用读数（与接线前的语义一致：不让错形态的噪声占用
  // 把关卡推歪；真正"哪个形态对"由下面的证据决定）。
  const primarySlots = portraits.length > 0 ? slotsOfForm(primaryForm) : [];
  const topBarOccupiedCount =
    portraits.length > 0 ? countOccupiedSlots(bmp, primarySlots) : 0;

  // 阶段判定：**我的 pick 动作是否完成**说了算（`parsePickState` 在 `index.ts` 里解析）。
  //
  // ⚠️ 真机 bug（2026-10-11，选人段）：原判据是
  //   `isPhase2 = topBarOccupiedCount > 0 || pickState === 'locked'`
  // —— 顶栏占用**单独**就能翻阶段。而顶栏（备选区）在我还在三选一时就会被**队友**
  // 锁定的英雄填满（真机日志：`第二阶段(picking): 顶栏占用 3 格 …`），
  // 于是这一轮的生产者从"我的三张卡"被抢到"顶栏"：
  // 我的卡片一个标签都没有，屏幕上反而出现队友的顶栏标签，下一轮阶段又切回去 →
  // 标签记忆被反复 reset → 用户看到的正是"三选一阶段识别准确率非常低"。
  //
  // 现在的口径（纯函数 + 单测 `packages/vision/src/champ-select-stage.ts`）：
  //   · `locked`（我选完了）→ 顶栏；
  //   · `picking`（我还在选）→ **卡片**（顶栏占用是队友的，不作依据）；
  //   · `unknown`（LCU 读不到我的动作）→ 才用顶栏占用兜底。
  const stageDecision = decideChampSelectStage({ pickState, topBarOccupiedCount });
  const isPhase2 = stageDecision.stage === 'topbar';

  /**
   * 顶栏逐格标签（**形态的 `geo` 必须与槽位同源**）。
   *
   * 抽出来是因为两个分支都要用：顶栏分支本身，以及"卡片两形态都不过"时
   * 的**对称兜底**（LCU 说 `unknown` 时占用噪声可能把关卡推成一阶段，
   * 而屏幕上其实是二阶段）。
   */
  function topBarLabelPlan(input: {
    readonly slots: readonly Rect[];
    readonly cands: ReturnType<typeof detectTopBarCandidates>;
    readonly geo: CaptureGeometry;
  }): { readonly labels: CardLabel[]; readonly identified: string[] } {
    const labels: CardLabel[] = [];
    const identified: string[] = [];
    for (const cand of input.cands) {
      // ⚠️ 识别可能给出高 ID（60000+），而排行榜只有基础 ID —— 必须归一化，
      // 否则顶栏每个英雄都会显示「暂无数据」（真机实测过）。
      const cid = deps.canonicalId(cand.championId);
      const row = rankings?.heroes.find((h) => h.championId === cid);
      const sub = deps.championName(cid);
      identified.push(`${sub}=${cand.score.toFixed(2)}`);
      labels.push(
        slotLabelFor(input.slots[cand.slotIndex]!, input.geo, display.workArea, {
          name: sub,
          winRate: row?.winRate ?? 0,
          hasData: row !== undefined,
          championId: cid,
        }),
      );
    }
    return { labels, identified };
  }

  if (isPhase2) {
    // ── 第二阶段：顶栏备选区逐格胜率 ──
    const scan = scanTopBar();
    const picked = chooseChampSelectCaptureForm(scan.readings);
    const form = formOf(picked.form);
    const { labels, identified } = topBarLabelPlan({
      slots: scan.slots,
      cands: scan.cands,
      geo: form.geo,
    });
    const formTrace =
      `形态=${picked.form}（${picked.reason}）` +
      `[${scan.readings.map((r) => `${r.form}:占用${r.occupied}/识别${r.identified}`).join(' ')}]`;
    const diag =
      `第二阶段(${pickState}): 顶栏占用 ${topBarOccupiedCount} 格, 识别成功 ${labels.length} 格` +
      ` ${formTrace}` +
      (identified.length > 0 ? ` [${identified.join(' ')}]` : '') +
      (labels[0]
        ? ` 标签0@(${labels[0].x.toFixed(0)},${labels[0].y.toFixed(0)}) ${labels[0].w}x${labels[0].h}` +
          // ⚠️ 槽位 x 是**窗口内归一化**坐标，换成屏幕 CSS 必须加窗口原点
          //    `geo.windowX`（真机日志打 439 而真实屏幕 x 是 784 = 439+345 →
          //    少了这一项，这条日志一直在把人往"坐标算错"的方向带）。
          ` 槽0 x=${scan.slots[0]!.x.toFixed(3)}(归一)→CSS ${(scan.slots[0]!.x * form.geo.windowWidth + form.geo.windowX).toFixed(0)}`
        : '');

    // 有头像但一个都没认出来：**先问"是不是我还没锁"** ——
    //   · `locked`（我确实选完了）→ 不画（宁漏勿错），诊断留给日志；
    //   · 否则（`unknown`/`picking`）→ 再试一次候选卡：错形态的"占用噪声"会把
    //     关卡推到顶栏分支，而屏幕上其实还是我的三张卡 —— 那时按"什么都没画"
    //     返回就等于整块面板空白（与修这个 bug 的初衷相反）。
    if (labels.length === 0 && pickState !== 'locked') {
      const cards = scanCards();
      if (cards.chosen) {
        return finishCards({
          cards: cards.chosen.result.cards,
          geo: cards.chosen.view.geo,
          source: 'geometry',
          trace: `形态=${cards.chosen.view.form}（顶栏没认出→改用卡片判据定形态）`,
        });
      }
    }
    return { msg: { active: labels.length > 0, labels, diag }, display, stage: 'topbar' };
  }

  // ── 第一阶段：卡片下方显示胜率 ──
  //
  // 卡片矩形有两个来源（开关 `HEXBOX_CHAMP_SELECT_CARDS`）：
  //   · `geometry`（默认）—— `detectChampSelectCards`：真机标定的"居中一行 2 或 3 张"
  //     布局 + 四边框判据（吸附到象牙白高亮线的**外缘**）。真机 6 帧正样本全过、
  //     13 个阴性帧（第二阶段大立绘 / 局内海克斯面板）一张都不出。
  //     **形态按证据挑**（`champ-select-capture-form.ts`）：主形态 = 窗口
  //     （选人截屏的来源），备形态 = 显示器，判据全过的那个胜出 —— 见函数头注。
  //   · `legacy` —— 旧的 `detectCards`（自由搜索）：真机同一套界面上 0/2/3 张抖动，
  //     且在大立绘帧上给出位置错误的 2 个矩形。只作对照，**不为它做两形态重试**
  //     （它本来就是"真机不稳"的对照开关，重试救不了它；形态沿用自动判）。
  //   · `off` —— 一张都不画（只出顶栏标签）。
  // 各分支都**不**互相兜底：几何没拿到就是没拿到（宁可少画，绝不画错位置）。
  const cardMode = deps.champSelectCards?.() ?? 'geometry';
  const emptyGeo: ChampSelectCardsResult = {
    cards: [],
    confident: false,
    reason: '（未启用几何检出器）',
    count: 0,
    probes: [],
  };
  const emptyLegacy = { cards: [] as readonly Rect[], confident: false, reason: '（未启用旧检出器）' };

  /**
   * 卡片分支的收尾：OCR → join → 标签。
   *
   * ⚠️ `geo` 必须与"检出这几张矩形时用的 `region`"**同出一个形态** ——
   * 否则会出现"卡片认出来了、标签画在别处"（错形态下横向差 50~130 DIP）。
   */
  function finishCards(input: {
    readonly cards: readonly Rect[];
    readonly geo: CaptureGeometry;
    readonly source: string;
    /** 形态说明（进诊断行：这一轮用了哪个形态、为什么）。 */
    readonly trace: string;
  }): { msg: VisionOverlayMsg; display: Electron.Display; stage: VisionStage } {
    const workArea = display.workArea;
    const labels: CardLabel[] = [];
    const nameLibrary = resolveDeps(deps.nameLibrary);
    const perCard: string[] = [];
    for (const rect of input.cards) {
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
      /** 诊断：区分「取样失败」「无文字」「分数不够」三种拒绝原因。 */
      let why = '';
      if (!raw) {
        why = '取样越界';
      } else {
        const strip = extractNameStrip(raw.gray, raw.width, raw.height);
        const ink = strip.bits.reduce((s, v) => s + v, 0) / Math.max(1, strip.bits.length);
        // ⚠️ 用带区分度的匹配：第二阶段/对局内会在美术图上误检出矩形，
        // 只看最高分会给出 0.45~0.5 的假命中，于是把错误胜率画到屏幕中间。
        const m = matchNameCareful(strip, nameLibrary);
        if (m) {
          championId = m.championId;
          score = m.score;
          margin = m.margin;
        } else {
          why = ink < 0.05 ? '无文字' : `分数不够(墨迹${(ink * 100).toFixed(0)}%)`;
        }
      }
      perCard.push(championId > 0 ? `${score.toFixed(2)}/${margin.toFixed(2)}` : `拒绝:${why}`);

      if (championId <= 0) {
        // 识别不出就不画（宁漏勿错）—— 用户已确认不要「未识别」占位框
        continue;
      }

      // 胜率 join（core 纯函数）
      // ⚠️ 同顶栏：名字指纹库含高 ID（60000+）条目，而排行榜只有基础 ID，
      // 必须归一化，否则识别成功也会显示「暂无数据」（真机实测过）。
      const cid = deps.canonicalId(championId);
      const row = rankings?.heroes.find((h) => h.championId === cid);
      const name = deps.championName(cid);
      // 悬停提示框：文案在**主进程**拼（这里才有榜单与统计日期），渲染端只画。
      // 判定与排版是纯函数（`vision/label-tip.ts` + `label-hover.ts`，都有单测）。
      const tip = championLabelTip({
        name,
        winRate: row?.winRate ?? null,
        pickRate: row?.pickRate ?? null,
        rank: row?.rank ?? null,
        rankChangeDesc: row?.rankChangeDesc,
        dataDate: rankings?.meta.dataDate ?? null,
      });
      labels.push({
        ...cardLabelFor(rect, input.geo, workArea, {
          name,
          winRate: row?.winRate ?? 0,
          hasData: row !== undefined,
          championId: cid,
        }),
        ...tip,
      });
    }

    // 真机核对用：把标签坐标与它对应的卡片矩形一起报出来，
    // 这样"标签是否落在卡片下方"可以只看日志判断，不必再猜几何。
    const firstCard = input.cards[0];
    return {
      msg: {
        active: true,
        labels,
        diag:
          `第一阶段(${pickState})[${input.source}]: 卡片 ${input.cards.length} 张 → 出标签 ${labels.length} 个` +
          ` ${input.trace}` +
          ` [得分/分差 ${perCard.join(' ')}]` +
          (labels[0] && firstCard
            ? ` 标签0@(${labels[0].x.toFixed(0)},${labels[0].y.toFixed(0)}) ${labels[0].w}x${labels[0].h}` +
              ` 卡0 x=${firstCard.x.toFixed(4)} w=${firstCard.w.toFixed(4)}` +
              ` y=${(firstCard.y + firstCard.h).toFixed(3)}(归一)→CSS ${((firstCard.y + firstCard.h) * input.geo.windowHeight).toFixed(0)}`
            : ''),
      },
      display,
      stage: 'cards',
    };
  }

  if (cardMode === 'geometry') {
    const scan = scanCards();
    const picked = chooseChampSelectCaptureForm(scan.readings);
    const trace =
      `形态=${picked.form}（${picked.reason}）` +
      (scan.readings.length > 1
        ? `[${scan.readings.map((r) => `${r.form}:${r.cardsConfident ? '过' : '不过'}`).join(' ')}]`
        : '[形态唯一]');
    if (scan.chosen) {
      return finishCards({
        cards: scan.chosen.result.cards,
        geo: scan.chosen.view.geo,
        source: 'geometry',
        trace,
      });
    }
    // 卡片两形态都不过 → **对称兜底**：再问一次顶栏。
    //
    // LCU 说 `unknown` 时，阶段判定只能靠"主形态的占用读数"；若主形态恰好是错的
    // 那个（真机上另一种截屏形态），占用可能是 0 → 关卡推成一阶段，而屏幕上其实
    // 已经是二阶段（大立绘 + 顶栏头像）。此时按"0 张卡"返回就等于整块空白。
    // ⚠️ 兜底判据是**认出 ≥1 格**（不是"占用 > 0"）：真机实测错形态下占用能到 10 格
    //    却一个都认不出，用占用兜底会画出整排错标签。
    if (pickState !== 'picking') {
      const top = scanTopBar();
      if (top.cands.length > 0) {
        const pickedTop = chooseChampSelectCaptureForm(top.readings);
        const topForm = formOf(pickedTop.form);
        const plan = topBarLabelPlan({
          slots: top.slots,
          cands: top.cands,
          geo: topForm.geo,
        });
        return {
          msg: {
            active: plan.labels.length > 0,
            labels: plan.labels,
            diag:
              `第二阶段(${pickState})[卡片两形态都不过→顶栏兜底]: 顶栏占用 ${topBarOccupiedCount} 格, ` +
              `识别成功 ${plan.labels.length} 格 形态=${pickedTop.form}（${pickedTop.reason}）` +
              `[${top.readings.map((r) => `${r.form}:占用${r.occupied}/识别${r.identified}`).join(' ')}]` +
              (plan.identified.length > 0 ? ` [${plan.identified.join(' ')}]` : '') +
              ` —— ${trace}`,
          },
          display,
          stage: 'topbar',
        };
      }
    }
    return {
      msg: {
        active: false,
        labels: [],
        diag:
          `第一阶段(${pickState})但未检出卡片[geometry]: ${trace}（顶栏占用 ${topBarOccupiedCount}）` +
          ` —— ${scan.results.map((r) => `${r.form}: ${r.result.reason}`).join(' ｜ ')}`,
      },
      display,
      // 阶段判定是**明确的**（顶栏没占用、LCU 也没说 locked）→ 就是一阶段，
      // 只是这一轮没检出卡片。它仍然是一阶段证据（不能当成"不知道"）。
      stage: 'cards',
    };
  }

  // legacy / off：保持接线前的口径（形态自动判）。
  const autoGeo = makeScreenGeometry(bmp, windowPhysical, {
    bounds: display.bounds,
    scaleFactor: display.scaleFactor,
    workArea: display.workArea,
  });
  const choice = chooseChampSelectCards({
    mode: cardMode,
    geometric: emptyGeo,
    legacy: cardMode === 'legacy' ? detectCards(bmp) : emptyLegacy,
  });
  const det = { cards: choice.cards, confident: choice.confident, reason: choice.reason };

  if (!det.confident || det.cards.length === 0) {
    return {
      msg: {
        active: false,
        labels: [],
        diag:
          `第一阶段(${pickState})但未检出卡片[${choice.source}]: ${det.reason ?? '?'}` +
          `（顶栏占用 ${topBarOccupiedCount}；形态=自动判 ${autoGeo.kind}）`,
      },
      display,
      stage: 'cards',
    };
  }

  return finishCards({
    cards: det.cards,
    geo: autoGeo.geo,
    source: choice.source,
    trace: `形态=${autoGeo.kind}（自动判，legacy/off 路径不做两形态重试）`,
  });
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
  /**
   * 上一轮**真正落在**的子阶段（`runVisionRound` 回报；`null` = 还没有证据）。
   *
   * ⚠️ 为什么不能只看 `pickState`（真机 bug，2026-10-11）：LCU 的 `pickState`
   * 可能是 `unknown`/'picking' 而屏幕上顶栏已经有头像（占用 > 0）→
   * `isPhase2` 为真、走顶栏分支，但 `pickState` 一直没变 → 换阶段判据**永不触发**
   * → 卡片标签以 TTL 挂在二阶段（日志 L86：`第二阶段(locked): 顶栏占用 2 格,
   * 识别成功 0 格` 却仍推送 3 个卡片标签）。所以换阶段要按**实际阶段**判。
   */
  private lastStage: VisionStage | null = null;

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
        // ⚠️ **每 tick 只读一次** `pickState`，并把同一个值传进 `runVisionRound`：
        // 截屏 await 有 1~2 秒，期间 LCU（每 2 秒轮询）完全可能把 picking 翻成
        // locked —— 两次读取会得到两个阶段，于是"用于重置记忆的阶段"与
        // "用于画标签的阶段"不一致（真机日志 L86 的成因）。
        const pickState = this.deps.pickState?.() ?? 'unknown';
        const { msg, display, stage } = await runVisionRound(this.deps, pickState);
        this.round++;
        // 子阶段切换（第一阶段⇄第二阶段）时**立刻**清空标签记忆 —— 否则
        // 卡片胜率会在选定后继续残留最多 6 轮（≈9 秒），真机反馈为
        // "进入二阶段还不消失"。卡片与顶栏的标签位置完全不同，不能混用。
        //
        // 两条判据都留着（各自覆盖对方漏掉的情形）：
        //   · `pickState` 变化（LCU 说得清时最灵敏）；
        //   · **实际阶段**变化（LCU 说 unknown/picking、靠顶栏占用进二阶段时，
        //     `pickState` 根本不会变 —— 只有这条能兜住）。
        // 重置放在本轮输出之后、`memory.update()` 之前：效果与"轮前重置"等价，
        // 而且用的是**本轮真正使用的**那个阶段。
        const pickChanged = this.lastPickState !== null && pickState !== this.lastPickState;
        const stageChanged = stage !== null && this.lastStage !== null && stage !== this.lastStage;
        if (pickChanged || stageChanged) {
          this.memory.reset();
        }
        this.lastPickState = pickState;
        if (stage !== null) this.lastStage = stage;

        const active = msg !== null && msg.active;
        // 记忆补齐:本轮识别到的标签 + TTL 内未过期的旧标签
        const produced = msg?.labels.length ?? 0;
        const labels = this.memory.update(msg?.labels ?? [], this.round, active);
        if (active) {
          this.failCount = 0;
        } else {
          this.failCount++;
        }
        const shown = active || labels.length > 0;
        // ⚠️ 诊断必须把"**本轮产出 X 个 → 实际推出 Y 个**"打在同一行：
        // 幽灵标签那个 bug 里，两行日志（产出 3 / 推送 4）要靠人工对比才发现
        //（真机日志 L40 vs L34）。
        const flow = `本轮产出 ${produced} → 实际推出 ${labels.length}`;
        this.deps.onResult(
          shown
            ? { active: true, labels, diag: `${msg?.diag ?? '记忆保持'}（${flow}）` }
            : { active: false, labels: [], diag: `${msg?.diag ?? '未找到游戏窗口'}（${flow}）` },
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
    // 新会话不该继承上一段的阶段（否则第一 tick 会拿着旧阶段做一次无意义的重置）
    this.lastPickState = null;
    this.lastStage = null;
    this.deps.onResult({ active: false, labels: [] }, screen.getPrimaryDisplay());
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }
}
