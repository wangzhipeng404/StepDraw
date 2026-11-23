"""生成 StepDraw Android 应用图标（自适应图标，米白纸底 + 黑色毛笔 S 形笔迹 + 红色起笔点）。

设计复用 ipad/tools/gen_icon.py 的同一套算法（纯标准库，无 PIL 依赖），
输出 Android 自适应图标所需两张 432x432 的图：
  - android/app/src/main/res/drawable/ic_launcher_foreground.png  （主体，安全区内）
  - android/app/src/main/res/drawable/ic_launcher_background.png  （纯色底）
同时生成一张 512x512 的 README 预览图 android/Icon.png。
"""
import math
import os
import struct
import zlib

bg = (0xF7, 0xF3, 0xEA)   # 米白
ink = (0x2B, 0x2B, 0x2B)  # 墨黑
red = (0xE5, 0x39, 0x35)  # 起笔点红

# 笔迹设计坐标（1024 画布，起笔左下 -> 收笔右上）
P0 = (268.0, 800.0)
C = (370.0, 520.0)
P1 = (756.0, 244.0)
DOT_R = 62.0

N = 56
segs = []
for i in range(N):
    t0, t1 = i / N, (i + 1) / N
    u0, u1 = 1 - t0, 1 - t1
    a = (u0*u0*P0[0] + 2*u0*t0*C[0] + t0*t0*P1[0],
         u0*u0*P0[1] + 2*u0*t0*C[1] + t0*t0*P1[1])
    b = (u1*u1*P0[0] + 2*u1*t1*C[0] + t1*t1*P1[0],
         u1*u1*P0[1] + 2*u1*t1*C[1] + t1*t1*P1[1])
    w = 46 + 40 * (t0 + t1) / 2
    segs.append((a[0], a[1], b[0], b[1], w))


def dist_seg(px, py, x0, y0, x1, y1):
    vx, vy = x1 - x0, y1 - y0
    wx, wy = px - x0, py - y0
    L2 = vx * vx + vy * vy
    t = 0 if L2 == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / L2))
    dx = px - (x0 + t * vx)
    dy = py - (y0 + t * vy)
    return math.hypot(dx, dy)


GC = 16
cell = {}
for si, (x0, y0, x1, y1, w) in enumerate(segs):
    mnx = int(min(x0, x1) - w) // (1024 // GC)
    mxx = int(max(x0, x1) + w) // (1024 // GC)
    mny = int(min(y0, y1) - w) // (1024 // GC)
    mxy = int(max(y0, y1) + w) // (1024 // GC)
    for cx in range(max(0, mnx), min(GC, mxx + 1)):
        for cy in range(max(0, mny), min(GC, mxy + 1)):
            cell.setdefault((cx, cy), []).append(si)


def color_at(x, y):
    """在 1024 设计画布坐标 (x,y) 取色"""
    cx = min(GC - 1, int(x) // (1024 // GC))
    cy = min(GC - 1, int(y) // (1024 // GC))
    for si in cell.get((cx, cy), ()):
        x0, y0, x1, y1, w = segs[si]
        if dist_seg(x, y, x0, y0, x1, y1) <= w:
            return ink
    dx, dy = x - P0[0], y - P0[1]
    return red if dx * dx + dy * dy <= DOT_R * DOT_R else bg


def chunk(tag, data):
    c = struct.pack(">I", len(data)) + tag + data
    return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def write_png(path, w, h, pixels):
    rows = []
    for y in range(h):
        row = bytearray(w * 3)
        for x in range(w):
            c = pixels(y, x)
            o = x * 3
            row[o:o + 3] = bytes(c)
        rows.append(b"\x00" + bytes(row))
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(b"".join(rows), 9))
    png += chunk(b"IEND", b"")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(png)
    print(f"ok  {path}  ({len(png)} bytes)")


HERE = os.path.dirname(os.path.abspath(__file__))
ANDROID = os.path.normpath(os.path.join(HERE, ".."))   # android/ 根目录

# 自适应图标 432x432：主体设计在 1024 画布 -> 安全区（66%）内。
# 1024 设计映射到 432 * 0.66 = 285 的中央区域，四周留透明安全边。
S = 432
SAFE = 432 * 0.66          # 285.12
CENTER = S / 2


def fg_pixels(y, x):
    # 1024 设计坐标：把 (x,y) 反算到 1024 画布，超出安全区外透明
    dx = (x - CENTER) / SAFE * 1024 + 512
    dy = (y - CENTER) / SAFE * 1024 + 512
    if not (0 <= dx <= 1024 and 0 <= dy <= 1024):
        return (0, 0, 0)
    return color_at(dx, dy)


# Android 前景层允许带透明；安全区外的笔迹部分被 launcher 裁掉没问题
write_png(os.path.join(ANDROID, "app/src/main/res/drawable/ic_launcher_foreground.png"),
          S, S, fg_pixels)

# 背景：纯色
write_png(os.path.join(ANDROID, "app/src/main/res/drawable/ic_launcher_background.png"),
          S, S, lambda y, x: bg)

# README 预览图（512，整图带米白底）
PRE = 512


def preview_pixels(y, x):
    return color_at(x / PRE * 1024, y / PRE * 1024)


write_png(os.path.join(ANDROID, "Icon.png"), PRE, PRE, preview_pixels)
print("icons done")
