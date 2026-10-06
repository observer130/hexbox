#!/usr/bin/env node
/**
 * 局内状态探针（Live Client Data API · 真实对局中运行）
 *
 * 目的：回答"**局内到底能拿到哪些状态**"，特别是这两条能否拿到 ——
 *   1. 玩家死亡状态（`isDead` / `respawnTimer`）
 *   2. 玩家等级（`level`）
 * 以及复查"海克斯相关字段是否真的一无所有"。
 *
 * 为什么必须真机跑一次：官方文档给了字段清单，但
 *   · 本机只验证过**端点/schema 清单**（真机 swagger 24 端点零命中 augment 关键词）；
 *   · 字段级内容（尤其"海克斯乱斗"这种轮换模式里这些字段是否照常返回）没验证过。
 * 所以按项目惯例：**先查证再做，不要假设**。
 *
 * 用法（需要游戏**正在进行中**；2999 端口只在局内存在）：
 *   node --experimental-strip-types packages/lcu/src/probe-live.ts
 *
 * 产物：debug/live-probe.json（原始 allgamedata + 结论清单）—— debug/ 不入库。
 *
 * 合规：这是游戏客户端**自带的官方本地 REST 接口**（Riot 文档化的 Game Client API），
 * 与 LCU 同类。不读内存、不注入、不解析封包。因此这里用 node:https 直接请求，
 * **不设** `NODE_TLS_REJECT_UNAUTHORIZED` 全局开关（只对本请求关闭校验）——
 * 全局关校验是 AGENTS.md 明确记过的坑。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', '..', '..', 'debug');
const BASE = 'https://127.0.0.1:2999';

/** 只对本请求忽略自签证书（游戏客户端用自签证书）。 */
function getJson(path: string, timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request(
      `${BASE}${path}`,
      { method: 'GET', rejectUnauthorized: false, timeout: timeoutMs },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (e) {
            reject(new Error(`JSON 解析失败：${e instanceof Error ? e.message : String(e)}`));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
    req.end();
  });
}

type Obj = Record<string, unknown>;

function asObj(v: unknown): Obj | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : null;
}

function pick(o: Obj | null, key: string): unknown {
  return o === null ? undefined : o[key];
}

function mark(ok: boolean): string {
  return ok ? '✓' : '✗';
}

/** 海克斯相关关键词复查（大小写不敏感，扫整份 payload）。 */
const KEYWORDS = ['augment', 'cherry', 'kiwi', 'hextech', 'brawl', 'arena', 'rune', 'enhance'] as const;

async function main(): Promise<void> {
  console.log('hexbox · 局内状态探针（Live Client Data API，需游戏进行中）\n');
  mkdirSync(OUT_DIR, { recursive: true });

  // 0) 先确认在对局中
  let stats: Obj | null = null;
  try {
    stats = asObj(await getJson('/liveclientdata/gamestats'));
  } catch (e) {
    console.log(`✗ 连不上 2999：${e instanceof Error ? e.message : String(e)}`);
    console.log('  请确认游戏**正在对局中**（2999 只在局内存在），并且没有被防火墙拦。');
    process.exitCode = 1;
    return;
  }
  console.log('[0] 对局元信息 /liveclientdata/gamestats');
  for (const k of ['gameMode', 'gameTime', 'mapName', 'mapNumber', 'mapTerrain']) {
    console.log(`    ${k.padEnd(12)} ${String(pick(stats, k) ?? '—')}`);
  }
  console.log();

  // 1) 全量
  let all: Obj | null = null;
  try {
    all = asObj(await getJson('/liveclientdata/allgamedata', 8000));
  } catch (e) {
    console.log(`✗ /allgamedata 失败：${e instanceof Error ? e.message : String(e)}`);
  }

  const active = asObj(pick(all, 'activePlayer'));
  const players = Array.isArray(pick(all, 'allPlayers')) ? (pick(all, 'allPlayers') as unknown[]) : [];
  const events = asObj(pick(all, 'events'));
  const eventList = Array.isArray(pick(events, 'Events')) ? (pick(events, 'Events') as unknown[]) : [];
  const gameData = asObj(pick(all, 'gameData'));

  // 2) 我们最关心的三条：等级 / 死亡 / 复活倒计时
  const activeLevel = pick(active, 'level');
  const meName = String(pick(active, 'riotId') ?? pick(active, 'summonerName') ?? '');
  const playerObjs = players.map(asObj).filter((p): p is Obj => p !== null);
  const me: Obj | null =
    playerObjs.find((p) => {
      const n = String(pick(p, 'riotId') ?? pick(p, 'summonerName') ?? '');
      return meName !== '' && n === meName;
    }) ?? null;
  const meLevel = pick(me, 'level') ?? activeLevel;
  const isDead = pick(me, 'isDead');
  const respawn = pick(me, 'respawnTimer');

  console.log('[1] 关键问题：等级 / 死亡 / 复活倒计时');
  console.log(`    ${mark(typeof activeLevel === 'number')} 我的等级           activePlayer.level        = ${String(activeLevel ?? '—')}`);
  console.log(`    ${mark(typeof meLevel === 'number')} 我的等级（玩家列表）  allPlayers[我].level       = ${String(meLevel ?? '—')}`);
  console.log(`    ${mark(typeof isDead === 'boolean')} 我的死亡状态         allPlayers[我].isDead      = ${String(isDead ?? '—')}`);
  console.log(`    ${mark(typeof respawn === 'number')} 我的复活倒计时       allPlayers[我].respawnTimer = ${String(respawn ?? '—')}`);
  console.log(`    （识别到我是：${meName || '未匹配到 —— 请看下面 warning'}）`);
  if (!me && players.length > 0) {
    console.log('    ⚠ 没在 allPlayers 里匹配到自己：riotId/summonerName 口径可能不同，请把 payload 发回。');
  }
  console.log();

  // 3) 全量清单：还有什么能用
  console.log('[2] 可用状态清单（官方文档字段）');
  const champStats = asObj(pick(active, 'championStats'));
  console.log(`    ${mark(champStats !== null)} championStats（当前/最大生命、护甲、移速、技能急速…）字段数 ${champStats ? Object.keys(champStats).length : 0}`);
  console.log(`    ${mark(pick(active, 'currentGold') !== undefined)} currentGold = ${String(pick(active, 'currentGold') ?? '—')}`);
  console.log(`    ${mark(players.length > 0)} allPlayers（每人：championName/level/isDead/respawnTimer/items/scores/summonerSpells/team）共 ${players.length} 人`);
  console.log(`    ${mark(eventList.length > 0)} events 已发生 ${eventList.length} 条；最近 8 条：`);
  for (const e of eventList.slice(-8)) {
    const o = asObj(e);
    console.log(`        ${String(pick(o, 'EventName') ?? '?')} @${String(pick(o, 'EventTime') ?? '?')}`);
  }
  const firstPlayer = playerObjs[0] ?? null;
  if (firstPlayer) {
    console.log(`    单个玩家条目的字段：${Object.keys(firstPlayer).join(', ')}`);
  }
  if (gameData) {
    console.log(`    gameData 字段：${Object.keys(gameData).join(', ')}`);
  }
  console.log();

  // 4) 海克斯关键词复查（整份 payload）
  console.log('[3] 海克斯相关关键词复查（整份 allgamedata）');
  const flat = JSON.stringify(all ?? {}).toLowerCase();
  for (const k of KEYWORDS) {
    const n = (flat.match(new RegExp(k, 'g')) ?? []).length;
    console.log(`    ${k.padEnd(10)} ${n > 0 ? `✓ ${n} 次` : '-'}`);
  }
  console.log('    （若 augment 为 0：三选一的**内容**确实只能截屏读，API 只给前提条件）');
  console.log();

  // 5) 落盘
  const outPath = join(OUT_DIR, 'live-probe.json');
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        probedAt: new Date().toISOString(),
        gamestats: stats,
        checklist: {
          activeLevelPresent: typeof activeLevel === 'number',
          playerLevelPresent: typeof meLevel === 'number',
          isDeadPresent: typeof isDead === 'boolean',
          respawnTimerPresent: typeof respawn === 'number',
          playerCount: players.length,
          eventCount: eventList.length,
          me: me ?? null,
        },
        allgamedata: all,
      },
      null,
      2,
    ),
  );
  console.log(`原始 payload 与清单已写入：${outPath}`);
  console.log('请把这个文件（或其中 [1] 段）发回 —— 据此决定是否用 API 触发升频。');
}

main().catch((e: unknown) => {
  console.error('未捕获错误:', e);
  process.exitCode = 1;
});
