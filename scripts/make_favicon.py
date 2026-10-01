# -*- coding: utf-8 -*-
"""从用户上传的设计图生成工作台图标集（20261001b）
- 修补右下角「豆包 AI 生成」水印：区域为纯渐变背景（已验证无轨道环穿过），
  用水印上下两行的真实像素做逐列线性插值，保证渐变方向无缝。
- 产出 public/icon.png（512×512 全图）+ public/favicon.ico（16/32/48 中心 80% 裁剪）。
"""
import numpy as np
from PIL import Image

SRC = r'c:\Users\16507\.trae-cn\attachments\6a717d1f20fe4ac0f76cbb2a\6c2156f7-6310-4fa2-b727-c03a217b5325_fd120f32-045e-44f6-b243-61c586c0b33d_金融网站设计方案.png'
OUT_PNG = r'C:\Users\16507\AppData\Local\Temp\sa_icons\icon.png'
OUT_ICO = r'C:\Users\16507\AppData\Local\Temp\sa_icons\favicon.ico'

img = Image.open(SRC).convert('RGB')
a = np.array(img).astype(np.float64)
h, w, _ = a.shape  # 1536x1536

# 水印实测 bbox: y[1455..1502] x[1289..1499]，加安全边距
y0, y1 = 1444, 1514
x0, x1 = 1259, w
row_top = a[y0 - 2, x0:x1, :]        # 上方真实行
row_bot = a[y1 + 2, x0:x1, :]        # 下方真实行
for i, y in enumerate(range(y0, y1)):
    t = (y - (y0 - 2)) / ((y1 + 2) - (y0 - 2))  # 梯度方向插值
    a[y, x0:x1, :] = row_top * (1 - t) + row_bot * t

patched = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))

# 验证：修补区域内不应再残留高亮文字像素
reg = np.array(patched)[y0:y1, x0:x1].astype(int)
lum = reg.mean(axis=2)
assert (lum > lum.mean() + 40).sum() == 0, '水印残留'

# 主图标：全图 512×512
patched.resize((512, 512), Image.LANCZOS).save(OUT_PNG, optimize=True)

# favicon.ico：中心 80% 裁剪（小尺寸下扇形圆环更清晰），多分辨率
m = int(h * 0.10)
tight = patched.crop((m, m, w - m, h - m))
tight.save(OUT_ICO, format='ICO', sizes=[(16, 16), (32, 32), (48, 48)])

# icon.ico（桌面快捷方式用）：全图 256 基准 + 完整尺寸梯度，桌面大图标高清
OUT_DESKTOP = r'C:\Users\16507\AppData\Local\Temp\sa_icons\desktop_icon.ico'
patched.resize((256, 256), Image.LANCZOS).save(
    OUT_DESKTOP, format='ICO',
    sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

import os
print('icon.png:', os.path.getsize(OUT_PNG), 'bytes')
print('favicon.ico:', os.path.getsize(OUT_ICO), 'bytes')
print('desktop icon.ico:', os.path.getsize(OUT_DESKTOP), 'bytes')
print('watermark patched, no bright residue: OK')
