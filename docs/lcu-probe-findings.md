# LCU 探测结果（国服 · WeGame 启动）

> 探测时间：2026-09-25
> 环境：英雄联盟（国服，E:\Games\WeGameApps\英雄联盟），经 **WeGame** 启动，客户端运行中
> 工具：`packages/lcu`

## 结论速览

## 🟢 已解决（管理员运行后）

**用户以管理员身份运行探测，全部打通：**

```
[1] 探测凭证
  port                     13161
  来源                       进程命令行 (pid 30108)
  ✓ 凭证可用

[2] 连通性 —— /lol-summoner/v1/current-summoner
  当前召唤师                    小泥人蹲着#86079
  ✓ LCU 可访问

[3] 游戏流状态
  （无进行中的对局/会话）
```

| # | 待验证问题 | 结果 |
|---|---|---|
| 1 | `LeagueClientUx.exe` 命令行含 `--app-port` / `--remoting-auth-token`？ | ✅ **确认含**（管理员下可读）→ 标准方案在国服**直接可用** |
| 2 | LCU 是否可访问？ | ✅ **可访问**（返回召唤师 `小泥人蹲着#86079`） |
| 3 | WeGame 是否改变 LCU 启动参数？ | ✅ **没有改变** —— 参数格式与官方一致 |
| 4 | LCU 端口是否可发现？ | ✅ 可以（见下方端口判定修正） |
| 5 | 局内 swagger 是否含 augment 字段？ | ✅ **已确认无**（24 端点/24 schema，零命中） |
| 6 | 原生 API（/Help）是否有 augment？ | ⏬ **降级为低优先级** —— 虎牙采用截屏+OCR（用户确认），侧面印证无隐藏 API |

> ✅ **结论：国服（WeGame）环境下 LCU 完全可用**，且无需任何特殊适配。
> 之前的障碍**纯粹是当前会话非管理员**，不是 WeGame 的问题。

## 🔧 修正：端口发现曾选错端口

初版 `detectPortByListener()` 取"最大端口"，返回 **56695** —— **错的**。

实测：`LeagueClient.exe` 监听**多个**端口：

```
候选端口: [56695, 40017, 30183, 13161]
```

其中：
- **13161** → 无凭证请求返回 **401**（服务存在、需鉴权）＝ **真正的 LCU**
- 56695 → 超时
- 40017 → SSL 握手失败

修正后：改为**逐个探测**，以"返回 401"为判定标准。验证：

```
候选端口: [{"port":56695,...},{"port":40017,...},{"port":30183,...},{"port":13161,...}]
判定为 LCU 的端口: 13161 (pid 28932)   ✅
```

> 注意真实拓扑：`--app-port=13161` 来自 `LeagueClientUx.exe`（pid 30108），
> 但**实际监听**该端口的是 `LeagueClient.exe`（pid 28932）。二者是父子进程关系。
> 因此按进程名过滤时不能用 `LeagueClientUx`。

## ✅ 局内 swagger 已验证（真实对局，用户执行）

用户在一场**真实游戏进行中**执行了：

```powershell
curl --insecure https://127.0.0.1:2999/swagger/v3/openapi.json
```

返回的 OpenAPI 3.0.0 文档（`info.title = "LoLClient"`, version 1.0.0）经逐项核对：

### `paths` 全部端点（共 24 个）

```
builtin 元操作 : /AsyncDelete /AsyncResult /AsyncStatus /Cancel /Exit /Help
                 /Subscribe /Unsubscribe /async/v1/result/{t} /async/v1/status/{t}
liveclientdata : /activeplayer /activeplayerabilities /activeplayername
                 /activeplayerrunes /allgamedata /eventdata /gamestats
                 /playeritems /playerlist /playermainrunes /playerscores
                 /playersummonerspells
swagger        : /v1/api-docs /v1/api-docs/{api} /v2/swagger.json /v3/openapi.json
```

### `components.schemas` 全部类型

```
AbilityResource, BindingAsyncCancelEvent, BindingAsyncFailureEvent,
BindingAsyncState, BindingCallbackEvent, BindingFullApiHelp,
BindingFullArgumentHelp, BindingFullEnumValueHelp, BindingFullEventHelp,
BindingFullFieldHelp, BindingFullFunctionHelp, BindingFullTypeHelp,
BindingFullTypeIdentifier, BindingGenericAsyncEvent, BindingGenericEvent,
BindingHelpFormat, Color, RemotingHelpFormat, RemotingPrivilege,
RemotingSerializedFormat, TeamID, Vector2f, Vector3f, Vector4f
```

### 🔴 结论：确认无 augment 相关字段

对整份文档检索，以下关键词**全部未出现**：

```
augment ✗   cherry ✗   kiwi ✗   hextech ✗   brawl ✗
```

> ✅ **这从线上版本最终确认了 §2.6 的结论**：
> 官方 Live Client Data API **不提供**"玩家当前被提供的 3 个海克斯"，
> 也没有海克斯选择相关事件。**局内自动识别不可行**（除非读内存/OCR，已排除）。
>
> 此前结论基于官方已发布样本，可能滞后于线上版本 —— **该疑虑现已消除**。

### ⚠️ 但发现一个此前遗漏的接口：`/Help`（tag `builtin`）

swagger 显示存在原生 remoting 元操作：

| 端点 | 说明 |
|---|---|
| `/Help` | "Returns information on available functions and types" —— 可列出游戏客户端**全部**原生函数与类型 |
| `/Subscribe` | 订阅任意事件（param: `eventName`） |

**这意味着 `liveclientdata` 只是冰山一角**——完整的原生 API 表面可能更大，
`/Help?format=Full` 才是全量清单。

> ⏳ **待验证**：下次对局中执行
> ```powershell
> curl --insecure -X POST "https://127.0.0.1:2999/Help?format=Full"
> ```
> 检索返回中是否含 augment / cherry / kiwi。
>
> **这是唯一尚未排除的可能性** —— 若 `/Help` 里也没有，则"局内拿不到三选一"
> 就是**彻底定论**，没有任何合法途径。
>
> 注意：即便 `/Help` 暴露了相关函数，仍需评估其是否属于
> "官方公开 API"（`liveclientdata` 才是 Riot 文档化的部分）。

（原结论仍成立，仅作为降级路径的说明保留）

`LeagueClient\lockfile` 与 `lockfile_` 均为 **0 字节**；
有效的只有 `Riot Client Data\...\lockfile`，但那是 **Riot Client** 的。

不过**命令行探测已足够**，lockfile 不再是必需路径。

---

## 1. 进程命令行：非管理员读不到

```
Get-CimInstance Win32_Process -Filter "Name='LeagueClientUx.exe'"
  → CommandLine     : (空)
  → ExecutablePath  : (空)
Get-Process LeagueClientUx
  → Path            : (空)
```

**原因**：当前会话**非管理员**（`IsAdmin: False`）。
Windows 对**非本用户且未提权**的进程查询会屏蔽 `CommandLine` 与 `ExecutablePath`。
这是**环境权限问题，不是 WeGame 改变了启动参数**。

> ✅ 官方方式本应返回 `--app-port=...` 与 `--remoting-auth-token=...`。
> **建议**：以管理员身份重跑探测即可确认。

## 2. lockfile 被清空（重要，国服特有现象）

扫描到的 lockfile 候选：

| 路径 | 大小 | 说明 |
|---|---|---|
| `...\LeagueClient\lockfile` | **0** | LCU 的 lockfile，**为空** |
| `...\LeagueClient\lockfile_` | **0** | 备份，也为空 |
| `...\Riot Client Data\Metadata\riot client\lockfile` | **0** | 空 |
| `...\Riot Client Data\User Data\Config\lockfile` | **52** | ✅ **有效，但这是 Riot Client** |

有效的那个内容（已脱敏展示结构）：

```
Riot Client:31620:14890:<token>:https
            ↑pid   ↑port
```

这是 **Riot Client**（pid 31620）的锁文件，**不是 LCU 的**。
用它访问 LCU 路径会返回 404；用它的 token 访问 LCU 端口会超时（鉴权失败）。

> ⚠️ **关键发现**：国服 WeGame 环境下，**LCU 的 lockfile 被清空为 0 字节**。
> 这与标准 Riot 客户端行为不同 —— 标准客户端会在 lockfile 写入
> `LeagueClient:<pid>:<port>:<password>:https`。
>
> 可能原因：WeGame 启动器为避免第三方工具接入而清空，或使用了不同的凭证传递机制。

### 文件被占用

直接读取会报：

```
The process cannot access the file '...lockfile'
because it is being used by another process.
```

需用共享模式打开（`FileShare.ReadWrite`）—— 已在探测工具中处理。

## 3. LCU 端口：可通过监听端口发现 ✅

即使没有 lockfile，仍可从 TCP 监听端口定位 LCU：

```
Get-NetTCPConnection -State Listen | Where LocalAddress -eq '127.0.0.1'

LocalPort  OwningProcess
---------  -------------
    56695          28932   ← LeagueClient.exe（LCU）
    40017          28932
    30183          28932
    14890          31620   ← Riot Client
```

**LCU 端口 = 56695**（归 `LeagueClient.exe` pid 28932）。

> 这是可靠的发现方式，不依赖 lockfile。

## 4. 待验证：局内 swagger（需真实对局）

此前结论（官方样本无 augment 字段）需在线上版本复核。
LCU 的 2999 端口**仅在游戏中存在**，需在一场真实海克斯乱斗对局中执行：

```powershell
curl --insecure https://127.0.0.1:2999/swagger/v3/openapi.json
```

然后在输出中检索 `augment` / `cherry` / `kiwi`。
同时可确认 `/liveclientdata/gamestats` 的 `gameMode` 是否为 `BRAWL`。

---

## 下一步（按优先级）

1. **以管理员身份重跑探测** → 确认命令行是否含 `--app-port` / `--remoting-auth-token`
   - 若含，则标准取凭证方案在国服**直接可用**，问题仅是我当前无权限
   - 若不含，则需研究 WeGame 的凭证传递机制
2. **真实对局中验证 2999 端口**（回答 augment 字段问题）

## 附：探测工具

### ⚠️ 重要：`pnpm` 与 `powershell.exe` 都不在 PATH 上

在用户终端实测：`pnpm` 未安装（只存在于 DSH 内置运行时），
且 PATH 中**不含** `powershell.exe`。因此：

```powershell
# ❌ 这样会失败
pnpm --filter @hexbox/lcu probe --install-dir "..."
# 报错: 术语 'pnpm' 不会被识别
```

**请用这个（已实测可用）**：

```powershell
node --experimental-strip-types "D:\Projects\hexbox\packages\lcu\src\cli.ts" --install-dir "E:\Games\WeGameApps\英雄联盟"
```

系统 Node 位于 `C:\Program Files\nodejs\node.exe`（v24.19.0），已在 PATH。

### 已修复的坑：硬编码 `powershell.exe`

初版用 `execFile('powershell.exe', ...)`，在 PATH 不含它的环境下会
`spawn ENOENT`，且错误被 `catch` 静默吞掉 —— 表现为"探测不到端口"却不报错，
极易误判为"客户端没启动"。

修复：`resolvePowershell()` 按固定路径解析

```
%windir%\System32\WindowsPowerShell\v1.0\powershell.exe
%windir%\SysWOW64\WindowsPowerShell\v1.0\powershell.exe
powershell.exe   ← PATH 兜底
```

同时修掉原查询的引号语法错误（`Name='..."` 缺右引号）。

### PATH 中的坏条目（与本项目无关，但建议清理）

```
D:\Softwares\node.js\"      ← 尾部多了引号，且目录不存在
```

### 工具能力

- 进程命令行探测（**需管理员**）
- lockfile 共享读取（客户端独占打开，用 `FileShare.ReadWrite`）
- **监听端口发现**（不依赖 lockfile / 权限）✅ 国服实测有效
- 递归查找有效 lockfile（排除 Riot Client 的）
