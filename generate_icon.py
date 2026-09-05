"""Generate a modern stock analyzer icon (ICO + PNG)"""
from PIL import Image, ImageDraw, ImageFilter

def lerp_color(c1, c2, t):
    return tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))

def create_icon(size=256):
    # Supersample for smooth edges
    ss = 4
    s = size * ss
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # === Background: rounded square with diagonal gradient ===
    c_top = (11, 17, 32)      # #0B1120 dark navy
    c_mid = (19, 78, 74)      # #134E4A dark teal
    c_bot = (13, 148, 136)    # #0D9488 teal

    for y in range(s):
        for x in range(s):
            t = (x + y) / (2 * s)
            if t < 0.5:
                color = lerp_color(c_top, c_mid, t * 2)
            else:
                color = lerp_color(c_mid, c_bot, (t - 0.5) * 2)
            draw.point((x, y), fill=color + (255,))

    # Rounded corner mask
    radius = int(s * 0.19)
    mask = Image.new('L', (s, s), 0)
    mdraw = ImageDraw.Draw(mask)
    mdraw.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=255)
    img.putalpha(mask)

    # === Subtle glow at top-right ===
    glow = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    gr = int(s * 0.35)
    gcx, gcy = int(s * 0.75), int(s * 0.25)
    for r in range(gr, 0, -2):
        alpha = int(25 * (1 - r / gr) ** 2)
        gdraw.ellipse([gcx - r, gcy - r, gcx + r, gcy + r], fill=(13, 148, 136, alpha))
    glow = glow.filter(ImageFilter.GaussianBlur(radius=int(s * 0.025)))
    img = Image.alpha_composite(img, glow)
    draw = ImageDraw.Draw(img)

    # === Candlesticks ===
    # Layout (fractions of size):
    # x centers: 0.27, 0.50, 0.73
    cx_list = [0.27, 0.50, 0.73]
    body_w = 0.095
    body_radius = int(s * 0.018)
    wick_w = max(2, int(s * 0.014))

    # Each: (x_center, wick_top, wick_bot, body_top, body_bot, color)
    candles = [
        (cx_list[0], 0.48, 0.76, 0.56, 0.69, (239, 68, 68)),    # red, small
        (cx_list[1], 0.36, 0.70, 0.42, 0.60, (34, 197, 94)),    # green, medium
        (cx_list[2], 0.22, 0.64, 0.27, 0.50, (74, 222, 128)),   # bright green, tall
    ]

    for cx_f, wt, wb, bt, bb, color in candles:
        px = int(cx_f * s)
        bw = int(body_w * s)
        # Wick (line through the candle)
        draw.line(
            [(px, int(wt * s)), (px, int(wb * s))],
            fill=color + (255,), width=wick_w
        )
        # Body as rounded rectangle
        x0 = px - bw // 2
        y0 = int(bt * s)
        x1 = px + bw // 2
        y1 = int(bb * s)
        # Subtle inner highlight: lighter at top
        # Draw body with vertical gradient
        for dy in range(y1 - y0):
            t = dy / max(y1 - y0, 1)
            # Lighter at top, original at bottom
            if t < 0.5:
                # Lighten
                c = tuple(min(255, int(color[i] + (255 - color[i]) * 0.25 * (1 - t * 2))) for i in range(3))
            else:
                c = color
            draw.line([(x0, y0 + dy), (x1, y0 + dy)], fill=c + (255,))

        # Now round the corners by clearing them
        corner_clear = Image.new('L', (bw + 4, (y1 - y0) + 4), 255)
        cc_draw = ImageDraw.Draw(corner_clear)
        cc_draw.rounded_rectangle([0, 0, bw + 2, (y1 - y0) + 2], radius=body_radius, fill=0)
        # Apply: where corner_clear == 255 (outside rounded rect), make transparent
        for cy in range((y1 - y0) + 4):
            for cx2 in range(bw + 4):
                if corner_clear.getpixel((cx2, cy)) == 255:
                    actual_x = x0 - 2 + cx2
                    actual_y = y0 - 2 + cy
                    if 0 <= actual_x < s and 0 <= actual_y < s:
                        r, g, b, a = img.getpixel((actual_x, actual_y))
                        img.putpixel((actual_x, actual_y), (r, g, b, 0))

    draw = ImageDraw.Draw(img)

    # === Trend line (golden, dashed look via transparency) ===
    trend_points = [(int(cx * s), int(bt * s)) for cx, wt, wb, bt, bb, color in candles]
    line_w = max(2, int(s * 0.009))
    trend_color = (252, 211, 77)  # #FCD34D

    # Draw solid trend line with glow
    for r in range(int(s * 0.012), 0, -2):
        alpha = int(40 * (1 - r / (s * 0.012)) ** 2)
        for i in range(len(trend_points) - 1):
            draw.line([trend_points[i], trend_points[i + 1]],
                      fill=trend_color + (alpha,), width=line_w + r * 2)
    # Main line
    for i in range(len(trend_points) - 1):
        draw.line([trend_points[i], trend_points[i + 1]],
                  fill=trend_color + (220,), width=line_w)

    # Endpoint glow + dot
    end_x, end_y = trend_points[-1]
    end_r = int(s * 0.028)
    for r in range(end_r, 0, -1):
        alpha = int(200 * (1 - r / end_r) ** 1.5)
        draw.ellipse([end_x - r, end_y - r, end_x + r, end_y + r],
                     fill=trend_color + (alpha,))
    # Solid center
    cr = int(s * 0.011)
    draw.ellipse([end_x - cr, end_y - cr, end_x + cr, end_y + cr],
                 fill=(255, 255, 255, 255))

    # Downscale
    img = img.resize((size, size), Image.LANCZOS)
    return img


def main():
    output_dir = r"C:\Users\16507\WorkBuddy\2026-08-01-18-18-13\stock-analyzer"

    # Main PNG (preview)
    icon = create_icon(256)
    icon.save(output_dir + r"\public\icon.png", "PNG")
    print("Saved: public/icon.png (256x256)")

    # ICO with multiple sizes for desktop shortcut
    sizes = [256, 128, 64, 48, 32, 16]
    images = [create_icon(sz) for sz in sizes]
    images[0].save(output_dir + r"\icon.ico", format='ICO',
                   sizes=[(sz, sz) for sz in sizes])
    print(f"Saved: icon.ico (sizes: {sizes})")

    # Favicon for web app
    fav32 = create_icon(32)
    fav32.save(output_dir + r"\public\favicon.ico", format='ICO',
               sizes=[(32, 32), (16, 16)])
    print("Saved: public/favicon.ico (32x32, 16x16)")

    print("\nAll icons generated successfully!")


if __name__ == '__main__':
    main()