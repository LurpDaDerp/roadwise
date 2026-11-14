"""Derive every app icon image from the RoadWise logo.

Input:  assets/logo.png   1024x1024 RGB, the yellow gauge arc and check mark (with a soft drop
        shadow) on a vertical navy gradient. The source of truth for the mark.
Output (all in assets/):
  icon.png                       the logo itself (iOS home screen, App Store, Android legacy icon)
  adaptive-icon.png              1024x1024 RGBA, Android adaptive foreground: the mark and its shadow
                                 on transparent, the logo scaled to the 72/108 visible area
  adaptive-icon-background.png   1024x1024 RGB, Android adaptive background: the logo's gradient,
                                 stretched so the visible area shows exactly the logo's top-to-bottom range
  splash.png                     RGBA, the mark and its shadow on transparent, cropped square
  notification-icon.png          96x96 RGBA, the mark as a white glyph on transparent (80x80 live area)

Usage (from the repo root; dev-only, never bundled; needs Pillow and numpy):
    python scripts/make-app-icons.py

How the mark is lifted off the gradient:
1. The background row colour B(y) is the logo's left-edge pixel on that row (the gradient is vertical).
2. The mark's colour Y(y) is a straight-line fit, per channel, of the fully-yellow pixels against y.
3. Shadow: away from the mark a pixel is B(y) pulled toward one dark-navy shadow colour K,
   P = B + s (K - B); K and the opacity s are fitted by least squares. Under the mark's edge s is
   filled in from nearby shadow pixels.
4. Mark opacity, from the red channel against the shadowed background:
   a = (R - S_R) / (Y_R - S_R), S = (1-s) B + s K.
5. Layer opacity = mark over shadow, a + (1-a) s (raised where a colour would leave 0..255), and
   each pixel's colour solved exactly from it: C = (P - (1-alpha) B) / alpha. Composited over B(y)
   the layer gives back the logo (the script prints the error and fails above 3 levels).
"""
import shutil

import numpy as np
from PIL import Image, ImageFilter

SRC = 'assets/logo.png'
logo = Image.open(SRC).convert('RGB')
W, H = logo.size
P = np.asarray(logo, dtype=np.float64)
ys = np.arange(H, dtype=np.float64)

# 1. Background gradient per row.
B = P[:, 0, :][:, None, :].repeat(W, axis=1)

# 2. Mark colour: pixels clearly yellow (red near full, blue low).
yellow = (P[..., 0] > 250) & (P[..., 2] < 40) & (P[..., 1] > 150)
yy, _ = np.nonzero(yellow)
Yrow = np.empty((H, 3))
for c in range(3):
    k, b0 = np.polyfit(yy, P[..., c][yellow], 1)
    Yrow[:, c] = np.clip(k * ys + b0, 0, 255)
Y = Yrow[:, None, :].repeat(W, axis=1)

# 3. Shadow: a pixel off the mark is B(y) pulled toward one shadow colour K (a dark navy, fitted
#    here), P = B + s (K - B). K and s are fitted in turn by least squares on the shadowed pixels.
markish = (P[..., 0] - B[..., 0]) > 6
grown = np.asarray(Image.fromarray(markish.astype(np.uint8) * 255).filter(ImageFilter.MaxFilter(5))) > 0
D = B - P
shadowed = ~grown & (D.sum(axis=2) > 6)
K = np.zeros(3)
for _ in range(30):
    V = B - K
    sv = np.clip((D * V).sum(axis=2) / np.maximum((V * V).sum(axis=2), 1e-6), 0, 1)
    sm = sv[shadowed][:, None]
    # P = B (1 - s) + s K  ->  K = sum s (P - B (1 - s)) / sum s^2
    K = np.clip(((P[shadowed] - B[shadowed] * (1 - sm)) * sm).sum(axis=0) / (sm * sm).sum(), 0, 255)
print('shadow colour', K.round(1))
V = B - K
s_known = np.clip((D * V).sum(axis=2) / np.maximum((V * V).sum(axis=2), 1e-6), 0, 1)
s_known[grown] = 0
known = (~grown).astype(np.float64)
num = np.asarray(Image.fromarray((s_known * 255).round().astype(np.uint8)).filter(ImageFilter.GaussianBlur(4)), dtype=np.float64)
den = np.asarray(Image.fromarray((known * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(4)), dtype=np.float64)
s_fill = np.where(den > 1, num / np.maximum(den, 1e-6), 0)  # 0..1 (both blurs are 0..255)
s = np.where(grown, np.clip(s_fill, 0, 1), s_known)

# 4. Mark opacity.
Bs_R = (1 - s) * B[..., 0] + s * K[0]
a = np.clip((P[..., 0] - Bs_R) / np.maximum(Y[..., 0] - Bs_R, 1e-6), 0, 1)
a[~grown] = 0

# 5. Layer and check. The opacity is the model's, raised where needed so the exact colour
#    C = (P - (1-alpha) B) / alpha stays within 0..255; composited over B(y) the layer then gives
#    back the logo pixel for pixel (up to 8-bit rounding).
alpha = a + (1 - a) * s
need = np.maximum((B - P) / np.maximum(B, 1e-6), (P - B) / np.maximum(255 - B, 1e-6)).max(axis=2)
alpha = np.clip(np.maximum(alpha, need), 0, 1)
alpha8 = np.round(alpha * 255) / 255
rgb = np.where(alpha8[..., None] > 0, (P - (1 - alpha8[..., None]) * B) / np.maximum(alpha8[..., None], 1e-6), 0)
rgb = np.clip(np.round(rgb), 0, 255)
comp = rgb * alpha8[..., None] + B * (1 - alpha8[..., None])
err = np.abs(comp - P)
print(f'recomposite error: max {err.max():.2f}, mean {err.mean():.3f}, 99.9% {np.percentile(err, 99.9):.2f}')
if err.max() > 3:
    raise SystemExit('the lifted mark does not reproduce the logo')
layer = Image.fromarray(np.dstack([rgb, alpha8 * 255]).round().clip(0, 255).astype(np.uint8))

# icon.png: the logo as given.
shutil.copyfile(SRC, 'assets/icon.png')

# adaptive-icon.png: the whole 1024 layer at 72/108 (= 2/3), centred, keeping the logo's proportions.
inner = round(W * 2 / 3)
fg = Image.new('RGBA', (W, H), (0, 0, 0, 0))
fg.alpha_composite(layer.resize((inner, inner), Image.LANCZOS), ((W - inner) // 2, (H - inner) // 2))
fg.save('assets/adaptive-icon.png', optimize=True)

# adaptive-icon-background.png: canvas row y shows logo row (y - off) * 1.5, the gradient's
# straight-line fit carrying it past the logo's ends.
off = (H - inner) / 2
src_y = (ys - off) * W / inner
Brow = P[:, 0, :]
bg = np.empty((H, 3))
for c in range(3):
    k, b0 = np.polyfit(ys, Brow[:, c], 1)
    inside = np.interp(np.clip(src_y, 0, H - 1), ys, Brow[:, c])
    bg[:, c] = np.where((src_y >= 0) & (src_y <= H - 1), inside, k * src_y + b0)
bgimg = np.clip(bg, 0, 255).round().astype(np.uint8)[:, None, :].repeat(W, axis=1)
Image.fromarray(bgimg).save('assets/adaptive-icon-background.png', optimize=True)

# splash.png: the layer cropped to what is visible (shadow included), padded to a square.
l, t, r, b = Image.fromarray((alpha > 0.02).astype(np.uint8) * 255).getbbox()
crop = layer.crop((l, t, r, b))
side = max(crop.size)
sq = Image.new('RGBA', (side, side), (0, 0, 0, 0))
sq.alpha_composite(crop, ((side - crop.width) // 2, (side - crop.height) // 2))
sq.save('assets/splash.png', optimize=True)

# notification-icon.png: the mark alone (no shadow, no gradient), white, fit into 80x80 of 96x96.
mask = Image.fromarray((a * 255).round().astype(np.uint8))
glyph = mask.crop(mask.getbbox())
scale = 80 / max(glyph.size)
tw, th = max(1, round(glyph.width * scale)), max(1, round(glyph.height * scale))
glyph = glyph.resize((tw, th), Image.LANCZOS)
na = Image.new('L', (96, 96), 0)
na.paste(glyph, ((96 - tw) // 2, (96 - th) // 2))
note = Image.new('RGBA', (96, 96), (255, 255, 255, 0))
note.putalpha(na)
note.save('assets/notification-icon.png', optimize=True)

print('mark box', mask.getbbox(), 'splash', sq.size, 'notification glyph', (tw, th))
