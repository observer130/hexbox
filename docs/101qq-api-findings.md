# 101.qq.com 海克斯排行页 — 数据与接口调研

> 调查者：子代理（DeepSeek Harness）
> 日期：2026-09-25
> 方法：`web_fetch` + allorigins 代理取原始 HTML + microlink 渲染/取 JS 文本
> 结论可信度：**接口为实测（HTTP 200 + 真实 JSON），非推断**

---

## 0. 环境说明（复现前提）

> 🔄 **更新（2026-09-25，权限策略改为完全访问后）**：
> 本机环境**已恢复正常**，下述代理 workaround **不再需要**。
> `pwsh` 的 TLS 现已对全部站点可用（baidu / GitHub / 腾讯 / CDragon 均实测 200），
> Node v24.21.0、Python 3.12.14、git 2.53.0 均可用。
>
> **现在可直接复现**：
> ```powershell
> Invoke-WebRequest "https://mlol.qt.qq.com/go/battle_info/odp_proxy/fuwen_aram_rune_rank_v2?augmentid_level=255" -SkipCertificateCheck
> ```
> 或用 Python `urllib` 直接抓取（已实测跑通，211 条记录全部匹配 CDragon 定义）。
>
> 下文 §0 原内容保留，作为**故障期间**的取证记录。

<details>
<summary>原环境说明（故障期间，已过时）</summary>

本机 `pwsh` 的 TLS **完全不可用** —— 不只是 101.qq.com，连 `https://www.baidu.com/`
都报 `The SSL connection could not be established`。因此**不要**用 `curl`/`Invoke-WebRequest`
复现本报告。

实际可用的取数路径：

| 目的 | 方法 |
|---|---|
| 取任意页面 **原始 HTML/JSON** | `https://api.allorigins.win/get?url=<urlencoded>` |
| 取 **JS/JSON 文本**（web_fetch 会拒 `application/x-javascript`、`application/octet-stream`） | `https://api.microlink.io/?url=<urlencoded>&meta=false&data.x.selector=body&data.x.type=text` |
| 渲染执行 JS 的页面 / 截图 / PDF | `https://api.microlink.io/?url=<urlencoded>&screenshot=true` |

> 注：`codetabs`、`corsproxy`、`r.jina.ai` 本次均失败（522/403/超时）。
> allorigins 对**大文件**（如主 bundle）会 522，所以要用 microlink 逐个取小 chunk。

</details>

---

## 1. 站点性质（CONFIRMED）

`101.qq.com` 是**腾讯官方**英雄联盟「攻略中心」，**一方产品**：

- `lol.qq.com/main.shtml`（官方官网）中两次链接到它，均标注「攻略中心」：
  - `https://101.qq.com/?ADTAG=cooperation.glzx.web#/page-index/tab-index`
  - `//101.qq.com/`
- urlscan.io 历史快照（2023-10、2024-05）显示当时标题为
  `攻略中心-英雄联盟官方网站-腾讯游戏`。
- 页面内置配置（原始 HTML 原文）：

```js
window["ZMProjectConfig"] = {
  "project_name":"lolstrategy",
  "env":"production",
  "project_name_cn":"LOL Strategy",
  "release_url":"https://lol.qq.com/lolstrategy/",
  "ZMSERVICE":"https://mlol.qt.qq.com",   // ← 后端 API host
  "aegisid":""
};
```

`https://lol.qq.com/lolstrategy/` 提供**同一个 SPA**（第二入口）。

页面 meta（原文，两次抓取一致）：

- `Description`: 101英雄联盟英雄榜提供召唤师峡谷、海克斯大乱斗、极地大乱斗与经典模式英雄排名，查看 Tier、胜率、登场率、禁用率、符文天赋与装备构筑。
- `Keywords`: lol, 英雄联盟, 英雄联盟英雄榜, LOL胜率排行, 英雄强度榜, 极地大乱斗英雄榜, 大乱斗胜率, 乱斗强势英雄, **海克斯大乱斗英雄榜, 海斗英雄, 海斗胜率**, LOL经典模式, 经典模式英雄榜, 符文, 装备

---

## 2. 前端资源（CONFIRMED）

**注意：资源不在 101.qq.com 上**，而在官方 CDN `lol.qq.com/lolstrategy/`。

SPA 外壳（注意是 ES module，非 index-<hash>.js）：

```html
<script type="module" crossorigin src="https://lol.qq.com/lolstrategy/assets/20260924/strategy-Cg1Sb-c9.js"></script>
<link rel="stylesheet" crossorigin href="https://lol.qq.com/lolstrategy/assets/20260924/strategy-Dqiy3j5I.css">
```

`strategy-Cg1Sb-c9.js` 只是 **Vue 3.5.39 运行时 + 路由**，其 Vite 依赖清单里列出了各页面 chunk。
与海克斯榜相关的两个（**已实际取到内容**）：

```
assets/20260924/HextechRankView-0Y_XrT7L.js
assets/20260924/AugmentPopover.vue_vue_type_script_setup_true_lang-BZJd2oOt.js
```

其余 chunk（供参考）：`ClassicRankView-*`、`jadeData-*`、`ClassicHeroView-*`、
`ClassicEquipmentView-*`、`ItemPopover-*`、`HeroDetailView-*`、`DataRunesView-*`、
`DataItemsView-*`、`DataSummonersView-*`、`VersionView-*`、`ClassicSummonerView-*`。

另：`https://lol.qq.com/lolstrategy/version.json` 与 `https://101.qq.com/version.json`
均 200，内容一致（ETag `"6ab4f7b9-4b"`，75 字节），只是构建 hash，**不含 chunk 清单**。

---

## 3. 页面显示什么数据（CONFIRMED，来自 chunk 源码）

`/rankings/hextech` 页面（`HextechRankView`）有 **3 个 Tab**：

```js
N = [
  {label:"海克斯榜",   value:"augment"},
  {label:"英雄榜",     value:"tier"},
  {label:"最佳拍档榜", value:"duo"}
]
```

### Tab 1「海克斯榜」= **强化符文（海克斯）级别**的胜率/选取率

表头（源码字面量）：

```js
[{title:"排名",       key:"rank",   width:"80px"},
 {title:"品质",       key:"rarity", width:"96px"},   // Prismatic/Gold/Silver ← kPrismatic/kGold/kSilver
 {title:"海克斯强化", key:"augment"},
 {title:"胜率",       key:"winRate",  sorter:true},
 {title:"选取率",     key:"pickRate", sorter:true},
 {title:"最适配英雄", key:"bestChamps", width:"160px"}]
```

还计算 `winRank` / `pickRank` / `winRankChange` / `pickRankChange`（排名升降箭头）。
→ **这是 Riot 政策中点名的「augment 胜率」在真实世界的确凿反例，且由一方（腾讯）发布。**

### Tab 2「英雄榜」= **英雄**级别的胜率（按模式，含海克斯大乱斗）

```js
[{title:"排名",   key:"rank", width:"80px"},
 {title:"英雄",   key:"championTier", width:"240px"},
 {title:"T级",    key:"tier", width:"90px"},
 {title:"胜率",   key:"winRate", width:"120px", sorter:true},
 {title:"顶级符文", key:"runes", width:"480px"}]   // ← 该英雄的"顶级符文"，实为 top augments
```

带分路筛选；点英雄跳 `/hero-detail?heroId=<id>&mode=hextech`。
（`顶级符文` 列取自 API 的 `lowest_rank_runes` 字段并 `getAugment()` 解析。）

### Tab 3「最佳拍档榜」= 英雄组合

```js
[{title:"排名",     key:"rank",     width:"64px"},
 {title:"英雄组合", key:"duo"},
 {title:"配合胜率", key:"winRate",  width:"140px", sorter:true},
 {title:"登场率",   key:"pickRate", width:"140px", sorter:true}]
```

覆盖模式：召唤师峡谷 / 海克斯大乱斗 / 极地大乱斗 / 经典模式。

---

## 4. 后端接口（**全部实测 HTTP 200**）

Host：`https://mlol.qt.qq.com`（= `ZMProjectConfig.ZMSERVICE`）
统一前缀：`/go/battle_info/odp_proxy/`
认证：**无**（无需 cookie / referer / token）

源码中的字面声明（来自 `AugmentPopover` chunk）：

```js
async function R(e){ return u(d("/go/battle_info/odp_proxy/fuwen_aram_hero_rank_v2", e), "json") }
async function T(e){ return u(d("/go/battle_info/odp_proxy/fuwen_aram_rune_rank_v2", {augmentid_level:255, ...e}), "json") }
async function M(e=255,t=255,s=255,i){ return u(d("/go/battle_info/odp_proxy/fuwen_aram_hero_parttner", {role1:e,role2:t,championid:s, ...i}), "json") }
async function Z(e,t){ return u(d("/go/battle_info/odp_proxy/fuwen_hero_rank", {championid:e, ...t}), "json") }
```

### 4.1 海克斯（符文）榜 — `fuwen_aram_rune_rank_v2`

```
GET https://mlol.qt.qq.com/go/battle_info/odp_proxy/fuwen_aram_rune_rank_v2?augmentid_level=255
```

响应：

```json
{"code":0,"errMsg":"","result":0,
 "data":{"_fieldValues":{"R15381":"{\"dtstatdate\":\"20260924\",\"augmentlist\":\"...\"}"}}}
```

`augmentlist` 为 `#` 分隔的扁平字符串，每条 `_` 分隔：

```
augmentId _ augmentid_level _ pick_rate _ pick_rank _ pick_rank_change _ win_rate _ win_rank _ win_rank_change _ heroIds(csv,6)
```

实测首行 / 末行：

```
1238_255_0.646_1_0_0.6541_1_0_22,30,63,17,136,238
1187_255_0.007_210_0_0.4796_183_4_875,64,54,141,53,122
```

- 共 **219** 条海克斯；`dtstatdate: "20260924"` 为统计日期（T-1）
- 比率需 ×100（前端 `parseFloat((o*100).toFixed(6))`）
- `augmentid_level=255` = 全部品质
- **`augmentId` 与 CommunityDragon `cherry-augments.json` 的 `id` 同一体系**
  （如 1205 = 物理转魔法），可直接 join 取中文名/图标/稀有度

### 4.2 英雄榜（该模式）— `fuwen_aram_hero_rank_v2`

```
GET https://mlol.qt.qq.com/go/battle_info/odp_proxy/fuwen_aram_hero_rank_v2?dtstatdate=20260924
```

**`dtstatdate` 为必填**（省略时返回 `{"code":0,"data":null,"message":"arg dtstatdate is required"}`）。

响应 `data._fieldValues.Rxxxxx` → `{"listcollect":"..."}`，`#` 分隔每条：

```
heroId _ rank _ changeDesc _ win_rate _ pick_rate _ topAugments
```

- `changeDesc` 形如 `未变化` / `上升N位` / `下降N位`
- `topAugments` 为 `augId,pickRate,winRate,rank` 四元组，以 `&`（JSON 中 `\u0026`）连接

实测（英雄 157）：

```
157_1_未变化_0.5721_0.1067_
  17,0.059,0.6137,1&63,0.0587,0.6129,2&136,0.0477,0.6288,3&...
```

### 4.3 最佳拍档 — `fuwen_aram_hero_parttner`

```
GET https://mlol.qt.qq.com/go/battle_info/odp_proxy/fuwen_aram_hero_parttner?role1=255&role2=255&championid=255
```

`#` 分隔，每条：

```
hero1;hero2 | role1,role2;role3,role4 | win_rate | pick_rate | rank
```

实测：`157;63|assassin,fighter;mage,support|0.6148|0.0172|1`（共约 1985 条）

### 4.4 经典模式 — `fuwen_hero_rank`

路径存在于源码，参数 `championid`。本次**未实测**（同前缀其余三个均 200，前缀本身已确认可用）。

---

## 5. 与本项目 `research.md` 的关系（结论修正建议）

`docs/research.md` §4.1 把「腾讯 101 站展示海克斯数据」作为**用户提出的反例**记录。
本次调查将其**升级为已核实的一手事实**，并具体化：

| 原文档表述 | 应修正为 |
|---|---|
| 腾讯 101 站公开展示海克斯数据（用户指出） | ✅ **已实测**：`/rankings/hextech` 的「海克斯榜」Tab 直接展示每个海克斯的**胜率 + 选取率 + 排名升降**，数据来自 `mlol.qt.qq.com` 的无鉴权 JSON 接口 |
| §2.4「国服拿不到数据」 | 该结论**仅适用于 Riot Web API**（国服确实无 host）。腾讯自有 ODP 数据链路**可以**拿到，且可直接 GET。故不做胜率功能的理由是**纯政策取舍**，不再有技术层面的托词 |
| §7.C 非目标 | 维持不变，但需明确：这是**主动放弃**，不是**能力所限** |

**接口可用性不影响本项目决策**：Riot 政策禁止的是**第三方**产品展示 augment 胜率
（"This applies to all websites, applications and overlays."）。
腾讯作为运营方不受该文档约束；第三方开发者仍然受约束。
因此本项目继续不做胜率，但文档中「做不到」的表述必须删掉，改为「不越线」。

---

## 6. 未能确认的部分（诚实记录）

- **未在浏览器中目视确认渲染后的表格**。microlink 渲染 `#/rankings/hextech` 时
  返回的 DOM 与原始外壳一致（未渲染出内容，可能因数据中心 IP 或等待时间不足）。
  但**接口数据已实测**，且 chunk 源码中的表头字面量已取到，故结论不依赖渲染截图。
- **经典模式接口 `fuwen_hero_rank`** 未实测。
- chunk 源码中少数字面量（如两个表头常量）在传输中呈 mojibake，
  已通过列宽 + 实时数据字段名（`winRate`/`pickRate`）对应还原为
  「排名/品质/海克斯强化/胜率/选取率/最适配英雄」，但严格说这几项中文标签
  是**对应还原**而非逐字节确认。

## 7. 实测记录（可复现）

| URL | 结果 |
|---|---|
| `https://101.qq.com/` | 200，SPA 外壳 |
| `https://101.qq.com/#/rankings/hextech` | 200，同一外壳（内容由 JS 渲染） |
| `https://101.qq.com/version.json` | 200，75 B |
| `https://lol.qq.com/lolstrategy/version.json` | 200，75 B |
| `https://lol.qq.com/lolstrategy/assets/20260924/strategy-Cg1Sb-c9.js` | 200 `application/x-javascript` |
| `https://lol.qq.com/lolstrategy/assets/20260924/HextechRankView-0Y_XrT7L.js` | 200，5240 B |
| `https://lol.qq.com/lolstrategy/assets/20260924/AugmentPopover...BZJd2oOt.js` | 200，1514 B |
| `https://mlol.qt.qq.com/` | 200 |
| `.../fuwen_aram_rune_rank_v2?augmentid_level=255` | **200，真实数据** |
| `.../fuwen_aram_hero_rank_v2?dtstatdate=20260924` | **200，真实数据** |
| `.../fuwen_aram_hero_parttner?role1=255&role2=255&championid=255` | **200，真实数据** |
| `https://101.qq.com/api/rankings/hextech` | 404（腾讯游戏 404 页） |
| `https://101.qq.com/api/hextech` | 404 |
| `https://101.qq.com/api/v1/rankings/hextech` | 404 |
| `https://101.qq.com/assets/index.js` | 404 |
| `https://101.qq.com/assets/index-6c1f0f0f.js` | 404 |
| `https://101.qq.com/robots.txt` | 404 |
| `https://mlol.qt.qq.com/lolstrategy/rankings/hextech` | 404 (nginx) |
| `https://mlol.qt.qq.com/go/lolstrategy/rankings/hextech` | 404 (nginx) |
| `https://mlol.qt.qq.com/go/strategy/rankings/hextech` | 404 (nginx) |
| `https://lol.qq.com/lolstrategy/assets/20260924/` | 403（禁止目录列表） |
| urlscan.io API `/result/...` | 403（需登录） |
| archive.org / web.archive.org | 本机不可达 |
