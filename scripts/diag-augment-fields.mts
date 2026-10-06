/**
 * 诊断脚本 2：上游英雄详情里**未被使用**的字段（尤其 `augment_json`）、
 * 以及强度表的分页/参数行为。
 *
 *   node --experimental-strip-types scripts/diag-augment-fields.mts [championId]
 */

const HERO_DETAIL_URL = 'https://mlol.qt.qq.com/go/battle_info/odp_proxy/fuwen_hero_rank';

interface FieldValues {
  data?: { _fieldValues?: Record<string, string> };
}

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
  const t = fieldValue.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return JSON.parse(t) as unknown;
    } catch {
      /* fallthrough */
    }
  }
  return fieldValue;
}

async function get(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { 'user-agent': 'hexbox-diag/0.1' } });
  return res.json();
}

const cid = Number.parseInt(process.argv[2] ?? '154', 10);

console.log('--- 顶层 _fieldValues 的 key 与长度 ---');
const payload = (await get(`${HERO_DETAIL_URL}?championid=${cid}`)) as FieldValues;
for (const [k, v] of Object.entries(payload.data?._fieldValues ?? {})) {
  console.log(`  ${k}: len=${v.length}`);
}

const fv = extractFieldValue(payload);
const detail = unwrapValue(fv) as Record<string, unknown>;
console.log('\n--- 详情顶层字段 ---');
for (const [k, v] of Object.entries(detail)) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  console.log(`  ${k}: len=${s.length}`);
}

console.log('\n--- augment_json（未被使用！）---');
const aj = detail['augment_json'];
if (typeof aj === 'string') {
  console.log(`  长度 ${aj.length}`);
  console.log(`  前 600 字符：${aj.slice(0, 600)}`);
  const parsedAj = unwrapValue(aj);
  if (typeof parsedAj === 'object' && parsedAj !== null) {
    console.log(`  是对象，keys=${Object.keys(parsedAj).length}，前 3 键=${Object.keys(parsedAj).slice(0, 3).join(',')}`);
    console.log(`  样例：${JSON.stringify(Object.entries(parsedAj as Record<string, unknown>).slice(0, 3))}`);
    // 统计所有出现过的海克斯 id
    const ids = new Set<number>();
    for (const v of Object.values(parsedAj as Record<string, unknown>)) {
      if (typeof v !== 'object' || v === null) continue;
      for (const val of Object.values(v as Record<string, unknown>)) {
        if (typeof val === 'number' && val > 1000) ids.add(val);
        if (typeof val === 'string') for (const m of val.matchAll(/\d+/g)) ids.add(Number(m[0]));
      }
    }
    console.log(`  猜出的数字集合大小=${ids.size}`);
  } else {
    console.log(`  不是 JSON 对象：${String(parsedAj).slice(0, 200)}`);
  }
} else {
  console.log(`  不存在/非字符串: ${String(aj)}`);
}

// 强度表 id 与 augment_json 的 id 交集
const irank = detail['augment_json_irank'];
if (typeof irank === 'string') {
  const irankIds = new Set<number>();
  for (const seg of irank.split('&')) {
    for (const b of seg.split('#')) {
      const f = b.split('|');
      if (f.length >= 6) irankIds.add(Number(f[2]));
    }
  }
  console.log(`\n  augment_json_irank 全部 id 数（含分组去重前）= ${irankIds.size}`);
}

/* ---------- 参数与分页行为 ---------- */
console.log('\n--- 不同参数下 augment_json_irank 的 255 组条数 ---');
const variants = [
  `championid=${cid}`,
  `championid=${cid}&augmentid_level=255`,
  `championid=${cid}&page=1&pagesize=500`,
  `championid=${cid}&pageno=1&pagesize=500`,
  `championid=${cid}&dtstatdate=`,
];
for (const q of variants) {
  try {
    const p = (await get(`${HERO_DETAIL_URL}?${q}`)) as FieldValues;
    const d = unwrapValue(extractFieldValue(p) ?? '') as Record<string, unknown>;
    const s = d['augment_json_irank'];
    let n = 0;
    if (typeof s === 'string') {
      const seg0 = s.split('&')[0] ?? '';
      for (const b of seg0.split('#')) if (b.split('|').length >= 6) n++;
    }
    console.log(`  ${q} → 255 组 ${n} 条 (存在=${typeof s === 'string'})`);
  } catch (e) {
    console.log(`  ${q} → 失败 ${String(e)}`);
  }
}
