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


def write_icns(image, path):
    """macOS용 icns 생성. PNG 를 담는 최신 icns 타입만 사용한다.

    (mac 이 아닌 곳에서도 만들 수 있도록 iconutil 없이 직접 컨테이너를 쓴다)
    """
    import struct
    from io import BytesIO

    # (OSType, 픽셀 크기)
    entries = [
        (b'icp4', 16), (b'icp5', 32), (b'icp6', 64),
        (b'ic07', 128), (b'ic08', 256), (b'ic09', 512),
        (b'ic10', 1024),                    # 512@2x
        (b'ic11', 32), (b'ic12', 64),       # 16@2x, 32@2x
        (b'ic13', 256), (b'ic14', 512),     # 128@2x, 256@2x
    ]
    chunks = []
    for ostype, size in entries:
        buf = BytesIO()
        image.resize((size, size), Image.LANCZOS).save(buf, format='PNG')
        data = buf.getvalue()
        chunks.append(ostype + struct.pack('>I', len(data) + 8) + data)
    body = b''.join(chunks)
    with open(path, 'wb') as f:
        f.write(b'icns' + struct.pack('>I', len(body) + 8) + body)


# macOS 아이콘은 다른 앱과 크기를 맞추기 위해 아트워크를 85% 로 줄이고 둘레에 투명 여백을 둔다
mac_canvas = Image.new('RGBA', (S, S), (0, 0, 0, 0))
scaled = round(S * 0.85)
off = (S - scaled) // 2
mac_canvas.paste(img.resize((scaled, scaled), Image.LANCZOS), (off, off), img.resize((scaled, scaled), Image.LANCZOS))
icns_path = os.path.join(out_dir, 'icon.icns')
write_icns(mac_canvas, icns_path)

# 렌더러(정보 창)에서 표시할 사본
renderer_dir = os.path.join(os.path.dirname(out_dir), 'src', 'renderer', 'assets')
os.makedirs(renderer_dir, exist_ok=True)
img.resize((256, 256), Image.LANCZOS).save(os.path.join(renderer_dir, 'icon.png'))
print('wrote', os.path.join(renderer_dir, 'icon.png'))

print('wrote', png_path)
print('wrote', ico_path)
print('wrote', icns_path)
