# 一次性导出 LCU 凭证到用户级凭证文件（之后所有工具免提权可用）
#
# 为什么需要：国服 WeGame 的 LeagueClient\lockfile 实测为 0 字节，
# 而非管理员读不到进程命令行（Windows 屏蔽），于是普通进程拿不到任何凭证，
# 每次调试都得用管理员重开终端。这里由**提权会话读一次**，
# 写进 ~/.hexbox/lcu-credentials（与 lockfile 同格式），
# 之后 packages/lcu 的探测会自动读取它（见 LCU_CREDENTIALS_ENV 文档）。
#
# 用法（**需要管理员**；客户端须在运行）：
#   powershell -ExecutionPolicy Bypass -File scripts\export-lcu-credentials.ps1
#
# 安全说明：
#   - 文件写在用户目录，**不在仓库内**（不会被 git 提交）；
#   - token 只在内存与文件之间传递，不打印到终端、不进日志；
#   - 客户端重启后端口与 token 都会变，重新跑一次即可；
#   - 不想留文件就删掉它：Remove-Item ~\.hexbox\lcu-credentials

$ErrorActionPreference = 'Stop'

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host '✗ 需要管理员权限（否则读不到 LCU 进程命令行）。' -ForegroundColor Red
  Write-Host '  请右键「以管理员身份运行」PowerShell 后重试：' -ForegroundColor Yellow
  Write-Host '    powershell -ExecutionPolicy Bypass -File scripts\export-lcu-credentials.ps1' -ForegroundColor Yellow
  exit 1
}

# 1) 找 LeagueClientUx 进程（LCU 本体；游戏进程是 League of Legends）
$proc = Get-CimInstance Win32_Process -Filter "Name='LeagueClientUx.exe'" -ErrorAction SilentlyContinue |
  Select-Object -First 1
if (-not $proc -or -not $proc.CommandLine) {
  Write-Host '✗ 未找到 LeagueClientUx 进程，或仍读不到其命令行。' -ForegroundColor Red
  Write-Host '  请确认客户端（含 WeGame）已启动并登录。' -ForegroundColor Yellow
  exit 1
}

# 2) 从命令行抽 --app-port 与 --remoting-auth-token
$portMatch = [regex]::Match($proc.CommandLine, '--app-port=(\d+)')
$tokenMatch = [regex]::Match($proc.CommandLine, '--remoting-auth-token=([^\s"]+)')
if (-not $portMatch.Success -or -not $tokenMatch.Success) {
  Write-Host '✗ 命令行里没找到 --app-port / --remoting-auth-token。' -ForegroundColor Red
  Write-Host '  （新版本客户端可能改了参数名，请把 --help 输出发给开发者）' -ForegroundColor Yellow
  exit 1
}
$port = [int]$portMatch.Groups[1].Value
$token = $tokenMatch.Groups[1].Value

# 3) 写入用户级凭证文件（与 lockfile 同格式：LeagueClient:pid:port:password:https）
$dir = Join-Path $env:USERPROFILE '.hexbox'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$path = Join-Path $dir 'lcu-credentials'
$line = "LeagueClient:$($proc.ProcessId):$port`:$token`:https"
[System.IO.File]::WriteAllText($path, $line, (New-Object System.Text.UTF8Encoding($false)))

# 4) 顺手验一次（用官方 LCU 端点），确认凭证可用
$pair = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("riot:$token"))
$ok = $false
try {
  $r = Invoke-WebRequest -UseBasicParsing -SkipCertificateCheck `
    -Uri "https://127.0.0.1:$port/lol-gameflow/v1/gameflow-phase" `
    -Headers @{ Authorization = "Basic $pair" } -TimeoutSec 8
  Write-Host "✓ 凭证有效：HTTP $($r.StatusCode)  当前阶段 = $($r.Content)" -ForegroundColor Green
  $ok = $true
} catch {
  Write-Host "⚠ 凭证已写入，但验证请求失败：$($_.Exception.Message)" -ForegroundColor Yellow
  Write-Host '  （若阶段为 None 属正常；401 才说明 token 不对）' -ForegroundColor Yellow
}

Write-Host ''
Write-Host "凭证文件：$path" -ForegroundColor Cyan
Write-Host "端口：$port   token 长度：$($token.Length)（不打印内容）" -ForegroundColor Cyan
if ($ok) {
  Write-Host '现在普通（非管理员）终端也能读到凭证了 —— 可以直接跑：' -ForegroundColor Green
  Write-Host '  pnpm --filter @hexbox/overlay debug:capture' -ForegroundColor Green
}
