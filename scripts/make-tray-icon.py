#!/usr/bin/env python
"""生成**托盘图标**（apps/overlay/build/tray/*.png + tray.ico）。

为什么要单独一套图标、不直接用 `icon.png`（与 make-app-icon.py 同一套配色）：
  · `icon.png` 是"深色圆角底板 + 六边形 + H"，在**深色任务栏**上底板与任务栏
    几乎同色（底板 (18,22,32) vs Win11 深色任务栏 ≈ (32,32,32)）——
    16×16 缩下去只剩一团黑，用户根本找不到托盘图标。所以托盘版**去掉底板**、
    背景全透明，只留六边形 + H：深色任务栏上靠青绿填充，浅色任务栏上靠白字。
  · Windows 托盘按 DPI 取 16/20/24/32 px（100%/125%/150%/200%）。
    只给 512px 一张图让系统自己缩，小尺寸会糊；所以**逐个尺寸单独画**
    （先在 size×SS 上画再 LANCZOS 缩，等于超采样，边缘才平滑）。
  · ICO 里同时带 16/20/24/32/48 五个尺寸（Pillow 对 ≤48 写 BMP 条目 ——
    最兼容的那种，Windows 的 LoadImage 直接认），给它一张图就能拿到最清晰的一档。

用法（本机已验证，Pillow 12.3.0）：
  python scripts/make-tray-icon.py

产物（都进仓库：打包时经 electron-builder 的 extraResources 落到
`resources/tray/`，开发时主进程直接读 apps/overlay/build/tray/）：
  apps/overlay/build/tray/tray-16.png / -20 / -24 / -32 / -48
  apps/overlay/build/tray/tray.ico
  debug/tray-icon-preview.png   仅用于人眼复核（放大 8 倍；debug/ 是 gitignore）
"""

import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw

# 本机控制台是 GBK（936），直接 print 非 ASCII 会 UnicodeEncodeError
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / 'apps' / 'overlay' / 'build' / 'tray'
PREVIEW = ROOT / 'debug' / 'tray-icon-preview.png'

# 与 make-app-icon.py 同一套配色（浅色/深色任务栏上都要能看清）
HEX_FILL = (32, 148, 168, 255)
HEX_EDGE = (94, 226, 240, 255)
TEXT = (240, 248, 255, 255)
TEXT_STROKE = (10, 40, 48, 255)

SIZES = (16, 20, 24, 32, 48)
SS = 8  # 超采样倍数（先画大图再缩，边缘才不锯齿）


def hexagon(cx: float, cy: float, r: float) -> list[tuple[float, float]]:
    """尖顶朝上的正六边形（与 make-app-icon.py 同一个函数）。"""
    return [
        (cx + r * math.cos(math.radians(-90 + 60 * i)), cy + r * math.sin(math.radians(-90 + 60 * i)))
        for i in range(6)
    ]


def render(size: int) -> Image.Image:
    """画一张 size×size 的托盘图标（背景透明，只有六边形 + H）。"""
    s = size * SS
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx = cy = s / 2

    # 六边形：撑满高度（尖顶），左右留一点余量 —— 与 icon.png 里那颗同形
    r = s * 0.47
    pts = hexagon(cx, cy, r)
    d.polygon(pts, fill=HEX_FILL)
    d.line(pts + [pts[0]], fill=HEX_EDGE, width=max(SS, int(s * 0.045)), joint='curve')

    # 字母 H 用**矩形**画（不用字体）：16px 上字体一渲染就糊，
    # 而三个矩形在任何尺寸下都一致、可控（与 make-app-icon.py 的字体失败回退同形）。
    bar = s * 0.15  # 竖笔宽
    half_w = s * 0.20  # H 半宽
    half_h = s * 0.235  # H 半高
    cross = s * 0.075  # 横笔半高
    stroke = max(1.0, s * 0.018)  # 深色描边（浅色任务栏上 H 与青绿底要有分离）
    for x0, x1 in ((cx - half_w, cx - half_w + bar), (cx + half_w - bar, cx + half_w)):
        d.rectangle(
            (x0 - stroke, cy - half_h - stroke, x1 + stroke, cy + half_h + stroke),
            fill=TEXT_STROKE,
        )
    d.rectangle(
        (cx - half_w - stroke, cy - cross - stroke, cx + half_w + stroke, cy + cross + stroke),
        fill=TEXT_STROKE,
    )
    for x0, x1 in ((cx - half_w, cx - half_w + bar), (cx + half_w - bar, cx + half_w)):
        d.rectangle((x0, cy - half_h, x1, cy + half_h), fill=TEXT)
    d.rectangle((cx - half_w, cy - cross, cx + half_w, cy + cross), fill=TEXT)

    return img.resize((size, size), Image.LANCZOS)


def write_preview(images: dict[int, Image.Image]) -> None:
    """放大 8 倍并排在深/浅两种底上（人眼复核用；产物在 gitignore 的 debug/）。"""
    scale = 8
    pad = 4
    cell_w = max(images) * scale + pad * 2
    sheet = Image.new('RGBA', (cell_w * len(images), cell_w * 2), (0, 0, 0, 0))
    for row, bg in enumerate(((32, 32, 32, 255), (245, 245, 245, 255))):
        strip = Image.new('RGBA', (cell_w * len(images), cell_w), bg)
        for i, size in enumerate(sorted(images)):
            big = images[size].resize((size * scale, size * scale), Image.NEAREST)
            strip.paste(big, (i * cell_w + pad, pad), big)
        sheet.paste(strip, (0, row * cell_w))
    PREVIEW.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(PREVIEW)
    print(f'  预览（上=深色任务栏 / 下=浅色任务栏，各 8 倍）：{PREVIEW}')


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    images: dict[int, Image.Image] = {}

    for size in SIZES:
        img = render(size)
        images[size] = img
        out = OUT_DIR / f'tray-{size}.png'
        img.save(out)
        print(f'✓ {out}  {size}x{size}  {out.stat().st_size / 1024:.1f} KB')

    # ICO：多个尺寸一把装进去（Pillow 会按 append_images 里已有的尺寸取用，
    # 不会从大图缩），Windows 按当前 DPI 选最合适的一档。
    ico = OUT_DIR / 'tray.ico'
    base = images[48]
    base.save(
        ico,
        format='ICO',
        sizes=[(s, s) for s in sorted(images)],
        append_images=[images[s] for s in sorted(images) if s != 48],
    )
    with Image.open(ico) as back:
        got = sorted(back.info.get('sizes', []))
    print(f'✓ {ico}  含尺寸 {got}  {ico.stat().st_size / 1024:.1f} KB')

    write_preview(images)


if __name__ == '__main__':
    main()
