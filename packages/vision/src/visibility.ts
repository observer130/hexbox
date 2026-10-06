/**
 * 悬浮窗可见性与视觉循环开关判定（纯函数）
 *
 * 为什么抽出来：主进程需要「用户可见状态」与「实际已应用状态」比较后
 * 才动窗口 —— 直接调 `showInactive()`/`hide()` 有两个真实问题：
 *   1. 每 2s 轮询都调一次，窗口会被反复 show（闪烁且无意义地重排）；
 *   2. 只在**阶段变化**时才处理，会漏掉「阶段没变但连接状态变了」的场景。
 *
 * 问题 2 是真实 bug：原实现只在 `phase !== lastPhase` 时更新窗口，
 * 于是中途客户端掉线（connected 由 true→false，phase 仍是非对局值）时
 * 不会重新应用窗口状态。
 *
 * 本模块是纯函数：主进程在 CI 里跑不起来（需管理员 + 真实桌面），
 * 只有抽成纯函数才能被单测覆盖（与 overlay-view / itemset 同一惯例）。
 *
 * ⚠️ 2026-10-04 按用户决策调整（选人阶段只留覆盖层）：
 *   · 侧边窗**只在局内**出现。选人阶段由截屏覆盖层在游戏画面内直接标注
 *     卡片与顶栏胜率，侧边窗与它信息重复，还会叠在英雄立绘上抢地方
 *     —— 用户反馈"悬浮窗大小和位置不对"即由此而来。
 *   · 连不上客户端时也**不再**弹窗（用户选择"干脆不要了，只写日志"）。
 *
 * ⚠️ 2026-10-04 追加决策（局内海克斯识别开工前确认）：
 *   **局内也不要侧边窗** —— 局内的信息载体是"海克斯卡上的强度标签"
 *   （见 augment-panel.ts 与 docs/AUGMENT-PANEL.md），侧边窗的
 *   "该英雄海克斯强度列表"被它取代。因此 `showPanel` 现恒为 false；
 *   侧边窗代码本身留到 S4 再整体删除（保留是为了让本改动可回退、
 *   且不必在这一步动窗口/渲染端）。
 */

/** 一份「应该长什么样」的判定结果。 */
export interface VisibleState {
  /**
   * 侧边悬浮窗是否应显示。
   *
   * ⚠️ 恒为 false（用户 2026-10-04 决策：局内也不要侧边窗，局内信息由
   * 海克斯卡上的标签承担）。字段保留到 S4 删除侧边窗为止 ——
   * 主进程仍在用它决定 show/hide，因此不要在这里改成"删字段"。
   */
  readonly showPanel: boolean;
  /** S2 全屏覆盖层是否应显示。 */
  readonly showVision: boolean;
  /**
   * 视觉循环是否应运行。
   *
   * 与 `showVision` 分开的理由：覆盖层窗口的显隐只在进入/离开选人时变，
   * 而视觉循环有自己的标签记忆 TTL（见 label-memory.ts），
   * 两者都由本对象派生，避免主进程里出现第二处阶段判断。
   *
   * ⚠️ 当前仅选人阶段为 true。局内海克斯面板的门控循环（augment-panel）
   * **不并进这里**（局内与选人用的采样带、节奏、清空规则都不同 ——
   * S5.4d 的接线就是照这条要求做的）：它由本文件末尾的
   * `augmentChainActive()` 单独判定，两者**互斥**（选人时它必须为 false，
   * 否则每 1.5s 推一次的胜率标签会把局内强度标签踩掉），
   * 组合关系由单测锁住。**不要**把两者合并成一个布尔。
   */
  readonly visionActive: boolean;
}

/**
 * 依据当前阶段与连接状态算出应显示什么。
 *
 * @param phase     游戏流阶段（`ChampSelect` / `InProgress` / `None` …）。
 * @param connected 是否已连上客户端（有凭证即视为已连；仅用于日志/诊断语义，
 *                  不再影响窗口显隐）。
 *
 * 规则：
 *   - 侧边窗：**不再显示**（选人阶段看覆盖层；局内看海克斯卡上的标签）。
 *   - 覆盖层与视觉循环：**仅选人阶段**（局内海克斯面板的门控在 S5.4 接入）。
 */
export function decideVisible(phase: string, connected: boolean): VisibleState {
  const inChampSelect = phase === 'ChampSelect';
  return {
    // connected 目前不改变可见性（用户要求不再弹诊断面板），保留形参
    // 是为了让调用方不必在阶段判断之外再做一次连接状态分支。
    showPanel: false,
    showVision: inChampSelect,
    visionActive: inChampSelect,
  };
}

/** 两份判定结果是否等价（用于避免每轮无谓地 show/hide）。 */
export function sameVisibleState(a: VisibleState | null, b: VisibleState): boolean {
  return (
    a !== null &&
    a.showPanel === b.showPanel &&
    a.showVision === b.showVision &&
    a.visionActive === b.visionActive
  );
}

/* ------------------------------------------------------------------ */
/* 画布归属：选人胜率标签 vs 局内海克斯标签（同一块画布，绝不同时写）      */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ 为什么需要这一段（S5.4d 的核心风险）：
 * 选人阶段（S2）与局内海克斯标签（S5.4c）用的是**同一块**全屏透明画布
 * （`main/label-overlay.ts` 的 `overlay:vision` 通道），而两者的
 * **内容来源、节奏、清空规则**完全不同：
 *
 *   · 选人：`vision-loop.ts` 每 1.5s 一轮、有 **6 轮 TTL 标签记忆**
 *     （`label-memory.ts`，漏检时旧标签续显），画卡片下方/顶栏逐格胜率；
 *   · 局内：API 触发 + 屏幕流门控，**开边沿画、关边沿立刻清空、不复用任何 TTL**
 *     （每次 offer 是不同三张卡，残留会把上一轮强度贴到新卡上 —— §六 #4）。
 *
 * 如果两处各自"想画就画"，就会出现**互相踩**：局内的强度字母被选人循环的
 * 胜率标签覆盖（或反之），而这类 bug 只在真机对局里偶发、代价是一整局。
 * 所以"此刻该由谁产出标签"必须是**一处纯函数**（本函数），不写在主进程里。
 *
 * 判定规则（阶段优先，其次才是局内面板状态）：
 *   · `ChampSelect` → 选人生产者（唯一在选人阶段能写画布的人）；
 *   · 局内阶段（见 `AUGMENT_CHAIN_PHASES`）→ 局内海克斯生产者
 *     （链路被开关关掉时 → `none`）；
 *   · 其它阶段（大厅/匹配/结算/未知）→ `none`（谁都别画）。
 */

/** 谁来产出标签（同一时刻**只有一个**）。 */
export type LabelProducer = 'champ-select' | 'augment' | 'none';

/**
 * 局内海克斯面板的门控状态。
 *
 * `'unknown'` = 链路没在跑 / 还没采过样（等价于"面板不在屏"，
 * 因此**不许**当成"可能有内容"）。
 */
export type AugmentPanelState = 'closed' | 'open' | 'unknown';

/**
 * **局内阶段**（不含选人）：海克斯标签链路只在这些阶段工作。
 *
 * · 不含 `ChampSelect` —— 那时玩家在选英雄，海克斯还没出现
 *   （`docs/OVERLAY-STAGES.md` §三 #1 记录过这个错），而且画布归选人；
 * · `Reconnect` 算局内 —— 重连期间还在同一局里，面板仍可能弹出；
 * · `GameStart`（加载中）/`WaitingForStats`/`PreEndOfGame`（结算）都不算：
 *   那里不会出现三选一，起截屏流纯属浪费。
 */
export const AUGMENT_CHAIN_PHASES: readonly string[] = ['InProgress', 'Reconnect'];

/** 局内海克斯链路的开关判定参数。 */
export interface LabelProducerOptions {
  /** 局内海克斯链路是否启用（`HEXBOX_OVERLAY_AUGMENT=0` 关掉）。默认启用。 */
  readonly augmentEnabled?: boolean;
}

/**
 * 环境变量 `HEXBOX_OVERLAY_AUGMENT` → 是否启用局内海克斯链路。
 *
 * 只有显式写 `0`（或 `false` / `off`，大小写与空白无关）才**关掉**；
 * 其它任何值（含未设置）都启用 —— 这样"手滑写成 `true`/`1`"不会静默关掉功能，
 * 而"降级"必须是一个**明确写出来**的动作。
 */
export function overlayAugmentEnabled(raw: string | undefined): boolean {
  const v = (raw ?? '').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

/**
 * 局内海克斯链路此刻是否应当运行（起常驻屏幕流 + 轮询 2999 + 门控）。
 *
 * 与 `decideVisible()` 的组合关系（由单测锁住）：
 *   · `ChampSelect` → `visionActive === true` 且本函数 `false`（选人视觉循环跑）；
 *   · 局内阶段 → `visionActive === false` 且本函数 `true`（选人循环必须停，
 *     否则它每 1.5s 推一次胜率标签，会把局内强度标签踩掉）。
 */
export function augmentChainActive(stage: string, options: LabelProducerOptions = {}): boolean {
  if (options.augmentEnabled === false) return false;
  return AUGMENT_CHAIN_PHASES.includes(stage);
}

/** 一次"谁拥有画布"的判定结果。 */
export interface LabelOwnership {
  /** 当前的生产者（唯一）。 */
  readonly producer: LabelProducer;
  /**
   * 该生产者此刻**是否应当有内容在屏**（false = 画布必须为空）。
   *
   * · 选人生产者：恒 `true`（具体画什么由视觉循环逐轮决定，含 6 轮 TTL）；
   * · 局内海克斯生产者：**只看面板是否在屏** —— 面板关闭/未知时必须是空画布
   *   （绝不留上一次 offer 的字母；`docs/AUGMENT-PANEL.md` §七 的清空规则）；
   * · `none`：恒 `false`。
   */
  readonly shouldDraw: boolean;
  /**
   * 生产者与上一轮**不同** → 调用方必须用**现成的** `clearLabelOverlay()`
   * 清掉对方遗留的标签，再让新生产者画。
   *
   * 真实场景：上一局的面板开着时对局结束 → 进入下一局的选人阶段，
   * 局内字母若不清就会一直挂在屏幕上（直到选人循环恰好覆盖掉它）。
   * `prev === null`（首轮）时为 `false` —— 启动时画布本来就是空的，
   * 没必要多推一次清空去和"选人第一轮推送"抢时序。
   */
  readonly handover: boolean;
}

/**
 * 决定"此刻由谁产出标签"（纯函数；主进程只做比较与显式清空）。
 *
 * @param stage  游戏流阶段（`ChampSelect` / `InProgress` / `None` …）。
 * @param panel  局内海克斯门控状态（链路没在跑时传 `'unknown'`）。
 * @param prev   上一轮的生产者（`null` = 还没判定过）；只用于算 `handover`。
 * @param options 见 `LabelProducerOptions`。
 */
export function labelProducerFor(
  stage: string,
  panel: AugmentPanelState,
  prev: LabelProducer | null = null,
  options: LabelProducerOptions = {},
): LabelOwnership {
  const producer: LabelProducer =
    stage === 'ChampSelect'
      ? 'champ-select'
      : augmentChainActive(stage, options)
        ? 'augment'
        : 'none';
  const shouldDraw =
    producer === 'champ-select' ? true : producer === 'augment' ? panel === 'open' : false;
  return { producer, shouldDraw, handover: prev !== null && prev !== producer };
}

/* ------------------------------------------------------------------ */
/* 局内链路的**启停状态机**（纯函数）：起一次、离开就停、在途启动要作废     */
/* ------------------------------------------------------------------ */

/**
 * 链路启停状态。
 *
 * · `idle`     —— 没在跑（也包含"这一局不跑"的常态）；
 * · `starting` —— `start()` 在途（探窗口 + 建流 + 等就绪，最长约 10 秒）；
 * · `running`  —— 常驻流已就绪；
 * · `failed`   —— **这一局**起不来（屏幕流没就绪）→ 不再重试，离开对局回到 `idle`。
 */
export type AugmentChainState = 'idle' | 'starting' | 'running' | 'failed';

/** 一轮启停判定：该做什么 + 下一轮状态 + **会话令牌**。 */
export interface AugmentChainTransition {
  /** 本轮动作：`start` 只在 `idle` 时给一次；`stop` 只在"该停但还在跑"时给。 */
  readonly action: 'start' | 'stop' | 'none';
  readonly state: AugmentChainState;
  /**
   * **会话计数**：调用方把它存下来，下一轮原样传回。
   *
   * 语义：**一次启动 = 一个新号**。`start` 分配 `generation + 1`（新会话）；
   * `stop` 也 +1（收工后不再有会话）—— 下一个 `start` 因此**必然拿到全新的号**，
   * 绝不与任何历史会话重号。重号会让"作废在途启动"彻底失效（真机缺陷的温床）。
   */
  readonly generation: number;
  /**
   * 本轮动作**必须带上的会话令牌**：
   *
   *   · `start` → 新会话的号，交给 `AugmentController.start(token)`；
   *   · `stop`  → **要作废的那一代**（= 动作之前的 `generation`），
   *     交给 `AugmentController.stop(why, { token })`；
   *   · `none`  → 当前会话的号（调用方本轮不用它）。
   *
   * ⚠️ 为什么 `stop` 带的是"要作废的那一代"而不是新号（2026-10-06 真机缺陷）：
   * `start()` 是异步的（探窗口 + 建流 + 等就绪，最长约 10 秒），期间阶段完全可能
   * "确认离开"又"回到对局"。那条**在途启动**的回调落地时必须能判断
   * "我这一代还是不是当前会话"：
   *
   *   · 是 → 正常收尾（记 running / failed）；
   *   · 不是 → **什么都不做**（见 `augmentStartIsStale()`）—— 绝不可以用
   *     "看到新世代就 `stop()`"的写法：那会把**新一代**的流一起收掉，真机表现
   *     正是"面板刚弹出、标签刚画上，随即被清掉"。
   *
   * "什么都不做"不会留下没人管的屏幕流：本代自己的流由 `AugmentController`
   * 在每个 await 检查点**按令牌自行收掉**（`abortStart` / `dropStream`）。
   */
  readonly token: number;
}

/**
 * 阶段 → 链路启停（纯函数；主进程只负责执行 `action` 并把状态存回去）。
 *
 * 为什么值得抽出来单测：这段"什么时候起、什么时候停"的逻辑里有三个真实陷阱，
 * 全都在真机上以"整局没有标签 / 白跑一局截屏 / 标签闪一下就没了"的形式出现过：
 *   ① **选人阶段绝不能起链路**（那时画布归选人视觉循环，且海克斯还没出现）；
 *   ② **局内只起一次** —— 每 2 秒轮询一次，重复 `start()` 会建出多条流；
 *   ③ **在途启动必须能被作废，而且只能作废自己那一代** —— `start()` 要几秒，
 *      期间对局可能已经结束；那次的回调不能把收工后的链路标成 running，更不能
 *      留着那条流，**也不能去收掉期间新起的那一代**（令牌在这里给：见 `token`）。
 * 失败（`failed`）**本局不重试**：避免每轮轮询都去建一次流；离开对局回到
 * `idle`，下一局重新试（真机场景：第一局流被系统节流，第二局正常）。
 */
export function augmentChainTransition(
  prev: AugmentChainState,
  generation: number,
  stage: string,
  options: LabelProducerOptions = {},
): AugmentChainTransition {
  if (augmentChainActive(stage, options)) {
    if (prev === 'idle') {
      const next = generation + 1;
      return { action: 'start', state: 'starting', generation: next, token: next };
    }
    // starting / running / failed 都不再重复起（failed = 本局放弃）
    return { action: 'none', state: prev, generation, token: generation };
  }
  if (prev === 'idle') return { action: 'none', state: 'idle', generation, token: generation };
  // 离开对局（或开关被关掉）：作废在途启动 + 收工。
  // ⚠️ `token` 是**要作废的那一代**（= 动作前的 generation），不是新号：
  // 调用方据此只收掉那一代的流，期间新起的会话一概不许碰（真机缺陷的修法）。
  return { action: 'stop', state: 'idle', generation: generation + 1, token: generation };
}

/**
 * 一次 `start()` 的回调是否**已经作废**（令牌不再是当前会话号）。
 *
 * `true` → 回调**什么都不许做**：既不许把链路记成 running/failed，更不许
 * `stop()` —— 那会把期间新起的那一代连流带标签一起收掉（2026-10-06 真机缺陷：
 * "面板刚弹出、标签刚画上，随即被清掉"）。本代自己的屏幕流已经由控制器在每个
 * await 检查点按令牌自行收干净了，所以这里"什么都不做"不会留下没人管的流。
 *
 * 单独抽出来是为了让这条**唯一判据**有单测、且主进程里不出现第二份比较。
 */
export function augmentStartIsStale(token: number, session: number): boolean {
  return token !== session;
}

/* ------------------------------------------------------------------ */
/* 阶段读数的**门**：读取失败 ≠ 离开对局                                  */
/* ------------------------------------------------------------------ */

/**
 * 把一次 `/lol-gameflow/v1/session` 的**响应体**变成一个阶段读数（纯函数）。
 *
 * ⚠️ 为什么必须单独有这一步（2026-10-06 真机回归复盘）：
 * 调用方原来写的是 `String(read.phase ?? 'None')` —— 一旦响应体里**没有可用的
 * `phase` 字段**（会话读到了、但形状不是预期：客户端升级/字段改名/重连中的半成品
 * 响应），它就变成 `'None'`，而 `'None'` 的含义是**确定的"不在对局"**
 *（见 `createStageGate`：那是"确实没有会话"的值）。于是"读到了一个看不懂的会话"
 * 被当成"已经离开对局"，**连续两次**就够确认离开 → 停链路 + 清整排标签，
 * 而面板可能还开着（日志里表现为"疑似离开 1/2 → 保持 InProgress"之后紧跟着
 * "阶段换手 augment → none"，看起来自相矛盾）。
 *
 * 正确语义只有三种，这里把第三种单独分出来：
 *   · 没有会话（HTTP 404/400，调用方自己判）→ `'None'`（**确定的**不在对局）；
 *   · 有会话且有可用 `phase` → 那个 phase；
 *   · 有会话但 `phase` 不可用 → **`null`**（= "这一轮不知道"，交给阶段门保持上一阶段）。
 *
 * @param read 反序列化后的响应体（`null`/非对象/缺 phase 都算"读到了但不可用"）
 */
export function stageSampleFromSession(read: unknown): {
  readonly sample: string | null;
  readonly reason: string;
} {
  if (read === null || typeof read !== 'object') {
    return {
      sample: null,
      reason: `读到了非对象响应（${read === null ? 'null' : typeof read}）→ 这一轮不知道阶段`,
    };
  }
  const phase = (read as { phase?: unknown }).phase;
  if (typeof phase !== 'string' || phase.trim() === '') {
    return {
      sample: null,
      reason: `会话里没有可用的 phase 字段（${phase === undefined ? '缺字段' : typeof phase}）` +
        '→ 这一轮不知道阶段（**不**当作离开对局）',
    };
  }
  return { sample: phase, reason: `会话 phase=${phase}` };
}

/**
 * 连续多少次「确实不在对局」才认作离开（默认 2 次 ≈ 4 秒）。
 *
 * 为什么必须 >1：阶段是**每 2 秒一次 HTTP 读**来的，而"离开对局"会触发
 * 一整串不可逆的动作 —— `augmentChainTransition()` 给 `stop` → 控制器
 * `stop()` → `clearLabelOverlay()` 清掉整排强度标签，而局内链路**一局只起一次**，
 * 重新起链路时 API 触发状态机是新的（`capture=false`）→ 面板还开着也一帧不取
 * → 那一块面板的标签**再也回不来**。所以"离开"必须是**连续的**读数，
 * 不能由一次抖动决定。
 */
export const AUGMENT_STAGE_LEAVE_CONFIRM = 2;

/**
 * 连续多少次**读不到**阶段就认输、按"离开对局"处理（默认 5 次 ≈ 10 秒）。
 *
 * 读取失败本身**不**算离开（见 `createStageGate`），否则一次 5 秒超时就会清标签；
 * 但也不能无限保持 —— LCU 真的挂了（客户端被关掉）时，保持 `InProgress`
 * 会让整局标签挂在屏幕上不消失。所以给一个上限：连续读不到这么久 = 认输。
 */
export const AUGMENT_STAGE_READ_FAIL_LIMIT = 5;

export interface StageGateOptions {
  /** 连续多少次"确实不在对局"才认作离开（默认 `AUGMENT_STAGE_LEAVE_CONFIRM`）。 */
  readonly leaveConfirm?: number;
  /** 连续多少次读不到阶段就认输（默认 `AUGMENT_STAGE_READ_FAIL_LIMIT`）。 */
  readonly readFailLimit?: number;
}

/** 一轮阶段读数经过"门"之后的结果。 */
export interface StageGateReading {
  /**
   * 本轮**应当采用**的阶段。
   *
   * 读取失败、或"疑似离开但还没连续够次数"时 = **保持上一轮**的阶段
   * （于是下游的归属判定 / 启停判定 / 英雄清空判定都看不到这次抖动）。
   */
  readonly stage: string;
  /** 本轮是否**没有采纳**读数、保持了上一轮的阶段。 */
  readonly held: boolean;
  /** 本轮读数是否属于"读不到"（`null` 输入）。 */
  readonly readFailed: boolean;
  /** 已连续多少次读到"不在对局"（读失败不计入）。 */
  readonly leaveStreak: number;
  /** 已连续多少次读不到阶段。 */
  readonly readFailStreak: number;
  /** 人类可读的原因（**每一次保持都要能解释**；主进程把它写进日志）。 */
  readonly reason: string;
}

export interface StageGate {
  /** 喂一轮读数：`string` = 读到的阶段，`null` = 这一轮**读失败**（不是"不在对局"）。 */
  push(sample: string | null): StageGateReading;
  readonly state: StageGateReading;
}

/**
 * LCU 阶段读数的**去抖门**（纯状态机，无时间概念）。
 *
 * 为什么需要它（真机缺陷：局内面板开着不动，标签几秒后自己消失）：
 * `apps/overlay/src/main/index.ts` 每 2 秒读一次 `/lol-gameflow/v1/session`，
 * 而**读失败**（5 秒超时 / 网络抖动 / 5xx / 鉴权失效）与**确实不在对局**
 * （404 = 当前没有 gameflow 会话）此前都落到同一个值 `'None'` 上。于是一次
 * 偶发失败就同时触发两条**不可逆**的清空：
 *
 *   1. `labelProducerFor('None', …, prev='augment')` → `handover === true`
 *      → `clearLabelOverlay()` 清掉整排标签；
 *   2. `augmentChainTransition('running', gen, 'None')` → `action === 'stop'`
 *      → `AugmentController.stop()`（内部也会清标签 + 丢行基准锁 + 丢重随基线）。
 *
 * 判定规则（每条都对应上面的一种真实情形）：
 *   · **读失败**（`null`）→ 保持上一阶段；连续 `readFailLimit` 次才认输（按离开处理）；
 *   · **读到局内阶段**（`AUGMENT_CHAIN_PHASES`）→ 立刻采纳、清掉两个计数；
 *   · **读到别的已知阶段**：
 *       - 上一阶段**本来就不在局内**（大厅→选人这种正常切换）→ **立刻采纳**，
 *         绝不能延迟选人阶段的覆盖层（它每 1.5 秒推一次胜率标签）；
 *       - 上一阶段**在局内**（= 真的在"离开对局"）→ 要连续 `leaveConfirm` 次才采纳，
 *         否则保持局内阶段。
 *
 * ⚠️ 门只负责"该不该相信这次读数"，**不**负责启停或画布归属 —— 那两件事仍然
 * 由 `augmentChainTransition()` / `labelProducerFor()` 判定（喂给它们的必须是
 * 本门输出 `stage`，不是原始读数）。
 */
export function createStageGate(options: StageGateOptions = {}): StageGate {
  const leaveConfirm = Math.max(1, Math.round(options.leaveConfirm ?? AUGMENT_STAGE_LEAVE_CONFIRM));
  const readFailLimit = Math.max(1, Math.round(options.readFailLimit ?? AUGMENT_STAGE_READ_FAIL_LIMIT));

  let stage = 'None';
  let leaveStreak = 0;
  let readFailStreak = 0;
  let current: StageGateReading = {
    stage,
    held: false,
    readFailed: false,
    leaveStreak: 0,
    readFailStreak: 0,
    reason: '尚未读取阶段',
  };

  const push = (sample: string | null): StageGateReading => {
    if (sample === null) {
      readFailStreak++;
      if (readFailStreak >= readFailLimit) {
        // 认输：读不到这么久，只能按"离开对局"处理（否则标签会永远挂在屏幕上）
        stage = 'None';
        leaveStreak = 0;
        current = {
          stage,
          held: false,
          readFailed: true,
          leaveStreak,
          readFailStreak,
          reason: `连续 ${readFailStreak} 次读不到阶段（上限 ${readFailLimit}）→ 按离开对局处理`,
        };
        return current;
      }
      current = {
        stage,
        held: true,
        readFailed: true,
        leaveStreak,
        readFailStreak,
        reason:
          `阶段读取失败（第 ${readFailStreak}/${readFailLimit} 次）→ 保持 ${stage}` +
          '，**不**当作离开对局（否则一次超时就会清掉整排标签）',
      };
      return current;
    }

    readFailStreak = 0;
    if (AUGMENT_CHAIN_PHASES.includes(sample)) {
      stage = sample;
      leaveStreak = 0;
      current = {
        stage,
        held: false,
        readFailed: false,
        leaveStreak,
        readFailStreak,
        reason: `在对局中（${sample}）`,
      };
      return current;
    }

    // 已知阶段，但不在局内：只有"从局内阶段往外走"才需要连续确认
    if (!AUGMENT_CHAIN_PHASES.includes(stage)) {
      stage = sample;
      leaveStreak = 0;
      current = {
        stage,
        held: false,
        readFailed: false,
        leaveStreak,
        readFailStreak,
        reason: `阶段 ${sample}（上一轮本来就不在局内 → 直接采纳）`,
      };
      return current;
    }

    leaveStreak++;
    if (leaveStreak < leaveConfirm) {
      current = {
        stage,
        held: true,
        readFailed: false,
        leaveStreak,
        readFailStreak,
        reason: `疑似离开对局（读到 ${sample}，第 ${leaveStreak}/${leaveConfirm} 次）→ 保持 ${stage}`,
      };
      return current;
    }
    stage = sample;
    leaveStreak = 0;
    current = {
      stage,
      held: false,
      readFailed: false,
      leaveStreak,
      readFailStreak,
      reason: `连续 ${leaveConfirm} 次读到 ${sample} → 确认离开对局`,
    };
    return current;
  };

  return {
    push,
    get state(): StageGateReading {
      return current;
    },
  };
}
