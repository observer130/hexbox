/**
 * 悬浮窗渲染端（纯浏览器环境）
 *
 * 不 import 任何 Node 依赖 —— LCU 轮询、数据集读取都在主进程，
 * 这里只接收 `overlay:state` 推送并渲染。
 *
 * 合规边界由主进程保证（见 packages/core/src/compliance.ts）：
 * 只显示静态图鉴与选人阶段可见信息，不显示胜率，不识别局内三选一。
 */

interface OverlayStateMsg {
  connected: boolean;
  phase: string;
  gameMode: string;
  queueId: number | null;
  isBrawl: boolean;
  augCount: number;
  picks: Array<{ championId: number; name: string }>;
  clickThrough: boolean;
  policyReason: string;
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

function panel(header: string, tag: string, body: string, foot: string): string {
  return `
    <div class="panel">
      <div class="hd"><span class="dot${tag === '离线' ? ' off' : ''}"></span> hexbox
        <span class="tag">${esc(header)}</span></div>
      <div class="body">${body}</div>
      <div class="foot dim">${foot}</div>
    </div>`;
}

function render(s: OverlayStateMsg): void {
  if (!s.connected) {
    app.innerHTML = panel('离线', '离线', '<div class="dim">未检测到英雄联盟客户端。</div>',
      '请先启动客户端；本工具需管理员权限读取 LCU 凭证。');
    return;
  }

  const phaseLabel = PHASE_LABEL[s.phase] ?? s.phase;

  if (s.phase === 'ChampSelect') {
    const picks = s.picks.length
      ? s.picks.map((p) => `<div class="li">· ${esc(p.name)}</div>`).join('')
      : '<div class="li dim">· （尚无已选英雄）</div>';
    app.innerHTML = panel(
      phaseLabel,
      s.isBrawl ? '海克斯乱斗' : s.gameMode,
      `
        <div class="row"><span class="k">模式</span><span class="v">${esc(s.gameMode)}</span></div>
        <div class="row"><span class="k">队列</span><span class="v">${esc(String(s.queueId ?? '—'))}</span></div>
        <div class="row"><span class="k">海克斯</span><span class="v">${s.augCount} 条静态图鉴</span></div>
        <div class="sep"></div>
        <div class="k">我方已选：</div>
        ${picks}
      `,
      s.isBrawl ? '<span class="ok">✓ 已识别为海克斯乱斗</span>' : '进入对局后可查阅完整海克斯池',
    );
    return;
  }

  if (s.phase === 'InProgress') {
    app.innerHTML = panel(
      phaseLabel,
      s.isBrawl ? '海克斯乱斗' : s.gameMode,
      `
        <div class="notice">
          <strong>静态海克斯图鉴</strong>（${s.augCount} 条）随工具提供，可自行查阅。
        </div>
        <div class="li dim">· 不识别你当前被提供的 3 个海克斯</div>
        <div class="li dim">· 不显示胜率 / 选取率</div>
        <div class="li dim">· 不替你做选择</div>
      `,
      s.policyReason
        ? `政策原因：${esc(s.policyReason.slice(0, 72))}…`
        : '',
    );
    return;
  }

  app.innerHTML = panel(phaseLabel, phaseLabel, `<div class="dim">${esc(phaseLabel)}。</div>`,
    '进入选人阶段后自动显示。');
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
