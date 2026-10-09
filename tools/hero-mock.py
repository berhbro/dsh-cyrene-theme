#!/usr/bin/env python3
"""生成「新会话欢迎页那一行」的样子图（纯预览，不参与运行）。

按 2 倍尺寸把真实的页面渐变（body::before 那五层）铺出来，再把**真正在用的那张贴纸**
（带透明通道的 Q 版立绘，直接用素材自己的 alpha）和方正舒体的粉白渐变艺术字排成一行，
并把形象高度做成 64 / 72 / 88 三档，用来挑大小。

用法：python tools/hero-mock.py [素材路径] [输出路径]
默认素材 = meme/俏皮眨眼.png（＝ lib/index.js 里 DEFAULT_HERO.image）
默认输出 = tools/hero-mock.png
"""

import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DEFAULT_ASSET = os.path.join(ROOT, "meme", "俏皮眨眼.png")
OUT_DEFAULT = os.path.join(HERE, "hero-mock.png")

TITLE = "让昔涟来帮帮你吧"
NOTE = "♪"
SCALE = 2  # 页面上 72px 形象 / 32px 艺术字，这里按 2 倍画
TITLE_PX = 32 * SCALE
GAP = 12 * SCALE
SIZES = [64, 72, 88]

WIDTH = 1100
HEAD_H = 64
ROW_H = 210
PAD_X = 44


def _load_preview():
    """复用字体对比脚本里的渐变字/字体挑选逻辑。"""
    import importlib.util

    path = os.path.join(HERE, "hero-preview.py")
    spec = importlib.util.spec_from_file_location("cyrene_hero_preview", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


preview = _load_preview()


def page_background(width, height):
    """和 body::before 一致的五层渐变：一层 158deg 线性 + 四个柔光斑。"""
    yy, xx = np.mgrid[0:height, 0:width].astype(np.float64)
    x = xx / max(width - 1, 1)
    y = yy / max(height - 1, 1)
    angle = math.radians(158)  # CSS 角度：0deg 朝上
    ux, uy = math.sin(angle), -math.cos(angle)
    span = abs(ux) + abs(uy)
    t = np.clip((x * ux + y * uy) / span, 0.0, 1.0)
    stops = [
        (0.00, (255, 248, 252)),
        (0.34, (255, 238, 247)),
        (0.68, (247, 236, 255)),
        (1.00, (238, 246, 255)),
    ]
    canvas = np.zeros((height, width, 3), dtype=np.float64)
    for index in range(len(stops) - 1):
        left, color_a = stops[index]
        right, color_b = stops[index + 1]
        span_t = (t - left) / (right - left)
        weight = np.clip(np.minimum(span_t, 1.0) - np.maximum(span_t - 1.0, 0.0), 0.0, 1.0)
        if index == 0:
            canvas += weight[..., None] * np.array(color_a, dtype=np.float64)
        canvas += weight[..., None] * np.array(color_b, dtype=np.float64)

    blobs = [
        (0.12, -0.06, 1100 / 2, 760 / 2, (255, 196, 226), 0.95, 0.62),
        (0.88, 0.04, 900 / 2, 700 / 2, (206, 190, 255), 0.80, 0.60),
        (0.76, 0.96, 760 / 2, 620 / 2, (178, 220, 255), 0.65, 0.62),
        (0.08, 0.92, 900 / 2, 800 / 2, (255, 214, 233), 0.85, 0.65),
    ]
    for cx, cy, rx, ry, color, alpha, reach in blobs:
        distance = np.sqrt(((x - cx) / (rx / width)) ** 2 + ((y - cy) / (ry / height)) ** 2)
        weight = np.clip(1.0 - distance / reach, 0.0, 1.0) * alpha
        canvas = canvas * (1 - weight[..., None]) + np.array(color, dtype=np.float64) * weight[..., None]
    return Image.fromarray(np.clip(canvas, 0, 255).astype(np.uint8), "RGB")


def mark_image(path, height):
    """按 alpha 裁紧再缩到指定高度——素材自带透明通道，不需要任何遮罩。"""
    image = Image.open(path).convert("RGBA")
    alpha = np.asarray(image)[:, :, 3]
    ys, xs = np.nonzero(alpha > 8)
    image = image.crop((int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1))
    width = max(1, round(image.width * height / image.height))
    return image.resize((width, height), Image.LANCZOS)


def main():
    asset = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_ASSET
    out = sys.argv[2] if len(sys.argv) > 2 else OUT_DEFAULT
    if not os.path.exists(asset):
        raise SystemExit(f"素材不在：{asset}")

    height = HEAD_H + ROW_H * len(SIZES) + 40
    canvas = page_background(WIDTH, height)
    draw = ImageDraw.Draw(canvas)
    draw.text(
        (PAD_X, 22),
        "新会话欢迎页 · 形象大小对照（真实渐变，按 2 倍画；页面上是 32px 方正舒体艺术字）",
        font=preview.load("msyhbd.ttc", 20),
        fill=(120, 74, 100),
    )

    note_font = preview.pick_note_font(round(TITLE_PX * 0.86))
    title_font = preview.load("FZSTK.TTF", TITLE_PX)
    title_w = round(title_font.getlength(TITLE) + note_font.getlength(NOTE)) + 22
    label_font = preview.load("msyh.ttc", 16)

    for index, size in enumerate(SIZES):
        top = HEAD_H + index * ROW_H
        draw.line((PAD_X, top, WIDTH - PAD_X, top), fill=(255, 214, 233), width=1)
        draw.text((PAD_X, top + 8), f"形象高度 {size}px", font=label_font, fill=(150, 112, 134))

        mark = mark_image(asset, size * SCALE)
        row_w = mark.width + GAP + title_w
        left = (WIDTH - row_w) // 2
        row_top = top + 34
        y = row_top + (ROW_H - 44 - mark.height) // 2
        canvas.paste(mark, (left, y), mark)
        preview.draw_title(canvas, (left + mark.width + GAP, y + (mark.height - TITLE_PX) // 2 - 6), title_font, note_font)

    canvas.save(out)
    print(f"asset {os.path.basename(asset)} -> {out} ({canvas.width}x{canvas.height})")


if __name__ == "__main__":
    main()
