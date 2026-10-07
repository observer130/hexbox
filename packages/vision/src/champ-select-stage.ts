/**
 * 选人阶段的**两个纯决策**（可单测）：`pickState` 的解析口径 + "这一轮用哪个生产者"
 *
 * ── 真机回归（2026-10-11，打包版同一份日志的**选人段**）────────────────────
 *
 * ```
 * 697: 第一阶段(picking)但未检出卡片: …（共 6 个候选桶）（顶栏占用 0）
 * 701: 第二阶段(picking): 顶栏占用 1 格, 识别成功 1 格 [刀锋之影=0.92]
 * 706: 第二阶段(picking): 顶栏占用 3 格, 识别成功 3 格 [刀锋之影 北地之怒 诺克萨斯之手]
 * …（706~733 连续 5 轮都在给**队友**的顶栏画标签）
 * 740: 第二阶段(locked): 顶栏占用 10 格, 识别成功 4 格      ← 我自己锁了之后才是 locked
 * ```
 *
 * 用户原话："在三选一阶段识别准确率非常低，同时上方的备选栏已经开始识别了"。
 * 日志完全对上：**我还在 picking（三选一还没选），队友锁完就把顶栏填满了**，
 * 于是 `isPhase2 = topBarOccupiedCount > 0 || pickState === 'locked'`
 * （`vision-loop.ts` 旧判定）把生产者从"我的三张卡"切到"顶栏"：
 *   · 我的三张卡这一轮**一个标签都没有**（卡片分支根本没跑）；
 *   · 屏幕上换成队友的顶栏标签，而下一轮阶段又可能切回去 → 阶段来回切 =
 *     标签记忆被反复 `reset()` → 用户看到"标签一闪就没 / 准确率非常低"。
 *
 * ── 为什么"顶栏占用 > 0"不能单独当二阶段判据 ─────────────────────────────
 *
 * `pickState` 的来源是 LCU 选人会话里**我自己那条 pick 动作是否 completed**
 * （`index.ts`），所以：
 *   · `locked`  = 我已经选完 → 三选一卡片已经消失 → 二阶段（顶栏）✓；
 *   · `picking` = 我**还没**选完 → 三选一还在屏上 → 一阶段（卡片）✓，
 *     此时顶栏里那些已占用的格子是**队友**锁的，跟"我该看哪一块 UI"无关。
 *
 * 旧口径真正的软肋在**解析失败时的取值**：原来 `acts.length === 0` 才算 unknown，
 * 而"动作列表非空、但里面没有**我的**那条 pick 动作"（字段/模式差异、动作已被移除）
 * 会被算成 `picking` —— 那才是"我其实已经锁了、代码却还在画卡片假标签"的来源。
 * 所以这里把口径改成：**找不到我的 pick 动作 = unknown**（交给顶栏占用兜底），
 * 只有"确实找到了我的 pick 动作且未完成"才是 `picking`。
 *
 * 代价（如实记录）：若某局 LCU 的 pick 动作**一直解析不到**（unknown），
 * 且顶栏始终为 0 占用，则仍然走一阶段分支（与改动前一致，没有变差）；
 * 若解析到我的动作却始终 `completed=false`（极端情况），则会一直走卡片分支 ——
 * 卡片分支本身有"判据不自信就一个都不画"的保护（`det.confident`），
 * 最坏情况是这一局没有标签，而不是画错标签。
 */

export type ChampSelectPickState = 'picking' | 'locked' | 'unknown';

/** 这一轮该由哪个生产者出标签（与 `vision-loop.ts` 的 `VisionStage` 同义）。 */
export type ChampSelectStage = 'cards' | 'topbar';

/** LCU 选人动作里我们真正用到的字段（结构类型，不做运行时校验）。 */
export interface ChampSelectActionLike {
  readonly type?: string | undefined;
  readonly completed?: boolean | undefined;
  readonly actorCellId?: number | undefined;
}

export interface PickStateDecision {
  readonly state: ChampSelectPickState;
  /** 人读原因（诊断行会带上它）。 */
  readonly reason: string;
}

/**
 * 解析"我这一轮是 picking 还是 locked"。
 *
 * 判据只有一个：**我自己那条 `type === 'pick'` 的动作是否 `completed`**。
 * 找不到我的动作 → `unknown`（**不是** `picking`：那是"还在选"的意思，
 * 会让我们在已经选完的界面上继续画卡片标签）。
 */
export function parsePickState(input: {
  readonly localPlayerCellId: number | null | undefined;
  readonly actions: readonly ChampSelectActionLike[];
}): PickStateDecision {
  const cell = input.localPlayerCellId;
  if (typeof cell !== 'number') {
    return { state: 'unknown', reason: '选人会话里没有"我的格子"（localPlayerCellId）→ 子阶段未知' };
  }
  const mine = input.actions.filter((a) => a.type === 'pick' && a.actorCellId === cell);
  if (mine.length === 0) {
    return {
      state: 'unknown',
      // ⚠️ 这一条就是旧口径的缺陷：不能默认成 picking（"我还在选"）
      reason: `没找到我的 pick 动作（本方格子 ${cell}，动作 ${input.actions.length} 条）→ 子阶段未知，交给顶栏占用兜底`,
    };
  }
  const done = mine.some((a) => a.completed === true);
  return done
    ? { state: 'locked', reason: '我的 pick 动作已完成 → 已锁定' }
    : { state: 'picking', reason: '我的 pick 动作未完成 → 还在三选一' };
}

export interface ChampSelectStageDecision {
  readonly stage: ChampSelectStage;
  readonly reason: string;
}

/**
 * 决定这一轮用哪个生产者。
 *
 * | pickState | 判定 | 依据 |
 * |---|---|---|
 * | `locked` | **topbar** | 我已经选完、三选一卡片消失；顶栏（备选/已锁）才是有效 UI |
 * | `picking` | **cards** | 我还在三选一 → 顶栏里被占的格子是**队友**锁的，不能抢生产者 |
 * | `unknown` | 占用 > 0 ? topbar : cards | 唯一还能用的物理证据（保留旧兜底，别丢标签能力）|
 */
export function decideChampSelectStage(input: {
  readonly pickState: ChampSelectPickState;
  readonly topBarOccupiedCount: number;
}): ChampSelectStageDecision {
  const occupied = Math.max(0, Math.trunc(input.topBarOccupiedCount));
  if (input.pickState === 'locked') {
    return { stage: 'topbar', reason: '我的 pick 已完成（locked）→ 二阶段：顶栏逐格' };
  }
  if (input.pickState === 'picking') {
    return {
      stage: 'cards',
      reason:
        `我还在选（picking）→ 一阶段：我的三张卡（顶栏占用 ${occupied} 格是**队友**锁的，` +
        '不作为切换生产者的依据）',
    };
  }
  return occupied > 0
    ? { stage: 'topbar', reason: `子阶段未知但顶栏占用 ${occupied} 格 → 二阶段顶栏（旧兜底）` }
    : { stage: 'cards', reason: '子阶段未知且顶栏为空 → 一阶段卡片（旧兜底）' };
}
