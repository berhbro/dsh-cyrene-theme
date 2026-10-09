#!/usr/bin/env python3
"""生成「欢迎页艺术字」的字体对比图（纯预览，不参与运行）。

在粉白渐变背景上，把同一句欢迎语用几个候选字体各画一行，填色与描边都按
`lib/client.js` 里 `.cyre-hero-title-text` 的实际取值来（粉 → 白渐变 + 粉边），
用来挑字体时有个眼睛能看的东西。

用法：python tools/hero-preview.py [输出路径]
默认输出 tools/hero-font-preview.png
"""

import os
import sys

from PIL import Image, ImageDraw, ImageFont

FONTS_DIR = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")
OUT_DEFAULT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hero-font-preview.png")

TITLE = "让昔涟来帮帮你吧"
NOTE = "♪"

# (标签, 字体文件) —— 顺序就是 CSS 里字栈的候选顺序
CANDIDATES = [
    ("幼圆 YouYuan（现在这版字栈的头一个）", "SIMYOU.TTF"),
    ("华文琥珀 STHupo", "STHUPO.TTF"),
    ("方正舒体 FZShuTi", "FZSTK.TTF"),
    ("华文新魏 STXinwei", "STXINWEI.TTF"),
    ("华文行楷 STXingkai（原来那版）", "STXINGKA.TTF"),
    ("微软雅黑（对照：完全不用艺术体）", "msyh.ttc"),
]

FILL_TOP = (255, 124, 187)   # #ff7cbb
FILL_BOTTOM = (255, 247, 252)  # #fff7fc
STROKE = (232, 105, 159)     # #e8699f
LABEL = (150, 112, 134)

WIDTH = 1000
PAD_X = 40
ROW_H = 74
HEAD_H = 58


def load(path, size):
    return ImageFont.truetype(os.path.join(FONTS_DIR, path), size)


def vgradient(size, top, bottom):
    """竖直渐变底：先画一列再拉宽，够用且快。"""
    w, h = size
    strip = Image.new("RGB", (1, h))
    for y in range(h):
        t = y / max(h - 1, 1)
        strip.putpixel(
            (0, y),
            tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)),
        )
    return strip.resize((w, h), Image.BILINEAR)


def pick_note_font(size):
    """♪ 要挑一个真的有这个码位的字体：微软雅黑里没有，会画成豆腐块。"""
    for filename in ("seguisym.ttf", "segoeui.ttf", "simsun.ttc", "msyh.ttc"):
        path = os.path.join(FONTS_DIR, filename)
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def draw_title(base, xy, font, note_font):
    """先按扩张一档的蒙版画描边，再用实际蒙版贴渐变字。

    渐变的高度要贴着字形本身（不是整块画布），不然粉→白只走到一小截，
    看上去就成了一句纯粉的字。
    """
    probe = ImageDraw.Draw(Image.new("L", (8, 8)))
    bb = probe.textbbox((0, 0), TITLE, font=font, stroke_width=2)
    note_bb = probe.textbbox((0, 0), NOTE, font=note_font, stroke_width=2)
    glyph_h = bb[3] - bb[1]
    top = -bb[1]
    text_w = font.getlength(TITLE)
    note_w = note_font.getlength(NOTE)

    box = (round(text_w + note_w) + 16, glyph_h + 6)
    fill_mask = Image.new("L", box, 0)
    stroke_mask = Image.new("L", box, 0)
    for mask, width in ((fill_mask, 0), (stroke_mask, 2)):
        draw = ImageDraw.Draw(mask)
        draw.text((0, top), TITLE, font=font, fill=255, stroke_width=width, stroke_fill=255)
        draw.text(
            (round(text_w) + 6, top + glyph_h - (note_bb[3] - note_bb[1])),
            NOTE,
            font=note_font,
            fill=255,
            stroke_width=width,
            stroke_fill=255,
        )

    base.paste(STROKE, xy, stroke_mask)
    base.paste(vgradient(box, FILL_TOP, FILL_BOTTOM), xy, fill_mask)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else OUT_DEFAULT
    height = HEAD_H + ROW_H * len(CANDIDATES) + PAD_X
    canvas = vgradient((WIDTH, height), (255, 232, 244), (255, 252, 253))
    draw = ImageDraw.Draw(canvas)
    label_font = load("msyh.ttc", 15)
    note_font = pick_note_font(29)
    draw.text((PAD_X, 18), "欢迎页艺术字字体对比（粉→白渐变 + 粉描边）", font=load("msyhbd.ttc", 20), fill=(120, 74, 100))

    for index, (label, filename) in enumerate(CANDIDATES):
        y = HEAD_H + index * ROW_H
        draw.line((PAD_X, y, WIDTH - PAD_X, y), fill=(255, 214, 233), width=1)
        draw.text((PAD_X, y + 6), label, font=label_font, fill=LABEL)
        try:
            font = load(filename, 34)
        except OSError as error:  # 字体没装就跳过，别整个脚本挂掉
            draw.text((PAD_X, y + 30), f"（读不到 {filename}：{error}）", font=label_font, fill=(190, 90, 120))
            continue
        draw_title(canvas, (PAD_X + 4, y + 24), font, note_font)

    canvas.save(out)
    print(f"已生成 {out}（{canvas.width}x{canvas.height}）")


if __name__ == "__main__":
    main()
