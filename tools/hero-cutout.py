#!/usr/bin/env python3
"""把欢迎页那张形象从白底上扣出来（去背 → 带透明通道的 PNG）。

素材是方形裁切的 JPEG（白底），直接贴上去就会有一圈方框。这里从四条边做洪水填充，
把**与边缘连通的浅色底**去掉（人物内部的白色高光因为不连通会保留），
再用一点高斯羽化 + 收边把 JPEG 的白圈吃掉，最后按 alpha 的包围盒裁紧。

用法：python tools/hero-cutout.py [--tol 232] [--blur 0.6] [--shrink 0.28] [--pad 2]
默认输入  meme/IMG_20260612_155829.jpg
默认输出  assets/cyrene-hero.png
"""

import argparse
import os
import sys

import numpy as np
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC_DEFAULT = os.path.join(ROOT, "meme", "IMG_20260612_155829.jpg")
OUT_DEFAULT = os.path.join(ROOT, "assets", "cyrene-hero.png")


def flood_from_border(pale):
    """从四条边出发、只沿 pale 连通地扩散，得到"背景"掩码。"""
    background = np.zeros_like(pale)
    background[0, :] = pale[0, :]
    background[-1, :] = pale[-1, :]
    background[:, 0] = pale[:, 0]
    background[:, -1] = pale[:, -1]
    while True:
        grown = background.copy()
        grown[1:, :] |= background[:-1, :]
        grown[:-1, :] |= background[1:, :]
        grown[:, 1:] |= background[:, :-1]
        grown[:, :-1] |= background[:, 1:]
        grown &= pale
        if np.array_equal(grown, background):
            return background
        background = grown


def cutout(args):
    image = Image.open(args.source).convert("RGB")
    rgb = np.asarray(image).astype(np.int16)
    floor = rgb.min(axis=2)
    spread = rgb.max(axis=2) - floor
    # 「白底」= 又亮又中性：只看亮度会把人物身上的浅色（皮肤、头发高光）一起挖掉，
    # 所以再要求这一点几乎不含色偏。
    pale = (floor >= args.tol) & (spread <= args.neutral)
    background = flood_from_border(pale)

    alpha = np.where(background, 0, 255).astype(np.uint8)
    if args.blur > 0:
        alpha = np.asarray(Image.fromarray(alpha, "L").filter(ImageFilter.GaussianBlur(args.blur)))
    if args.shrink > 0:
        scaled = np.asarray(alpha).astype(np.float32) / 255.0
        scaled = np.clip((scaled - args.shrink) / (1.0 - args.shrink), 0.0, 1.0)
        alpha = (scaled * 255.0).astype(np.uint8)
    else:
        alpha = np.asarray(alpha).astype(np.uint8)

    rgba = np.dstack([np.asarray(image), alpha])
    result = Image.fromarray(rgba, "RGBA")

    ys, xs = np.nonzero(alpha > 8)
    if len(xs) == 0:
        raise SystemExit("扣完什么都不剩了，把 --tol 调大一点试试")
    left = max(int(xs.min()) - args.pad, 0)
    right = min(int(xs.max()) + 1 + args.pad, result.width)
    top = max(int(ys.min()) - args.pad, 0)
    bottom = min(int(ys.max()) + 1 + args.pad, result.height)
    result = result.crop((left, top, right, bottom))

    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    result.save(args.output)
    covered = float((np.asarray(result)[:, :, 3] > 8).mean()) if result.size else 0.0
    print(f"source {image.width}x{image.height} -> {result.width}x{result.height}  {args.output}")
    print(f"  tol={args.tol} neutral={args.neutral} blur={args.blur} shrink={args.shrink} pad={args.pad}")
    print(f"  crop=({left},{top},{right},{bottom})  不透明占比={covered:.1%}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", default=SRC_DEFAULT)
    parser.add_argument("--output", default=OUT_DEFAULT)
    parser.add_argument("--tol", type=int, default=240, help="算作白底的亮度下限")
    parser.add_argument("--neutral", type=int, default=14, help="白底允许的最大色偏（max-min）")
    parser.add_argument("--blur", type=float, default=0.6, help="alpha 羽化半径（像素）")
    parser.add_argument("--shrink", type=float, default=0.28, help="收边强度：0 不收，越大越往人物里面缩")
    parser.add_argument("--pad", type=int, default=2, help="裁紧后四周留的空隙")
    args = parser.parse_args()
    if not os.path.exists(args.source):
        raise SystemExit(f"素材不在：{args.source}")
    cutout(args)


if __name__ == "__main__":
    main()
