"""Generate a tiny placeholder sticker so we can test the chat image channel.

Standalone markdown images are rendered as contained previews by the chat
surface, so this file exists purely to check whether a relative path and an
absolute path both resolve. Delete it once real stickers land.
"""

from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 360
OUT = Path(__file__).resolve().parent.parent / "stickers" / "cyrene-probe.png"

TOP = (255, 217, 236)
BOTTOM = (255, 170, 208)
INK = (91, 47, 71)
BLUSH = (255, 138, 180)


def gradient(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    for y in range(size):
        t = y / max(size - 1, 1)
        color = tuple(round(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3))
        draw.line([(0, y), (size, y)], fill=color + (255,))
    return img


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)

    card = gradient(SIZE)
    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=72, fill=255)
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    img.paste(card, (0, 0), mask)

    draw = ImageDraw.Draw(img)
    draw.ellipse([62, 78, 298, 250], fill=(255, 246, 251, 140))
    draw.ellipse([116, 140, 152, 196], fill=INK + (255,))
    draw.ellipse([208, 140, 244, 196], fill=INK + (255,))
    draw.ellipse([124, 152, 144, 172], fill=(255, 255, 255, 235))
    draw.ellipse([216, 152, 236, 172], fill=(255, 255, 255, 235))
    draw.ellipse([88, 186, 138, 216], fill=BLUSH + (150,))
    draw.ellipse([222, 186, 272, 216], fill=BLUSH + (150,))
    draw.arc([156, 178, 204, 222], start=20, end=160, fill=INK + (255,), width=8)

    img.save(OUT)
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
