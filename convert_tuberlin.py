#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
TU-Berlin SVG 笔序转换
输入: sketches_svg/<类别>/image-xxxx.svg
      每个 <path> 按文档顺序 = 笔序
      d 支持 M/L/H/V/C/S/Q/T/A/Z（相对坐标、隐式重复、贝塞尔采样、圆弧）
输出: 与 convert_quickdraw.py 一致
      每案例一个 json + 类别索引 + 总索引

用法:
    python convert_tuberlin.py
"""

import glob
import json
import math
import os
import re
import sys

# ==================== 配置 ====================
SRC_DIR = r"C:\Users\epro\Downloads\hiroshima\sketches_svg\svg"          # 类别子目录的父目录
OUT_DIR = r"C:\Users\epro\Downloads\hiroshima\sketches_svg\out"     # 输出目录

MAX_PER_CATEGORY = 0              # 每类最多转多少条; 0 = 全部
TARGET_SIZE = 256                 # 输出 viewBox 边长
STROKE_WIDTH = 3.0                # 统一笔宽
BEZIER_STEPS = 8                  # 三次/二次贝塞尔采样段数
ARC_STEPS = 12                    # 圆弧采样段数
MIN_POINTS = 2                    # 少于该点数的笔画丢弃
PAD = 8.0                         # 缩放后四周留白
TAG = "TU-Berlin"
# =============================================

NUM_RE = re.compile(r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")
PATH_RE = re.compile(
    r"""<path\b[^>]*?\bd\s*=\s*(?:"([^"]*)"|'([^']*)')""",
    re.I | re.S)


# ---------------- 流式 path 读取器 ----------------

class PathReader:
    """流式读取 d 字符串，正确处理 A 命令的紧凑 flag（如 011）"""

    def __init__(self, d):
        self.d = d
        self.i = 0
        self.n = len(d)

    def _skip(self):
        while self.i < self.n and self.d[self.i] in " \t\r\n,":
            self.i += 1

    def at_end(self):
        self._skip()
        return self.i >= self.n

    def peek_cmd(self):
        self._skip()
        if self.i < self.n and self.d[self.i].isalpha():
            return self.d[self.i]
        return None

    def read_cmd(self):
        self._skip()
        if self.i < self.n and self.d[self.i].isalpha():
            c = self.d[self.i]
            self.i += 1
            return c
        return None

    def read_num(self):
        self._skip()
        if self.i >= self.n:
            return None
        m = NUM_RE.match(self.d, self.i)
        if not m:
            return None
        self.i = m.end()
        return float(m.group(0))

    def read_flag(self):
        """A 命令的 large-arc / sweep 只能是 0 或 1，可能紧贴下一数字"""
        self._skip()
        if self.i >= self.n:
            return None
        c = self.d[self.i]
        if c in "01":
            self.i += 1
            return int(c)
        v = self.read_num()
        if v is None:
            return None
        return 1 if v != 0 else 0


# ---------------- 圆弧转点 ----------------

def arc_to_points(x1, y1, rx, ry, phi_deg, large_arc, sweep, x2, y2, steps):
    """SVG 端点参数化圆弧 -> 采样点列表（不含起点）"""
    if rx == 0 or ry == 0:
        return [(x2, y2)]

    rx, ry = abs(rx), abs(ry)
    phi = math.radians(phi_deg)
    cos_phi, sin_phi = math.cos(phi), math.sin(phi)

    dx = (x1 - x2) / 2.0
    dy = (y1 - y2) / 2.0
    x1p = cos_phi * dx + sin_phi * dy
    y1p = -sin_phi * dx + cos_phi * dy

    lam = (x1p ** 2) / (rx ** 2) + (y1p ** 2) / (ry ** 2)
    if lam > 1:
        s = math.sqrt(lam)
        rx *= s
        ry *= s

    num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
    den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
    coef = math.sqrt(max(num / den, 0.0)) if den > 1e-12 else 0.0
    if large_arc == sweep:
        coef = -coef

    cxp = coef * rx * y1p / ry
    cyp = -coef * ry * x1p / rx
    cx = cos_phi * cxp - sin_phi * cyp + (x1 + x2) / 2.0
    cy = sin_phi * cxp + cos_phi * cyp + (y1 + y2) / 2.0

    def angle(ux, uy, vx, vy):
        dot = ux * vx + uy * vy
        n = math.hypot(ux, uy) * math.hypot(vx, vy)
        if n == 0:
            return 0.0
        a = math.acos(max(-1.0, min(1.0, dot / n)))
        return -a if (ux * vy - uy * vx) < 0 else a

    ux, uy = (x1p - cxp) / rx, (y1p - cyp) / ry
    vx, vy = (-x1p - cxp) / rx, (-y1p - cyp) / ry
    theta1 = angle(1.0, 0.0, ux, uy)
    dtheta = angle(ux, uy, vx, vy)

    if not sweep and dtheta > 0:
        dtheta -= 2 * math.pi
    elif sweep and dtheta < 0:
        dtheta += 2 * math.pi

    pts = []
    for k in range(1, steps + 1):
        t = theta1 + dtheta * k / steps
        ex = rx * math.cos(t)
        ey = ry * math.sin(t)
        pts.append((cos_phi * ex - sin_phi * ey + cx,
                    sin_phi * ex + cos_phi * ey + cy))
    return pts


# ---------------- path d 解析 ----------------

def parse_path_d(d, steps=BEZIER_STEPS, arc_steps=ARC_STEPS):
    """解析 d -> [[(x,y), ...], ...]，遇到 M 视为新笔画"""
    r = PathReader(d)
    strokes, cur = [], []
    x = y = 0.0
    sx = sy = 0.0
    last_cx = last_cy = None
    prev_cmd = None
    cmd = None

    def flush():
        nonlocal cur
        if len(cur) >= MIN_POINTS:
            strokes.append(cur)
        cur = []

    def bezier3(x1, y1, x2, y2, px, py):
        for k in range(1, steps + 1):
            t = k / steps
            mt = 1 - t
            cur.append((
                mt**3 * x + 3 * mt * mt * t * x1
                + 3 * mt * t * t * x2 + t**3 * px,
                mt**3 * y + 3 * mt * mt * t * y1
                + 3 * mt * t * t * y2 + t**3 * py,
            ))

    def bezier2(x1, y1, px, py):
        for k in range(1, steps + 1):
            t = k / steps
            mt = 1 - t
            cur.append((
                mt * mt * x + 2 * mt * t * x1 + t * t * px,
                mt * mt * y + 2 * mt * t * y1 + t * t * py,
            ))

    while not r.at_end():
        c = r.peek_cmd()
        if c is not None:
            cmd = r.read_cmd()
            if cmd in "Zz":
                flush()
                x, y = sx, sy
                last_cx = last_cy = None
                prev_cmd = "Z"
                continue
        elif cmd is None:
            r.read_num()
            continue

        u = cmd.upper()
        rel = cmd.islower()

        if u == "M":
            px, py = r.read_num(), r.read_num()
            if px is None or py is None:
                break
            if rel:
                px += x
                py += y
            flush()
            cur = [(px, py)]
            x, y = px, py
            sx, sy = px, py
            cmd = "l" if rel else "L"     # 后续数字按 L 处理
            last_cx = last_cy = None
            prev_cmd = "M"
            continue

        if u == "L":
            px, py = r.read_num(), r.read_num()
            if px is None or py is None:
                break
            if rel:
                px += x
                py += y
            cur.append((px, py))
            x, y = px, py
            last_cx = last_cy = None

        elif u == "H":
            px = r.read_num()
            if px is None:
                break
            if rel:
                px += x
            cur.append((px, y))
            x = px
            last_cx = last_cy = None

        elif u == "V":
            py = r.read_num()
            if py is None:
                break
            if rel:
                py += y
            cur.append((x, py))
            y = py
            last_cx = last_cy = None

        elif u == "C":
            x1, y1 = r.read_num(), r.read_num()
            x2, y2 = r.read_num(), r.read_num()
            px, py = r.read_num(), r.read_num()
            if None in (x1, y1, x2, y2, px, py):
                break
            if rel:
                x1 += x; y1 += y
                x2 += x; y2 += y
                px += x; py += y
            bezier3(x1, y1, x2, y2, px, py)
            last_cx, last_cy = x2, y2
            x, y = px, py

        elif u == "S":
            x2, y2 = r.read_num(), r.read_num()
            px, py = r.read_num(), r.read_num()
            if None in (x2, y2, px, py):
                break
            if rel:
                x2 += x; y2 += y
                px += x; py += y
            if prev_cmd in ("C", "S") and last_cx is not None:
                x1, y1 = 2 * x - last_cx, 2 * y - last_cy
            else:
                x1, y1 = x, y
            bezier3(x1, y1, x2, y2, px, py)
            last_cx, last_cy = x2, y2
            x, y = px, py

        elif u == "Q":
            x1, y1 = r.read_num(), r.read_num()
            px, py = r.read_num(), r.read_num()
            if None in (x1, y1, px, py):
                break
            if rel:
                x1 += x; y1 += y
                px += x; py += y
            bezier2(x1, y1, px, py)
            last_cx, last_cy = x1, y1
            x, y = px, py

        elif u == "T":
            px, py = r.read_num(), r.read_num()
            if px is None or py is None:
                break
            if rel:
                px += x
                py += y
            if prev_cmd in ("Q", "T") and last_cx is not None:
                x1, y1 = 2 * x - last_cx, 2 * y - last_cy
            else:
                x1, y1 = x, y
            bezier2(x1, y1, px, py)
            last_cx, last_cy = x1, y1
            x, y = px, py

        elif u == "A":
            rx, ry, phi = r.read_num(), r.read_num(), r.read_num()
            la = r.read_flag()
            sw = r.read_flag()
            px, py = r.read_num(), r.read_num()
            if None in (rx, ry, phi, la, sw, px, py):
                break
            if rel:
                px += x
                py += y
            cur.extend(arc_to_points(x, y, rx, ry, phi, la, sw,
                                     px, py, arc_steps))
            last_cx = last_cy = None
            x, y = px, py

        else:
            r.read_num()
            continue

        prev_cmd = u

    flush()
    return strokes


# ---------------- 几何 ----------------

def dedup(pts):
    out = [pts[0]]
    for p in pts[1:]:
        if abs(p[0] - out[-1][0]) > 1e-9 or abs(p[1] - out[-1][1]) > 1e-9:
            out.append(p)
    return out


def normalize(strokes, target, pad):
    xs = [p[0] for s in strokes for p in s]
    ys = [p[1] for s in strokes for p in s]
    if not xs:
        return strokes
    minx, maxx = min(xs), max(xs)
    miny, maxy = min(ys), max(ys)
    w = max(maxx - minx, 1e-9)
    h = max(maxy - miny, 1e-9)
    inner = max(target - 2 * pad, 1.0)
    scale = min(inner / w, inner / h)
    ox = (target - w * scale) / 2.0 - minx * scale
    oy = (target - h * scale) / 2.0 - miny * scale
    return [[(p[0] * scale + ox, p[1] * scale + oy) for p in s]
            for s in strokes]


def build_item(strokes, cid, name):
    steps = []
    for i, s in enumerate(strokes, 1):
        steps.append({
            "id": i,
            "tip": "",
            "strokes": [{
                "width": round(STROKE_WIDTH, 2),
                "points": [[round(p[0], 2), round(p[1], 2)] for p in s],
            }],
        })
    n = len(steps)
    difficulty = 1 if n <= 4 else (2 if n <= 7 else 3)
    return {
        "id": cid,
        "name": name,
        "tags": [TAG],
        "difficulty": difficulty,
        "viewBox": [0, 0, TARGET_SIZE, TARGET_SIZE],
        "thumbnail": "",
        "steps": steps,
    }


def safe_id(s):
    return "".join(c for c in s if c.isalnum() or c in "-_") or "x"


# ---------------- 转换单个 SVG ----------------

def convert_svg(path):
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        text = f.read()

    strokes = []
    for m in PATH_RE.finditer(text):
        d = m.group(1) or m.group(2) or ""
        if not d.strip():
            continue
        for s in parse_path_d(d):
            s = dedup(s)
            if len(s) >= MIN_POINTS:
                strokes.append(s)

    if not strokes:
        return None
    return normalize(strokes, TARGET_SIZE, PAD)


# ---------------- 主流程 ----------------

def build_cat_index(cat_dir, cat, name):
    items = []
    for p in sorted(glob.glob(os.path.join(cat_dir, "*.json"))):
        if os.path.basename(p) == "index.json":
            continue
        with open(p, "r", encoding="utf-8") as f:
            it = json.load(f)
        items.append({
            "id": it["id"],
            "name": it["name"],
            "difficulty": it["difficulty"],
            "stepCount": len(it["steps"]),
        })
    with open(os.path.join(cat_dir, "index.json"), "w",
              encoding="utf-8") as fo:
        json.dump({
            "category": cat,
            "name": name,
            "viewBox": [0, 0, TARGET_SIZE, TARGET_SIZE],
            "count": len(items),
            "items": items,
        }, fo, ensure_ascii=False, separators=(",", ":"))
    return len(items)


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    if not os.path.isdir(SRC_DIR):
        print(f"[错误] 输入目录不存在: {os.path.abspath(SRC_DIR)}")
        print("提示: 解压 sketches_svg.zip 后，让 SRC_DIR 下直接是类别子目录")
        return

    cat_dirs = sorted(
        d for d in glob.glob(os.path.join(SRC_DIR, "*")) if os.path.isdir(d))
    if not cat_dirs:
        print(f"[错误] {SRC_DIR} 下没有类别子目录")
        return

    os.makedirs(OUT_DIR, exist_ok=True)
    print(f"输入: {os.path.abspath(SRC_DIR)}")
    print(f"输出: {os.path.abspath(OUT_DIR)}")
    print(f"类别: {len(cat_dirs)} 个\n")

    categories = []
    total = 0
    grand_skip = 0

    for cd in cat_dirs:
        cat = safe_id(os.path.basename(cd))
        svgs = sorted(glob.glob(os.path.join(cd, "*.svg")))
        if not svgs:
            print(f"[跳过] {cat}: 无 svg")
            continue

        cat_dir = os.path.join(OUT_DIR, cat)
        os.makedirs(cat_dir, exist_ok=True)

        kept = 0
        skipped = 0
        for sp in svgs:
            if MAX_PER_CATEGORY and kept >= MAX_PER_CATEGORY:
                break
            stem = os.path.splitext(os.path.basename(sp))[0]
            cid = safe_id(f"{cat}_{stem}")
            try:
                strokes = convert_svg(sp)
            except Exception as e:
                print(f"  [失败] {cat}/{stem}: {e}")
                skipped += 1
                continue
            if not strokes:
                skipped += 1
                continue

            item = build_item(strokes, cid, stem)
            with open(os.path.join(cat_dir, f"{cid}.json"), "w",
                      encoding="utf-8") as fo:
                json.dump(item, fo, ensure_ascii=False,
                          separators=(",", ":"))
            kept += 1

        cnt = build_cat_index(cat_dir, cat, cat)
        print(f"=== {cat}: 写入 {kept}, 跳过 {skipped}, 索引 {cnt} ===")
        total += cnt
        grand_skip += skipped
        if cnt:
            categories.append({
                "id": cat, "name": cat, "count": cnt, "dir": cat,
            })

    root_index = os.path.join(OUT_DIR, "index.json")
    with open(root_index, "w", encoding="utf-8") as f:
        json.dump({
            "viewBox": [0, 0, TARGET_SIZE, TARGET_SIZE],
            "categories": categories,
        }, f, ensure_ascii=False, separators=(",", ":"))

    print("\n" + "=" * 44)
    print(f"类别: {len(categories)}, 案例总数: {total}, 跳过: {grand_skip}")
    print(f"总索引: {os.path.abspath(root_index)}")


if __name__ == "__main__":
    main()