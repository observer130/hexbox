# 一次性生成器：把档位字母（A~Z）用**真字体轮廓**导出成 packages/vision/src/label-letter.ts
#
# 为什么需要它：局内档位字母是 Chromium 用系统字体画的（`label-draw.ts` 的
# `LABEL_TIER_FONT_FAMILY`），而离线预览（`scripts/preview-augment-labels.mts`）
# 跑在纯 Node 里、没有字体引擎。为了做到"预览 = 局内"，这里把**同一套字体**
# （字体栈首项 Segoe UI Black）的大写字母轮廓 + 字体度量导出成纯数据：
#
#   · 轮廓 = `GraphicsPath.AddString` + `Flatten(0.25)` 的**平坦化多边形**（em 单位），
#     预览按覆盖率光栅化 → 任意字号都清晰（不是位图，不需要选分辨率）；
#   · 度量 = 前进宽 / 墨迹包围盒（em）+ 大写字高（cap/em）——
#     `label-draw.ts` 用它们做**视觉居中**（canvas 居中前进宽，展示型字体因此会偏）。
#
# 数据是**可复核的十进制数**（不是 base64/位图）：字形换了重跑本脚本即可。
#
# 用法（在仓库根目录）：
#   pwsh -NoProfile -File scripts/render-tier-letter-glyphs.ps1
#
# 依赖：Windows + .NET System.Drawing + 已安装 Segoe UI Black（seguibl.ttf）。
# 合规：只读本机字体文件，不联网、不注入、不读游戏内存。

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$FAMILY = 'Segoe UI Black'   # 必须与 label-draw.ts 字体栈首项一致（有单测锁）
$EM = 512                    # 生成用的 em 尺寸（px）——只影响数值精度
$TOL = 0.25                  # 平坦化容差（em 像素；0.25/512 ≈ 0.05% em ≈ 0.06px @130px 字号）
$OUT = 'packages/vision/src/label-letter.ts'                    # 度量（小；渲染端与预览都要）
$OUT_OUTLINES = 'packages/vision/src/label-letter-outlines.ts'  # 轮廓（大；只有离线预览要）
$LETTERS = [char[]]'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
$INV = [System.Globalization.CultureInfo]::InvariantCulture
$SF = [System.Drawing.StringFormat]::GenericTypographic

function Format-Num([double]$v) {
  $r = [math]::Round($v, 4)
  if ($r -eq 0) { $r = [double]0 }   # 去掉 "-0"
  return $r.ToString('0.####', $INV)
}

function Get-GlyphPath([string]$ch) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddString($ch, $script:fam, [int][System.Drawing.FontStyle]::Regular, $script:EM, (New-Object System.Drawing.PointF(0, 0)), $SF)
  $p.Flatten($null, [single]$script:TOL)
  return $p
}

# 平坦化后的点按**子路径**分组（PathTypes 的 0x07 == 0 是 Start；0x80 是闭合标记）
function Get-Subpaths($path) {
  $pts = $path.PathPoints
  $types = $path.PathTypes
  $out = New-Object System.Collections.ArrayList
  $cur = $null
  for ($i = 0; $i -lt $pts.Length; $i++) {
    if (($types[$i] -band 0x07) -eq 0) {
      if ($null -ne $cur -and $cur.Count -ge 3) { [void]$out.Add($cur) }
      $cur = New-Object System.Collections.ArrayList
    }
    if ($null -ne $cur) { [void]$cur.Add($pts[$i]) }
  }
  if ($null -ne $cur -and $cur.Count -ge 3) { [void]$out.Add($cur) }
  # GDI+ 常在闭合子路径末尾重复首点 —— 去掉（否则多边形多一段零长边）
  foreach ($c in $out) {
    $a = $c[0]
    $b = $c[$c.Count - 1]
    if ([math]::Abs($a.X - $b.X) -lt 1e-6 -and [math]::Abs($a.Y - $b.Y) -lt 1e-6) { $c.RemoveAt($c.Count - 1) }
  }
  # ⚠️ 必须用 `,$out`：PowerShell 会把返回值**展开一层**，只有 1 条轮廓的字母
  #（C/S/G…）会被展开成"一堆点"，调用方就会把每个点当成一条轮廓（真实踩过）。
  return , $out
}

# ── 字体存在性（`FontFamily` 构造失败即不存在；构造成功但名字不同 = 被替换了） ──
$fam = $null
try { $fam = New-Object System.Drawing.FontFamily($FAMILY) }
catch { throw "本机没有字体「$FAMILY」：$($_.Exception.Message)" }
if ($fam.Name -ne $FAMILY) { throw "字体族被替换成了「$($fam.Name)」——度量会失真，请改 `$FAMILY" }
Write-Host "字体 OK：$FAMILY（$($fam.Name)）"

# ── 基线 = 平底字母 H 的墨迹下沿（H 正好坐在基线上，无 overshoot） ──
$hPath = Get-GlyphPath 'H'
$hPts = $hPath.PathPoints
$hMinY = ($hPts | Measure-Object -Property Y -Minimum).Minimum
$hMaxY = ($hPts | Measure-Object -Property Y -Maximum).Maximum
$baseline = $hMaxY
$capPx = $hMaxY - $hMinY
$capRatio = $capPx / $EM
$hPath.Dispose()
Write-Host ("基线 = {0:N2}（em {1}）；cap 高 = {2:N2}px → cap/em = {3:N5}" -f $baseline, $EM, $capPx, $capRatio)

# ── 前进宽：MeasureString 双字符 − 单字符（消掉 GDI+ 的排版留白） ──
$probeBmp = New-Object System.Drawing.Bitmap(1, 1)
$probeG = [System.Drawing.Graphics]::FromImage($probeBmp)
$fontForMeasure = New-Object System.Drawing.Font($fam, [single]$EM, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
function Get-Advance([string]$ch) {
  $one = $script:probeG.MeasureString($ch, $script:fontForMeasure, (New-Object System.Drawing.PointF(0, 0)), $SF).Width
  $two = $script:probeG.MeasureString("$ch$ch", $script:fontForMeasure, (New-Object System.Drawing.PointF(0, 0)), $SF).Width
  return ($two - $one) / $script:EM
}

# ── 逐个字母取轮廓 + 度量 ──
$glyphs = @{}
$totalPoints = 0
foreach ($ch in $LETTERS) {
  $p = Get-GlyphPath ([string]$ch)
  $subs = Get-Subpaths $p
  # 自检：平坦化路径里的 Start 点数必须等于分出来的轮廓数（防"展开一层"那类错）
  $starts = 0
  foreach ($t in $p.PathTypes) { if (($t -band 0x07) -eq 0) { $starts++ } }
  if ($subs.Count -ne $starts) { throw "字母 $ch：轮廓数 $($subs.Count) ≠ Start 点数 $starts" }
  if (($subs | ForEach-Object { $_.Count } | Measure-Object -Sum).Sum -lt 4) { throw "字母 $ch：轮廓点太少，导出失败" }
  $minsX = [double]::MaxValue; $maxsX = [double]::MinValue
  $minsY = [double]::MaxValue; $maxsY = [double]::MinValue
  foreach ($c in $subs) {
    foreach ($pt in $c) {
      if ($pt.X -lt $minsX) { $minsX = $pt.X }
      if ($pt.X -gt $maxsX) { $maxsX = $pt.X }
      if ($pt.Y -lt $minsY) { $minsY = $pt.Y }
      if ($pt.Y -gt $maxsY) { $maxsY = $pt.Y }
    }
    $totalPoints += $c.Count
  }
  $p.Dispose()
  $glyphs[[string]$ch] = [pscustomobject]@{
    advance   = Get-Advance ([string]$ch)
    inkLeft   = $minsX / $EM
    inkRight  = $maxsX / $EM
    inkTop    = ($minsY - $baseline) / $EM
    inkBottom = ($maxsY - $baseline) / $EM
    contours  = $subs
  }
}
$probeG.Dispose(); $probeBmp.Dispose(); $fontForMeasure.Dispose()

# S/A/B/C 的墨迹宽/cap 高最大值 —— 未知字母按它保守排版（尖括号永不压字）
$design = 0.0
foreach ($ch in 'S', 'A', 'B', 'C') {
  $g = $glyphs[$ch]
  $a = ($g.inkRight - $g.inkLeft) / $capRatio
  if ($a -gt $design) { $design = $a }
}

# ── 生成 TS（两个文件） ──
#
# 为什么拆成两个：渲染端（局内 canvas）只需要**度量**（视觉居中、字距），而
# **轮廓**（几十 KB）只有离线预览用 —— 合成一个文件会被 `label-draw.ts` 一起
# 拖进渲染端 bundle（真机上量到 overlay-canvas.js 从 14KB 涨到 74KB）。
$metrics = New-Object System.Collections.ArrayList
$outlines = New-Object System.Collections.ArrayList
function Add-Metric([string]$s) { [void]$metrics.Add($s) }
function Add-Outline([string]$s) { [void]$outlines.Add($s) }

Add-Metric '/**'
Add-Metric ' * 档位字母的**字体度量**（生成物：`scripts/render-tier-letter-glyphs.ps1`）'
Add-Metric ' *'
Add-Metric ' * 局内的档位字母是 Chromium 用系统字体画的（`label-draw.ts` 的 `LABEL_TIER_FONT_FAMILY`），'
Add-Metric ' * 而离线预览（`scripts/preview-augment-labels.mts`）跑在纯 Node 里、没有字体引擎。'
Add-Metric ' * 这份数据是**同一套字体**（字体栈首项）的大写字母度量：'
Add-Metric ' *'
Add-Metric ' *   · `advance` / `ink*`：字体度量（em）。canvas 的 `textAlign=''center''` 居中的是'
Add-Metric ' *     **前进宽**，展示型字体的墨迹并不在前进宽正中，所以 `label-draw.ts` 用'
Add-Metric ' *     `advance/2 − 墨迹中心` 做**视觉居中**（每个字母各自修正，卡与卡之间才一致），'
Add-Metric ' *     并按 `inkWidth` 排尖括号（每个字母"墨迹 + 固定空隙"，见 `tierTagPlan`）；'
Add-Metric ' *   · `TIER_LETTERS_CAP_RATIO`：大写字高/em —— `label-draw.ts` 的 `LABEL_CAP_RATIO` **引用它**，'
Add-Metric ' *     所以"预览里字号多大、局内就多大"这条关系不可能漂（与 `GLYPH_CAP_RATIO` 同一套做法）。'
Add-Metric ' *'
Add-Metric ' * ⚠️ 坐标约定：x 自**笔位原点**（`fillText` 的左端，未含视觉居中修正）起算，'
Add-Metric ' * y 自**基线**起算、**向下为正**（圆字母（S/C/O）会略微低于基线，这是字体本身的 overshoot）。'
Add-Metric ' *'
Add-Metric ' * ⚠️ **轮廓在另一个生成物里**（`label-letter-outlines.ts`）：局内只要度量，'
Add-Metric ' * 把几十 KB 的轮廓带进渲染端 bundle 是白花的（实测 14KB → 74KB）。'
Add-Metric ' *'
Add-Metric (" * 生成方式（字体换了就重跑；文件是生成物，不要手改）：pwsh -NoProfile -File scripts/render-tier-letter-glyphs.ps1   # {0} @ em {1}px，平坦化容差 {2}" -f $FAMILY, $EM, $TOL)
Add-Metric (" * 实测：cap/em = {0}，S/A/B/C 墨迹宽/cap 高最大 = {1}（= 未知字母的保守值）。" -f (Format-Num $capRatio), (Format-Num $design))
Add-Metric ' */'
Add-Metric ''
Add-Metric '/**'
Add-Metric ' * 一个字母的度量（全部 **em 单位**：1 = 一个字号）。'
Add-Metric ' *'
Add-Metric ' * `ink*` 是**墨迹包围盒**（x 自笔位原点、y 自基线向下为正）。'
Add-Metric ' */'
Add-Metric 'export interface TierLetterEmMetrics {'
Add-Metric '  /** 前进宽 / em（canvas 按它居中）。 */'
Add-Metric '  readonly advance: number'
Add-Metric '  readonly inkLeft: number'
Add-Metric '  readonly inkRight: number'
Add-Metric '  readonly inkTop: number'
Add-Metric '  readonly inkBottom: number'
Add-Metric '}'
Add-Metric ''
Add-Metric '/** 生成这份数据的字体族 —— `label-draw.ts` 的字体栈**首项必须等于它**（有单测锁）。 */'
Add-Metric ("export const TIER_LETTERS_FONT = '{0}'" -f $FAMILY)
Add-Metric ''
Add-Metric '/** 生成时的 em 尺寸（px）与平坦化容差（em 像素）——只用于说明精度，运行时不用。 */'
Add-Metric ("export const TIER_LETTERS_EM = {0}" -f $EM)
Add-Metric ("export const TIER_LETTERS_FLATTEN = {0}" -f $TOL)
Add-Metric ''
Add-Metric '/** 大写字高 / em（= `label-draw.ts` 的 `LABEL_CAP_RATIO`，两边不可能漂）。 */'
Add-Metric ("export const TIER_LETTERS_CAP_RATIO = {0}" -f (Format-Num $capRatio))
Add-Metric ''
Add-Metric '/** S/A/B/C 的墨迹宽 / cap 高的**最大值** —— 没有实测度量的字母按它保守排版。 */'
Add-Metric ("export const TIER_LETTERS_DESIGN_INK_ASPECT = {0}" -f (Format-Num $design))
Add-Metric ''
Add-Metric '/** A~Z 的度量（键 = 大写字母）。 */'
Add-Metric 'export const TIER_LETTER_EM_METRICS: Readonly<Record<string, TierLetterEmMetrics>> = {'
foreach ($ch in $LETTERS) {
  $g = $glyphs[[string]$ch]
  Add-Metric ("  {0}: {{ advance: {1}, inkLeft: {2}, inkRight: {3}, inkTop: {4}, inkBottom: {5} }}," -f `
      $ch, (Format-Num $g.advance), (Format-Num $g.inkLeft), (Format-Num $g.inkRight), (Format-Num $g.inkTop), (Format-Num $g.inkBottom))
}
Add-Metric '}'
Add-Metric ''
Add-Metric '/** 取一个字母的度量（只认 A~Z；小写与大写等价，其他字符返回 null）。 */'
Add-Metric 'export function tierLetterEmMetrics(ch: string): TierLetterEmMetrics | null {'
Add-Metric '  return TIER_LETTER_EM_METRICS[ch.trim().toUpperCase().slice(0, 1)] ?? null'
Add-Metric '}'
Add-Metric ''

Add-Outline '/**'
Add-Outline ' * 档位字母的**轮廓**（生成物：`scripts/render-tier-letter-glyphs.ps1`）'
Add-Outline ' *'
Add-Outline ' * 与 `label-letter.ts` 的度量来自**同一次生成、同一套字体**（字体栈首项）：'
Add-Outline ' * 这里存 `GraphicsPath.AddString` + `Flatten` 出的**闭合多边形**（em 单位），'
Add-Outline ' * 离线预览按覆盖率光栅化（`label-raster.ts`）—— **矢量数据**，所以任意字号都不糊；'
Add-Outline ' * 填充用**偶奇规则**（与 GDI+ 那条路径的 `FillMode = Alternate` 一致）。'
Add-Outline ' *'
Add-Outline ' * ⚠️ 这个文件**只给离线预览**（`label-glyph.ts` 的 `drawTierLetter()`）；'
Add-Outline ' * 渲染端要的度量在 `label-letter.ts`（不要从这里导入，会把几十 KB 拖进 bundle）。'
Add-Outline (" * 实测：全部 {0} 个字母共 {1} 个轮廓点。" -f $LETTERS.Count, $totalPoints)
Add-Outline ' */'
Add-Outline ''
Add-Outline "import { tierLetterEmMetrics, type TierLetterEmMetrics } from './label-letter.ts'"
Add-Outline ''
Add-Outline '/** 一个字母的字形 = 度量（`label-letter.ts`）+ 轮廓（本文件）。 */'
Add-Outline 'export interface TierLetterGlyph extends TierLetterEmMetrics {'
Add-Outline '  /** 闭合轮廓；每个元素是一条平坦折线（`[x0, y0, x1, y1, …]`，首尾自动闭合）。 */'
Add-Outline '  readonly contours: readonly (readonly number[])[]'
Add-Outline '}'
Add-Outline ''
Add-Outline '/** A~Z 的轮廓（键 = 大写字母；坐标 em，x 自笔位原点、y 自基线向下为正）。 */'
Add-Outline 'export const TIER_LETTER_OUTLINES: Readonly<Record<string, readonly (readonly number[])[]>> = {'
foreach ($ch in $LETTERS) {
  $g = $glyphs[[string]$ch]
  Add-Outline ("  {0}: [" -f $ch)
  foreach ($c in $g.contours) {
    Add-Outline '    ['
    $line = '     '
    $n = 0
    foreach ($pt in $c) {
      $line += (" {0},{1}," -f (Format-Num ($pt.X / $EM)), (Format-Num (($pt.Y - $baseline) / $EM)))
      $n++
      if ($n % 5 -eq 0) { Add-Outline $line; $line = '     ' }
    }
    if ($line.Trim().Length -gt 0) { Add-Outline $line }
    Add-Outline '    ],'
  }
  Add-Outline '  ],'
}
Add-Outline '}'
Add-Outline ''
Add-Outline '/**'
Add-Outline ' * 取一个字母的字形（轮廓 + 度量；只认 A~Z，小写与大写等价，其他字符返回 `null`）。'
Add-Outline ' *'
Add-Outline ' * 没有字形时**明确返回 null**：调用方（离线预览）据此回退到内置单线字形/提示框，'
Add-Outline ' * 绝不静默漏画。'
Add-Outline ' */'
Add-Outline 'export function tierLetterGlyph(ch: string): TierLetterGlyph | null {'
Add-Outline '  const key = ch.trim().toUpperCase().slice(0, 1)'
Add-Outline '  const contours = TIER_LETTER_OUTLINES[key]'
Add-Outline '  const metrics = tierLetterEmMetrics(key)'
Add-Outline '  return contours && metrics ? { ...metrics, contours } : null'
Add-Outline '}'
Add-Outline ''

Set-Content -Path $OUT -Value $metrics -Encoding UTF8
Set-Content -Path $OUT_OUTLINES -Value $outlines -Encoding UTF8
Write-Host ""
Write-Host "每个字母（em 单位）："
foreach ($ch in $LETTERS) {
  $g = $glyphs[[string]$ch]
  Write-Host ("  {0}  advance={1,7} inkW={2,7} capAspect={3,6} inkTop={4,8} inkBottom={5,8} 轮廓点={6}" -f `
      $ch, (Format-Num $g.advance), (Format-Num ($g.inkRight - $g.inkLeft)), (Format-Num (($g.inkRight - $g.inkLeft) / $capRatio)), `
      (Format-Num $g.inkTop), (Format-Num $g.inkBottom), (($g.contours | ForEach-Object { $_.Count } | Measure-Object -Sum).Sum))
}
Write-Host ""
Write-Host "→ $OUT（$($metrics.Count) 行，度量；进渲染端 bundle）"
Write-Host "→ $OUT_OUTLINES（$($outlines.Count) 行，轮廓点合计 $totalPoints；只给离线预览）"
