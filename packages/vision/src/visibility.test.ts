/**
 * 可见性判定测试
 *
 * 重点回归「连不上客户端时诊断面板不再出现」的真实 bug：
 * 原实现只在**阶段变化**时更新窗口，因此中途掉线（阶段没变、
 * 仅连接状态变化）不会重新显示窗口。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AUGMENT_CHAIN_PHASES,
  AUGMENT_STAGE_LEAVE_CONFIRM,
  AUGMENT_STAGE_READ_FAIL_LIMIT,
  augmentChainActive,
  augmentChainTransition,
  augmentStartIsStale,
  createStageGate,
  decideVisible,
  labelProducerFor,
  overlayAugmentEnabled,
  sameVisibleState,
  type AugmentChainState,
} from './visibility.ts';

test('decideVisible：选人阶段**只**显示覆盖层，不弹侧边窗', () => {
  // 2026-10-04 用户决策：选人阶段的信息由覆盖层画在游戏画面内
  // （卡片下方 / 顶栏逐格），侧边窗与它重复且会叠在英雄立绘上抢地方。
  assert.deepEqual(decideVisible('ChampSelect', true), {
    showPanel: false,
    showVision: true,
    visionActive: true,
  });
});

test('decideVisible：对局中**也不**显示侧边窗（局内信息在海克斯卡上）', () => {
  // 2026-10-04 追加决策：局内的信息载体是"海克斯卡上的强度标签"
  // （augment-panel + docs/AUGMENT-PANEL.md），侧边窗的强度列表被它取代。
  assert.deepEqual(decideVisible('InProgress', true), {
    showPanel: false,
    showVision: false,
    visionActive: false,
  });
});

test('decideVisible：任何阶段都不再显示侧边窗（锁住"已移除"这一语义）', () => {
  for (const phase of ['None', 'Lobby', 'ChampSelect', 'InProgress', 'EndOfGame', '']) {
    assert.equal(decideVisible(phase, true).showPanel, false, `阶段 ${phase}`);
    assert.equal(decideVisible(phase, false).showPanel, false, `阶段 ${phase}（未连接）`);
  }
});

test('decideVisible：大厅等非对局阶段隐藏侧边窗（已连上，不是故障）', () => {
  for (const phase of ['None', 'Lobby', 'Matchmaking', 'ReadyCheck', 'EndOfGame']) {
    assert.deepEqual(
      decideVisible(phase, true),
      { showPanel: false, showVision: false, visionActive: false },
      `阶段 ${phase} 不该显示侧边窗`,
    );
  }
});

test('decideVisible：连不上客户端也不再弹窗（用户选择"只写日志"）', () => {
  // 回归：此处曾是「未连接必须显示诊断面板」。用户 2026-10-04 明确改为
  // 不弹窗、只写日志 —— 排查信息在终端输出与 overlay-live.log 里。
  for (const phase of ['None', 'Lobby', 'ChampSelect', '', 'InProgress']) {
    const v = decideVisible(phase, false);
    assert.equal(v.showPanel, false, `阶段 ${phase} 的侧边窗显隐`);
  }
});

test('decideVisible：未连接时不启动视觉循环（没有客户端就没有选人）', () => {
  const v = decideVisible('None', false);
  assert.equal(v.visionActive, false);
  assert.equal(v.showVision, false);
});

test('sameVisibleState：null 与任何状态都不等价（首轮必须应用一次）', () => {
  assert.equal(sameVisibleState(null, decideVisible('None', true)), false);
});

test('sameVisibleState：内容相同的两个对象等价（避免每轮 show/hide 闪烁）', () => {
  const a = decideVisible('InProgress', true);
  const b = decideVisible('InProgress', true);
  assert.equal(sameVisibleState(a, b), true);
  assert.notEqual(a, b); // 确实是两个对象，等价性来自字段比较
});

test('sameVisibleState：任一字段变化都要重新应用', () => {
  // 进/出选人：showVision 与 visionActive 都要翻转
  const lobby = decideVisible('Lobby', true);
  assert.equal(sameVisibleState(lobby, decideVisible('ChampSelect', true)), false);
  // ⚠️ 进出对局**不再**翻转任何字段（2026-10-04 起局内也没有侧边窗），
  // 因此这两份判定等价 —— 断言它，避免以后有人悄悄把侧边窗加回局内。
  assert.equal(sameVisibleState(lobby, decideVisible('InProgress', true)), true);
  // 同阶段重复：等价，不必重复 show/hide
  assert.equal(sameVisibleState(lobby, decideVisible('ReadyCheck', true)), true);
  assert.equal(sameVisibleState(lobby, decideVisible('None', true)), true);
});

test('sameVisibleState：连接状态翻转**不**改变可见性（用户要求不再弹窗）', () => {
  // 2026-10-04 起"连不上"不再影响窗口显隐，因此这两份判定等价；
  // 保留用例是为了锁住这个语义（曾经它会翻转，并引出"诊断面板不出现"的 bug）。
  for (const phase of ['None', 'Lobby', 'ChampSelect', 'InProgress']) {
    assert.equal(
      sameVisibleState(decideVisible(phase, true), decideVisible(phase, false)),
      true,
      `阶段 ${phase}：连接状态不该改变可见性`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* 画布归属（S5.4d）：选人胜率标签 vs 局内海克斯强度标签                  */
/* ------------------------------------------------------------------ */

test('labelProducerFor：选人阶段由**选人生产者**产出，局内链路不介入', () => {
  // 这是"不许回归选人路径"的第一条锁：选人阶段画布归选人循环，
  // 它有自己的 6 轮 TTL 与卡片/顶栏两套几何。
  for (const panel of ['closed', 'open', 'unknown'] as const) {
    const o = labelProducerFor('ChampSelect', panel);
    assert.equal(o.producer, 'champ-select', `面板 ${panel} 时选人阶段的生产者`);
    assert.equal(o.shouldDraw, true, `面板 ${panel} 时选人生产者应当可以画`);
  }
});

test('labelProducerFor：局内阶段由**局内海克斯生产者**产出（面板在屏才画）', () => {
  const open = labelProducerFor('InProgress', 'open');
  assert.equal(open.producer, 'augment');
  assert.equal(open.shouldDraw, true);

  // 面板不在屏（关闭/还没采过样）→ 归属不变（清空由同一个生产者负责），
  // 但画布**必须为空**：绝不留下上一次 offer 的字母（§七 的清空规则）。
  for (const panel of ['closed', 'unknown'] as const) {
    const o = labelProducerFor('InProgress', panel);
    assert.equal(o.producer, 'augment', `面板 ${panel} 时仍是局内生产者`);
    assert.equal(o.shouldDraw, false, `面板 ${panel} 时不许有内容`);
  }
});

test('labelProducerFor：非对局阶段谁都别画（大厅/匹配/结算/未知）', () => {
  for (const phase of ['None', 'Lobby', 'Matchmaking', 'ReadyCheck', 'EndOfGame', 'GameStart', 'WaitingForStats', 'PreEndOfGame', '', 'InProgressX']) {
    for (const panel of ['closed', 'open', 'unknown'] as const) {
      const o = labelProducerFor(phase, panel);
      assert.equal(o.producer, 'none', `阶段 ${phase}（面板 ${panel}）不该有生产者`);
      assert.equal(o.shouldDraw, false, `阶段 ${phase}（面板 ${panel}）不该有内容`);
    }
  }
});

test('labelProducerFor：面板开/关**不算**换手（同一阶段内不许反复清画布）', () => {
  // 面板开→关→开 都是同一个生产者的事：清空由它自己在关边沿做
  //（`clearLabelOverlay`），不能靠"归属变化"去清 —— 否则每次开面板都要多推一次清空，
  // 还会和"开边沿锁定行基准"的时序搅在一起。
  const a = labelProducerFor('InProgress', 'open', 'augment');
  assert.equal(a.handover, false);
  const b = labelProducerFor('InProgress', 'closed', 'augment');
  assert.equal(b.handover, false);
  const c = labelProducerFor('ChampSelect', 'closed', 'champ-select');
  assert.equal(c.handover, false);
});

test('labelProducerFor：**阶段切换瞬间**换手 → 必须先清掉对方的遗留标签', () => {
  // ① 选人 → 局内：选人的胜率标签必须被清掉，再让海克斯标签上场
  const intoGame = labelProducerFor('InProgress', 'closed', 'champ-select');
  assert.deepEqual(intoGame, { producer: 'augment', shouldDraw: false, handover: true });
  // ② 局内 → 下一局的选人：上一局面板若还开着，字母会一直挂在屏幕上
  const intoSelect = labelProducerFor('ChampSelect', 'closed', 'augment');
  assert.deepEqual(intoSelect, { producer: 'champ-select', shouldDraw: true, handover: true });
  // ③ 对局结束回大厅 → 谁都别画，也要把局内遗留清掉
  const intoLobby = labelProducerFor('None', 'closed', 'augment');
  assert.deepEqual(intoLobby, { producer: 'none', shouldDraw: false, handover: true });
  // ④ 反向：大厅 → 选人
  assert.equal(labelProducerFor('ChampSelect', 'closed', 'none').handover, true);
});

test('labelProducerFor：首轮（prev=null）**不**算换手（启动时画布本来就是空的）', () => {
  for (const phase of ['ChampSelect', 'InProgress', 'None']) {
    assert.equal(labelProducerFor(phase, 'closed', null).handover, false, `阶段 ${phase}`);
  }
});

test('labelProducerFor：同一阶段重复判定 → 归属稳定、无换手', () => {
  let prev: 'champ-select' | 'augment' | 'none' = 'augment';
  for (let i = 0; i < 5; i++) {
    const o = labelProducerFor('InProgress', i % 2 === 0 ? 'open' : 'closed', prev);
    prev = o.producer;
    assert.equal(o.producer, 'augment');
    assert.equal(o.handover, false);
  }
});

test('labelProducerFor：开关关掉局内链路 → 局内归 `none`（并清掉局内遗留）', () => {
  const off = { augmentEnabled: false };
  // 选人**照常**工作（降级开关只关局内那一条链路）
  assert.deepEqual(labelProducerFor('ChampSelect', 'closed', null, off), {
    producer: 'champ-select',
    shouldDraw: true,
    handover: false,
  });
  // 局内：以前由 augment 拥有 → 现在换成 none，必须换手清空
  assert.deepEqual(labelProducerFor('InProgress', 'open', 'augment', off), {
    producer: 'none',
    shouldDraw: false,
    handover: true,
  });
  // 关掉时局内也不该起链路
  assert.equal(augmentChainActive('InProgress', off), false);
});

test('augmentChainActive：只认局内阶段，**绝不**在选人/加载/结算阶段起链路', () => {
  for (const phase of AUGMENT_CHAIN_PHASES) {
    assert.equal(augmentChainActive(phase), true, `阶段 ${phase} 应当起链路`);
  }
  for (const phase of ['ChampSelect', 'GameStart', 'WaitingForStats', 'PreEndOfGame', 'None', 'Lobby', '']) {
    assert.equal(augmentChainActive(phase), false, `阶段 ${phase} 不该起链路`);
  }
  assert.equal(augmentChainActive('InProgress', { augmentEnabled: false }), false);
});

test('组合：选人循环与局内链路**互斥**（谁也别抢谁的画布）', () => {
  // 这是把两个模块锁在一起的关键断言 —— 一旦有人把 visionActive 扩到局内，
  // 或者忘了在选人阶段拦住局内链路，这里立刻红。
  for (const phase of ['ChampSelect', 'InProgress', 'Reconnect', 'GameStart', 'None', 'Lobby']) {
    const vision = decideVisible(phase, true).visionActive;
    const augment = augmentChainActive(phase);
    assert.equal(
      vision && augment,
      false,
      `阶段 ${phase}：选人视觉循环与局内链路不能同时跑（vision=${vision} augment=${augment}）`,
    );
    // 归属也必须与"谁在跑"一致：唯一生产者就是正在跑的那个
    const owner = labelProducerFor(phase, 'open').producer;
    if (vision) assert.equal(owner, 'champ-select', `阶段 ${phase}`);
    else if (augment) assert.equal(owner, 'augment', `阶段 ${phase}`);
    else assert.equal(owner, 'none', `阶段 ${phase}`);
  }
});

test('组合：局内生产者与 `augmentChainActive` 永远同进同退（两个入口不许分家）', () => {
  for (const phase of ['ChampSelect', 'InProgress', 'Reconnect', 'GameStart', 'None']) {
    for (const enabled of [true, false]) {
      const active = augmentChainActive(phase, { augmentEnabled: enabled });
      const owner = labelProducerFor(phase, 'closed', null, { augmentEnabled: enabled }).producer;
      assert.equal(owner === 'augment', active, `阶段 ${phase} / 启用 ${enabled}`);
    }
  }
});

test('overlayAugmentEnabled：只有显式写 0/false/off 才关掉（降级必须是明确动作）', () => {
  for (const v of ['0', 'false', 'FALSE', 'off', ' Off ', ' 0 ']) {
    assert.equal(overlayAugmentEnabled(v), false, `值 ${JSON.stringify(v)} 应当关掉`);
  }
  for (const v of [undefined, '', ' ', '1', 'true', 'yes', 'on', 'no', 'anything']) {
    assert.equal(overlayAugmentEnabled(v), true, `值 ${JSON.stringify(v)} 应当启用`);
  }
});

/* ------------------------------------------------------------------ */
/* 链路启停状态机（S5.4d）：起一次、离开就停、在途启动要作废              */
/* ------------------------------------------------------------------ */

/**
 * 跑一遍阶段序列，返回每一轮的判定（模拟主进程每 2 秒一轮的轮询）。
 *
 * `running` 用来模拟"启动成功"（主进程在 `start()` 的回调里把状态改成 running）；
 * 不传就一直是 starting —— 这正是"启动很慢"的真实情形。
 */
function replay(
  stages: readonly string[],
  opts: { readonly runningAt?: readonly number[]; readonly augmentEnabled?: boolean } = {},
): Array<{ stage: string; action: string; state: AugmentChainState; generation: number }> {
  let state: AugmentChainState = 'idle';
  let generation = 0;
  const out: Array<{ stage: string; action: string; state: AugmentChainState; generation: number }> = [];
  for (const [i, stage] of stages.entries()) {
    const t = augmentChainTransition(state, generation, stage, {
      augmentEnabled: opts.augmentEnabled ?? true,
    });
    generation = t.generation;
    state = t.state;
    // 模拟异步 start() 的落地：成功 → running
    if (t.action === 'start' && (opts.runningAt ?? []).includes(i)) state = 'running';
    out.push({ stage, action: t.action, state, generation });
  }
  return out;
}

test('augmentChainTransition：一局完整阶段序列 —— 局内只起一次、离开立刻停', () => {
  const seq = replay(
    ['None', 'ChampSelect', 'InProgress', 'InProgress', 'InProgress', 'ChampSelect', 'None'],
    { runningAt: [2] },
  );
  assert.deepEqual(
    seq.map((s) => s.action),
    ['none', 'none', 'start', 'none', 'none', 'stop', 'none'],
  );
  assert.deepEqual(
    seq.map((s) => s.state),
    ['idle', 'idle', 'running', 'running', 'running', 'idle', 'idle'],
  );
  // 选人阶段**永远不给 start**（画布归选人循环，且海克斯还没出现）
  for (const s of seq.filter((x) => x.stage === 'ChampSelect')) {
    assert.notEqual(s.action, 'start');
  }
});

test('augmentChainTransition：重复轮询不会重复起链路（局内 10 轮只 start 一次）', () => {
  const seq = replay(new Array(10).fill('InProgress'), { runningAt: [0] });
  assert.equal(seq.filter((s) => s.action === 'start').length, 1);
  assert.equal(seq.filter((s) => s.action === 'stop').length, 0);
});

test('augmentChainTransition：**在途启动**期间离开对局 → 必须停 + 世代号作废', () => {
  // 第 0 轮 InProgress 给了 start（state=starting，因为启动很慢、没落地）
  // 第 1 轮已经回到选人 → 必须 stop，且世代号与 start 那一轮不同（在途回调作废）
  const seq = replay(['InProgress', 'ChampSelect']);
  assert.equal(seq[0]!.action, 'start');
  assert.equal(seq[0]!.state, 'starting');
  assert.equal(seq[1]!.action, 'stop');
  assert.equal(seq[1]!.state, 'idle');
  assert.notEqual(
    seq[1]!.generation,
    seq[0]!.generation,
    '离开对局必须让在途的 start() 世代号失配（否则会留下一条没人管的屏幕流）',
  );
});

/* ------------------------------------------------------------------ */
/* 会话令牌：start/stop **只允许作废自己那一代**（2026-10-06 真机缺陷）      */
/* ------------------------------------------------------------------ */

test('会话令牌：stop 带的是**要作废的那一代**，start 拿到的必须是全新号', () => {
  const start1 = augmentChainTransition('idle', 0, 'InProgress');
  assert.deepEqual(start1, { action: 'start', state: 'starting', generation: 1, token: 1 });
  // 在途启动期间确认离开：stop 指向**要作废的那一代**（1），计数器前进到 2
  const stop1 = augmentChainTransition(start1.state, start1.generation, 'None');
  assert.deepEqual(stop1, { action: 'stop', state: 'idle', generation: 2, token: 1 });
  // 回到对局：新会话拿到全新号（3），与刚被作废的 1 不同 —— 否则"作废"会失效
  const start2 = augmentChainTransition(stop1.state, stop1.generation, 'InProgress');
  assert.deepEqual(start2, { action: 'start', state: 'starting', generation: 3, token: 3 });
  assert.notEqual(start2.token, stop1.token);
  // 稳定在局内重复轮询：动作 none、令牌一直是当前会话
  const idle = augmentChainTransition(start2.state, start2.generation, 'InProgress');
  assert.deepEqual(idle, { action: 'none', state: 'starting', generation: 3, token: 3 });
});

test('augmentStartIsStale：令牌不是当前会话 → 回调什么都不许做（尤其不许 stop）', () => {
  assert.equal(augmentStartIsStale(3, 3), false, '自己那一代：照常收尾');
  assert.equal(augmentStartIsStale(1, 3), true, '期间起了新一代（1 → 3）：过期');
  assert.equal(augmentStartIsStale(1, 2), true, '期间确认离开且还没回来（1 → 2）：过期');
});

test('会话令牌：任何时间轴上都不重号（重号 = 在途启动作废失效）', () => {
  const seen = new Set<number>();
  let state: AugmentChainState = 'idle';
  let generation = 0;
  for (const stage of [
    'InProgress',
    'None',
    'InProgress',
    'None',
    'Reconnect',
    'ChampSelect',
    'InProgress',
  ]) {
    const t = augmentChainTransition(state, generation, stage);
    generation = t.generation;
    state = t.state;
    if (t.action === 'start') {
      assert.equal(seen.has(t.token), false, `令牌 ${t.token} 被重用`);
      seen.add(t.token);
    }
    if (t.action === 'stop') {
      assert.equal(seen.has(t.token), true, 'stop 必须指向一个真实存在过的会话');
      assert.notEqual(t.token, t.generation, 'stop 之后计数器必须前进（不许与新会话重号）');
    }
  }
  assert.equal(seen.size, 4);
});

test('augmentChainTransition：`failed` 本局不重试，离开对局后下一局重新起', () => {
  let state: AugmentChainState = 'idle';
  let generation = 0;
  const step = (stage: string): { action: string; state: AugmentChainState; generation: number } => {
    const t = augmentChainTransition(state, generation, stage);
    state = t.state;
    generation = t.generation;
    return { action: t.action, state, generation };
  };
  assert.equal(step('InProgress').action, 'start');
  state = 'failed'; // 模拟 start() 失败（屏幕流没起来）
  assert.deepEqual(step('InProgress'), { action: 'none', state: 'failed', generation: 1 });
  assert.deepEqual(step('InProgress'), { action: 'none', state: 'failed', generation: 1 });
  // 对局结束 → 收工回 idle；下一局重新给 start
  assert.equal(step('None').action, 'stop');
  assert.equal(step('InProgress').action, 'start');
});

test('augmentChainTransition：降级开关关掉 → 局内也不起（选人阶段本来就不归它）', () => {
  const seq = replay(['ChampSelect', 'InProgress', 'Reconnect', 'None'], { augmentEnabled: false });
  assert.deepEqual(
    seq.map((s) => s.action),
    ['none', 'none', 'none', 'none'],
  );
  assert.ok(seq.every((s) => s.state === 'idle'));
});

test('augmentChainTransition：`Reconnect` 也算局内（同一局里面板仍可能弹出）', () => {
  const seq = replay(['InProgress', 'Reconnect', 'InProgress'], { runningAt: [0] });
  assert.deepEqual(
    seq.map((s) => s.action),
    ['start', 'none', 'none'],
  );
});

test('augmentChainTransition：启动中（starting）重复轮询不给第二次 start', () => {
  const seq = replay(['InProgress', 'InProgress', 'InProgress']); // 一直没落地
  assert.deepEqual(
    seq.map((s) => s.action),
    ['start', 'none', 'none'],
  );
  assert.ok(seq.every((s) => s.state === 'starting'));
});

/* ------------------------------------------------------------------ */
/* 阶段门：读取失败 ≠ 离开对局（真机缺陷：面板开着不动、标签几秒后消失）      */
/* ------------------------------------------------------------------ */

/**
 * 这一组锁的是 2026-10-06 的真机缺陷：
 *
 * 主进程每 2 秒读一次 `/lol-gameflow/v1/session`。**读失败**（5 秒超时 /
 * 网络抖动 / 5xx）与**确实不在对局**（404）此前都写成 `'None'`，于是一次偶发
 * 失败就同时触发两条不可逆的清空：
 *   ① `labelProducerFor('None', …, 'augment').handover === true` → 清画布；
 *   ② `augmentChainTransition('running', gen, 'None').action === 'stop'` → 链路停
 *      （控制器内部也清标签），而且重新起链路时 API 触发是新的 → 那一块面板
 *      再也画不出标签。
 *
 * 门（`createStageGate()`）只做一件事：**读失败保持上一阶段、离开要连续 N 次**。
 */

test('阶段门：**读失败**保持上一阶段（不当作离开），连续到上限才认输', () => {
  const gate = createStageGate();
  assert.equal(gate.push('InProgress').stage, 'InProgress');
  // 前 limit-1 次读失败：阶段**一点不动**（这是"一次超时不许清标签"的保证）
  for (let i = 1; i < AUGMENT_STAGE_READ_FAIL_LIMIT; i++) {
    const r = gate.push(null);
    assert.equal(r.stage, 'InProgress', `第 ${i} 次读失败不该改阶段`);
    assert.equal(r.held, true);
    assert.equal(r.readFailed, true);
    assert.equal(r.readFailStreak, i);
    assert.match(r.reason, /读取失败/);
    assert.match(r.reason, /不.*当作离开对局/);
  }
  // 到上限：认输（LCU 真的挂了不能把标签永远挂在屏幕上）
  const giveUp = gate.push(null);
  assert.equal(giveUp.stage, 'None');
  assert.equal(giveUp.held, false);
  assert.equal(giveUp.readFailStreak, AUGMENT_STAGE_READ_FAIL_LIMIT);
  assert.match(giveUp.reason, /按离开对局处理/);
});

test('阶段门：读失败不累计"离开"次数，中途读到局内就把计数清零', () => {
  const gate = createStageGate();
  gate.push('InProgress');
  assert.equal(gate.push('None').held, true); // 第 1 次"不在对局" → 保持
  assert.equal(gate.push(null).stage, 'InProgress'); // 读失败：保持，且不计入离开
  assert.equal(gate.push(null).stage, 'InProgress');
  assert.equal(gate.push('InProgress').leaveStreak, 0); // 回到局内 → 清零
  assert.equal(gate.push(null).readFailStreak, 1); // 读失败计数也已清零
  // 清零之后"离开"仍要重新连续 2 次
  assert.equal(gate.push('None').held, true);
  assert.equal(gate.push('None').stage, 'None');
});

test('阶段门：**连续 N 次**读到"不在对局"才采纳（单次抖动被挡住）', () => {
  const gate = createStageGate();
  gate.push('InProgress');
  const first = gate.push('None');
  assert.equal(first.stage, 'InProgress', '单次抖动必须保持局内阶段');
  assert.equal(first.held, true);
  assert.equal(first.readFailed, false);
  assert.equal(first.leaveStreak, 1);
  assert.match(first.reason, /疑似离开对局/);
  const second = gate.push('None');
  assert.equal(second.stage, 'None', `${AUGMENT_STAGE_LEAVE_CONFIRM} 次确认后采纳`);
  assert.equal(second.held, false);
  assert.match(second.reason, /确认离开对局/);
});

test('阶段门：上一轮**本来就不在局内**时，阶段切换立即采纳（不延迟选人覆盖层）', () => {
  const gate = createStageGate();
  // 大厅 → 匹配 → 选人：每一步都必须**当轮**生效（选人覆盖层每 1.5s 一轮，
  // 延迟 2 秒会让"卡片胜率标签"晚出来一整轮）
  for (const stage of ['Lobby', 'Matchmaking', 'ReadyCheck', 'ChampSelect']) {
    const r = gate.push(stage);
    assert.equal(r.stage, stage, `阶段 ${stage} 必须立即采纳`);
    assert.equal(r.held, false);
  }
  // 局内阶段同理（选人 → 对局；Reconnect 也算局内）
  assert.equal(gate.push('GameStart').stage, 'GameStart');
  assert.equal(gate.push('InProgress').stage, 'InProgress');
  assert.equal(gate.push('Reconnect').stage, 'Reconnect');
});

test('阶段门：默认值与常量一致（离开确认 2 次 / 读失败上限 5 次）', () => {
  assert.equal(AUGMENT_STAGE_LEAVE_CONFIRM, 2);
  assert.equal(AUGMENT_STAGE_READ_FAIL_LIMIT, 5);
  const gate = createStageGate();
  assert.equal(gate.state.stage, 'None');
  assert.match(gate.state.reason, /尚未读取/);
  // 可注入（自测/单测用）
  const fast = createStageGate({ leaveConfirm: 1, readFailLimit: 1 });
  fast.push('InProgress');
  assert.equal(fast.push('None').stage, 'None', 'leaveConfirm=1 时当轮就采纳');
  assert.equal(fast.push(null).stage, 'None', 'readFailLimit=1 时当轮就认输');
});

test('阶段门 + 归属/启停（回归）：**一次读失败**不再清标签、不再停链路', () => {
  const gate = createStageGate();
  let state: AugmentChainState = 'idle';
  let generation = 0;
  let producer: 'champ-select' | 'augment' | 'none' | null = null;

  /** 一轮轮询：门 → 归属 → 启停（与主进程 `pollOnce` 同序）。 */
  const round = (sample: string | null): { handover: boolean; action: string; stage: string } => {
    const gated = gate.push(sample);
    const ownership = labelProducerFor(gated.stage, 'open', producer);
    const t = augmentChainTransition(state, generation, gated.stage);
    generation = t.generation;
    state = t.state;
    producer = ownership.producer;
    return { handover: ownership.handover, action: t.action, stage: gated.stage };
  };

  assert.deepEqual(round('InProgress'), { handover: false, action: 'start', stage: 'InProgress' });
  state = 'running'; // 模拟 start() 落地
  // ⚠️ 这一轮就是真机缺陷的触发点：读失败
  assert.deepEqual(round(null), { handover: false, action: 'none', stage: 'InProgress' });
  assert.deepEqual(round('InProgress'), { handover: false, action: 'none', stage: 'InProgress' });
  // 单次"不在对局"（例如 5xx 被上游当成 404 的瞬间）同样被挡住
  assert.deepEqual(round('None'), { handover: false, action: 'none', stage: 'InProgress' });
  assert.deepEqual(round('InProgress'), { handover: false, action: 'none', stage: 'InProgress' });
  // 底线不变：**连续 2 次真的不在对局** → 换手清空 + 停链路（真离开必须清）
  assert.deepEqual(round('None'), { handover: false, action: 'none', stage: 'InProgress' });
  assert.deepEqual(round('None'), { handover: true, action: 'stop', stage: 'None' });
});

test('阶段门 + 归属（对照）：**旧行为**（直接把读失败写成 None）确实会清空', () => {
  // 这不是"要求这样"，而是把 bug 的机制钉在测试里：门去掉之后它立刻回来。
  const raw = 'None';
  const ownership = labelProducerFor(raw, 'open', 'augment');
  assert.equal(ownership.producer, 'none');
  assert.equal(ownership.handover, true, '原始读数喂进归属判定 → 换手清空（改前就是这样）');
  const t = augmentChainTransition('running', 7, raw);
  assert.equal(t.action, 'stop', '同时会停链路 → 控制器也清标签');
  assert.notEqual(t.generation, 7);
  // 而门的输出（同一时刻）不会：两条不可逆动作都不发生
  const gate = createStageGate();
  gate.push('InProgress');
  const gated = gate.push(null);
  assert.equal(labelProducerFor(gated.stage, 'open', 'augment').handover, false);
  assert.equal(augmentChainTransition('running', 7, gated.stage).action, 'none');
});

test('阶段门：`decideVisible` 的字段在"读失败"这一轮一个都不翻转（选人循环不会被误停）', () => {
  // 选人循环的启停看 `visionActive`，而它一旦从 true 变 false 就会
  // `visionLoop.stop()` → 推一帧 `active:false` → **清掉整块画布**。
  // 所以"读失败"这一轮连 `want` 都不许变。
  const gate = createStageGate();
  const wantFor = (sample: string | null): ReturnType<typeof decideVisible> =>
    decideVisible(gate.push(sample).stage, true);
  const inSelect = wantFor('ChampSelect');
  assert.equal(inSelect.visionActive, true);
  assert.equal(sameVisibleState(inSelect, wantFor(null)), true, '读失败这一轮可见性判定必须等价');
  assert.equal(sameVisibleState(inSelect, wantFor('ChampSelect')), true);
  // 局内同理
  const inGame = wantFor('InProgress');
  assert.equal(sameVisibleState(inGame, wantFor(null)), true);
});


