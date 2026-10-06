# 渲染全部「海克斯名」的二值位图指纹（供卡面 OCR 名字匹配）
#
# 与 render-name-fingerprints.ps1 同一套做法（二值化 → 裁包围盒 → 位串 base64），
# 只是数据源换成 dataset.hextechs（只看 KIWI 模式）—— 海克斯名是 2~10 个汉字。
#
# 为什么需要单独渲染：卡面名字是**印刷体**，与名字指纹库的渲染字体必须同源；
# 且字体粗细/字号决定笔画密度，而行末归一化到 96×16 网格后，
# 笔画密度直接决定 Jaccard 能否区分（详见 docs/AUGMENT-PANEL.md 的标定记录）。
#
# 输出: data/augment-name-fingerprints[-bold].json
#   [{ id, name, width, height, bits: base64 }]
param(
  [string]$DatasetPath = 'data/dataset.json',
  [string]$OutPath = 'data/augment-names.json',
  [ValidateSet('Regular', 'Bold')][string]$FontStyle = 'Bold',
  [int]$CanvasW = 480,
  [int]$CanvasH = 96,
  [int]$FontSize = 40
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$dataset = Get-Content $DatasetPath -Raw -Encoding UTF8 | ConvertFrom-Json
$augments = @($dataset.hextechs | Where-Object { $_.modes -contains 'KIWI' })
Write-Host "渲染 $($augments.Count) 个海克斯名 ($FontSize px Microsoft YaHei $FontStyle)"

$style = if ($FontStyle -eq 'Bold') { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
$results = New-Object System.Collections.Generic.List[object]
$font = New-Object System.Drawing.Font('Microsoft YaHei', $FontSize, $style, [System.Drawing.GraphicsUnit]::Pixel)

foreach ($a in $augments) {
  $bmp = New-Object System.Drawing.Bitmap($CanvasW, $CanvasH)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Black)
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias

  $size = $g.MeasureString($a.name, $font)
  $x = [int](($CanvasW - $size.Width) / 2)
  $y = [int](($CanvasH - $size.Height) / 2)
  if ($x -lt 0) { $x = 0 }
  if ($y -lt 0) { $y = 0 }
  $g.DrawString($a.name, $font, [System.Drawing.Brushes]::White, $x, $y)
  $g.Dispose()

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
    Write-Warning "海克斯 $($a.id) $($a.name) 渲染为空,跳过"
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

  $byteCount = [int][Math]::Ceiling($w * $h / 8.0)
  $packed = New-Object byte[] $byteCount
  for ($i = 0; $i -lt $bits.Length; $i++) {
    if ($bits[$i] -eq 1) {
      $packed[[int][Math]::Floor($i / 8)] = $packed[[int][Math]::Floor($i / 8)] -bor (1 -shl ($i % 8))
    }
  }

  $results.Add([PSCustomObject]@{
    id = $a.id
    name = $a.name
    width = $w
    height = $h
    bits = [Convert]::ToBase64String($packed)
  }) | Out-Null
}

$font.Dispose()
$json = $results | ConvertTo-Json -Depth 3 -Compress
if ($results.Count -eq 1) { $json = "[$json]" }
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText((Join-Path (Get-Location) $OutPath), $json, $utf8NoBom)
Write-Host "已写入 $OutPath ($($results.Count) 个指纹)"
