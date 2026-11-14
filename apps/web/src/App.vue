<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { countChampionSet, type AugmentMode } from '@hexbox/core';
import { useDataset } from './useDataset';
import { modeLabel } from './format';
import { buildAugmentCatalog, type CatalogTile } from './augment-catalog';
import { RARITY_META, rarityMeta } from './rarity';
import RankView from './components/RankView.vue';

const { dataset, rankings, loading, error, rankingsError, load } = useDataset();
onMounted(load);

const search = ref('');
const modeFilter = ref<string>('KIWI');
const rarityFilter = ref<string>('all');
const sortBy = ref<'name' | 'rarity'>('rarity');

// 图鉴主体：**国服口径优先**，CDragon 只补全国服未收录的条目。
// 同名两源品质冲突时以国服为准（如 ChainReaction / Quest_UrfsChampion），
// 合并规则与理由见 augment-catalog.ts。
const catalog = computed<readonly CatalogTile[]>(() => {
  const ds = dataset.value;
  return ds ? buildAugmentCatalog(ds.augments, ds.hextechs) : [];
});

const cnCount = computed(() => catalog.value.filter((t) => t.source === 'cn').length);
const cdragonOnlyCount = computed(() => catalog.value.filter((t) => t.source === 'cdragon').length);

const modesPresent = computed(() => {
  const s = new Set<string>();
  for (const a of catalog.value) for (const m of a.modes) s.add(m);
  return ['all', ...[...s].sort()];
});

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  let list = catalog.value;

  if (modeFilter.value !== 'all') {
    list = list.filter((a) => a.modes.includes(modeFilter.value as AugmentMode));
  }
  if (rarityFilter.value !== 'all') {
    list = list.filter((a) => a.rarity === rarityFilter.value);
  }
  if (q) {
    list = list.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.augmentNameId.toLowerCase().includes(q),
    );
  }

  return [...list].sort((x: CatalogTile, y: CatalogTile) => {
    if (sortBy.value === 'name') return x.name.localeCompare(y.name, 'zh-CN');
    const dr = rarityMeta(x.rarity).order - rarityMeta(y.rarity).order;
    return dr !== 0 ? dr : x.name.localeCompare(y.name, 'zh-CN');
  });
});

const stats = computed(() => {
  const ds = dataset.value;
  if (!ds) return null;
  const byMode = new Map<string, number>();
  for (const a of catalog.value) for (const m of a.modes) byMode.set(m, (byMode.get(m) ?? 0) + 1);
  // ⚠️ **英雄数不是 `champions.length`**（真机数字描述错误）：CommunityDragon 的
  // `champion-summary.json` 里同一英雄有**两套 ID**（基础 ID + 60000+ 的 `Jade_*`
  // 变体条目）。实测 245 行 = **173 真实英雄** + 72 变体条目，而官方强度表
  // （`builds.json` 的 `details`）正好是 173 个英雄 —— 所以展示必须分开：
  // 英雄显示 173，变体条目**单独说明它是什么**，绝不混进英雄数里。
  const championCounts = countChampionSet(ds.champions);
  return {
    augments: catalog.value.length,
    cnAugments: cnCount.value,
    cdragonOnly: cdragonOnlyCount.value,
    champions: championCounts.champions,
    championVariants: championCounts.variants,
    items: ds.items.length,
    byMode,
    fetchedAt: new Date(ds.meta.fetchedAt).toLocaleString('zh-CN'),
  };
});

// 英雄 ID -> 名称/图标（排行榜 join 用）
const championMap = computed(() => {
  const m = new Map<number, { name: string; iconPath: string }>();
  for (const c of dataset.value?.champions ?? []) {
    m.set(c.id, { name: c.name, iconPath: c.iconPath });
  }
  return m;
});
</script>

<template>
  <div class="wrap">
    <header class="head">
      <div class="brand">
        <h1>hexbox</h1>
        <span class="badge">海克斯乱斗数据站</span>
      </div>
      <p class="dim sub">
        静态图鉴以 <b>国服官方</b>数据为准（腾讯一方 CDN），CommunityDragon 补全国服未收录条目
        · 排行榜来自
        <a href="https://101.qq.com/#/rankings/hextech" target="_blank" rel="noreferrer">
          腾讯 101 官方数据站
        </a>
      </p>
    </header>

    <div v-if="loading" class="state" role="status" aria-live="polite">加载中…</div>

    <div v-else-if="error" class="state err" role="alert">
      <strong>加载失败</strong>
      <p>{{ error }}</p>
      <pre class="dim">pnpm sync</pre>
    </div>

    <template v-else>
      <section v-if="stats" class="cards">
        <div class="card">
          <div class="num">{{ stats.augments }}</div>
          <div class="dim">海克斯（国服优先 + CDragon 补全）</div>
        </div>
        <div class="card">
          <div class="num">{{ stats.cnAugments }}</div>
          <div class="dim">国服官方收录</div>
        </div>
        <div class="card">
          <div class="num">{{ stats.cdragonOnly }}</div>
          <div class="dim">CDragon 补充（非国服池）</div>
        </div>
        <div class="card">
          <div class="num">{{ stats.champions }}</div>
          <div class="dim">英雄</div>
          <div v-if="stats.championVariants > 0" class="dim small">
            另有 {{ stats.championVariants }} 条同一英雄的变体条目（图鉴里同一英雄的第二套 ID，
            不计入英雄数）
          </div>
        </div>
        <div class="card">
          <div class="num">{{ stats.items }}</div>
          <div class="dim">装备</div>
        </div>
        <div class="card wide">
          <div class="modes">
            <span v-for="[m, n] in [...stats.byMode]" :key="m" class="modechip">
              {{ modeLabel(m) }} <b>{{ n }}</b>
            </span>
          </div>
          <div class="dim small">抓取于 {{ stats.fetchedAt }}</div>
        </div>
      </section>

      <section class="controls">
        <input
          v-model="search"
          class="input"
          type="search"
          placeholder="搜索海克斯名称…"
          aria-label="搜索海克斯名称"
        />
        <select v-model="modeFilter" class="select" aria-label="按模式筛选">
          <option v-for="m in modesPresent" :key="m" :value="m">
            {{ m === 'all' ? '全部模式' : modeLabel(m) }}
          </option>
        </select>
        <select v-model="rarityFilter" class="select" aria-label="按品质筛选">
          <option value="all">全部品质</option>
          <option v-for="(meta, key) in RARITY_META" :key="key" :value="key">
            {{ meta.label }}
          </option>
        </select>
        <select v-model="sortBy" class="select" aria-label="图鉴排序方式">
          <option value="rarity">按品质</option>
          <option value="name">按名称</option>
        </select>
        <span class="dim count" aria-live="polite">{{ filtered.length }} 项</span>
      </section>

      <section class="grid">
        <article v-for="a in filtered" :key="a.key" class="tile">
          <img v-if="a.iconUrl" :src="a.iconUrl" :alt="a.name" loading="lazy" />
          <div v-else class="noicon">?</div>
          <div class="meta">
            <div class="name">{{ a.name }}</div>
            <div class="row">
              <span class="rarity" :style="{ color: rarityMeta(a.rarity).color }">
                {{ rarityMeta(a.rarity).label }}
              </span>
              <span class="dim id">{{ a.augmentNameId }}</span>
            </div>
            <div class="row modes">
              <span v-for="m in a.modes" :key="m" class="mtag">{{ modeLabel(m) }}</span>
            </div>
          </div>
        </article>
      </section>

      <p v-if="!filtered.length" class="state">没有匹配的海克斯。</p>

      <!-- 官方排行榜（official-aggregated，标注来源与统计日期） -->
      <RankView
        :rankings="rankings"
        :rankings-error="rankingsError"
        :hextechs="dataset?.hextechs ?? []"
        :champions="championMap"
      />
    </template>

    <footer class="foot">
      <p class="dim small">
        hexbox 未获得 Riot Games 认可，不代表 Riot Games 或任何参与制作、管理 Riot Games
        财产的人士的观点或意见。Riot Games 及所有相关财产均为 Riot Games, Inc. 的商标或注册商标。
      </p>
      <p class="dim small">
        本站只使用官方一方公开数据：静态图鉴以腾讯官方 CDN 的国服数据为准，
        CommunityDragon 补全国服未收录条目；排行榜来自腾讯 101 官方数据站
        （101.qq.com）并随数据标注统计日期。
        不读内存、不注入、不解析封包，也不识别对局内被提供的海克斯。
      </p>
    </footer>
  </div>
</template>

<style scoped>
.wrap {
  max-width: 1200px;
  margin: 0 auto;
  padding: 24px 20px 60px;
}

.head {
  margin-bottom: 20px;
}
.brand {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
h1 {
  margin: 0;
  font-size: 26px;
  letter-spacing: 0.5px;
}
.badge {
  font-size: 12px;
  color: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 10px;
  padding: 1px 8px;
}
.sub {
  margin: 6px 0 0;
  font-size: 13px;
}

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px;
  margin-bottom: 18px;
}
.card {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
}
.card.wide {
  grid-column: span 2;
  min-width: 260px;
}
.num {
  font-size: 22px;
  font-weight: 600;
  color: var(--accent);
}
.modes {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 6px;
}
.modechip {
  background: var(--bg-elev2);
  border-radius: 4px;
  padding: 2px 7px;
  font-size: 12px;
}
.small {
  font-size: 12px;
}

.controls {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-bottom: 16px;
}
.input,
.select {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 6px;
  padding: 7px 10px;
  font-size: 13px;
  font-family: inherit;
}
.input {
  flex: 1;
  min-width: 200px;
}
.input:focus,
.select:focus {
  outline: none;
  border-color: var(--accent);
}
.count {
  font-size: 12px;
  margin-left: auto;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 10px;
}
.tile {
  display: flex;
  gap: 10px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px;
  transition: border-color 0.15s;
}
.tile:hover {
  border-color: var(--accent);
}
.tile img {
  width: 44px;
  height: 44px;
  border-radius: 6px;
  flex-shrink: 0;
  background: var(--bg-elev2);
}
.noicon {
  width: 44px;
  height: 44px;
  border-radius: 6px;
  background: var(--bg-elev2);
  display: grid;
  place-items: center;
  color: var(--text-dim);
  flex-shrink: 0;
}
.meta {
  min-width: 0;
  flex: 1;
}
.name {
  font-weight: 600;
  margin-bottom: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.row.modes {
  margin-top: 4px;
  gap: 4px;
}
.rarity {
  font-size: 12px;
  font-weight: 600;
}
.id {
  font-size: 11px;
  font-family: ui-monospace, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mtag {
  font-size: 11px;
  background: var(--bg-elev2);
  border-radius: 3px;
  padding: 1px 5px;
  color: var(--text-dim);
}

.state {
  padding: 40px 0;
  text-align: center;
  color: var(--text-dim);
}
.state.err {
  color: #e08a8a;
  text-align: left;
  background: var(--bg-elev);
  border: 1px solid #5a2a2a;
  border-radius: 8px;
  padding: 16px;
}
.state.err pre {
  background: var(--bg);
  padding: 8px 10px;
  border-radius: 5px;
  margin: 8px 0 0;
}

.foot {
  margin-top: 40px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
}
.foot p {
  margin: 4px 0;
  line-height: 1.6;
}
</style>
