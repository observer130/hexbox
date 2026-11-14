# 真机验收前置检查（P1 验收 / 一局全链路）
#
# 用法（**以管理员身份**打开 PowerShell，仓库根或任意目录均可）：
#   powershell -ExecutionPolicy Bypass -File scripts\preflight-acceptance.ps1
#
# 它只做**只读检查**并打印本次验收要用的启动/回放命令，不启动游戏、不启动覆盖层。
# 退出码：0 = 可以上机（警告项自行判断），1 = 有硬阻塞（先修再上机）。
#
# 为什么需要它：真机验收最贵的成本是"坐到电脑前才发现数据过期/模板缺失/
# 不是管理员/录制没开"，而这些都能在 2 秒内查出来。

param(
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$dataDir = Join-Path $repo 'data'
$sessionDir = Join-Path $repo 'debug\sessions'
$logFile = Join-Path $repo 'debug\p1.log'

$problems = New-Object System.Collections.Generic.List[string]
$warns = New-Object System.Collections.Generic.List[string]

function Add-Problem([string]$text) {
  $problems.Add($text)
  if (-not $Quiet) { Write-Host "  ✗ $text" -ForegroundColor Red }
}
function Add-Warn([string]$text) {
  $warns.Add($text)
  if (-not $Quiet) { Write-Host "  ⚠ $text" -ForegroundColor Yellow }
}
function Add-Ok([string]$text) {
  if (-not $Quiet) { Write-Host "  ✓ $text" -ForegroundColor Green }
}

Write-Host ''
Write-Host '== hexbox 真机验收前置检查 ==' -ForegroundColor Cyan
Write-Host "仓库：$repo"

# ── 1. 管理员（读 LCU 进程命令行/凭证的前提）────────────────────────────
Write-Host '-- 运行环境'
try {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $isAdmin = (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
  if ($isAdmin) { Add-Ok "管理员：是（$($id.Name)）" }
  else {
    Add-Problem '不是管理员：读不到 LCU 凭证 → 选人/局内标签都不会出现。请以管理员身份重开 PowerShell'
  }
} catch {
  Add-Warn "无法判断管理员身份：$($_.Exception.Message)"
}

try {
  $nodeVersion = (& node --version 2>$null).Trim()
  $pnpmVersion = (& pnpm --version 2>$null).Trim()
  if ([string]::IsNullOrWhiteSpace($nodeVersion)) {
    Add-Problem '找不到 node（PATH 里没有）'
  } else {
    Add-Ok "node $nodeVersion / pnpm $pnpmVersion"
  }
} catch {
  Add-Problem "找不到 node/pnpm：$($_.Exception.Message)"
}

# ── 2. 数据文件（图鉴 / 榜单 / 英雄详情 / 模板 / 名字指纹）──────────────
Write-Host '-- 数据文件'
$required = @(
  @{ file = 'dataset.json'; label = '图鉴' },
  @{ file = 'rankings.json'; label = '排行榜' },
  @{ file = 'builds.json'; label = '英雄详情' },
  @{ file = 'templates.json'; label = '头像模板' },
  @{ file = 'augment-names.json'; label = '名字指纹' }
)
$dataset = $null
foreach ($item in $required) {
  $path = Join-Path $dataDir $item.file
  if (-not (Test-Path $path)) {
    Add-Problem "缺少 $($item.label)：$path（先运行 pnpm sync / pnpm templates / 指纹脚本）"
    continue
  }
  $size = (Get-Item $path).Length
  if ($size -le 0) { Add-Problem "$($item.label) 是空文件：$path"; continue }
  Add-Ok "$($item.label)：$([math]::Round($size / 1kb)) KB"
  if ($item.file -eq 'dataset.json') {
    try { $dataset = Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json } catch {
      Add-Problem "dataset.json 不是合法 JSON：$($_.Exception.Message)"
    }
  }
}

if ($null -ne $dataset) {
  $schema = $dataset.meta.schemaVersion
  if ($null -eq $schema) { Add-Warn 'dataset.json 没有 schemaVersion（旧格式，读取时会自动迁移为 v2；建议重新 pnpm sync）' }
  elseif ([int]$schema -gt 2) { Add-Problem "dataset.json schemaVersion=$schema 高于本程序支持的 2：请升级程序" }
  else { Add-Ok "dataset.json schemaVersion=$schema" }

  $fetched = $dataset.meta.fetchedAt
  if ($fetched) {
    try {
      $ageH = ((Get-Date).ToUniversalTime() - ([datetime]$fetched).ToUniversalTime()).TotalHours
      if ($ageH -gt 24) { Add-Warn ("图鉴数据已过期：{0:N1} 小时前（离线验收可接受；建议重新 pnpm sync）" -f $ageH) }
      else { Add-Ok ("图鉴数据新鲜：{0:N1} 小时前" -f $ageH) }
    } catch { Add-Warn "dataset.json 的 fetchedAt 无法解析：$fetched" }
  }
  $championCount = @($dataset.champions).Count
  $hextechCount = @($dataset.hextechs).Count
  if ($hextechCount -eq 0) { Add-Problem 'dataset.hextechs 为空：国服图鉴缺失 → 局内强度标签一张都画不出' }
  else { Add-Ok "图鉴：英雄 $championCount / 国服海克斯 $hextechCount" }
}

$rankingsPath = Join-Path $dataDir 'rankings.json'
if (Test-Path $rankingsPath) {
  try {
    $rk = Get-Content $rankingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (@($rk.heroes).Count -eq 0) { Add-Warn 'rankings.heroes 为空：选人胜率标签会显示"暂无数据"' }
    else { Add-Ok "排行榜：英雄 $(@($rk.heroes).Count) / 海克斯 $(@($rk.augments).Count)，统计日期 $($rk.meta.dataDate)" }
  } catch { Add-Problem "rankings.json 解析失败：$($_.Exception.Message)" }
}

$buildsPath = Join-Path $dataDir 'builds.json'
if (Test-Path $buildsPath) {
  try {
    $builds = Get-Content $buildsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (@($builds.details).Count -eq 0) { Add-Problem 'builds.details 为空：局内没有强度数据可画' }
    else { Add-Ok "英雄详情：$(@($builds.details).Count) 个英雄，统计日期 $($builds.meta.dataDate)" }
  } catch { Add-Problem "builds.json 解析失败：$($_.Exception.Message)" }
}

# ── 3. 覆盖层构建产物（避免现场才 build）────────────────────────────────
Write-Host '-- 覆盖层产物'
$distMain = Join-Path $repo 'apps\overlay\dist\main\index.cjs'
$distRenderer = Join-Path $repo 'apps\overlay\dist\renderer\overlay.html'
if (-not (Test-Path $distMain)) {
  Add-Problem "缺少覆盖层构建产物：$distMain（先运行 pnpm --filter @hexbox/overlay build）"
} elseif (-not (Test-Path $distRenderer)) {
  Add-Problem "缺少渲染端产物：$distRenderer（先运行 pnpm --filter @hexbox/overlay build）"
} else {
  $mtime = (Get-Item $distMain).LastWriteTime
  Add-Ok "dist 已构建（$($mtime.ToString('yyyy-MM-dd HH:mm'))）"
}

# ── 4. LCU 凭证可达性（客户端可能还没开，这里只提示）────────────────────
Write-Host '-- LCU 凭证'
$credFile = Join-Path $env:USERPROFILE '.hexbox\lcu-credentials'
$haveCreds = $false
if ($env:HEXBOX_LCU_CREDENTIALS) { Add-Ok '已设置 HEXBOX_LCU_CREDENTIALS（显式凭证）'; $haveCreds = $true }
elseif (Test-Path $credFile) {
  $len = (Get-Item $credFile).Length
  if ($len -gt 0) { Add-Ok "用户凭证文件存在：$credFile"; $haveCreds = $true }
  else { Add-Warn "凭证文件是空的：$credFile" }
}
$lockfiles = @()
try {
  $lockfiles = @(Get-ChildItem 'C:\Riot Games\League of Legends\lockfile', 'D:\Riot Games\League of Legends\lockfile' -ErrorAction SilentlyContinue | Where-Object { $_.Length -gt 0 })
  if (-not $haveCreds -and $lockfiles.Count -gt 0) { Add-Ok "lockfile 可读：$($lockfiles[0].FullName)"; $haveCreds = $true }
} catch { }
if (-not $haveCreds) {
  Add-Warn '未找到 LCU 凭证（客户端没开/装在非默认路径/凭证未导出）。先启动客户端并登录，或运行 scripts\export-lcu-credentials.ps1'
}

# ── 5. 录制落地目录可写 ────────────────────────────────────────────────
Write-Host '-- 录制目录'
try {
  New-Item -ItemType Directory -Force -Path $sessionDir | Out-Null
  $probe = Join-Path $sessionDir '.write-probe'
  Set-Content -Path $probe -Value 'ok' -Encoding ASCII
  Remove-Item $probe -Force
  Add-Ok "可写：$sessionDir"
} catch {
  Add-Problem "录制目录不可写：$sessionDir（$($_.Exception.Message)）"
}
try {
  New-Item -ItemType Directory -Force -Path (Split-Path $logFile) | Out-Null
  $probe = Join-Path (Split-Path $logFile) '.write-probe'
  Set-Content -Path $probe -Value 'ok' -Encoding ASCII
  Remove-Item $probe -Force
  Add-Ok "日志目录可写：$(Split-Path $logFile)"
} catch {
  Add-Warn "日志目录不可写：$logFile（不影响功能，但验收日志无法落盘）"
}

# ── 6. 打印启动/回放命令 ────────────────────────────────────────────────
Write-Host ''
if ($problems.Count -gt 0) {
  Write-Host "== 结论：有 $($problems.Count) 个硬阻塞（先修复再上机）==" -ForegroundColor Red
  $problems | ForEach-Object { Write-Host "  ✗ $_" -ForegroundColor Red }
} else {
  Write-Host '== 结论：前置检查通过（可以上机）==' -ForegroundColor Green
}
if ($warns.Count -gt 0) {
  Write-Host "警告 $($warns.Count) 条（不影响启动，但会影响验收结论）：" -ForegroundColor Yellow
  $warns | ForEach-Object { Write-Host "  ⚠ $_" -ForegroundColor Yellow }
}

Write-Host ''
Write-Host '== 录制开启的一局验收（复制到【管理员】PowerShell 执行）==' -ForegroundColor Cyan
Write-Host '# 1) 固定数据目录与日志（dev:overlay 的 cwd 是 apps/overlay，相对路径会落错地方）'
Write-Host "`$env:HEXBOX_DATA_DIR = '$dataDir'"
Write-Host "`$env:HEXBOX_LOG_FILE = '$logFile'"
Write-Host '# 2) 开启会话录制（录制根目录由数据目录推导：<仓库>\debug\sessions）'
Write-Host "`$env:HEXBOX_AUGMENT_RECORD = '1'"
Write-Host '# 3) 启动常驻覆盖层（选人 + 局内全链路）'
Write-Host 'pnpm dev:overlay'
Write-Host ''
Write-Host '# 收尾：打完一局后，从托盘菜单「退出」（不要强杀进程）'
Write-Host '# → before-quit 会关闭录制器并写 report.json，会话目录才算完整。'
Write-Host ''
Write-Host '== 打完后的回放（验证录制完整 + 与 golden 逐项比对）==' -ForegroundColor Cyan
Write-Host "node --experimental-strip-types scripts/replay-session.mts '$sessionDir\<时间戳目录>'"
Write-Host ''
Write-Host '// 若走独立录制工具（只录局内海克斯链，Ctrl+C 收尾）：'
Write-Host "// `$env:HEXBOX_AUGMENT_RECORD='1'; pnpm --filter @hexbox/overlay debug:augment"
Write-Host ''

if ($problems.Count -gt 0) { exit 1 }
exit 0
