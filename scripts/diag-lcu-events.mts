/**
 * 诊断：**实地**验证 LCU 事件订阅（`packages/lcu/src/events.ts`）
 *
 * 为什么需要：单测能证明"帧编解码 + 退避重连"的逻辑，但证明不了三件事 ——
 *   ① LCU 认不认我们用 `https.request` 拼的 **Upgrade** 握手（含自签证书）；
 *   ② 订阅命令 `[5,"OnJsonApiEvent_..."]` 是不是真的能收到事件；
 *   ③ 真实 LCU 推来的帧我们的解析器读不读得懂（会不会一直"等更多字节"）。
 * 这三件事只有真机（客户端在跑）能证明，所以留一个可重复运行的诊断脚本。
 *
 * 用法（**不需要管理员**；只用本机 LCU 与 lockfile）：
 *   node --experimental-strip-types scripts/diag-lcu-events.mts
 *   node --experimental-strip-types scripts/diag-lcu-events.mts --seconds 30
 *   node --experimental-strip-types scripts/diag-lcu-events.mts --all      # 额外订阅全部事件
 *
 * 判读：
 *   · 打印 `✔ 已连接并订阅` → 握手 + 证书 + 掩码订阅帧三件事都通了；
 *   · 打印 `⚡ 事件` 行 → 解析器读懂了真实帧（**去游戏里点一下大厅/匹配**，
 *     相位一变化就会立刻出现，这正是它比 2 秒轮询快的地方）；
 *   · 只连上、迟迟没有事件行 → 正常（相位没变时 LCU 不推相位事件）。
 */

import { LcuEventStream, detectCredentialsDetailed } from '../packages/lcu/src/index.ts';

function argNum(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const seconds = argNum('--seconds', 20);
const wantAll = process.argv.includes('--all');

const detected = await detectCredentialsDetailed().catch((e: unknown) => ({
  credentials: null,
  detail: `探测抛错：${e instanceof Error ? e.message : String(e)}`,
}));

if (!detected.credentials) {
  console.error(`✗ 读不到 LCU 凭证：${detected.detail}`);
  console.error('  （客户端没启动？或需要以管理员身份运行才能读进程命令行）');
  process.exit(2);
}

const creds = detected.credentials;
console.log(`LCU 凭证来源：${creds.source}，端口 ${creds.port}`);

const auth = `Basic ${Buffer.from(`riot:${creds.password}`).toString('base64')}`;
const restPhase = await fetch(`https://127.0.0.1:${creds.port}/lol-gameflow/v1/gameflow-phase`, {
  headers: { Authorization: auth },
  // @ts-expect-error Node 侧 TLS 选项不在 DOM 类型里；脚本是本地诊断，按需放宽
  rejectUnauthorized: false,
})
  .then((r) => (r.ok ? r.text() : `HTTP ${r.status}`))
  .catch((e: unknown) => `读不到（${e instanceof Error ? e.message : String(e)}）`);
console.log(`（对照）REST 当前相位：${restPhase}`);

let phaseEvents = 0;
const stream = new LcuEventStream({
  creds,
  onPhase: (p, detail) => {
    phaseEvents++;
    console.log(`⚡ 相位事件 #${phaseEvents}：${p}（${detail}）`);
  },
  onStatus: (status, detail) => {
    if (status === 'connected') console.log(`✔ 已连接并订阅：${detail}`);
    else if (status !== 'connecting') console.log(`… ${status}：${detail}`);
  },
});
stream.start();

/**
 * 再挂一条"**全部**事件"的订阅。
 *
 * 为什么需要它：相位没变化时 LCU **不会**推相位事件，于是"没收到事件"这件事
 * 既可能是"相位没变"（正常），也可能是"我们的帧解析器根本没读懂真实帧"（故障）。
 * 订阅全部事件后，客户端只要有任何资源变动就会推帧 —— 只要这里打出了 topic，
 * 就证明**握手 + 帧解析**是真的通了。
 */
const seenTopics = new Set<string>();
const allStream: LcuEventStream | null = wantAll
  ? new LcuEventStream({
      creds,
      eventName: 'OnJsonApiEvent',
      onPhase: () => {},
      onEvent: (topic) => {
        if (topic === null) return;
        if (seenTopics.size < 12 && !seenTopics.has(topic)) {
          seenTopics.add(topic);
          console.log(`· 收到事件帧：${topic}`);
        }
      },
    })
  : null;
allStream?.start();

console.log(`监听 ${seconds} 秒…（想看到相位事件：去大厅点一下匹配，或进出选人）`);
await new Promise((r) => setTimeout(r, seconds * 1000));

stream.stop();
allStream?.stop();
console.log(
  `统计：相位事件 ${phaseEvents} 条；` +
    `解出的全部事件 ${stream.totalEvents + (allStream?.totalEvents ?? 0)} 条` +
    (wantAll && seenTopics.size > 0 ? `（${seenTopics.size} 种 topic）` : ''),
);
console.log(
  phaseEvents > 0
    ? '✔ 订阅链路验证通过（相位事件实时到达）'
    : wantAll && seenTopics.size > 0
      ? '✔ 握手与帧解析验证通过（收到了事件帧；相位没变所以没有相位事件，属正常）'
      : '⚠ 本次没有收到任何事件：相位没变 + 客户端空闲时可能如此；' +
        '若刚手动切过相位仍无输出，请把上面日志发回来',
);
process.exit(0);
