"""生成 StepDraw 应用图标（1024x1024 PNG，纯标准库，无 PIL 依赖）。

设计：米白纸底 + 黑色毛笔 S 形笔迹（粗细渐变）+ 红色起笔点。
输出：StepDraw/Icon.png（ipeddle.toml 的 icon 字段指向它）。
"""
import struct
import zlib
import math
import os

W = H = 1024
bg = (0xF7, 0xF3, 0xEA)   # 米白
ink = (0x2B, 0x2B, 0x2B)  # 墨黑
red = (0xE5, 0x39, 0x35)  # 起笔点红

# 二次贝塞尔 S 笔迹
P0 = (268.0, 800.0)   # 起笔（左下）
C = (370.0, 520.0)
P1 = (756.0, 244.0)   # 收笔（右上）


def qbezier(t):
    u = 1 - t
    x = u * u * P0[0] + 2 * u * t * C[0] + t * t * P1[0]
    y = u * u * P0[1] + 2 * u * t * C[1] + t * t * P1[1]
    return x, y


N = 56
segs = []
for i in range(N):
    t0, t1 = i / N, (i + 1) / N
    a, b = qbezier(t0), qbezier(t1)
    w = 46 + 40 * (t0 + t1) / 2   # 起笔细、收笔粗
    segs.append((a[0], a[1], b[0], b[1], w))

# 网格分桶（64px 单元），每个像素只查邻近线段
GC = 16
cell = {}
for si, (x0, y0, x1, y1, w) in enumerate(segs):
    mnx, mxx = int(min(x0, x1) - w) // (W // GC), int(max(x0, x1) + w) // (W // GC)
    mny, mxy = int(min(y0, y1) - w) // (H // GC), int(max(y0, y1) + w) // (H // GC)
    for cx in range(max(0, mnx), min(GC, mxx + 1)):
        for cy in range(max(0, mny), min(GC, mxy + 1)):
            cell.setdefault((cx, cy), []).append(si)


def dist_seg(px, py, x0, y0, x1, y1):
    vx, vy = x1 - x0, y1 - y0
    wx, wy = px - x0, py - y0
    L2 = vx * vx + vy * vy
    t = 0 if L2 == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / L2))
    dx = px - (x0 + t * vx)
    dy = py - (y0 + t * vy)
    return math.hypot(dx, dy)


DOT_R = 62.0
rows = []
for y in range(H):
    row = bytearray(W * 3)
    cy = min(GC - 1, y // (H // GC))
    for x in range(W):
        cx = min(GC - 1, x // (W // GC))
        on_ink = False
        for si in cell.get((cx, cy), ()):
            x0, y0, x1, y1, w = segs[si]
            if dist_seg(x, y, x0, y0, x1, y1) <= w:
                on_ink = True
                break
        if on_ink:
            row[x * 3:x * 3 + 3] = ink
        else:
            dx, dy = x - P0[0], y - P0[1]
            row[x * 3:x * 3 + 3] = red if dx * dx + dy * dy <= DOT_R * DOT_R else bg
    rows.append(b"\x00" + bytes(row))


def chunk(tag, data):
    c = struct.pack(">I", len(data)) + tag + data
    return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


png = b"\x89PNG\r\n\x1a\n"
png += chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0))
png += chunk(b"IDAT", zlib.compress(b"".join(rows), 9))
png += chunk(b"IEND", b"")

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "StepDraw", "Icon.png")
out = os.path.normpath(out)
with open(out, "wb") as f:
    f.write(png)
print(f"ok  {out}  ({len(png)} bytes)")
