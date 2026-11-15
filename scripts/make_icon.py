"""
生成 PaperLens 的应用图标。

设计：深色圆角底 + 几行文本 + 其中一行被高亮选中。
一眼能看出「在文字上划了一条」。

输出：
  resources/icon.png  256x256，给 BrowserWindow 用
  resources/icon.ico  多尺寸，给 Windows 快捷方式和窗口用
"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "resources"

BACKGROUND = (26, 26, 35, 255)
TEXT = (206, 206, 222, 255)
TEXT_DIM = (138, 138, 160, 255)
HIGHLIGHT = (255, 199, 64, 255)

# (纵向位置比例, 宽度比例, 颜色)
ROWS = [
    (0.315, 0.42, TEXT),
    (0.455, 0.62, TEXT),  # 被高亮的那一行
    (0.595, 0.50, TEXT_DIM),
    (0.735, 0.34, TEXT_DIM),
]


def build(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    radius = int(size * 0.23)
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=BACKGROUND)

    left = size * 0.175
    bar_height = max(3, int(round(size * 0.056)))
    bar_radius = bar_height / 2

    # 先把高亮块画在下面，再把文字压上去，这样文字仍然清晰可读
    pick_y = size * ROWS[1][0]
    pick_w = size * ROWS[1][1]
    pad_x = size * 0.045
    pad_y = size * 0.032
    draw.rounded_rectangle(
        [
            left - pad_x,
            pick_y - pad_y,
            left + pick_w + pad_x,
            pick_y + bar_height + pad_y,
        ],
        radius=int(size * 0.042),
        fill=HIGHLIGHT,
    )

    for index, (y_ratio, width_ratio, colour) in enumerate(ROWS):
        y = size * y_ratio
        width = size * width_ratio
        if index == 1:
            # 高亮行用深色文字，制造反白效果
            colour = (32, 26, 8, 255)
        draw.rounded_rectangle(
            [left, y, left + width, y + bar_height],
            radius=bar_radius,
            fill=colour,
        )

    return img


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    build(256).save(OUT / "icon.png", "PNG")

    # 每个尺寸单独重绘，直接缩放大图会糊
    sizes = [256, 128, 64, 48, 32, 24, 16]
    frames = [build(s) for s in sizes]
    frames[0].save(
        OUT / "icon.ico",
        format="ICO",
        sizes=[(s, s) for s in sizes],
        append_images=frames[1:],
    )

    print(f"wrote {OUT / 'icon.png'} and {OUT / 'icon.ico'}")


if __name__ == "__main__":
    main()
