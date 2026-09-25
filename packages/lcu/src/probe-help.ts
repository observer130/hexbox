#!/usr/bin/env node
/**
 * 局内探测脚本 —— 必须在**游戏进行中**运行（2999 端口仅此时存在）
 *
 * 用途：回答最后一个未决问题 —— 游戏客户端的**原生 remoting API**
 *      （/Help，tag=builtin）是否暴露 augment/cherry/kiwi 相关能力？
 *
 * 背景：swagger/v3/openapi.json 已确认 liveclientdata 端点**不含** augment 字段，
 *      但其中存在 `/Help` 与 `/Subscribe` 两个原生元操作，
 *      暗示完整 API 表面可能大于 liveclientdata。
 *      详见 docs/lcu-probe-findings.md
 *
 * 用法（在有真实对局时）:
 *   node --experimental-strip-types packages/lcu/src/probe-help.ts
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const BASE = 'https://127.0.0.1:2999';

/** 需要检索的关键词（不区分大小写）。 */
const KEYWORDS = [
  'augment',
  'cherry',
  'kiwi',
  'hextech',
  'brawl',
  'arena',
  'rune',
  'enhance',
] as const;

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(BASE + path, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<unknown>;
}

async function postJson(path: string): Promise<unknown> {
  const res = await fetch(BASE + path, {
    method: 'POST',
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<unknown>;
}

function countHits(text: string): Map<string, number> {
  const lower = text.toLowerCase();
  const out = new Map<string, number>();
  for (const k of KEYWORDS) {
    const re = new RegExp(k.toLowerCase(), 'g');
    out.set(k, (lower.match(re) ?? []).length);
  }
  return out;
}

async function main(): Promise<void> {
  console.log('hexbox · 局内探测（需游戏进行中）\n');

  // 1) 确认在对局中
  try {
    const stats = (await getJson('/liveclientdata/gamestats')) as Record<string, unknown>;
    console.log('[1] 对局状态');
    console.log(`  gameMode : ${String(stats['gameMode'] ?? '—')}`);
    console.log(`  mapName  : ${String(stats['mapName'] ?? '—')}`);
    console.log(`  gameTime : ${String(stats['gameTime'] ?? '—')}`);
    console.log(`  是否 BRAWL: ${String(stats['gameMode'] ?? '').toUpperCase() === 'BRAWL' ? '✓ 是' : '否'}\n`);
  } catch (e) {
    console.log(`[1] ✗ 无法连接 2999：${e instanceof Error ? e.message : String(e)}`);
    console.log('    请确认游戏**正在对局中**（2999 端口仅此时存在）。\n');
    process.exitCode = 1;
    return;
  }

  // 2) swagger 检索（复核 liveclientdata）
  console.log('[2] swagger/v3/openapi.json 关键词检索');
  try {
    const spec = JSON.stringify(await getJson('/swagger/v3/openapi.json'));
    for (const [k, n] of countHits(spec)) {
      console.log(`  ${k.padEnd(10)} ${n > 0 ? `✓ ${n} 次` : '-'}`);
    }
  } catch (e) {
    console.log(`  ✗ ${e instanceof Error ? e.message : String(e)}`);
  }
  console.log();

  // 3) 原生 API 全量检索 —— 这是关键新增项
  console.log('[3] /Help?format=Full —— 原生 remoting API 全量检索');
  try {
    const help = await postJson('/Help?format=Full');
    const text = JSON.stringify(help);
    console.log(`  返回大小: ${(text.length / 1024).toFixed(0)} KB`);

    const rec = help as { functions?: Array<{ name?: string }>; types?: Array<{ name?: string }>; events?: Array<{ name?: string }> };
    const fns = (rec.functions ?? []).map((f) => f.name ?? '');
    const types = (rec.types ?? []).map((t) => t.name ?? '');
    const events = (rec.events ?? []).map((e) => e.name ?? '');
    console.log(`  函数 ${fns.length} / 类型 ${types.length} / 事件 ${events.length}`);

    for (const [k, n] of countHits(text)) {
      console.log(`  ${k.padEnd(10)} ${n > 0 ? `✓ ${n} 次` : '-'}`);
    }

    const matched = [...fns, ...types, ...events].filter((n) =>
      /augment|cherry|kiwi|hextech|brawl|arena/i.test(n),
    );
    if (matched.length > 0) {
      console.log('\n  🔴 命中的标识符（需进一步评估）:');
      for (const m of matched.slice(0, 60)) console.log(`      ${m}`);
    } else {
      console.log('\n  ✅ 未发现任何 augment/cherry/kiwi 相关标识符');
      console.log('     → 局内获取"被提供的 3 个海克斯"确认无合法途径');
    }
  } catch (e) {
    console.log(`  ✗ /Help 失败: ${e instanceof Error ? e.message : String(e)}`);
    console.log('    若 404/405，说明该客户端版本未开放此端点。');
  }

  console.log('\n完成。请将输出贴回会话以便记录结论。');
}

main().catch((e: unknown) => {
  console.error('未捕获错误:', e);
  process.exitCode = 1;
});
