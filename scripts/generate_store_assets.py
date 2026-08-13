"""Create deterministic store banners from the approved campaign artwork."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "store-assets/source/promo-art-source.png"
OUT = ROOT / "store-assets/v0.1.0"
BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
REGULAR = "/System/Library/Fonts/Supplemental/Arial.ttf"


def cover(image, size):
    ratio = max(size[0] / image.width, size[1] / image.height)
    resized = image.resize((round(image.width * ratio), round(image.height * ratio)), Image.Resampling.LANCZOS)
    left = (resized.width - size[0]) // 2
    top = (resized.height - size[1]) // 2
    return resized.crop((left, top, left + size[0], top + size[1]))


def marquee():
    canvas = cover(Image.open(SOURCE).convert("RGB"), (1400, 560)).convert("RGBA")
    overlay = Image.new("RGBA", canvas.size)
    pixels = overlay.load()
    for x in range(canvas.width):
        alpha = round(245 * max(0, 1 - x / 780))
        for y in range(canvas.height): pixels[x, y] = (12, 14, 27, alpha)
    canvas.alpha_composite(overlay)
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle((72, 72, 246, 108), 18, fill="#dfff75")
    draw.text((88, 79), "OPEN SOURCE", font=ImageFont.truetype(BOLD, 18), fill="#171713")
    draw.text((72, 145), "Organizer", font=ImageFont.truetype(BOLD, 72), fill="white")
    draw.text((72, 236), "Clear the clutter.\nKeep the context.", font=ImageFont.truetype(BOLD, 42), fill="#b49fff", spacing=5)
    draw.text((74, 371), "Back up and organize tabs + bookmarks", font=ImageFont.truetype(REGULAR, 24), fill="#d5d8e2")
    canvas.convert("RGB").save(OUT / "promo-marquee-1400x560.png", optimize=True)


def small():
    source = Image.new("RGBA", (440, 280), "#0c0e1b")
    art_full = Image.open(SOURCE).convert("RGB")
    art = art_full.crop((art_full.width // 2, 0, art_full.width, art_full.height))
    art = cover(art, (220, 280)).convert("RGBA")
    art.putalpha(Image.new("L", art.size, 185))
    source.alpha_composite(art, (220, 0))
    shade = Image.new("RGBA", source.size)
    shade_draw = ImageDraw.Draw(shade)
    for x in range(300):
        alpha = round(225 * max(0, 1 - x / 300))
        shade_draw.line((x, 0, x, 280), fill=(8, 10, 22, alpha))
    source.alpha_composite(shade)
    icon = Image.open(ROOT / "shared/icons/icon-128.png").convert("RGBA").resize((72, 72), Image.Resampling.LANCZOS)
    shadow = Image.new("RGBA", source.size)
    shadow.alpha_composite(Image.new("RGBA", (84, 84), (0, 0, 0, 130)), (27, 27))
    shadow = shadow.filter(ImageFilter.GaussianBlur(12))
    source.alpha_composite(shadow)
    source.alpha_composite(icon, (33, 33))
    draw = ImageDraw.Draw(source)
    draw.text((32, 126), "Organizer", font=ImageFont.truetype(BOLD, 38), fill="white")
    draw.text((34, 178), "Tabs + bookmarks,\nunder control.", font=ImageFont.truetype(REGULAR, 17), fill="#e0e2eb", spacing=3)
    source.convert("RGB").save(OUT / "promo-small-440x280.png", optimize=True)


def normalize_screenshots():
    """Browser capture may return JPEG bytes; store every advertised .png as PNG."""
    for path in OUT.glob("screenshot-*.png"):
        image = Image.open(path).convert("RGB")
        image.save(path, format="PNG", optimize=True)


def favicon():
    icon = Image.open(ROOT / "shared/icons/icon-512.png").convert("RGBA")
    icon.save(ROOT / "shared/icons/favicon.ico", format="ICO", sizes=[(16, 16), (32, 32), (48, 48)])


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    marquee()
    small()
    normalize_screenshots()
    favicon()
    print(f"Generated store banners in {OUT}")
