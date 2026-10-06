#!/usr/bin/env python
"""生成 Windows 应用图标源图（apps/overlay/build/icon.png）。

为什么要一个脚本而不是直接塞一张图：
  · electron-builder 的 `win.icon` 需要 **≥256×256** 的图（它会自己转成多尺寸
    .ico）；把"这张图长什么样、怎么来的"写下来，下次换配色不用重新画。
  · 图是**纯几何**（六边形 + H），不依赖任何设计资源，可复现。

用法（本机已验证，Pillow 12.3.0）：
  python scripts/make-app-icon.py

产物：apps/overlay/build/icon.png（512×512，带透明圆角外沿）
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# 本机控制台是 GBK（936），直接 print 非 ASCII 会 UnicodeEncodeError
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

SIZE = 512
OUT = Path(__file__).resolve().parent.parent / 'apps' / 'overlay' / 'build' / 'icon.png'

# 配色与覆盖层一致的低饱和深色（图标在浅色/深色任务栏上都要能看清）
BG = (18, 22, 32, 255)
HEX_FILL = (32, 148, 168, 255)
HEX_EDGE = (94, 226, 240, 255)
TEXT = (240, 248, 255, 255)


def hexagon(cx: float, cy: float, r: float) -> list[tuple[float, float]]:
    """尖顶朝上的正六边形（六条边，角度从 -90° 起每 60°）。"""
    import math

    return [
        (cx + r * math.cos(math.radians(-90 + 60 * i)), cy + r * math.sin(math.radians(-90 + 60 * i)))
        for i in range(6)
    ]


def main() -> None:
    img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 圆角底板
    pad = int(SIZE * 0.03)
    d.rounded_rectangle(
        (pad, pad, SIZE - pad, SIZE - pad),
        radius=int(SIZE * 0.20),
        fill=BG,
        outline=(56, 68, 92, 255),
        width=max(2, SIZE // 128),
    )

    # 六边形（"hex"）：填充 + 发光描边
    cx = cy = SIZE / 2
    r = SIZE * 0.34
    pts = hexagon(cx, cy, r)
    d.polygon(pts, fill=HEX_FILL)
    for w, col in ((int(SIZE * 0.022), HEX_EDGE), (int(SIZE * 0.010), (255, 255, 255, 220))):
        d.line(pts + [pts[0]], fill=col, width=w, joint='curve')

    # 字母 H（找不到字体就退回简单矩形，绝不因为字体失败而中断）
    letter = 'H'
    font = None
    for name in ('seguibl.ttf', 'arialbd.ttf', 'segoeuib.ttf'):
        try:
            font = ImageFont.truetype(name, int(SIZE * 0.40))
            break
        except OSError:
            continue
    if font is not None:
        box = d.textbbox((0, 0), letter, font=font)
        d.text(
            (cx - (box[0] + box[2]) / 2, cy - (box[1] + box[3]) / 2),
            letter,
            font=font,
            fill=TEXT,
            stroke_width=int(SIZE * 0.012),
            stroke_fill=(10, 40, 48, 255),
        )
    else:
        bar = SIZE * 0.05
        d.rectangle((cx - SIZE * 0.13, cy - SIZE * 0.18, cx - SIZE * 0.13 + bar, cy + SIZE * 0.18), fill=TEXT)
        d.rectangle((cx + SIZE * 0.13 - bar, cy - SIZE * 0.18, cx + SIZE * 0.13, cy + SIZE * 0.18), fill=TEXT)
        d.rectangle((cx - SIZE * 0.13, cy - bar / 2, cx + SIZE * 0.13, cy + bar / 2), fill=TEXT)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT)
    print(f'✓ {OUT}  {img.size[0]}x{img.size[1]}  {OUT.stat().st_size / 1024:.1f} KB')


if __name__ == '__main__':
    main()
