/**
 * 悬浮窗渲染端（纯浏览器环境）
 *
 * 不 import 任何 Node 依赖 —— LCU 轮询、数据读取、join 都在主进程，
 * 这里只接收 `overlay:state` 推送并渲染。
 *
 * 分阶段渲染（见 docs/OVERLAY-STAGES.md）：
 *   - 选人阶段：只显示**所选英雄的胜率**（此时玩家在选英雄，
 *     海克斯还没出现，显示海克斯数据是错误的）。
 *   - 局内：显示该英雄口径的**海克斯强度**与**出装建议**。
 */

interface AugmentRow {
  name: string;
  icon: string;
  tier: string;
  pickRate: number;
  rarity: string;
}

interface BuildSlot {
  names: string[];
  pickRate: number;
  winRate: number;
}

interface OverlayStateMsg {
  connected: boolean;
  phase: string;
  gameMode: string;
  queueId: number | null;
  isBrawl: boolean;
  picks: Array<{ championId: number; name: string }>;
  clickThrough: boolean;
  me: { championId: number; name: string; winRate: number; hasData: boolean };
  augments: AugmentRow[];
  build: {
    start: BuildSlot[];
    shoes: BuildSlot[];
    core: BuildSlot[];
    full: BuildSlot[];
  };
  meta: { dataDate: string; hasBuilds: boolean };
  credsDetail: string;
}

interface OverlayApi {
  setClickThrough(on: boolean): Promise<boolean>;
  close(): Promise<void>;
  getState(): Promise<{ clickThrough: boolean }>;
  onState(cb: (s: OverlayStateMsg) => void): void;
  onClickThrough(cb: (on: boolean) => void): void;
}

declare const overlay: OverlayApi;

const app = document.getElementById('app') as HTMLElement;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

const PHASE_LABEL: Record<string, string> = {
  None: '未在对局中',
  Lobby: '大厅',
  Matchmaking: '匹配中',
  ReadyCheck: '等待确认',
  ChampSelect: '选人中',
  GameStart: '对局开始',
  InProgress: '对局中',
  WaitingForStats: '结算中',
  PreEndOfGame: '即将结束',
  EndOfGame: '对局结束',
};

/** 稀有度配色（与数据站口径一致）。 */
const RARITY_COLOR: Record<string, string> = {
  kPrismatic: '#c084fc',
  kGold: '#e0b64a',
  kSilver: '#9fb0c9',
  kEventChoice: '#6fb3d2',
};

/** 强度评级配色：S 最强 → C 最弱。 */
const TIER_COLOR: Record<string, string> = {
  S: '#e0b64a',
  A: '#c084fc',
  B: '#6fb3d2',
  C: '#9fb0c9',
  D: '#8b96ad',
};

function pct(rate: number, digits = 1): string {
  return `${(rate * 100).toFixed(digits)}%`;
}

/** 数据出处脚注。 */
function sourceFoot(meta: OverlayStateMsg['meta']): string {
  const date = meta.dataDate
    ? `${meta.dataDate.slice(0, 4)}-${meta.dataDate.slice(4, 6)}-${meta.dataDate.slice(6, 8)}`
    : '未知';
  return `<span class="dim">数据 101.qq.com 官方 · 统计日 ${date}</span>`;
}

function panel(header: string, tag: string, body: string, foot: string): string {
  return `
    <div class="panel">
      <div class="hd"><span class="dot${tag === '未连接' ? ' off' : ''}"></span> hexbox
        <span class="tag">${esc(header)}</span></div>
      <div class="body">${body}</div>
      ${foot ? `<div class="foot">${foot}</div>` : ''}
    </div>`;
}

/** 离线诊断面板（连不上 LCU 时显示）。 */
function offlinePanel(s: OverlayStateMsg): string {
  const detail = s.credsDetail
    ? `<div class="li dim">探测详情: ${esc(s.credsDetail)}</div>`
    : '';
  return panel(
    '未连接',
    '未连接',
    `
      <div class="notice">读不到 LCU 凭证，无法获取对局状态。</div>
      ${detail}
      <div class="sep"></div>
      <div class="k">令牌来源（二选一）：</div>
      <div class="li dim">· 进程命令行 —— 需管理员权限</div>
      <div class="li dim">· 安装目录 lockfile</div>
      <div class="sep"></div>
      <div class="k">排查顺序</div>
      <div class="li dim">1. 确认以<b>管理员身份</b>运行本工具</div>
      <div class="li dim">2. 国服 WeGame 的 lockfile 常为 0 字节，属已知现象</div>
      <div class="li dim">3. 完全退出客户端后重启，再启动本工具</div>
    `,
    '请关闭本窗口，右键以「管理员身份运行」重新启动。',
  );
}

/** 一个海克斯强度行。 */
function augRowHtml(a: AugmentRow): string {
  const icon = a.icon
    ? `<img class="ico" src="${esc(a.icon)}" alt="" loading="lazy" />`
    : `<div class="ico ph"></div>`;
  const color = TIER_COLOR[a.tier] ?? RARITY_COLOR[a.rarity] ?? '#9fb0c9';
  return `
    <div class="aug">
      ${icon}
      <div class="augmain">
        <div class="augname">${esc(a.name)}</div>
        <div class="heroes dim">登场率 ${pct(a.pickRate)}</div>
      </div>
      <div class="tier" style="background:${color}">${esc(a.tier)}</div>
    </div>`;
}

/** 一个出装槽位（含方案列表）。 */
function slotHtml(label: string, slots: BuildSlot[], compact = false): string {
  if (slots.length === 0) return '';
  const items = slots
    .map((s) => {
      const names = s.names.map((n) => esc(n)).join(' <span class="plus">+</span> ');
      return `
        <div class="buildrow">
          <div class="buildnames">${names}</div>
          <div class="buildstat">
            <span class="wr">${pct(s.winRate)}</span>
            <span class="dim pr">登场 ${pct(s.pickRate)}</span>
          </div>
        </div>`;
    })
    .join('');
  return `
    <div class="slot ${compact ? 'compact' : ''}">
      <div class="slotlabel">${esc(label)}</div>
      ${items}
    </div>`;
}

function render(s: OverlayStateMsg): void {
  if (!s.connected) {
    app.innerHTML = offlinePanel(s);
    return;
  }

  const phaseLabel = PHASE_LABEL[s.phase] ?? s.phase;
  const isBrawlTag = s.isBrawl ? '海克斯乱斗' : s.gameMode;

  /* ---------------- 英雄选择阶段：只显示英雄胜率 ---------------- */
  if (s.phase === 'ChampSelect') {
    const picks = s.picks.length
      ? s.picks.map((p) => `<span class="chip">${esc(p.name)}</span>`).join('')
      : '<span class="dim">（尚无已选英雄）</span>';

    // 玩家此时在做「选英雄」的决策，因此核心信息是该英雄的胜率。
    // 不发散到海克斯/出装 —— 那些在选人阶段没有决策价值。
    const meBlock = s.me.championId > 0
      ? `
        <div class="me">
          <div class="mename">${esc(s.me.name)}</div>
          ${
            s.me.hasData
              ? `<div class="mewr">${pct(s.me.winRate)}<span class="dim wrlabel">海斗胜率</span></div>`
              : '<div class="dim">暂无该英雄的海斗统计</div>'
          }
        </div>`
      : '<div class="li dim">选出英雄后显示其海斗胜率</div>';

    app.innerHTML = panel(
      phaseLabel,
      isBrawlTag,
      `
        <div class="row"><span class="k">队列</span><span class="v">${esc(String(s.queueId ?? '—'))}</span></div>
        <div class="sep"></div>
        <div class="k">我方已选</div>
        <div class="chips">${picks}</div>
        <div class="sep"></div>
        ${meBlock}
      `,
      `${s.isBrawl ? '<span class="ok">✓ 已识别为海克斯乱斗</span>' : ''}${sourceFoot(s.meta)}`,
    );
    return;
  }

  /* ---------------- 对局中：海克斯强度 + 出装 ---------------- */
  if (s.phase === 'InProgress') {
    const noData = s.me.championId === 0;
    const augBlock = noData
      ? '<div class="li dim">· 未识别到你的英雄</div>'
      : s.augments.length === 0
        ? '<div class="li dim">· 该英雄暂无海克斯强度统计</div>'
        : s.augments.map((a) => augRowHtml(a)).join('');

    const b = s.build;
    const buildBlock = noData
      ? ''
      : [
          slotHtml('出门装', b.start, true),
          slotHtml('鞋子', b.shoes, true),
          slotHtml('核心装备', b.core),
          slotHtml('成型六件套', b.full),
        ]
          .filter(Boolean)
          .join('') || '<div class="li dim">· 该英雄暂无出装统计</div>';

    const header = s.me.name ? `${s.me.name} · 建议` : '对局中';

    app.innerHTML = panel(
      phaseLabel,
      isBrawlTag,
      `
        ${
          s.me.championId > 0
            ? `<div class="row"><span class="k">英雄</span><span class="v">${esc(s.me.name)}</span></div>
               <div class="sep"></div>`
            : ''
        }
        <div class="k">海克斯强度 <span class="dim">（以该英雄为准）</span></div>
        ${augBlock}
        <div class="sep"></div>
        <div class="k">出装建议</div>
        ${buildBlock}
        <div class="sep"></div>
        <div class="li dim note">
          依据官方统计排序，供参考。不识别你当前被提供的 3 个海克斯，
          也不替你做选择。
        </div>
      `,
      sourceFoot(s.meta),
    );
    return;
  }

  /* ---------------- 其它阶段 ---------------- */
  app.innerHTML = panel(
    phaseLabel,
    phaseLabel,
    `<div class="dim">${esc(phaseLabel)}。</div>`,
    '进入选人阶段后自动显示。',
  );
}

function renderError(msg: string): void {
  app.innerHTML = `
    <div class="panel">
      <div class="hd"><span class="dot off"></span> hexbox</div>
      <div class="body dim">${esc(msg)}</div>
    </div>`;
}

// 穿透开关（仅此小按钮可点；其余区域穿透）
const pin = document.createElement('div');
pin.className = 'pin';
pin.title = '切换鼠标穿透';
let clickThrough = true;
pin.textContent = '穿透:开';
pin.addEventListener('click', () => {
  void overlay.setClickThrough(!clickThrough).then((v) => {
    clickThrough = v;
    pin.textContent = v ? '穿透:开' : '穿透:关';
  });
});
document.body.appendChild(pin);

overlay.onState((s) => {
  render(s);
  clickThrough = s.clickThrough;
  pin.textContent = s.clickThrough ? '穿透:开' : '穿透:关';
});
overlay.onClickThrough((on) => {
  clickThrough = on;
  pin.textContent = on ? '穿透:开' : '穿透:关';
});

window.addEventListener('error', (e) => renderError(`渲染错误: ${e.message}`));

renderError('正在连接…');
