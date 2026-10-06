/**
 * 诊断脚本：该英雄的强度表（`augment_json_irank`）上游到底给多少行。
 *
 * 用法：
 *   node --experimental-strip-types scripts/diag-augment-coverage.mts [championId ...]
 *
 * 只做真实请求 + 真实字段名解析，不猜。
 *
 * 结论（2026-10-05 实测）：`255`（全部品质）组的**原始块数 == 解析条数**，
 * 且 `255` 组条数 == 三个品质分组条数之和 → 上游给的就是该英雄的完整池，
 * 只是该池本身小于图鉴全量（248）。
 */

import { readFileSync } from 'node:fs';

import { parseChampionAugments } from '../packages/provider-tencent/src/index.ts';

const HERO_DETAIL_URL = 'https://mlol.qt.qq.com/go/battle_info/odp_proxy/fuwen_hero_rank';

interface FieldValues {
  data?: { _fieldValues?: Record<string, string> };
}

/** 与 provider 完全相同：取 _fieldValues 里最长的一个值。 */
function extractFieldValue(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const values = (payload as FieldValues).data?._fieldValues;
  if (typeof values !== 'object' || values === null) return null;
  let best: string | null = null;
  for (const v of Object.values(values)) {
    if (typeof v === 'string' && v.length > 0 && (best === null || v.length > best.length)) {
      best = v;
    }
  }
  return best;
}

function unwrapValue(fieldValue: string): unknown {
  const trimmed = fieldValue.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      /* fallthrough */
    }
  }
  return fieldValue;
}

async function fetchDetail(championId: number): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${HERO_DETAIL_URL}?championid=${championId}`, {
    headers: { 'user-agent': 'hexbox-diag/0.1' },
  });
  if (!res.ok) {
    console.log(`  HTTP ${res.status}`);
    return null;
  }
  const fv = extractFieldValue(await res.json());
  if (!fv) return null;
  const v = unwrapValue(fv);
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function dataset(): {
  names: Map<number, string>;
  rarity: Map<number, string>;
  champions: Map<number, string>;
  hextechs: number;
} {
  const raw = JSON.parse(readFileSync('data/dataset.json', 'utf8')) as {
    hextechs?: { id: number; name: string; rarity: string }[];
    champions?: { id: number; name: string }[];
  };
  return {
    names: new Map((raw.hextechs ?? []).map((h) => [h.id, h.name])),
    rarity: new Map((raw.hextechs ?? []).map((h) => [h.id, h.rarity])),
    champions: new Map((raw.champions ?? []).map((c) => [c.id, c.name])),
    hextechs: (raw.hextechs ?? []).length,
  };
}

/** 逐组解析成 id 列表（**不做任何过滤**，只要求至少 6 列）。 */
function groupIds(raw: string): { name: string; ids: number[] }[] {
  const out: { name: string; ids: number[] }[] = [];
  for (const seg of raw.split('&')) {
    let name = '(无组头)';
    let ids: number[] = [];
    for (const block of seg.split('#')) {
      if (!block) continue;
      const f = block.split('|');
      const colon = (f[0] ?? '').indexOf(':');
      if (colon >= 0) name = (f[0] ?? '').slice(0, colon);
      if (f.length < 6) continue;
      ids.push(Number(f[2]));
    }
    out.push({ name, ids });
  }
  return out;
}

/**
 * 统计原始串里每个分组的**全部非空块**（不做字段数过滤、不去重）。
 *
 * ⚠️ 这里刻意**不**复用 parse 的 `f.length < 6` 过滤 —— 否则「原始行数」
 * 与「解析条数」会同样被过滤，等于没验证解析是否丢行。
 */
function rawBlockStats(raw: string): {
  groups: { name: string; blocks: number; tooShort: number }[];
  totalBlocks: number;
} {
  const groups: { name: string; blocks: number; tooShort: number }[] = [];
  let totalBlocks = 0;
  for (const seg of raw.split('&')) {
    let name = '(无组头)';
    let blocks = 0;
    let tooShort = 0;
    for (const block of seg.split('#')) {
      if (!block) continue;
      const f = block.split('|');
      const colon = (f[0] ?? '').indexOf(':');
      if (colon >= 0) name = (f[0] ?? '').slice(0, colon);
      blocks++;
      totalBlocks++;
      if (f.length < 6) tooShort++;
    }
    groups.push({ name, blocks, tooShort });
  }
  return { groups, totalBlocks };
}

const ids = process.argv.slice(2).map((x) => Number.parseInt(x, 10)).filter((x) => x > 0);
const champions = ids.length > 0 ? ids : [154, 43, 157, 64, 99, 11, 145, 222];
const ds = dataset();

console.log(`图鉴 dataset.hextechs = ${ds.hextechs} 颗；英雄 = ${ds.champions.size} 个`);
console.log('已知 id 对照（用名字验证 id 空间，不只对 id）：');
for (const [id, expect] of [
  [1356, '暴击飞弹'],
  [1112, '终极不可阻挡'],
  [1353, '坦克引擎'],
] as const) {
  console.log(`  ${id} 期望「${expect}」→ 实际「${ds.names.get(id) ?? '(不在图鉴)'}」`);
}

let sumRatio = 0;
let n = 0;
for (const cid of champions) {
  console.log(`\n===== championId=${cid} (${ds.champions.get(cid) ?? '?'}) =====`);
  const detail = await fetchDetail(cid);
  if (!detail) {
    console.log('  无数据');
    continue;
  }
  const raw = detail['augment_json_irank'];
  if (typeof raw !== 'string' || raw.length === 0) {
    console.log('  augment_json_irank 缺失/为空');
    continue;
  }
  const stats = rawBlockStats(raw);
  const parsed = parseChampionAugments(raw);
  const parsedAll = parseChampionAugments(raw, 'all-groups');
  const all = stats.groups.find((g) => g.name === '255');
  const subSum = stats.groups
    .filter((g) => g.name !== '255')
    .reduce((s, g) => s + g.blocks, 0);
  const tooShort = stats.groups.reduce((s, g) => s + g.tooShort, 0);

  console.log(`  原始串长度 = ${raw.length}`);
  console.log(
    `  原始分组（全部非空块，未过滤）: ${stats.groups.map((g) => `${g.name}=${g.blocks}`).join('  ')}`,
  );
  console.log(`  255 组原始块数 = ${all?.blocks ?? 0}；解析(默认 255) = ${parsed.length}`);
  console.log(`  三个品质分组块数之和 = ${subSum}（与 255 组相等 → 无截断/无重复）`);
  console.log(`  字段不足 6 列被解析器丢弃的块 = ${tooShort}`);
  console.log(`  解析(all-groups) = ${parsedAll.length}`);
  console.log(
    `  覆盖率 = ${parsed.length} / ${ds.hextechs} = ${((parsed.length / ds.hextechs) * 100).toFixed(1)}%`,
  );
  const unknown = parsed.filter((p) => !ds.names.has(p.augmentId)).map((p) => p.augmentId);
  console.log(`  不在图鉴的 id: ${unknown.length ? unknown.join(',') : '无'}`);
  console.log(
    `  前 3 条: ${parsed
      .slice(0, 3)
      .map((p) => `${p.rank}|${p.augmentId}(${ds.names.get(p.augmentId) ?? '?'})|${p.level}|${p.tier}`)
      .join('  ')}`,
  );
  if (all && all.blocks !== parsed.length) {
    console.log('  ⚠️⚠️ 原始块数 != 解析条数 → 解析 bug！');
  }

  // 集合级校验：255 组 == 三个品质组的并集，且每颗的组名与图鉴稀有度一致
  const gids = groupIds(raw);
  const g255 = new Set(gids.find((g) => g.name === '255')?.ids ?? []);
  const union = new Set<number>();
  const rarityOk = { ok: 0, bad: [] as string[] };
  for (const g of gids) {
    if (g.name === '255') continue;
    for (const id of g.ids) {
      union.add(id);
      const codexRarity = ds.rarity.get(id);
      if (codexRarity === undefined) continue;
      if (codexRarity === g.name) rarityOk.ok++;
      else rarityOk.bad.push(`${id}(${g.name}→图鉴${codexRarity})`);
    }
  }
  const sameSet = g255.size === union.size && [...union].every((id) => g255.has(id));
  console.log(
    `  集合校验：255 组集(${g255.size}) == 品质组并集(${union.size})? ${sameSet ? '是' : '否 ⚠️'}`,
  );
  console.log(
    `  稀有度一致性：组名与图鉴 rarity 相符 ${rarityOk.ok} 条，不符 ${rarityOk.bad.length} 条` +
      (rarityOk.bad.length > 0 ? ` → ${rarityOk.bad.slice(0, 5).join(' ')}` : ''),
  );
  sumRatio += parsed.length / ds.hextechs;
  n++;
}

if (n > 0) {
  console.log(`\n=== ${n} 个英雄平均覆盖率 = ${((sumRatio / n) * 100).toFixed(1)}% ===`);
}
