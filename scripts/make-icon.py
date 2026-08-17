#!/usr/bin/env python3
"""앱 아이콘 생성기. build/icon.png(1024px) 과 build/icon.ico(멀티 사이즈)를 만든다.

디자인: 어두운 라운드 사각형 위에 파란 프롬프트 기호(> _).
실행: python3 scripts/make-icon.py
"""

import os
from PIL import Image, ImageDraw

S = 1024                      # 원본 캔버스 크기
BG = (18, 21, 27, 255)        # 배경(짙은 회흑)
EDGE = (42, 46, 55, 255)      # 테두리
ACCENT = (77, 163, 255, 255)  # 프롬프트 파랑
CURSOR = (228, 228, 228, 255) # 커서 흰색

out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'build')
os.makedirs(out_dir, exist_ok=True)

img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 라운드 사각형 본체
pad, radius = 40, 190
d.rounded_rectangle([pad, pad, S - pad, S - pad], radius=radius, fill=BG, outline=EDGE, width=10)

# 프롬프트 '>' — 두꺼운 꺾은선
w = 62
d.line([(300, 360), (500, 512), (300, 664)], fill=ACCENT, width=w, joint='curve')

# 커서 '_' — 오른쪽 아래 밑줄
d.rounded_rectangle([540, 620, 760, 664], radius=22, fill=CURSOR)

png_path = os.path.join(out_dir, 'icon.png')
img.save(png_path)

# Windows용 멀티 사이즈 ico
ico_path = os.path.join(out_dir, 'icon.ico')
img.save(ico_path, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

print('wrote', png_path)
print('wrote', ico_path)
