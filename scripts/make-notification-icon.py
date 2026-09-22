"""Derive the Android notification icon from the app mark (Task 18).

Input:  assets/adaptive-icon.png   512x512 RGBA, the blue chevron over a soft grey drop shadow
        sha256 9e3d0315a33c6799de601dd34cd8bf8cc3a8d16f3bf75592baec2ceb7240b391
Output: assets/notification-icon.png   96x96 RGBA, a white glyph on transparent
        sha256 1193bfec100045d9bf7fc174dd9f1937fa7b55819e4967bb326074fde691c857
        (Pillow 11.3.0; another Pillow version may differ in the last bits of the LANCZOS edge)

Usage (from the repo root; dev-only, never bundled):
    python scripts/make-notification-icon.py assets/adaptive-icon.png assets/notification-icon.png

Steps:
1. Glyph mask: a pixel is glyph when alpha >= 64 and blue >= 150 (the shadow is dark, b < 100).
2. Enclosed holes are filled (the pale highlight near each foot falls under the blue threshold):
   the background is flood-filled from a corner, and whatever it cannot reach is glyph.
3. Crop to the glyph's box, fit into an 80x80 live area (8 px margin, Android's 2 dp padding at
   xxxhdpi); the LANCZOS downsample of the hard mask gives the anti-aliased edge.
4. RGB white everywhere, alpha = the mask. Nothing else is kept (no gradient, no shadow).
"""
import sys

from PIL import Image, ImageDraw

src, out = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('RGBA')
w, h = im.size
mask = Image.new('L', (w, h), 0)
m, p = mask.load(), im.load()
for y in range(h):
    for x in range(w):
        r, g, b, a = p[x, y]
        if a >= 64 and b >= 150:
            m[x, y] = 255
# Step 2: fill enclosed holes.
outside = mask.copy()
ImageDraw.floodfill(outside, (0, 0), 128)
o = outside.load()
for y in range(h):
    for x in range(w):
        if o[x, y] == 0:
            m[x, y] = 255
box = mask.getbbox()
glyph = mask.crop(box)
gw, gh = glyph.size
scale = 80 / max(gw, gh)
tw, th = max(1, round(gw * scale)), max(1, round(gh * scale))
glyph = glyph.resize((tw, th), Image.LANCZOS)
alpha = Image.new('L', (96, 96), 0)
alpha.paste(glyph, ((96 - tw) // 2, (96 - th) // 2))
icon = Image.new('RGBA', (96, 96), (255, 255, 255, 0))
icon.putalpha(alpha)
icon.save(out, optimize=True)
print('source', src, im.size, 'glyph bbox', box, '->', (tw, th), 'saved', out)
