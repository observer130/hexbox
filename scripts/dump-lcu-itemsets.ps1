# 配装方案写入：schema 提取（可选，仅在需要时运行）
#
# 现状：
#   - OPTIONS /lol-item-sets/v1/item-sets/{id}/sets 返回
#     "Allow: GET OPTIONS POST PUT"  => 写入受支持（已确认）
#   - GET 同一路径可正常返回 { accountId, itemSets, timestamp }（已确认）
#
# 因此**不需要**再从 /help 抠 schema 也能实现。
# 本脚本用于：把你在游戏里手动保存的配装方案**读回来**，
# 作为写入格式的权威参照（比照社区记忆更可靠）。
#
# 用法（管理员 PowerShell）：
#   1. 先在游戏内「收藏 - 配装方案」里手动新建并保存一个方案
#   2. 运行本脚本，把输出贴回来
#
#   pwsh -File scripts\dump-lcu-itemsets.ps1

$ErrorActionPreference = 'Continue'
$out = Join-Path $PSScriptRoot 'lcu-itemsets-dump.txt'
'' | Set-Content $out -Encoding utf8
function Log($m) { Write-Host $m; Add-Content $out $m -Encoding utf8 }

$proc = Get-CimInstance Win32_Process -Filter "Name='LeagueClientUx.exe'" | Select-Object -First 1
if (-not $proc -or -not $proc.CommandLine) { Log '读不到命令行 —— 请用管理员身份运行。'; return }
$cmd = $proc.CommandLine
$port  = [regex]::Match($cmd, '--app-port=(\d+)').Groups[1].Value
$token = [regex]::Match($cmd, '--remoting-auth-token=([\w-]+)').Groups[1].Value
$auth = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("riot:$token"))
$hdr  = @{ Authorization = "Basic $auth" }
$base = "https://127.0.0.1:$port"
Log "LCU port=$port"

# ---- 1) 召唤师 ----
$me = $null
try {
  $me = Invoke-RestMethod -Uri "$base/lol-summoner/v1/current-summoner" -Headers $hdr -SkipCertificateCheck
  Log "`nsummonerId=$($me.summonerId)  accountId=$($me.accountId)  displayName=$($me.displayName)"
} catch { Log "取召唤师失败: $($_.Exception.Message)"; return }

# ---- 2) 读取现有配装方案（核心：这是写入格式的权威参照）----
Log "`n=== 当前配装方案（原样 JSON）==="
$sid = $me.summonerId
try {
  $sets = Invoke-RestMethod -Uri "$base/lol-item-sets/v1/item-sets/$sid/sets" -Headers $hdr -SkipCertificateCheck
  Log ($sets | ConvertTo-Json -Depth 30)

  $n = 0
  if ($sets.itemSets) { $n = @($sets.itemSets).Count }
  Log "`n方案数量: $n"
  if ($n -eq 0) {
    Log "（空 —— 请先在游戏内手动保存一个配装方案，再重跑本脚本）"
  } else {
    Log "`n=== 第一套方案的字段名（用于对照实现）==="
    $first = @($sets.itemSets)[0]
    Log ($first.PSObject.Properties | ForEach-Object { "$($_.Name) : $($_.Value.GetType().Name)" } | Out-String)
  }
} catch { Log "读取失败: $($_.Exception.Message)" }

# ---- 3) 探测支持的方法 ----
Log "`n=== HTTP 方法 ==="
try {
  $r = Invoke-WebRequest -Uri "$base/lol-item-sets/v1/item-sets/$sid/sets" -Method Options -Headers $hdr -SkipCertificateCheck
  Log "OPTIONS -> $($r.StatusCode)  Allow: $($r.Headers['Allow'])"
} catch { Log "OPTIONS 失败: $($_.Exception.Message)" }

# ---- 4) 顺带：召唤师技能相关端点是否存在（选人阶段推荐要用）----
Log "`n=== 召唤师技能相关端点探测（401=存在）==="
foreach ($u in @(
  '/lol-champ-select/v1/session',
  '/lol-summoner/v1/current-summoner',
  '/lol-perks/v1/pages'
)) {
  try {
    $r = Invoke-WebRequest -Uri "$base$u" -Headers $hdr -SkipCertificateCheck -ErrorAction Stop
    Log "  $u -> $($r.StatusCode) 存在"
  } catch {
    $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 'ERR' }
    Log "  $u -> $code"
  }
}

Log "`n完成: $out"
Write-Host "`n请把文件内容贴回来: $out" -ForegroundColor Green
