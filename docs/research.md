# 英雄联盟海克斯乱斗助手 — 调研与开发路线

> 状态：调研阶段（结论已基于可复现的公开资料核实）
> 日期：2026
> 目标：数据站查询 + **国服**游戏内悬浮窗辅助（推荐英雄/海克斯/出装/加点）

---

## 0. 结论速览（TL;DR）

| 问题 | 结论 | 可信度 |
|---|---|---|
| 数据站数据源能否拿到？ | ✅ 能。CommunityDragon 提供**完整静态数据**（海克斯定义、中文名、图标、每个模式的海克斯池） | 已核实 |
| 游戏内"玩家当前被提供的 3 个海克斯"能否拿到？ | ❌ **拿不到**。已在**真实对局**中抓取 `swagger/v3/openapi.json` 验证：24 个端点 / 24 个 schema 中，`augment`/`cherry`/`kiwi`/`hextech`/`brawl` **全部零命中** | ✅ 线上实测 |
| 能否做悬浮窗？ | ✅ 能，且**不需要**注入/读内存：独立置顶透明窗口即可 | 已核实 |
| **海克斯胜率/选取率数据能否拿到？** | ✅ **能，且已实测**。腾讯官方 `mlol.qt.qq.com` 一方接口，**免鉴权、GET、JSON**，含 219 个海克斯的胜率+选取率+最适配英雄（见 §4.2） | **已实测** |
| 那为什么本项目不做胜率？ | ⚠️ **纯粹是政策选择，不是技术限制**。Riot 将"第三方展示海克斯胜率"列为不予批准的用例 | 已核实 |
| 虎牙那类工具是怎么做的？ | ✅ **已确认：截屏 + OCR**（用户此前调研）。侧面印证"无隐藏 API"，OCR 是唯一途径 | 有依据 |

**两条约束，务必分清（我此前曾把第一条说错，已修正）**：

1. **技术约束（软，仅限"局内三选一"）**：官方 API 不提供"当前被提供的 3 个海克斯"。
   → **局内自动识别**不可行（除非读内存，已排除）。
   → 但**海克斯的胜率/选取率数据是完全可得的**（腾讯一方接口，已实测）。
2. **政策约束**：Riot 将"第三方展示海克斯胜率"列为不予批准的用例。
   → 所以胜率功能拿不到 Riot 认可。**这不是"数据非法"，也不是"拿不到"**（详见 §4.1–4.3）。

---

## 1. 术语与模式识别（重要）

"海克斯乱斗"在 Riot 内部有独立代号，搞清这点是全部数据工作的前提：

| 中文名 | Riot 内部代号 | 说明 | 证据 |
|---|---|---|---|
| 斗魂竞技场 | `CHERRY` | 2v2v2v2 竞技场，`mapId=30`（TGR） | `cherry-augments.json`、`maps.json` |
| **海克斯乱斗** | `KIWI` | 有独立海克斯池（约 215 条） | `augment-lists.json` |
| 海克斯乱斗（Jade 变体） | `KIWI_JADE` | 池更大，含"召唤师峡谷？"主题 | `augment-lists.json`、`game-mode-mutators.json` |

**官方模式的权威识别方式**（来自 Riot 官方静态文件，非第三方）：

```jsonc
// https://static.developer.riotgames.com/docs/lol/gameModes.json
{ "gameMode": "BRAWL", "description": "Brawl" }

// https://static.developer.riotgames.com/docs/lol/queues.json
{ "queueId": 2300, "map": "The Bandlewood", "description": "Brawl" }
```

> ✅ 我已独立抓取上述两个官方文件并确认：`gameMode = "BRAWL"`、`queueId = 2300` **是 Riot 官方文档化的**。
> 这是判断"是否处于海克斯乱斗对局"的**最可靠且完全合法**的依据。
> 注意 `mapId` 不可靠（"The Bandlewood" 不在 `maps.json` 中）。

`augment-lists.json` 的实际结构（已抓取原文）：

```json
[
  { "modeName": "CHERRY",    "augmentList": ["Maps/ModeSpecificData/Augments/ARAM_GetExcited", ...] },
  { "modeName": "KIWI",      "augmentList": ["Maps/ModeSpecificData/Augments/ARAM_BigBrain", ...] },
  { "modeName": "KIWI_JADE", "augmentList": ["Maps/ModeSpecificData/Augments/ARAM_BigBrain", ...] }
]
```

> ⚠️ **待你确认**：国服"海克斯乱斗"对应 `KIWI` 还是 `KIWI_JADE`？这直接影响推荐池的正确性。不同池的子集不同（例如 `KIWI_JADE` 独有 `DontStopCleavin`、`Upgrade_ZzRotPortal`、`DoOrDie` 等）。

---

## 2. 数据源评估

### 2.1 CommunityDragon（推荐主力，免费无鉴权）

基础路径：
```
https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/zh_cn/v1/
```

> ⚠️ **路径陷阱**：locale 目录的真实布局是 `global/<locale>/`（内含 `content/` 与 `v1/`）。
> `global/zh_cn/default/v1/...` 这种写法 **返回 404**，不要照搬 `global/default/v1/` 的模式。
>
> 另需注意：`cherry-augments.json` 中 `nameTRA` 是**本地化 key**（原文以英文字母标识），
> **国服中文名的确切来源尚未确认**，可能需要在客户端安装目录内读取，或自行维护映射表。

关键文件（**均已实际抓取验证可访问**）：

| 文件 | 内容 | 实测大小 |
|---|---|---|
| `cherry-augments.json` | 海克斯定义：`id` / `augmentNameId` / 中文名 `nameTRA` / 图标 / 稀有度 | ~114 KiB |
| `augment-lists.json` | **各模式的海克斯池**（CHERRY / KIWI / KIWI_JADE） | ~22 KiB |
| `champion-summary.json` | 英雄中文名、别名、头像 | ~54 KiB |
| `items.json` | 装备**中文名 + 完整中文描述 + 价格 + 合成树** | ~666 KiB |
| `perks.json` | 符文 | ~100 KiB |
| `summoner-spells.json` | 召唤师技能 | ~13 KiB |
| `queues.json` | 队列定义（含 `viableChampionRoster` 可用英雄名单） | ~353 KiB |

海克斯字段结构（真实样本）：
```json
{
  "id": 1205,
  "augmentNameId": "ARAM_ADAPt",
  "nameTRA": "物理转魔法",
  "simpleNameTRA": "",
  "augmentSmallIconPath": "/lol-game-data/assets/ASSETS/UX/Cherry/Augments/Icons/ADAPt_small.png",
  "rarity": "kSilver"
}
```

稀有度枚举：`kSilver`（白银）/ `kGold`（黄金）/ `kPrismatic`（棱彩）/ `kEventChoice`（事件抉择）

**优点**：中文名/图标/合成树齐全，免鉴权，CDN 直连。
**缺点**：只有**静态定义**，没有任何胜率/选取率统计。

### 2.2 Data Dragon（官方，备用）

```
https://ddragon.leagueoflegends.com/cdn/16.19.1/data/zh_CN/champion.json
```
官方静态数据，含模式专属目录 `data/{LOCALE}/mode/{mode-name}/`。
**缺点**：不含海克斯数据（海克斯属于客户端 `lol-game-data`，不在 DDragon 内）。

### 2.3 LCU API（本地，官方"允许使用但不支持"）

从 `lockfile` 或 `LeagueClientUx.exe` 命令行取 `--app-port` 与 `--remoting-auth-token`，用 HTTP Basic（用户名固定 `riot`）访问 `https://127.0.0.1:{port}`。

已确认存在的相关端点（来自 LCU 全量文档 <https://lcu.kebs.dev/>，客户端版本 26.16）：

| 端点 | 用途 |
|---|---|
| `GET /lol-gameflow/v1/gameflow-phase` | 判断当前阶段（对局中 / 选人中 / 大厅） |
| `GET /lol-gameflow/v1/session` | 含 `queueId` → **2300 = 海克斯乱斗** |
| `GET /lol-champ-select/v1/session` | **选人阶段推荐英雄的数据基础** |
| `GET /lol-inventory/v1/cherryInventory` | 账号级海克斯库存（**非**局内三选一） |

> LCU 中**并不存在** `lol-cherry*` / `lol-kiwi*` / `lol-brawl*` / `lol-augments*` 插件命名空间。
> `cherry` 仅匹配到 `cherryInventory`（库存）；`augment` 仅匹配到云顶之弈外观相关端点。
> `kiwi` 在整个 LCU 索引中**零匹配**。

**国服特有端点（已确认存在）**——证明国服共用同一 LCU 架构并额外挂载腾讯插件：
```
GET /lol-activity-center/v1/jade-home-tencent
GET /lol-activity-center/v1/jade-home-tencent-ready
GET /lol-activity-center/v1/jade-ready
```

> Riot 原文：LCU "is not officially supported for use with third party applications"，且**不得**用它绕开 Riot 官方 API 的限流。

### 2.4 ⚠️ 国服的特殊限制（重要架构约束）

| 能力 | 国服可用性 | 说明 |
|---|---|---|
| LCU 本地 API | ✅ **可用** | 共用同一架构；已确认存在腾讯专属插件端点 |
| Live Client Data（局内） | ✅ 可用 | 本地 127.0.0.1:2999 |
| Data Dragon 静态数据 | ✅ 可用 | 官方支持 `zh_CN` |
| CommunityDragon | ✅ 可用 | CDN 直连，无区域限制 |
| **Riot 官方 Web API（含 Match-V5）** | ❌ **不可用** | Riot 路由表中**没有国服 host** |
| **腾讯一方数据接口** | ✅ **可用（已实测）** | `mlol.qt.qq.com`，含海克斯胜率/选取率，见 §4.2 |

> **关键含义**：Riot 官方 API 的平台路由表（`na1` / `kr` / `euw1` …）中**不存在** `cn1` 或国服条目。
> 国服由腾讯独立运营，因此任何依赖 **Riot Match-V5** 的方案在国服跑不通。
>
> 🔴 **修正（我曾在此处写错）**：我原先写"这也从工程上二次封死了海克斯胜率这条路"——
> **这是错误的**。腾讯有自己的数据管线（ODP），
> 其 `fuwen_aram_rune_rank_v2` 接口**公开、免鉴权、可直接调用**（已实测，见 §4.2）。
> 因此"国服拿不到数据"的论断**不成立**：Riot 的 API 没有，但**腾讯自己的有**。
>
> 结论：本项目的数据层建立在**本地 LCU + 静态 CDN 数据**之上，
> 并且**明确选择不使用**腾讯的胜率接口（政策理由，见 §4.3）。

### 2.5 WeGame 启动器（待实测）

国服通过 WeGame 启动，理论上 WeGame 可能改变客户端的启动参数或端口发现方式。

> **待你本地实测**（最简单的一步）：
> 1. 游戏运行后，查看 `LeagueClientUx.exe` 的命令行是否含 `--app-port=` 与 `--remoting-auth-token=`；
> 2. 检查安装目录下是否存在 `lockfile`。
>
> 若两者存在，则标准的 lockfile / 进程命令行取凭证方案在国服直接可用。
> 目前所有 LCU 工具在国服可用这一事实，间接支持该结论。

### 2.6 Live Client Data API（**关键限制所在**）

游戏内本地 REST：`https://127.0.0.1:2999/liveclientdata/...`

| 端点 | 提供内容 |
|---|---|
| `/allgamedata` | 全量 |
| `/activeplayer` | 自身英雄、属性、金币、等级 |
| `/playerlist` | 全部 10 人：英雄、装备、等级、符文、KDA |
| `/eventdata` | 游戏事件 |
| `/gamestats` | **`gameMode`** / `gameTime` / `mapNumber` |

**⚠️ 本项目的决定性发现**：

我抓取了 Riot 官方两份样本（`liveclientdata_sample.json`、`liveclientdata_events.json`）逐字段检查：

- `allgamedata` 的 `activePlayer` 只有 `abilities` / `championStats` / `currentGold` / `fullRunes` / `level` / `summonerName`
- `allPlayers[]` 只有 `championName` / `items` / `level` / `runes` / `scores` / `summonerSpells`
- `events` 只含 `GameStart` / `ChampionKill` / `DragonKill` / `TurretKilled` / `Multikill` / `Ace` 等常规事件

对 "augment" / "Cherry" / "Kiwi" 做**不区分大小写**检索：**零匹配**。

**结论：没有任何 augment 相关字段，也没有"海克斯选择开始"事件。**

这意味着：**无法通过合法途径知道玩家此刻被提供的 3 个海克斯是什么。**

> 🔬 **运行时自证方法**（强烈建议在真实对局中执行一次，因为官方样本可能滞后于线上版本）：
> ```powershell
> curl --insecure https://127.0.0.1:2999/swagger/v3/openapi.json
> ```
> 这返回当前安装版本的权威 spec。在其中搜索 `augment` 即可最终确认。
>
> ✅ 同时可用它确认 `gameMode` 是否返回 `"BRAWL"`。

---

## 3. Riot 政策约束（**注意其性质与适用范围**）

来源：<https://developer.riotgames.com/docs/lol>

### 3.1 先看清这些条款挂在哪个章节下

```
# Game Policy
## Use Cases for Production Keys            ← 章节上下文：申请密钥时的"用例审批"
### Examples of Approved Use Cases for Personal Keys
### Examples of Unapproved Use Cases        ← 下方这些禁令在此
```

> ⚠️ **这决定了条款的性质**：它们是 **Riot 的"应用审批标准"**
> —— 即"符合这些描述的产品，我们不予批准"。
>
> 它们**不是法律**，**也不是**"该数据不可能存在"的技术断言。
> 违反的后果是 **拿不到 Riot 认可 / 可能被要求下架**，而非承担法律责任。

### 3.2 原文引用（"不予批准"的用例）

> "Products cannot display win rates for Augments or Arena Mode items. This applies to all websites, applications and overlays."

> "Products may not provide any game-session-specific information that would be previously unknown to the player."

> "Apps that dictate player decisions."

### 3.3 另一处（Developer API Policy → Game Integrity）

> "Products must not use or incorporate information not present in the game client that would give players a competitive edge (e.g., automatically or manually allowing tracking enemy ultimate cooldowns), especially when such data is not already accessible through regular gameplay."

> "Products should not remove game decisions, but **may highlight decisions that are important and give multiple choices** to help players make good decisions."

### 3.4 同时被明确允许的（本项目的立足点）

> "Game overlays that provide static data that is available prior to the game."

### 3.5 推导出的设计约束

| 功能 | 本项目是否做 | 原因 |
|---|---|---|
| 查海克斯中文名/描述/图标/稀有度 | ✅ | 静态数据，CommunityDragon 公开 |
| 展示海克斯池（某模式有哪些海克斯） | ✅ | 静态数据 |
| 显示海克斯**胜率/选取率** | ❌ **不做** | Riot 列为不予批准的用例（**非**违法，见 §4.1） |
| 局内识别玩家当前 3 选 1 的海克斯 | ❌ **做不到** | **技术限制**：官方 API 无此数据（见 §2.6） |
| 赛前/选人阶段推荐英雄 | ✅ | 选人阶段信息对玩家可见 |
| 推荐出装（静态预设） | ✅ | 静态数据 |
| 推荐技能加点 | ✅ | 静态数据 |
| 显示敌方技能冷却 | ❌ | 政策明文点名的反面例子 |

> **设计原则**：工具应**呈现选项与依据**，而不是输出"选这个"的单一指令。
> 这既是政策鼓励的方向（"give multiple choices"），也降低合规风险。
>
> **注**：腾讯官方站 `101.qq.com` 展示了海克斯数据（见 §4.1）。
> 这**不**改变本项目的选择——腾讯是**运营方（一方）**，而我们是**第三方开发者**，
> 适用主体不同。但它确实说明"这类数据存在且可获取"，因此我们的取舍理由是
> **"不申请/不越线"，而不是"做不到"**。

---

## 4. 关于参考站 resg.top 的调研结论

你提到的参考站 **resg.top 现已失效**（`301` 跳转到 `bilibili.com`）。查证结果：

| 项 | 结论 |
|---|---|
| 性质 | **个人自制**的第三方数据站，**并非** B 站官方项目 |
| 作者 | B 站 UP 主「驻韩研究员」（`space.bilibili.com/263680381`） |
| 直接证据 | 作者教程视频正文原文：「**自制的**海斗数据网站：https://www.resg.top/」 |
| 现址 | 已迁移为 B 站小程序：`https://www.bilibili.com/toy/resg/index.html` |
| 站点定位 | 「海克斯大乱斗**英雄与强化符文**数据站」 |
| 技术形态 | 前端为**客户端渲染 SPA**，HTML 仅有 `RESG` 字符串，抓不到 `/api/` 路径 |

> `/toy/` 是 B 站的**小程序静态托管**路径——B 站只托管前端，**不代表**该项目是 B 站产品。

### 它展示了什么数据（及能否复刻）

| RESG 的功能 | 本项目能否复刻 | 原因 |
|---|---|---|
| 英雄列表、强化符文（海克斯）列表 | ✅ 可以 | CommunityDragon 公开数据 |
| 海克斯中文名 / 图标 / 稀有度 | ✅ 可以 | 同上 |
| **海克斯胜率 / 选取率 / 梯度榜** | ⚠️ **技术上完全可以**（腾讯接口已实测可用）；本项目**主动选择不做** | 见 §4.3 的政策说明 |

#### 4.1 🔴 更正：我此前两个论断都是错的

我把这一条先后写成"**数据来源非法**"和"**技术上拿不到**"，**两者都是错误的**，现更正：

**反例（用户指出，我已逐项验证）**：腾讯官方数据站 <https://101.qq.com/#/rankings/hextech>
**不仅展示海克斯数据，而且其数据接口公开、免鉴权、可直接调用**（见 §4.2）。

> 事件的完整脉络：
> 1. 我最初断言："第三方展示海克斯胜率违反 Riot 政策，且**国服技术上也拿不到**。"
> 2. 你指出腾讯官方站就在展示这类数据 → 我的"拿不到"论断动摇。
> 3. 我一度退守到"它展示的可能只是**英雄**级数据，不是**海克斯**级数据"。
> 4. 实际抓取接口后确认：**海克斯级胜率与选取率确实存在**，第 3 步的退守也不成立。
>
> **教训**：我连续三次用"推测"替代"验证"。这些结论本应通过直接调用接口来确认。

##### 已核实的 101.qq.com 事实

| 项 | 已核实内容 | 证据 |
|---|---|---|
| 站点性质 | 腾讯**官方**「攻略中心」（`lol.qq.com/main.shtml` 两处链接指向它，标注"攻略中心"） | `lol.qq.com` |
| 项目标识 | `ZMProjectConfig.project_name = "lolstrategy"`，`project_name_cn = "LOL Strategy"` | SPA 内联配置 |
| 后端 API 主机 | `https://mlol.qt.qq.com`（实测存活；错误路径返回**真实 nginx 404**） | 实测 |
| 前端资源 CDN | `https://lol.qq.com/lolstrategy/assets/<date>/strategy-*.js`（实测存在，MIME 为 JS） | 实测 |
| 构建戳 | `version.json` 返回 `{"hash":...}`（仅 75 字节，**不含** chunk 清单） | 实测 |
| **页面描述原文** | 「101英雄联盟英雄榜提供召唤师峡谷、**海克斯大乱斗**、极地大乱斗与经典模式**英雄排名**，查看Tier、**胜率、登场率、禁用率**、符文天赋与装备构筑」 | `<meta name="description">`，多次抓取一致 |

##### ⚠️ 关键区分：它做的是"模式内**英雄**榜"，**不是**"海克斯榜"

描述中每个名词都是「**英雄**」：

- 「海克斯大乱斗**英雄排名**」= **该模式下的英雄**排名
- 「海斗**英雄**」「海斗**胜率**」= 海斗模式的**英雄**胜率
- 三个比率列（胜率/登场率/禁用率）都挂在「**英雄排名**」上
- 站点覆盖**四种模式**（召唤师峡谷/海克斯大乱斗/极地大乱斗/经典），
  并有符文天赋、装备构筑 → 是一个**通用英雄数据站**，而非海克斯数据站

##### 关键区分：它同时提供「英雄级」和「海克斯级」两种数据

我第二次的"退守"（认为它只有英雄级数据）**也是错的**。实测确认两者都有：

| 数据 | 含义 | Riot 政策 |
|---|---|---|
| 海斗模式下的**英雄**胜率 | "哪个英雄在海斗里强" | **不**在禁令范围内（禁令只提 Augment / Arena items） |
| **海克斯本身**的胜率 | "哪个强化符文强" | **属于**明文禁止的 Augment win rates |

该站有三个榜单页签（源码字面量）：

```js
[{label:"海克斯榜",value:"augment"},{label:"英雄榜",value:"tier"},{label:"最佳拍档榜",value:"duo"}]
```

- **海克斯榜** = 海克斯级胜率/选取率 ← **属于** Riot 禁令范围
- **英雄榜** = 模式内英雄 Tier/胜率 ← **不**在禁令范围

##### 完整取证报告

详细取证（含所有 URL 的实测状态、JS chunk 摘录、字段逐项解码、
CONFIRMED 与 UNVERIFIED 的区分）另见：[101qq-api-findings.md](101qq-api-findings.md)

##### 政策条款的准确定位

回到 Riot 官方文档的**章节层级**：

```
# Game Policy
## Use Cases for Production Keys            ← 章节上下文：申请密钥时的用例评估
### Examples of Approved Use Cases for Personal Keys
### Examples of Unapproved Use Cases        ← 海克斯胜率禁令在此
```

1. **禁令位于"Game Policy → Use Cases for Production Keys"之下**，
   本质是**应用审批标准**（"我们不会批准做这件事的产品"），
   **不是**法律声明，**也不是**"该数据不可能存在"的技术断言。

2. **腾讯不受该文档约束**。国服由腾讯作为**运营方**独立运营，
   腾讯发布自己游戏的数据是**一方行为**；
   而 Riot 开发者政策约束的是**第三方开发者**。适用主体不同。

3. 因此"违反政策"≠"违法"。前者是**合同/ToS 层面**（后果：不予注册、要求下架），
   后者才涉及法律责任。**我之前把两者混为一谈，是错误的。**

#### 4.2 🔴 已实测确认：该 API 真实可用（含胜率与选取率）

我已**亲自调用**下述端点，返回 HTTP 200、无需任何鉴权（无 token / referer / cookie）：

```
GET https://mlol.qt.qq.com/go/battle_info/odp_proxy/fuwen_aram_rune_rank_v2?augmentid_level=255
```

返回结构：

```jsonc
{"code":0,"errMsg":"","result":0,
 "data":{"_fieldValues":{"R15381":"{\"dtstatdate\":\"20260924\",\"augmentlist\":\"...\"}"}}}
```

`augmentlist` 是 `#` 分隔的扁平串，每条记录 `_` 分隔，字段依次为：

```
augmentId _ rarityLevel _ pickRate _ pickRank _ pickRankChange _ winRate _ winRank _ winRankChange _ topChamps(csv)
```

真实样本（首行 / 末行）：

```
1238_255_0.646_1_0_0.6541_1_0_22,30,63,17,136,238     ← 选取率 64.6%，胜率 65.41%，选取/胜率双第 1
1187_255_0.007_210_0_0.4796_183_4_875,64,54,141,53,122 ← 选取率 0.7%，胜率 47.96%
```

- 该串含 **219 个海克斯**，`dtstatdate: "20260924"` 为统计日期
- **海克斯 ID 与 CommunityDragon `cherry-augments.json` 的 `id` 完全对应**
  （已实测校验：`1205` → `ARAM_ADAPt` → 「物理转魔法」）
  → **可直接 join 拿到中文名、图标、稀有度**

**前端三个榜单标签页**（来自 `HextechRankView` chunk 字面量）：

```js
[{label:"海克斯榜",value:"augment"},{label:"英雄榜",value:"tier"},{label:"最佳拍档榜",value:"duo"}]
```

「海克斯榜」表格列：

```js
[{title:"排名",key:"rank"},{title:"品质",key:"rarity"},{title:"海克斯强化",key:"augment"},
 {title:"胜率",key:"winRate",sorter:true},{title:"选取率",key:"pickRate",sorter:true},
 {title:"最适配英雄",key:"bestChamps"}]
```

**其余三个同源端点**（源码字面量已确认路径，但**未逐个实测**）：

| 路径 | 用途 |
|---|---|
| `/go/battle_info/odp_proxy/fuwen_aram_rune_rank_v2` | **海克斯榜**（胜率/选取率）— ✅ 已实测 |
| `/go/battle_info/odp_proxy/fuwen_aram_hero_rank_v2` | 英雄榜（模式内英雄 Tier/胜率） |
| `/go/battle_info/odp_proxy/fuwen_aram_hero_parttner` | 最佳拍档榜（英雄组合胜率） |
| `/go/battle_info/odp_proxy/fuwen_hero_rank` | 单英雄详情（含该英雄顶级海克斯） |

> ⚠️ 后三条为**源码字面量**（`T`/`R`/`M`/`Z` 常量），标注为 **源码已确认 / 运行时未验证**。

#### 4.3 这对本项目的实际含义（结论已更新）

| 问题 | 准确回答 |
|---|---|
| 海克斯胜率数据"违法"吗？ | ❌ **不违法**。属 ToS 适用范围问题 |
| 该数据"技术上拿不到"吗？ | ❌ **完全错误**。腾讯一方 API **公开、免鉴权、可直接调用** |
| 国服能拿到海克斯胜率吗？ | ✅ **能**。上表端点即是一方数据源（**非** Riot Web API） |
| 第三方工具能展示吗？ | ⚠️ Riot 将"第三方展示海克斯胜率"列为**不予批准的用例** |

> 🔴 **重要修正**：我此前写的"国服拿不到数据 / 数据来源非法"**两条都是错的**。
> 事实是：**数据完全可得**（腾讯一方 ODP 接口，GET + JSON + 无鉴权）。
>
> 因此本项目不做胜率的理由，**纯粹是政策选择，没有任何"技术不可行"的遮挡**。
> 这是一个**主动的自我约束**，而非能力缺陷 —— 描述项目时应当如实说明这一点。
>
> 若未来要做该功能，正确路径是**向 Riot 开发者门户申请并取得明确认可**；
> 但需注意：申请对象是 Riot，而**腾讯的接口并不因此获得 Riot 的授权效力** ——
> 二者是两套独立的权利体系，不能互相背书。

---

## 5. "虎牙内置工具"是怎么做到的（已确认：截屏 + OCR）

**用户确认**：此前调研过，虎牙助手用的是**截屏 + OCR** 方案。

这把本项目的一条关键推论从"推断"升级为"有依据的确认"：

```
官方 API 不提供局内三选一   ←  已实测（swagger 24 端点/24 schema 零命中 + 官方样本）
        +
虎牙作为成熟产品仍需截屏+OCR ←  侧面印证：确实没有更好的合法数据源
        ↓
结论：局内三选一只能靠"读屏幕像素"获得
```

**含义**：如果连腾讯生态内的虎牙都要用截屏 OCR，说明：
1. **不存在**我们没发现的"隐藏 API"（已排除 `/Help` 原生 API 的可能性——
   虎牙有更强的逆向能力，若存在早用了）
2. OCR 是该数据点**唯一**的获取途径
3. **残留项（/Help 探测）可以从"必须验证"降级为"低优先级"**：
   结果几乎必然是"无"，因为虎牙的行为已经给出了工程界的答案

### 为什么本项目仍不采用 OCR

即便不读内存、不碰游戏进程，OCR 方案仍有三个问题：

1. **合规实质**：识别出三选一后必然要做"推荐"，而政策禁止
   "Apps that dictate player decisions"。展示+推荐与纯展示之间没有干净的界线。
2. **工程脆弱**：依赖 UI 像素位置，分辨率/缩放/UI 改版即失效——
   每个版本都要维护模板库，长期成本高。
3. **准确率上限**：海克斯名称含生僻字（如"沃格勒特的巫师帽"），
   OCR 在小字号+深色背景下的错误率不可忽视；
   识别错一个字，推荐就是误导。

> **结论**：本项目维持不采用 OCR。非目标已记录于 §7.C。
> `/Help` 残留项降级为低优先级（虎牙的方案选择已是强证据）。

---

## 6. 悬浮窗渲染方案

**好消息**：做悬浮窗本身**不需要**碰游戏进程。

LoL 实际以**无边框窗口（Borderless）**运行，由 DWM 合成，因此普通置顶窗口可以覆盖其上：

| 方案 | 说明 | 评价 |
|---|---|---|
| **Electron `transparent + alwaysOnTop + frameless`** | 跨平台，前端技术栈 | ✅ **推荐**：与数据站共用 UI 技术栈 |
| Win32 分层窗口 (`WS_EX_LAYERED` + `WS_EX_TOOLWINDOW` + `WS_EX_TRANSPARENT` + `WS_EX_NOACTIVATE`) | 原生、最省资源 | ✅ 可选，需 C#/C++/Rust |
| DirectComposition（合成器层） | 帧率最优 | ⚠️ 工程量最大，本项目过重 |
| 注入 (DLL injection / DirectX hook) | 绘制在游戏内 | ❌ **禁止**，反作弊目标 |

关键实现要点：
- Electron：`transparent: true` + `frame: false` + `skipTaskbar: true`，并调用
  `setAlwaysOnTop(true, 'screen-saver')`；鼠标穿透用 `setIgnoreMouseEvents(true, { forward: true })`
- **绝对不要抢焦点**：`focusable: false`，且不要用带焦点的 `show()`，否则游戏会丢失输入
- Win32 路线用 `WS_EX_NOACTIVATE` + `WS_EX_TOOLWINDOW`（不出现在 Alt-Tab）
- 需处理**多显示器 / DPI 缩放**，按游戏窗口矩形定位（多显示器需按显示器分别算 DPI）
- 定位游戏窗口：`FindWindow` 找 `RiotWindowClass`
- ⚠️ **不要打开游戏进程句柄**。LoL 在多数服务器带内核级反作弊（Vanguard）。
  严格停留在**操作系统窗口层**是最安全姿态。

> 本节内容基于 Win32/DWM 平台常识，**未从一手官方文档取得**，属工程经验判断，**建议实测验证**。

---

## 7. 建议的产品形态（重新定义后的可行版）

既然"局内实时海克斯推荐"不可行，把价值前移 + 后移：

### A. 数据站（功能 1）
- 海克斯图鉴：中文名、图标、稀有度、所属模式池（KIWI/KIWI_JADE/CHERRY）
- 英雄 × 海克斯**适配标签**（机制性说明，如"需要攻速"、"适配技能急速"）—— **不是胜率**
- 装备/符文/召唤师技能中文数据查询
- 数据自动同步（CDragon 每次补丁更新）

### B. 游戏内悬浮窗（功能 2，重新定位为**决策辅助**）
- **选人阶段**（LCU `champ-select`）：依据己方/敌方阵容推荐英雄候选，展示多个选项及理由
- **对局中**：显示本模式**完整海克斯池**，供玩家在 3 选 1 时自行查阅与判断
- 静态出装、技能加点、符文推荐（赛前可见信息）
- 明确的免责声明与合规声明

### C. 不做（明确非目标）

> ⚠️ **这些是主动的政策选择，不是技术做不到。** 尤其是第 1 条：
> 腾讯一方接口 `mlol.qt.qq.com` 已实测可公开、免鉴权获取海克斯胜率/选取率
> （见 §4.2）。我们**刻意不使用**它。

- ❌ **海克斯胜率/选取率** —— Riot 列为不予批准的用例（§3.2）
  - 注意：即便不展示"胜率"数字，**用它来给海克斯排序**同样属于该禁令的实质
    （政策原文针对的是"display win rates"这一行为，排序/推荐是其等价形式）
- ❌ **自动识别玩家当前 3 选 1 选项** —— 技术上也不可行（§2.6）
- ❌ 读内存 / 注入 / 封包解析 / OCR 抢答
- ❌ 敌方冷却追踪

> **关于"英雄榜"的界定（重要，避免自我设限过度）**：
> Riot 禁令的措辞是 "win rates for **Augments** or **Arena Mode items**"，
> 并未涵盖"某模式下的**英雄**胜率"。
> 因此理论上"海斗模式英雄 Tier 榜"**可能**不在禁令范围内 —— 但这属于**解释空间**，
> 且我们需要的是腾讯的数据、却不是腾讯的身份。
> **建议**：v1 先不碰任何胜率类数据；若要扩展，**先向 Riot 开发者门户咨询后再做**。

---

## 8. 待办与风险

### ✅ 环境问题：已解决

早前的两个环境故障**均已消失**（随着权限策略改为完全访问）：

| 故障 | 状态 |
|---|---|
| `SetNamedSecurityInfoW failed (Win32 5)` ACL 报错 | ✅ 已消失 |
| TLS 对**所有**站点握手失败 | ✅ 已消失 |

**实测结果（全部通过）**：

| 检查项 | 结果 |
|---|---|
| `pwsh` 执行 | ✅ 正常 |
| TLS → `baidu.com` / `api.github.com` | ✅ 200 |
| TLS → `mlol.qt.qq.com`（腾讯数据接口） | ✅ 200 |
| TLS → CommunityDragon | ✅ 200 |
| Node | ✅ v24.21.0 |
| Python | ✅ 3.12.14 |
| git | ✅ 2.53.0 |

**数据管线端到端已跑通**（Python 实测）：

```
[tencent] statdate=20260924  augments=211
[cdragon] augment defs=554
[join]    matched=211/211          ← 100% 匹配
```

校验样例：`id 1205` → 「物理转魔法」，胜率 55.85% —— 与 CDragon 定义一致。
胜率榜首：质变：棱彩阶 65.41%、缩小引擎 61.48%、亮出你的剑 60.98%。

> 结论：**数据层技术上完全可行**。是否使用该类数据**纯粹是政策决策**（见 §4.3）。

### 🟡 仍需确认的问题（按优先级）

| # | 问题 | 为何重要 | 怎么确认 |
|---|---|---|---|
| 1 | 国服"海克斯乱斗"对应 `KIWI` 还是 `KIWI_JADE`？ | 决定图鉴收录哪些海克斯 | 对照客户端内实际出现的海克斯，或读 `/liveclientdata/gamestats` 的 `gameMode` |
| 2 | 海克斯**中文名**的确切来源？ | `nameTRA` 是本地化 key，非最终中文 | 对比客户端内实际显示名 |

> ✅ **已解决**：
> - 模式代号（`KIWI`/`KIWI_JADE`/`CHERRY`）已确认
> - 官方模式识别方式（`gameMode: "BRAWL"` / `queueId: 2300`）已确认
> - **海克斯胜率数据的可得性**已实测确认（腾讯一方接口，见 §4.2）
> - **LCU 在国服（WeGame）可用**已实测确认（命令行含 token，返回召唤师信息）✅
> - **WeGame 未改变 LCU 启动参数** ✅
> - 局内三选一不可得（官方样本无 augment 字段）已确认（待对局中复核）
>
> ✅ **局内 swagger 已在线上版本验证**（用户于真实对局中执行）：
> `/swagger/v3/openapi.json` 返回 24 个端点、24 个 schema，
> 检索 `augment` / `cherry` / `kiwi` / `hextech` / `brawl` **全部零命中**。
>
> ✅ **虎牙侧证**（用户确认）：虎牙助手采用**截屏 + OCR** 方案实现局内识别。
> 作为成熟产品仍需 OCR，说明不存在我们遗漏的隐藏 API。
> 原生 API（`/Help`）探测从"必须验证"**降级为低优先级**（结果几乎必然为"无"）。
>
> **结论：局内三选一不可得的判断，已具备完整证据链**：
> 官方样本 + 线上 swagger 实测 + 成熟产品的方案选择，三方一致。

### 合规待办（上线前）
- 面向玩家的产品**必须注册** Riot 开发者应用 —— 政策原文：
  "If your product serves players, you must register it with us **regardless of whether or not your product uses official documented APIs**."
- 产品显著位置必须附带 Riot 标准声明（格式见 `README.md`）。
- 若使用 LCU，按政策需一并声明。
- 如需上线悬浮窗形态，**建议先取得 Riot 明确认可**：
  "must not use or incorporate information not present in the game client" 这一条解释空间很宽。
- ❌ **不要调用腾讯的胜率接口**（`mlol.qt.qq.com/.../fuwen_aram_rune_rank_v2`）。
  它是腾讯的一方接口，**不构成对第三方的授权**；我们既非腾讯，也不受其数据授权覆盖。

### 环境风险
- CommunityDragon 官方公告其服务器硬件老化、正在募资升级
  → 建议**本地缓存**全部静态数据，并准备 Data Dragon 作为降级数据源。
- 国服由腾讯独立运营，需实测验证（见上表 #3）。

### ✅ LCU 探测结果（国服 · WeGame，已实测）

用 `packages/lcu` 在**真实运行的国服客户端**上探测，结果见
[docs/lcu-probe-findings.md](lcu-probe-findings.md)。要点：

| 项 | 结果 |
|---|---|
| LCU 端口发现 | ✅ **可行**：监听端口 `56695`（归 `LeagueClient.exe`） |
| 进程命令行读 `--app-port` / `--remoting-auth-token` | ⚠️ **读不到**（当前会话非管理员，Windows 屏蔽 `CommandLine`） |
| lockfile | ⚠️ **被清空为 0 字节**（`LeagueClient\lockfile` 与 `lockfile_` 均空） |
| 有效 lockfile | 仅 `Riot Client Data\...\lockfile` 有内容，但那是 **Riot Client** 的，非 LCU |

> 🔴 **新发现（国服特有）**：WeGame 环境下 **LCU 的 lockfile 被清空**（0 字节），
> 与标准 Riot 客户端行为不同。
> 但**命令行探测完全可用**（需管理员），因此 lockfile 不是必需路径。

### ✅ LCU 已打通（管理员运行后，用户实测）

```
[1] 探测凭证
  port   13161
  来源   进程命令行 (pid 30108)     ← LeagueClientUx.exe
  ✓ 凭证可用
[2] 连通性
  当前召唤师  小泥人蹲着#86079
  ✓ LCU 可访问
```

| 原待验证项 | 结果 |
|---|---|
| 命令行含 `--app-port` / `--remoting-auth-token`？ | ✅ **确认含** |
| WeGame 是否改变 LCU 启动参数？ | ✅ **没有** —— 与官方一致 |
| LCU 是否可访问？ | ✅ 可访问 |

> **结论：国服（WeGame）下 LCU 完全可用，无需特殊适配。**
> 之前的障碍纯粹是"当前会话非管理员"，不是 WeGame 的问题。
>
> ⚠️ 期间还修正了一个 bug：端口发现曾误选 56695（实为 13161）。
> `LeagueClient.exe` 监听多个端口，需以"返回 401"判定真正的 LCU。
> 详见 [docs/lcu-probe-findings.md](lcu-probe-findings.md)。

---

## 9. 附录：已核实的证据链接

**Riot 官方**
- 政策与 API 文档（含 Live Client Data API）：<https://developer.riotgames.com/docs/lol>
- 游戏模式常量（证 `BRAWL`）：<https://static.developer.riotgames.com/docs/lol/gameModes.json>
- 队列常量（证 `queueId 2300`）：<https://static.developer.riotgames.com/docs/lol/queues.json>
- 官方 Live Client 样本（**证无 augment 字段**）：<https://static.developer.riotgames.com/docs/lol/liveclientdata_sample.json>
- 官方事件样本（**证无海克斯选择事件**）：<https://static.developer.riotgames.com/docs/lol/liveclientdata_events.json>

**数据源**
- CommunityDragon RAW：<https://raw.communitydragon.org/latest/>
- 海克斯定义（含中文名）：<https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/zh_cn/v1/cherry-augments.json>
- 模式海克斯池（CHERRY/KIWI/KIWI_JADE）：<https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/zh_cn/v1/augment-lists.json>
- Data Dragon 版本列表：<https://ddragon.leagueoflegends.com/api/versions.json>

**LCU**
- LCU 入门（Hextechdocs）：<https://hextechdocs.dev/getting-started-with-the-lcu-api/>
- LCU 全量端点文档：<https://lcu.kebs.dev/>

**参考站 resg.top**
- 现址（B 站小程序，仅 SPA 外壳）：<https://www.bilibili.com/toy/resg/index.html>
- 作者说明视频（"自制"出处）：<https://www.bilibili.com/list/263680381?oid=116894447243327&bvid=BV1NENE6rEyE>
