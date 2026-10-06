# 一次性生成器（debug/ 不进仓库）：把「选/取/率」用微软雅黑渲染成 4bit alpha 点阵，
# 生成 packages/vision/src/label-cjk.ts —— 供离线预览画「选取率 x%」那一行
# （局内是 canvas 用系统字体画的，见 label-draw.ts 的 TIER_RATE_*）。
#
# 用法：pwsh -NoProfile -File debug/gen-cjk-glyphs.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$chars = @('选', '取', '率')
$RENDER = 96          # 渲染字号（px）
$TARGET_H = 32        # 输出点阵的高（行数）
$OUT = 'packages/vision/src/label-cjk.ts'
$font = New-Object System.Drawing.Font('Microsoft YaHei', $RENDER, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)

$body = @()
$body += '/**'
$body += ' * 离线预览用的 **CJK 最小点阵**（只有「选取率」三个字）'
$body += ' *'
$body += ' * 局内标签那一行「选取率 12.1%」是 Chromium 用系统字体（微软雅黑）画的，'
$body += ' * 而离线预览（`scripts/preview-augment-labels.mts`）跑在纯 Node 里、没有字体引擎。'
$body += ' * 为了让预览与局内的**版面**一致（同样的字号、同样的居中、同样的墨迹高），'
$body += ' * 这里只内嵌那**三个汉字**的点阵（ASCII 部分仍用 `label-glyph.ts` 的 5×7 点阵）。'
$body += ' *'
$body += ' * ⚠️ 与局内的差异只剩"字形是位图、不是矢量字体"这一条（和档位字母用单线字形同理）。'
$body += ' * 生成方式（可重跑，字体换了就重新生成）：'
$body += ' *'
$body += ' *   pwsh -NoProfile -File debug/gen-cjk-glyphs.ps1   # 微软雅黑 Regular 96px'
$body += ' *     → 裁墨迹包围盒 → 盒式降采样到高 32 → 量化成 4bit alpha → 每行一个十六进制字符'
$body += ' *'
$body += ' * 数据是**十六进制点阵**而不是 base64：这样在源码里能直接看出字形（可复核）。'
$body += ' */'
$body += ''
$body += '/** 一个汉字点阵：w×h，每行 w 个十六进制字符（0 = 透明，f = 不透明）。 */'
$body += 'export interface CjkRateGlyph {'
$body += '  readonly w: number'
$body += '  readonly h: number'
$body += '  readonly rows: readonly string[]'
$body += '}'
$body += ''
$body += '/** 「选取率」三个字的点阵（键 = 汉字本身；查不到返回 null，调用方回退到方框提示）。 */'
$body += 'export const CJK_RATE_GLYPHS: Readonly<Record<string, CjkRateGlyph>> = {'

foreach ($ch in $chars) {
  $W = 200; $H = 200
  $bmp = New-Object System.Drawing.Bitmap($W, $H)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Black)
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
  $g.DrawString($ch, $font, [System.Drawing.Brushes]::White, 20, 20)
  $g.Dispose()

  $rect = New-Object System.Drawing.Rectangle(0, 0, $W, $H)
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $bytes = New-Object byte[] ($W * $H * 4)
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
  $bmp.UnlockBits($data); $bmp.Dispose()

  # 灰度（黑底白字：直接取 G 通道）与墨迹包围盒
  $minX = $W; $minY = $H; $maxX = -1; $maxY = -1
  $gray = New-Object 'double[,]' $W, $H
  for ($y = 0; $y -lt $H; $y++) {
    for ($x = 0; $x -lt $W; $x++) {
      $i = ($y * $W + $x) * 4
      $v = [double]$bytes[$i + 1] / 255.0
      $gray[$x, $y] = $v
      if ($v -gt 0.35) {
        if ($x -lt $minX) { $minX = $x }; if ($x -gt $maxX) { $maxX = $x }
        if ($y -lt $minY) { $minY = $y }; if ($y -gt $maxY) { $maxY = $y }
      }
    }
  }
  $inkW = $maxX - $minX + 1
  $inkH = $maxY - $minY + 1
  $outH = $TARGET_H
  $outW = [int][Math]::Round($TARGET_H * $inkW / $inkH)

  # 盒式降采样（对墨迹区域取平均），再量化到 4bit
  $rows = @()
  for ($oy = 0; $oy -lt $outH; $oy++) {
    $line = ''
    for ($ox = 0; $ox -lt $outW; $ox++) {
      $x0 = [int][Math]::Floor($minX + $ox * $inkW / $outW)
      $x1 = [int][Math]::Ceiling($minX + ($ox + 1) * $inkW / $outW)
      $y0 = [int][Math]::Floor($minY + $oy * $inkH / $outH)
      $y1 = [int][Math]::Ceiling($minY + ($oy + 1) * $inkH / $outH)
      if ($x1 -le $x0) { $x1 = $x0 + 1 }
      if ($y1 -le $y0) { $y1 = $y0 + 1 }
      $sum = 0.0; $n = 0
      for ($y = $y0; $y -lt $y1; $y++) { for ($x = $x0; $x -lt $x1; $x++) { $sum += $gray[$x, $y]; $n++ } }
      $a = if ($n -gt 0) { $sum / $n } else { 0 }
      if ($a -lt 0.18) { $a = 0 }   # 去掉抗锯齿灰雾
      $q = [int][Math]::Round($a * 15)
      if ($q -gt 15) { $q = 15 }
      $line += $q.ToString('x')
    }
    $rows += $line
  }
  Write-Host "$ch : 墨迹 ${inkW}x${inkH} → ${outW}x${outH} (墨迹高/字号 = $([Math]::Round($inkH / $RENDER, 3)))"
  $body += "  '$ch': { w: $outW, h: $outH, rows: ["
  foreach ($r in $rows) { $body += "    '$r'," }
  $body += "  ] },"
}

$body += '}'
$body += ''
$body += '/** 取一个汉字的点阵；没有内置字形时返回 null。 */'
$body += 'export function cjkRateGlyph(ch: string): CjkRateGlyph | null {'
$body += '  return CJK_RATE_GLYPHS[ch] ?? null'
$body += '}'
$body += ''

Set-Content -Path $OUT -Value $body -Encoding UTF8
Write-Host "→ $OUT（$($body.Count) 行）"
