/**
 * 悬浮窗渲染端（纯浏览器环境）
 *
 * 不 import 任何 Node 依赖 —— LCU 轮询、数据集读取、排行榜 join 都在主进程，
 * 这里只接收 `overlay:state` 推送并渲染。
 *
 * 数据出处由主进程随状态一并推送，渲染端只负责展示并标注来源。
 */

interface BoardRow {
  name: string;
  icon: string;
  winRate: number;
  pickRate: number;
  winRankChange: number;
  bestHeroes: string[];
  hasDef: boolean;
}

interface BoardGroup {
  rarity: string;
  label: string;
  rows: BoardRow[];
}

interface OverlayStateMsg {
  connected: boolean;
  phase: string;
  gameMode: string;
  queueId: number | null;
  isBrawl: boolean;
  augCount: number;
  picks: Array<{ championId: number; name: string }>;
  clickThrough: boolean;
  board: BoardGroup[];
  rankMeta: { available: boolean; dataDate: string; stale: boolean };
  advice: { championName: string; rows: BoardRow[] };
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

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/** 排名变化徽标：↑3 / ↓2 / —。 */
function changeHtml(n: number): string {
  if (n > 0) return `<span class="chg up">↑${n}</span>`;
  if (n < 0) return `<span class="chg down">↓${-n}</span>`;
  return '';
}

/** 一行海克斯：图标 + 名称 + 胜率 + 适配英雄。 */
function rowHtml(r: BoardRow): string {
  const icon = r.icon
    ? `<img class="ico" src="${esc(r.icon)}" alt="" loading="lazy" />`
    : `<div class="ico ph"></div>`;
  const heroes = r.bestHeroes.length
    ? `<div class="heroes dim">适合 ${r.bestHeroes.map((h) => esc(h)).join(' / ')}</div>`
    : '';
  const warn = r.hasDef ? '' : '<span class="warn" title="图鉴中暂无此海克斯">?</span>';
  return `
    <div class="aug">
      ${icon}
      <div class="augmain">
        <div class="augname">${esc(r.name)}${warn}</div>
        ${heroes}
      </div>
      <div class="augstat">
        <div class="wr">${pct(r.winRate)}${changeHtml(r.winRankChange)}</div>
        <div class="pr dim">选取 ${pct(r.pickRate)}</div>
      </div>
    </div>`;
}

/** 强度榜：按稀有度分组，每组一个小标题。 */
function boardHtml(groups: BoardGroup[]): string {
  return groups
    .map((g) => {
      const color = RARITY_COLOR[g.rarity] ?? '#9fb0c9';
      const rows = g.rows.map((r) => rowHtml(r)).join('');
      return `
        <div class="grp">
          <div class="grphd" style="color:${color}">
            <span class="bullet" style="background:${color}"></span>${esc(g.label)}
          </div>
          ${rows}
        </div>`;
    })
    .join('');
}

/** 数据出处脚注（来源 + 统计日期 + 过期提示）。 */
function sourceFoot(meta: OverlayStateMsg['rankMeta']): string {
  if (!meta.available) {
    return '<span class="dim">暂无排行数据（请运行 pnpm sync）</span>';
  }
  const date = meta.dataDate
    ? `${meta.dataDate.slice(0, 4)}-${meta.dataDate.slice(4, 6)}-${meta.dataDate.slice(6, 8)}`
    : '未知';
  const stale = meta.stale ? ' <span class="warn">⚠ 数据可能已过期</span>' : '';
  return `<span class="dim">海克斯胜率 · 101.qq.com 官方统计 · ${date}</span>${stale}`;
}

function panel(header: string, tag: string, body: string, foot: string): string {
  return `
    <div class="panel">
      <div class="hd"><span class="dot${tag === '离线' ? ' off' : ''}"></span> hexbox
        <span class="tag">${esc(header)}</span></div>
      <div class="body">${body}</div>
      ${foot ? `<div class="foot">${foot}</div>` : ''}
    </div>`;
}

/** 离线诊断面板（连不上 LCU 时显示，避免"什么都没有"的困惑）。 */
function offlinePanel(): string {
  return panel(
    '未连接',
    '未连接',
    `
      <div class="notice">读不到 LCU 凭证，无法获取对局状态。</div>
      <div class="li dim">· 客户端未启动，或</div>
      <div class="li dim">· 本工具未以<b>管理员身份</b>运行</div>
      <div class="sep"></div>
      <div class="k">令牌来源（二选一）：</div>
      <div class="li dim">· 进程命令行 —— 需管理员权限</div>
      <div class="li dim">· 安装目录 lockfile</div>
    `,
    '请关闭本窗口，右键以「管理员身份运行」重新启动。',
  );
}

function render(s: OverlayStateMsg): void {
  if (!s.connected) {
    app.innerHTML = offlinePanel();
    return;
  }

  const phaseLabel = PHASE_LABEL[s.phase] ?? s.phase;
  const isBrawlTag = s.isBrawl ? '海克斯乱斗' : s.gameMode;
  const noBoard = !s.rankMeta.available;

  /* ---------------- 选人阶段 ---------------- */
  if (s.phase === 'ChampSelect') {
    const picks = s.picks.length
      ? s.picks.map((p) => `<span class="chip">${esc(p.name)}</span>`).join('')
      : '<span class="dim">（尚无已选英雄）</span>';

    // 我方英雄的针对性推荐
    let adviceBlock = '';
    if (s.advice.championName && s.advice.rows.length > 0) {
      adviceBlock = `
        <div class="grphd" style="color:#c8a84e">
          <span class="bullet" style="background:#c8a84e"></span>
          ${esc(s.advice.championName)} 的高胜率海克斯
        </div>
        ${s.advice.rows.map((r) => rowHtml(r)).join('')}`;
    } else if (s.advice.championName) {
      adviceBlock =
        '<div class="li dim">· 该英雄暂无官方适配统计</div>';
    } else {
      adviceBlock =
        '<div class="li dim">· 选出英雄后显示其高胜率海克斯</div>';
    }

    const boardBlock = noBoard
      ? '<div class="li dim">· 无排行数据，仅有静态图鉴</div>'
      : boardHtml(s.board);

    app.innerHTML = panel(
      phaseLabel,
      isBrawlTag,
      `
        <div class="row"><span class="k">队列</span><span class="v">${esc(String(s.queueId ?? '—'))}</span></div>
        <div class="sep"></div>
        <div class="k">我方已选</div>
        <div class="chips">${picks}</div>
        <div class="sep"></div>
        ${adviceBlock}
        <div class="sep"></div>
        <div class="k">全局强度榜</div>
        ${boardBlock}
      `,
      // 注意：不能把 brawl 徽标与来源脚注做成二选一 ——
      // 选人阶段正是展示"推荐"的地方，恰恰最需要标注数据出处与统计日期。
      `${s.isBrawl ? '<span class="ok">✓ 已识别为海克斯乱斗</span>' : ''}${sourceFoot(s.rankMeta)}`,
    );
    return;
  }
  /* ---------------- 对局中 ---------------- */
  if (s.phase === 'InProgress') {
    const boardBlock = noBoard
      ? '<div class="li dim">· 无排行数据，请运行 pnpm sync</div>'
      : boardHtml(s.board);

    app.innerHTML = panel(
      phaseLabel,
      isBrawlTag,
      `
        <div class="k">海克斯强度榜</div>
        ${boardBlock}
        <div class="sep"></div>
        <div class="li dim note">
          依据官方统计排序，供参考。不识别你当前被提供的 3 个海克斯，
          也不替你做选择。
        </div>
      `,
      sourceFoot(s.rankMeta),
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
