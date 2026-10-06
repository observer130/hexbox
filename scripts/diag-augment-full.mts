/**
 * 诊断脚本 4：上游是否还有**能给到全量**的字段/接口。
 *
 *   node --experimental-strip-types scripts/diag-augment-full.mts
 *
 * 依次核对：
 *   1. 全局海克斯榜 `fuwen_aram_rune_rank_v2?augmentid_level=255` 的条目数
 *      （= 官方站「海克斯榜」那一列，是**跨英雄**的全量口径）；
 *   2. 英雄详情里的 `augment_json`（第 5 列没有 tier）到底是什么；
 *   3. 图鉴 248 颗的模式分布 —— 该英雄池之外的 id 是不是别的模式。
 */

import { readFileSync } from 'node:fs';

const RUNE_RANK_URL = 'https://mlol.qt.qq.com/go/battle_info/odp_proxy/fuwen_aram_rune_rank_v2';
const HERO_DETAIL_URL = 'https://mlol.qt.qq.com/go/battle_info/odp_proxy/fuwen_hero_rank';

interface FieldValues {
  data?: { _fieldValues?: Record<string, string> };
}

function longestFieldValue(payload: unknown): string | null {
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

function unwrap(s: string): unknown {
  const t = s.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return JSON.parse(t) as unknown;
    } catch {
      /* fallthrough */
    }
  }
  return s;
}

/* 1. 全局海克斯榜 */
console.log('--- 1. 全局海克斯榜（跨英雄口径）---');
for (const level of ['255', 'kGold', 'kSilver', 'kPrismatic']) {
  try {
    const res = await fetch(`${RUNE_RANK_URL}?augmentid_level=${level}`, {
      headers: { 'user-agent': 'hexbox-diag/0.1' },
    });
    const fv = longestFieldValue(await res.json());
    const v = unwrap(fv ?? '');
    let list = '';
    if (typeof v === 'object' && v !== null && 'augmentlist' in v) {
      list = String((v as { augmentlist?: unknown }).augmentlist ?? '');
    } else if (typeof v === 'string') {
      list = v;
    }
    const n = list.split('#').filter((b) => b.split('_').length >= 8).length;
    console.log(`  augmentid_level=${level} → ${n} 条`);
  } catch (e) {
    console.log(`  augmentid_level=${level} → 失败 ${String(e)}`);
  }
}

/* 2. 英雄详情的 augment_json */
console.log('\n--- 2. 英雄详情 $augment_json（未使用字段）---');
for (const cid of [154, 11, 43]) {
  const res = await fetch(`${HERO_DETAIL_URL}?championid=${cid}`, {
    headers: { 'user-agent': 'hexbox-diag/0.1' },
  });
  const v = unwrap(longestFieldValue(await res.json()) ?? '');
  const d = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  const aj = typeof d['augment_json'] === 'string' ? d['augment_json'] : '';
  const irank = typeof d['augment_json_irank'] === 'string' ? d['augment_json_irank'] : '';
  const groups: string[] = [];
  for (const seg of aj.split('&')) {
    const f = seg.split('#');
    groups.push(`${(f[0] ?? '').split(':')[0]}=${f.filter(Boolean).length}`);
  }
  const irank255 = (irank.split('&')[0] ?? '').split('#').filter(Boolean).length;
  console.log(
    `  championId=${cid}: augment_json 列数=${(aj.split('#')[0] ?? '').split('|').length} 分组=[${groups.join(' ')}] 共 ${aj.split('#').filter(Boolean).length} 条；irank 255 组=${irank255} 条`,
  );
}

/* 3. 图鉴模式分布 */
console.log('\n--- 3. 图鉴 248 的模式分布 ---');
const ds = JSON.parse(readFileSync('data/dataset.json', 'utf8')) as {
  hextechs: { id: number; name: string; modes: string[] }[];
};
const byMode = new Map<string, number>();
for (const h of ds.hextechs) {
  const key = h.modes.length > 0 ? h.modes.join('+') : '(无模式)';
  byMode.set(key, (byMode.get(key) ?? 0) + 1);
}
for (const [k, v] of [...byMode].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k}: ${v}`);
}

const b = JSON.parse(readFileSync('data/builds.json', 'utf8')) as {
  details: { championId: number; augments: { augmentId: number }[] }[];
};
const seen = new Set<number>();
for (const d of b.details) for (const a of d.augments) seen.add(a.augmentId);
let seenJadeOnly = 0;
for (const h of ds.hextechs) {
  if (!seen.has(h.id)) continue;
  if (h.modes.length === 1 && h.modes[0] === 'KIWI_JADE') seenJadeOnly++;
}
console.log(
  `\n  173 个英雄的强度表共出现 ${seen.size} 个不同 id（占图鉴 ${ds.hextechs.length} = ${((seen.size / ds.hextechs.length) * 100).toFixed(1)}%）`,
);
console.log(`  其中「只属于 KIWI_JADE」的 id = ${seenJadeOnly}`);
