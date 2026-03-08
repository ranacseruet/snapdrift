#!/usr/bin/env python3
"""
SnapDrift Logo Generator
Produces:
  assets/snapdrift-logo-icon.png    (512×512)
  assets/snapdrift-logo-banner.png  (1200×400)

Rendered at 2× then downsampled for natural antialiasing.
"""

import math, os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

# ── Palette ──────────────────────────────────────────────────────────────────
C_BG    = (10,  20,  35 )   # deep navy
C_WHITE = (228, 242, 255)   # near-white / reference
C_BLUE  = (0,   188, 248)   # electric blue / drift
C_TEAL  = (0,   218, 188)   # teal / delta accent
C_STEEL = (52,  92,  134)   # mid steel / separator / tag

FONT_DIN  = "/System/Library/Fonts/Supplemental/DIN Condensed Bold.ttf"
FONT_MONO = "/System/Library/Fonts/SFNSMono.ttf"

OUT = os.path.join(os.path.dirname(__file__))
os.makedirs(OUT, exist_ok=True)

SCALE = 2  # internal render multiplier


# ── Utilities ─────────────────────────────────────────────────────────────────

def soft_glow(W, H, cx, cy, radius, color, peak=0.55):
    """RGBA soft radial glow layer."""
    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    steps = 60
    for i in range(steps, 0, -1):
        r = int(radius * i / steps)
        a = int(255 * peak * (1 - i / steps) ** 0.72)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(*color, a))
    return layer.filter(ImageFilter.GaussianBlur(max(1, radius // 7)))


def brackets(draw, x, y, w, h, arm, color, stroke):
    """Four-corner bracket frame (horizontal + vertical strokes only)."""
    x, y, w, h, arm, stroke = int(x), int(y), int(w), int(h), int(arm), int(stroke)
    segs = [
        ((x, y + arm),     (x, y)),           ((x, y),     (x + arm, y)),         # TL
        ((x+w-arm, y),     (x + w, y)),        ((x + w, y), (x + w, y + arm)),     # TR
        ((x, y+h-arm),     (x, y + h)),        ((x, y + h), (x + arm, y + h)),     # BL
        ((x+w-arm, y + h), (x + w, y + h)),   ((x + w, y + h), (x + w, y+h-arm)), # BR
    ]
    for p1, p2 in segs:
        draw.line([p1, p2], fill=color, width=stroke)


def drift_mark(draw, cx, cy, S):
    """
    Draw the two-frame drift mark centered at (cx, cy).
    S = frame width in pixels (all other dims derived proportionally).
    """
    FW  = int(S)
    FH  = int(S * 0.727)   # 16:11.6 ratio
    OFF = int(S * 0.130)   # drift offset
    ARM = int(S * 0.228)   # bracket arm length
    ST  = max(2, int(S * 0.0155))  # stroke width

    f1x = int(cx - FW / 2 - OFF / 2)
    f1y = int(cy - FH / 2 - OFF / 2)
    f2x = f1x + OFF
    f2y = f1y + OFF

    # Blue "drifted" frame (draw first — underneath)
    brackets(draw, f2x, f2y, FW, FH, ARM, (*C_BLUE, 255), ST)
    # White "reference" frame (draw on top)
    brackets(draw, f1x, f1y, FW, FH, ARM, (*C_WHITE, 255), ST)

    # Teal delta arrow between frame centres
    c1x, c1y = f1x + FW // 2, f1y + FH // 2
    c2x, c2y = f2x + FW // 2, f2y + FH // 2
    AW  = max(1, int(S * 0.009))
    AHL = int(S * 0.048)
    ang = math.atan2(c2y - c1y, c2x - c1x)
    draw.line([(c1x, c1y), (c2x, c2y)], fill=(*C_TEAL, 195), width=AW)
    for da in (-0.52, 0.52):
        ex = int(c2x - AHL * math.cos(ang + da))
        ey = int(c2y - AHL * math.sin(ang + da))
        draw.line([(c2x, c2y), (ex, ey)], fill=(*C_TEAL, 195), width=AW)

    return f1x, f1y, f2x, f2y, FW, FH, OFF


# ── ICON  512×512 ─────────────────────────────────────────────────────────────

def render_icon():
    W = H = 512 * SCALE
    img = Image.new('RGBA', (W, H), (*C_BG, 255))

    # Soft radial glow
    img = Image.alpha_composite(img, soft_glow(W, H, W // 2, H // 2, int(W * 0.40), (18, 70, 155), 0.55))

    # Ghost connector lines between corresponding bracket corners
    S   = int(234 * SCALE)
    FW  = S
    FH  = int(S * 0.727)
    OFF = int(S * 0.130)
    cx, cy = W // 2, H // 2
    f1x = cx - FW // 2 - OFF // 2
    f1y = cy - FH // 2 - OFF // 2
    f2x, f2y = f1x + OFF, f1y + OFF

    ghost = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(ghost)
    for dx, dy in [(0, 0), (FW, 0), (0, FH), (FW, FH)]:
        gd.line(
            [(f1x + dx, f1y + dy), (f2x + dx, f2y + dy)],
            fill=(*C_BLUE, 22), width=SCALE
        )
    ghost = ghost.filter(ImageFilter.GaussianBlur(SCALE * 2.5))
    img = Image.alpha_composite(img, ghost)

    draw = ImageDraw.Draw(img)
    drift_mark(draw, W // 2, H // 2, int(234 * SCALE))

    return img.convert('RGB').resize((512, 512), Image.LANCZOS)


# ── BANNER  1200×400 ──────────────────────────────────────────────────────────

def render_banner():
    W0, H0 = 1200, 400
    W, H = W0 * SCALE, H0 * SCALE
    img = Image.new('RGBA', (W, H), (*C_BG, 255))

    # Dot-matrix texture
    dot_layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    dd = ImageDraw.Draw(dot_layer)
    STEP = int(30 * SCALE)
    for gx in range(STEP // 2, W, STEP):
        for gy in range(STEP // 2, H, STEP):
            r = SCALE
            dd.ellipse([gx - r, gy - r, gx + r, gy + r], fill=(*C_STEEL, 32))
    img = Image.alpha_composite(img, dot_layer)

    # Glow behind icon mark
    ICX = int(H * 0.535)   # icon center x (≈ 214 at 1×)
    img = Image.alpha_composite(img, soft_glow(W, H, ICX, H // 2, int(H * 0.40), (18, 70, 155), 0.42))

    draw = ImageDraw.Draw(img)

    # Icon mark — sized to fill the icon zone
    S = int(172 * SCALE)   # frame width at 2×
    drift_mark(draw, ICX, H // 2, S)

    # Vertical separator
    SEP_X = ICX + int(H * 0.375)
    draw.line(
        [(SEP_X, int(H * 0.18)), (SEP_X, int(H * 0.82))],
        fill=(*C_STEEL, 105), width=SCALE
    )

    # Text start
    TX = SEP_X + int(H * 0.082)

    # Fonts (at 2× scale)
    try:
        f_word = ImageFont.truetype(FONT_DIN,  int(H * 0.300))
        f_tag  = ImageFont.truetype(FONT_MONO, int(H * 0.058))
    except Exception as e:
        print(f"  Font error: {e}")
        f_word = f_tag = ImageFont.load_default()

    # Measure text
    _dm  = Image.new('RGBA', (1, 1))
    _dd  = ImageDraw.Draw(_dm)
    sb   = _dd.textbbox((0, 0), "Snap",      font=f_word)
    db   = _dd.textbbox((0, 0), "Drift",     font=f_word)
    fb   = _dd.textbbox((0, 0), "SnapDrift", font=f_word)
    tb   = _dd.textbbox((0, 0), "visual regression  ·  pixel-precise", font=f_tag)

    wh   = fb[3] - fb[1]
    wy   = (H - wh) // 2 - int(H * 0.038)

    # "Snap" — near white
    draw.text((TX - sb[0], wy - sb[1]), "Snap", font=f_word, fill=(*C_WHITE, 255))
    snap_w = sb[2] - sb[0]

    # "Drift" — electric blue
    draw.text((TX + snap_w - db[0], wy - db[1]), "Drift", font=f_word, fill=(*C_BLUE, 255))

    # Tagline — steel / monospace
    ty = wy + wh + int(H * 0.040)
    draw.text((TX - tb[0], ty - tb[1]),
              "visual regression  ·  pixel-precise",
              font=f_tag, fill=(*C_STEEL, 215))

    return img.convert('RGB').resize((W0, H0), Image.LANCZOS)


# ── Main ──────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    print("Rendering icon …")
    icon = render_icon()
    p = os.path.join(OUT, 'snapdrift-logo-icon.png')
    icon.save(p, optimize=True)
    print(f"  ✓  {p}")

    print("Rendering banner …")
    banner = render_banner()
    p = os.path.join(OUT, 'snapdrift-logo-banner.png')
    banner.save(p, optimize=True)
    print(f"  ✓  {p}")
