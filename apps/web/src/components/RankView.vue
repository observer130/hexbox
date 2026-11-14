<script setup lang="ts">
/**
 * 排行榜视图（official-aggregated）
 *
 * 数据来源：腾讯 101 官方数据站（101.qq.com）一方公开接口。
 * 展示约定：
 *   - 标注来源与上游统计日期（meta.dataDate 由 `formatStatDate` 转成 YYYY-MM-DD）；
 *   - 上游无数据时显示「暂无数据」，不用旧数据冒充；
 *   - 加载/校验失败时在榜单区显示**可操作**原因（`rankingsError`），不再静默
 *     伪装成「上游未更新」（2026-11 审查 P2 #2）。
 *
 * 可访问性（审查 P2 #3）：表格有 caption/scope/aria-sort，tab 有
 * tablist/tab/tabpanel + aria-selected/aria-controls，排序控件有 aria-label。
 * 模式中文名统一走 `format.ts` 的 `modeLabel()`（CHERRY 不再漏成英文）。
 */
import { computed, ref } from 'vue';
import {
  cnIconUrl,
  formatStatDate,
  modeLabel,
  pct,
  rankChangeClass,
  rankChangeText,
} from '../format';
import type { RankingSnapshot } from '../useDataset';
import { rarityMeta } from '../rarity';
import type { HextechStatic } from '@hexbox/core';

const props = defineProps<{
  rankings: RankingSnapshot | null;
  /** 排行榜独立加载/校验错误：只在榜单区显示，不阻塞图鉴。 */
  rankingsError: string | null;
  hextechs: readonly HextechStatic[];
  champions: ReadonlyMap<number, { name: string; iconPath: string }>;
}>();

type Tab = 'augments' | 'heroes';
const tab = ref<Tab>('augments');
type SortKey = 'winRate' | 'pickRate';
const sortBy = ref<SortKey>('winRate');

const hextechById = computed(() => {
  const m = new Map<number, HextechStatic>();
  for (const h of props.hextechs) m.set(h.id, h);
  return m;
});

const augmentRows = computed(() => {
  if (!props.rankings) return [];
  const rows = props.rankings.augments.map((e) => {
    const def = hextechById.value.get(e.id);
    return { ...e, def, sortWin: e.winRate, sortPick: e.pickRate };
  });
  const key = sortBy.value;
  return [...rows].sort((a, b) =>
    key === 'winRate' ? b.sortWin - a.sortWin : b.sortPick - a.sortPick,
  );
});

const heroRows = computed(() => {
  if (!props.rankings) return [];
  return [...props.rankings.heroes].sort((a, b) =>
    sortBy.value === 'winRate' ? b.winRate - a.winRate : b.pickRate - a.pickRate,
  );
});

const hasData = computed(
  () => (props.rankings?.augments.length ?? 0) + (props.rankings?.heroes.length ?? 0) > 0,
);

const fetchedAtText = computed(() =>
  props.rankings ? new Date(props.rankings.meta.fetchedAt).toLocaleString('zh-CN') : '',
);

function heroName(id: number): string {
  return props.champions.get(id)?.name ?? `英雄#${id}`;
}

function heroIcon(id: number): string {
  // 英雄图标走 CDragon（champion-summary 的 iconPath）
  const p = props.champions.get(id)?.iconPath;
  return p ? `https://raw.communitydragon.org/latest/plugins${p}` : '';
}
</script>

<template>
  <section class="rank">
    <header class="rank-head">
      <h2>海克斯乱斗 · 排行榜</h2>
      <p class="dim src">
        数据来源：
        <a href="https://101.qq.com/#/rankings/hextech" target="_blank" rel="noreferrer">
          腾讯 101 官方数据站
        </a>
        <template v-if="rankings?.meta.dataDate">
          · 统计日期 <b>{{ formatStatDate(rankings.meta.dataDate) }}</b>
        </template>
        <template v-if="rankings"> · 抓取于 {{ fetchedAtText }} </template>
      </p>
    </header>

    <!-- 排行榜独立容错：失败时给出可操作原因，不阻塞图鉴（审查 P2 #2） -->
    <div v-if="rankingsError" class="rank-error" role="alert">
      <strong>排行榜数据加载失败</strong>
      <p>{{ rankingsError }}</p>
      <p class="hint">
        可重新运行 <code>pnpm sync</code> 生成 data/rankings.json 后刷新页面（图鉴数据不受影响）。
      </p>
    </div>

    <div v-else-if="!hasData" class="state dim">暂无排行数据（上游统计未更新或接口维护中）。</div>

    <template v-else>
      <div class="controls">
        <div class="tabs" role="tablist" aria-label="排行榜类型">
          <button
            id="rank-tab-augments"
            class="tab"
            :class="{ active: tab === 'augments' }"
            role="tab"
            :aria-selected="tab === 'augments'"
            aria-controls="rank-panel-augments"
            @click="tab = 'augments'"
          >
            海克斯榜
          </button>
          <button
            id="rank-tab-heroes"
            class="tab"
            :class="{ active: tab === 'heroes' }"
            role="tab"
            :aria-selected="tab === 'heroes'"
            aria-controls="rank-panel-heroes"
            @click="tab = 'heroes'"
          >
            英雄榜
          </button>
        </div>
        <select v-model="sortBy" class="select" aria-label="排行榜排序方式">
          <option value="winRate">按胜率</option>
          <option value="pickRate">按选取率</option>
        </select>
      </div>

      <!-- 海克斯榜 -->
      <div
        v-if="tab === 'augments'"
        id="rank-panel-augments"
        class="tablewrap"
        role="tabpanel"
        aria-labelledby="rank-tab-augments"
      >
        <table class="tbl">
          <caption class="sr-only">
            海克斯排行榜（数据来自腾讯 101 官方数据站，按{{
              sortBy === 'winRate' ? '胜率' : '选取率'
            }}降序排列）
          </caption>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col" class="left">海克斯</th>
              <th scope="col" :aria-sort="sortBy === 'winRate' ? 'descending' : 'none'">胜率</th>
              <th scope="col">胜率排名</th>
              <th scope="col" :aria-sort="sortBy === 'pickRate' ? 'descending' : 'none'">选取率</th>
              <th scope="col">选取排名</th>
              <th scope="col" class="left">最适配英雄</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in augmentRows" :key="r.id">
              <td class="dim">{{ i + 1 }}</td>
              <td class="left cell-avg">
                <img v-if="r.def" :src="cnIconUrl(r.def)" :alt="r.def.name" loading="lazy" />
                <div class="min0">
                  <div class="name">{{ r.def?.name ?? `海克斯#${r.id}` }}</div>
                  <div class="row">
                    <span
                      v-if="r.def"
                      class="rarity"
                      :style="{ color: rarityMeta(r.def.rarity).color }"
                    >
                      {{ rarityMeta(r.def.rarity).label }}
                    </span>
                    <span v-for="m in r.def?.modes ?? []" :key="m" class="mtag">
                      {{ modeLabel(m) }}
                    </span>
                  </div>
                </div>
              </td>
              <td class="strong">{{ pct(r.winRate) }}</td>
              <td>
                {{ r.winRank }}
                <span class="chg" :class="rankChangeClass(r.winRankChange)">
                  {{ rankChangeText(r.winRankChange) }}
                </span>
              </td>
              <td>{{ pct(r.pickRate) }}</td>
              <td>
                {{ r.pickRank }}
                <span class="chg" :class="rankChangeClass(r.pickRankChange)">
                  {{ rankChangeText(r.pickRankChange) }}
                </span>
              </td>
              <td class="left">
                <img
                  v-for="hid in r.bestHeroes.slice(0, 6)"
                  :key="hid"
                  class="mini-hero"
                  :src="heroIcon(hid)"
                  :alt="heroName(hid)"
                  :title="heroName(hid)"
                  loading="lazy"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 英雄榜 -->
      <div
        v-else
        id="rank-panel-heroes"
        class="tablewrap"
        role="tabpanel"
        aria-labelledby="rank-tab-heroes"
      >
        <table class="tbl">
          <caption class="sr-only">
            英雄排行榜（数据来自腾讯 101 官方数据站，按{{
              sortBy === 'winRate' ? '胜率' : '选取率'
            }}降序排列）
          </caption>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col" class="left">英雄</th>
              <th scope="col" :aria-sort="sortBy === 'winRate' ? 'descending' : 'none'">胜率</th>
              <th scope="col" :aria-sort="sortBy === 'pickRate' ? 'descending' : 'none'">选取率</th>
              <th scope="col">排名变化</th>
              <th scope="col">平均死亡</th>
              <th scope="col">参团率</th>
              <th scope="col">伤害占比</th>
              <th scope="col">承伤占比</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in heroRows" :key="r.championId">
              <td class="dim">{{ r.rank || i + 1 }}</td>
              <td class="left cell-avg">
                <img :src="heroIcon(r.championId)" :alt="heroName(r.championId)" loading="lazy" />
                <div class="min0">
                  <div class="name">{{ heroName(r.championId) }}</div>
                </div>
              </td>
              <td class="strong">{{ pct(r.winRate) }}</td>
              <td>{{ pct(r.pickRate) }}</td>
              <td>
                <span class="chg" :class="rankChangeClass(r.rankChange)">
                  {{ rankChangeText(r.rankChange) }}
                </span>
              </td>
              <td>{{ r.avgDeathTime.toFixed(0) }}s</td>
              <td>{{ pct(r.avgParticipationRate) }}</td>
              <td>{{ pct(r.avgDamageRatio) }}</td>
              <td>{{ pct(r.avgTankRatio) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p class="dim note">
        英雄最佳搭档与海克斯最适配英雄为上游官方数据直出；
        表格排序为本站按上游比率字段重排，数值本身未做二次加工。
      </p>
    </template>
  </section>
</template>

<style scoped>
.rank {
  margin-top: 36px;
}
.rank-head {
  margin-bottom: 12px;
}
h2 {
  margin: 0 0 4px;
  font-size: 20px;
}
.src {
  margin: 0;
  font-size: 13px;
}

.controls {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 10px;
}
.tabs {
  display: flex;
  gap: 6px;
}
.tab {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  color: var(--text-dim);
  border-radius: 6px;
  padding: 6px 14px;
  cursor: pointer;
  font-size: 13px;
  font-family: inherit;
}
.tab.active {
  color: var(--accent);
  border-color: var(--accent);
}
.select {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 13px;
  font-family: inherit;
}

.tablewrap {
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-elev);
}
.tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  min-width: 640px;
}
.tbl th {
  position: sticky;
  top: 0;
  background: var(--bg-elev2);
  padding: 8px 10px;
  text-align: center;
  font-weight: 600;
  white-space: nowrap;
}
.tbl td {
  padding: 8px 10px;
  text-align: center;
  border-top: 1px solid var(--border);
  white-space: nowrap;
}
.tbl .left {
  text-align: left;
}
tbody tr:hover {
  background: var(--bg-elev2);
}
.strong {
  font-weight: 600;
  color: var(--accent);
}
.cell-avg {
  display: flex;
  gap: 8px;
  align-items: center;
  min-width: 180px;
}
.cell-avg img {
  width: 36px;
  height: 36px;
  border-radius: 6px;
  background: var(--bg-elev2);
  flex-shrink: 0;
}
.min0 {
  min-width: 0;
}
.name {
  font-weight: 600;
}
.row {
  display: flex;
  gap: 4px;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 2px;
}
.rarity {
  font-size: 11px;
  font-weight: 600;
}
.mtag {
  font-size: 11px;
  background: var(--bg-elev2);
  border-radius: 3px;
  padding: 1px 5px;
  color: var(--text-dim);
}
.chg {
  font-size: 12px;
  margin-left: 4px;
}
.chg.up {
  color: #7ec97e;
}
.chg.down {
  color: #e08a8a;
}
.chg.flat {
  color: var(--text-dim);
}
.mini-hero {
  width: 26px;
  height: 26px;
  border-radius: 4px;
  background: var(--bg-elev2);
  margin-right: 4px;
  vertical-align: middle;
}
.note {
  font-size: 12px;
  margin-top: 10px;
}
.state {
  padding: 30px 0;
  text-align: center;
}
.rank-error {
  background: var(--bg-elev);
  border: 1px solid #5a2a2a;
  border-radius: 8px;
  padding: 14px 16px;
  color: #e08a8a;
}
.rank-error p {
  margin: 8px 0 0;
}
.rank-error code {
  background: var(--bg);
  border-radius: 4px;
  padding: 2px 6px;
}
.rank-error .hint {
  color: var(--text-dim);
}
</style>
