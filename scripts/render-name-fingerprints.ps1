# 渲染全部英雄名的二值位图指纹（供 OCR 名字匹配）
# 用系统 Microsoft YaHei —— 与选人卡片名字字体同款。
# 输出: data/name-fingerprints.json
#   [{ championId, name, width, height, bits: base64 }]
param(
  [string]$DatasetPath = 'data/dataset.json',
  [string]$OutPath = 'data/name-fingerprints.json',
  # 渲染画布（位图尺寸,名字会居中并裁掉空白）
  [int]$CanvasW = 160,
  [int]$CanvasH = 40,
  [int]$FontSize = 22
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

function Test-Bit([bool]$v) { if ($v) { 1 } else { 0 } }

$dataset = Get-Content $DatasetPath -Raw -Encoding UTF8 | ConvertFrom-Json
$champions = @($dataset.champions | Where-Object { $_.id -gt 0 })
Write-Host "渲染 $($champions.Count) 个英雄名 ($FontSize px Microsoft YaHei)"

$results = New-Object System.Collections.Generic.List[object]
$font = New-Object System.Drawing.Font('Microsoft YaHei', $FontSize, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)

foreach ($c in $champions) {
  $bmp = New-Object System.Drawing.Bitmap($CanvasW, $CanvasH)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Black)
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias

  $size = $g.MeasureString($c.name, $font)
  $x = [int](($CanvasW - $size.Width) / 2)
  $y = [int](($CanvasH - $size.Height) / 2)
  if ($x -lt 0) { $x = 0 }
  if ($y -lt 0) { $y = 0 }
  $g.DrawString($c.name, $font, [System.Drawing.Brushes]::White, $x, $y)
  $g.Dispose()

  # 读像素 → 二值化(阈值128) → 裁剪到内容包围盒
  $rect = New-Object System.Drawing.Rectangle(0, 0, $CanvasW, $CanvasH)
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $bytes = New-Object byte[] ($CanvasW * $CanvasH * 4)
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
  $bmp.UnlockBits($data)
  $bmp.Dispose()

  $minX = $CanvasW; $minY = $CanvasH; $maxX = -1; $maxY = -1
  for ($py = 0; $py -lt $CanvasH; $py++) {
    for ($px = 0; $px -lt $CanvasW; $px++) {
      $i = ($py * $CanvasW + $px) * 4
      # BGRA → 灰度(白字): B/G/R 相近且亮
      $b = $bytes[$i]; $gch = $bytes[$i + 1]; $r = $bytes[$i + 2]
      $luma = 0.299 * $r + 0.587 * $gch + 0.114 * $b
      if ($luma -ge 128) {
        if ($px -lt $minX) { $minX = $px }
        if ($px -gt $maxX) { $maxX = $px }
        if ($py -lt $minY) { $minY = $py }
        if ($py -gt $maxY) { $maxY = $py }
      }
    }
  }
  if ($maxX -lt 0) {
    Write-Warning "英雄 $($c.id) $($c.name) 渲染为空,跳过"
    continue
  }

  $w = $maxX - $minX + 1
  $h = $maxY - $minY + 1
  $bits = New-Object byte[] ($w * $h)
  for ($py = 0; $py -lt $h; $py++) {
    for ($px = 0; $px -lt $w; $px++) {
      $si = (($minY + $py) * $CanvasW + ($minX + $px)) * 4
      $b = $bytes[$si]; $gch = $bytes[$si + 1]; $r = $bytes[$si + 2]
      $luma = 0.299 * $r + 0.587 * $gch + 0.114 * $b
      $bits[$py * $w + $px] = if ($luma -ge 128) { 1 } else { 0 }
    }
  }

  # 位串打包 → base64
  $byteCount = [int][Math]::Ceiling($w * $h / 8.0)
  $packed = New-Object byte[] $byteCount
  for ($i = 0; $i -lt $bits.Length; $i++) {
    if ($bits[$i] -eq 1) {
      $packed[[int][Math]::Floor($i / 8)] = $packed[[int][Math]::Floor($i / 8)] -bor (1 -shl ($i % 8))
    }
  }
  $b64 = [Convert]::ToBase64String($packed)

  $results.Add([PSCustomObject]@{
    championId = $c.id
    name = $c.name
    width = $w
    height = $h
    bits = $b64
  }) | Out-Null
}

$font.Dispose()
$json = $results | ConvertTo-Json -Depth 3 -Compress
# 统一成数组(JSON 单元素时 ConvertTo-Json 会输出对象)
if ($results.Count -eq 1) { $json = "[$json]" }
# 无 BOM UTF8（Node JSON.parse 不接受 BOM）
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText((Join-Path (Get-Location) $OutPath), $json, $utf8NoBom)
Write-Host "已写入 $OutPath ($($results.Count) 个指纹)"
