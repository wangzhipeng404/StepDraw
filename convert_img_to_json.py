#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
批量将目录下的图片转换成分步线稿 JSON。

用法:
    python img_to_steps.py

配置:
    修改下方 INPUT_DIR 和 OUTPUT_DIR 即可。
"""

import bisect
import json
import math
import os
import sys

import numpy as np
import vtracer
from scipy.ndimage import distance_transform_edt
from svgelements import SVG, Path, Shape, Move, Close, Line
from PIL import Image

# ==================== 配置 ====================
INPUT_DIR =  r"C:\Users\epro\Downloads\hiroshima\coloring_in"        # 输入图片目录
OUTPUT_DIR = r"C:\Users\epro\Downloads\hiroshima\coloring"        # 输出 JSON 目录
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
OVERWRITE = False  # 是否强制重新生成，设为 True 则覆盖已存在的文件
RECURSIVE = True   # 是否递归遍历子目录
GENERATE_THUMBNAIL = True  # 是否将原图转为 PNG 作为封面

TARGET_SIZE = 256
PADDING = 8
SAMPLES_PER_SEG = 8
SIMPLIFY_EPS = 0.8
THUMB_SIZE = 256  # 封面缩略图尺寸

# 缩略图路径约定（与 normalize_category_indexes.py 一致）：<group>/<cat>/<id>.png
# group 默认取 OUTPUT_DIR 的目录名（它同步到 web/public/data 后即为一级目录）；
# 有子目录时 cat 取子目录名，直接在 OUTPUT_DIR 下时退化为 <group>/<id>.png
THUMB_GROUP = None

# 笔迹拆分：单步（一条笔迹）在 256 坐标系下的最大长度，超过则拆成多段连续笔迹
MAX_STROKE_LEN = 120.0
MIN_SEG_LEN = 1.5          # 短于此长度的碎片直接丢弃

# vtracer 参数
FILTER_SPECKLE = 4
LENGTH_THRESHOLD = 4.0
CORNER_THRESHOLD = 60

# 线条特征分析（线宽 + 深浅），让 JSON 还原原图的层次
ANALYZE_TRAITS = True
MIN_STROKE_WIDTH = 1.0    # 256 坐标系下最小线宽
MAX_STROKE_WIDTH = 5.0    # 256 坐标系下最大线宽
COLOR_LUMA_DARK = 40      # 最深线映射到的灰度 (0=黑)
COLOR_LUMA_LIGHT = 150    # 最浅线映射到的灰度
DEFAULT_WIDTH = 2.0       # 分析失败时的回退线宽
DEFAULT_COLOR = "#333333" # 分析失败时的回退颜色
# =============================================


def rdp(points, eps):
    """Douglas-Peucker 路径简化"""
    if eps <= 0 or len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        max_d, idx = 0.0, -1
        for k in range(i + 1, j):
            d = _dist_point_seg(points[k], points[i], points[j])
            if d > max_d:
                max_d, idx = d, k
        if idx != -1 and max_d > eps:
            keep[idx] = True
            stack.extend([(i, idx), (idx, j)])
    return [p for p, k in zip(points, keep) if k]


def _dist_point_seg(p, a, b):
    x, y = p; x1, y1 = a; x2, y2 = b
    dx, dy = x2 - x1, y2 - y1
    if dx == 0 and dy == 0:
        return math.hypot(x - x1, y - y1)
    t = max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
    return math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))


def extract_paths(svg_path):
    """从 SVG 提取所有子路径的原始点列"""
    svg = SVG.parse(svg_path)
    raw = []
    for element in svg.elements():
        if not isinstance(element, Shape):
            continue
        path_obj = element if isinstance(element, Path) else Path(element)
        try:
            subpaths = list(path_obj.as_subpaths())
        except Exception:
            continue
        for sub in subpaths:
            pts = []
            for seg in sub:
                if isinstance(seg, (Move, Close)):
                    continue
                if isinstance(seg, Line):
                    pts.append([float(seg.end.x), float(seg.end.y)])
                else:
                    for i in range(1, SAMPLES_PER_SEG + 1):
                        try:
                            pt = seg.point(i / SAMPLES_PER_SEG)
                            pts.append([float(pt.x), float(pt.y)])
                        except Exception:
                            pass
            if len(pts) >= 2:
                raw.append(pts)
    return raw


def normalize(paths):
    """包围盒归一化到 [0, TARGET_SIZE]"""
    xs = [p[0] for path in paths for p in path]
    ys = [p[1] for path in paths for p in path]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    w, h = maxx - minx, maxy - miny
    if w <= 0 or h <= 0:
        return []

    inner = TARGET_SIZE - 2 * PADDING
    scale = inner / max(w, h)
    ox = (TARGET_SIZE - w * scale) / 2 - minx * scale
    oy = (TARGET_SIZE - h * scale) / 2 - miny * scale

    result = []
    for path in paths:
        norm = [[round(x * scale + ox, 2), round(y * scale + oy, 2)] for x, y in path]
        norm = rdp(norm, SIMPLIFY_EPS)
        if len(norm) >= 2:
            result.append(norm)
    return result


def path_metrics(points):
    """计算路径的近似面积和长度"""
    area = 0.0
    length = 0.0
    for i in range(len(points)):
        x1, y1 = points[i]
        x2, y2 = points[(i + 1) % len(points)]
        area += x1 * y2 - x2 * y1
        length += math.hypot(x2 - x1, y2 - y1)
    return abs(area) / 2, length


def path_length(points):
    length = 0.0
    for i in range(len(points) - 1):
        length += math.hypot(points[i + 1][0] - points[i][0],
                             points[i + 1][1] - points[i][1])
    return length


def orient_path(points):
    """确定笔迹方向：从上往下画、从左往右画（屏幕坐标，y 向下）。

    开放笔画：整体走向竖直时取顶→底，接近水平时取左→右；
    封闭轮廓：旋转到最高点（平手取最左）起笔，优先顺时针。
    返回 (定向后的点列, 长度)"""
    n = len(points)
    if n < 3:
        return points, path_length(points)
    total = path_length(points)
    if total <= 0:
        return points, total
    end_dist = math.hypot(points[-1][0] - points[0][0],
                          points[-1][1] - points[0][1])
    if end_dist > max(1.0, 0.2 * total):
        # 开放笔画：按整体走向定向（顶→底 / 左→右）
        net_dx = points[-1][0] - points[0][0]
        net_dy = points[-1][1] - points[0][1]
        keep = net_dy > 0 if abs(net_dy) >= abs(net_dx) else net_dx > 0
        return (list(points) if keep else list(reversed(points))), total
    # 封闭轮廓：去掉与起点重合的尾点，旋转到最高点起笔
    ring = list(points)
    if end_dist < max(1.0, 0.05 * total) and ring[-1] == ring[0]:
        ring.pop()
    m = len(ring)
    idx = 0
    for i in range(1, m):
        if (ring[i][1] < ring[idx][1] - 0.5
                or (abs(ring[i][1] - ring[idx][1]) <= 0.5
                    and ring[i][0] < ring[idx][0])):
            idx = i
    # 鞋带公式：屏幕坐标（y 向下）下，正值 = 顺时针
    shoelace = 0.0
    for i in range(m):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % m]
        shoelace += x1 * y2 - x2 * y1
    step = 1 if shoelace >= 0 else -1
    rot = [ring[(idx + k * step) % m] for k in range(m)]
    return rot, total


def split_path(points, max_len=MAX_STROKE_LEN, min_len=MIN_SEG_LEN):
    """按弧长把长笔迹拆成多段，每段共享衔接点，保证连续且长度 ≤ max_len。

    在弧长 max_len 的整数倍处切分（必要时在顶点之间的线上插点），
    相邻段共享切分点，因此描起来是一笔接一笔的连续动作。
    """
    n = len(points)
    if n < 2:
        return []
    lens = [0.0]
    for i in range(n - 1):
        lens.append(lens[-1] + math.hypot(points[i + 1][0] - points[i][0],
                                          points[i + 1][1] - points[i][1]))
    total = lens[-1]
    if total <= max_len:
        return [points] if total >= min_len else []

    cut_arcs = [k * max_len for k in range(1, int(total // max_len) + 1)
                if k * max_len < total - 1e-9]
    if not cut_arcs:
        return [points]

    def point_at_arc(arc):
        i = max(0, min(bisect.bisect_right(lens, arc) - 1, n - 2))
        link = lens[i + 1] - lens[i]
        t = (arc - lens[i]) / link if link > 0 else 0.0
        return [round(points[i][0] + t * (points[i + 1][0] - points[i][0]), 2),
                round(points[i][1] + t * (points[i + 1][1] - points[i][1]), 2)]

    # 原始顶点 + 切分点，按弧长排序（同弧长时顶点优先，稳定排序保证）
    wps = [(lens[k], points[k]) for k in range(n)]
    wps += [(a, point_at_arc(a)) for a in cut_arcs]
    wps.sort(key=lambda x: x[0])
    dedup = []
    for arc, p in wps:
        if dedup and arc - dedup[-1][0] < 1e-3:
            continue
        dedup.append((arc, p))

    # 每到切分点就收一段，下一段从切分点起笔
    segs, cur = [], [dedup[0][1]]
    for idx in range(1, len(dedup)):
        cur.append(dedup[idx][1])
        arc = dedup[idx][0]
        frac = arc / max_len
        if abs(frac - round(frac)) < 1e-3:
            if path_length(cur) >= min_len:
                segs.append(cur)
            cur = [dedup[idx][1]]
    if path_length(cur) >= min_len:
        segs.append(cur)
    return segs or [points]


def order_paths(paths):
    """启发式笔顺：大轮廓先画，细节后补；位置从上往下、从左往右。

    排序键（升序）：
      1) 包围面积大的优先（大轮廓先画，细节后补，同一量级合并）
      2) 位置：最高点从上往下，再从左往右
      3) 长笔画先画

    每条笔迹先整条定向为「从上往下 / 从左往右」的起笔方向，
    再拆分为 ≤ MAX_STROKE_LEN 的连续段（段间共享衔接点，保证连续）。
    """
    def sort_key(p):
        area, _ = path_metrics(p)
        length = path_length(p)
        sy = min(pt[1] for pt in p)
        sx = min(pt[0] for pt in p if pt[1] == sy)
        return (-round(area / 100),
                round(sy, 1),
                round(sx, 1),
                -round(length / 10))

    steps = []
    for pts in sorted(paths, key=sort_key):
        oriented, _ = orient_path(pts)
        for seg in split_path(oriented):
            steps.append(seg)
    return steps


def _otsu_threshold(gray):
    """numpy 实现的 Otsu 阈值，返回 (content_mask, 0~1 归一化灰度)"""
    gray_u = gray.astype(np.float64)
    gray_n = gray_u / 255.0
    hist, _ = np.histogram(gray_u, bins=np.arange(257))
    total = hist.sum()
    if total == 0:
        return gray_n < 0.5, gray_n
    p = hist / total
    bins = np.arange(256)
    omega = np.cumsum(p)
    mu = np.cumsum(p * bins)
    mu_t = mu[-1]
    denom = omega * (1.0 - omega)
    with np.errstate(divide="ignore", invalid="ignore"):
        sigma_b = (mu_t * omega - mu) ** 2 / np.where(denom > 0, denom, 1e-12)
    sigma_b[denom <= 0] = -1.0
    thr = bins[int(np.argmax(sigma_b))] / 255.0
    # 内容为暗线（小于阈值），mask=内容
    return gray_n < thr, gray_n


def analyze_traits(image_path, paths):
    """识别每条路径在原图中的线宽和颜色深浅，返回 (widths, luma, hex_colors)

    paths 为归一化后的 256 坐标系点列。
    widths: 每条路径的线宽（256 坐标系）
    luma: 每条路径的相对深浅 0~1（0 最深，1 最浅）
    hex_colors: 每条路径的十六进制颜色
    分析失败返回 (None, None, None)
    """
    n = len(paths)
    try:
        pil_img = Image.open(image_path)
        # 缩放到适中尺寸做特征分析（线宽/颜色），兼顾精度与速度
        max_dim = 700
        w0, h0 = pil_img.size
        factor = min(1.0, max_dim / max(w0, h0))
        if factor < 1.0:
            pil_img = pil_img.resize((max(1, int(w0 * factor)), max(1, int(h0 * factor))),
                                     Image.LANCZOS)
        gray = np.asarray(pil_img.convert("L"))
        img_h, img_w = gray.shape

        mask, gray_n = _otsu_threshold(gray)
        if not mask.any() or mask.mean() > 0.9:
            raise ValueError("二值化掩膜无效")

        # 距离变换：内容像素到最近背景像素的距离，中心线上即局部半线宽
        dist = distance_transform_edt(mask)

        # 包围盒 → 256 坐标系的映射参数（与 normalize() 保持一致）
        ys, xs = np.where(mask)
        minx, maxx = int(xs.min()), int(xs.max())
        miny, maxy = int(ys.min()), int(ys.max())
        bw, bh = maxx - minx, maxy - miny
        if bw <= 0 or bh <= 0:
            raise ValueError("内容为空")
        scale = (TARGET_SIZE - 2 * PADDING) / max(bw, bh)

        # 彩色图取最暗处的 RGB，保留色相（仅当整体有明显偏色时采用）
        src_rgb = None
        try:
            rgb = np.asarray(pil_img.convert("RGB"), dtype=np.float64)
            luma_img = (gray_n * 255.0)[..., None]
            color_dev = np.sqrt(np.mean((rgb - luma_img) ** 2, axis=2))
            if color_dev[mask].mean() > 12:
                src_rgb = rgb
        except Exception:
            src_rgb = None

        def to_px(p):
            x = minx + p[0] / scale
            y = miny + p[1] / scale
            ix = max(0, min(img_w - 1, int(round(x))))
            iy = max(0, min(img_h - 1, int(round(y))))
            return ix, iy

        # 每条路径：中心线线宽 + 深浅 + 颜色
        raw_widths, luma_vals, colors = [], [], []
        for pts in paths:
            m = len(pts) // 2
            samples = [pts[m], pts[max(0, m - 1)], pts[min(m, len(pts) - 1)], pts[0], pts[-1]]
            pixs = [to_px(p) for p in samples]
            half_ws = [float(dist[iy, ix]) for ix, iy in pixs]
            # 取每个采样点 3x3 邻域内最暗像素作为墨芯，避免细线采样点落在抗锯齿边缘
            lums = []
            for ix, iy in pixs:
                x0, x1 = max(0, ix - 1), min(img_w, ix + 2)
                y0, y1 = max(0, iy - 1), min(img_h, iy + 2)
                lums.append(float(gray_n[y0:y1, x0:x1].min()))
            if max(half_ws) < 0.25:
                # 采样点落在背景里（细线/偏移），用整条路径的均值兜底
                pixs = [to_px(p) for p in pts]
                half_ws = [float(dist[iy, ix]) for ix, iy in pixs]
                lums = [float(gray_n[max(0, iy - 1):min(img_h, iy + 2),
                                     max(0, ix - 1):min(img_w, ix + 2)].min())
                        for ix, iy in pixs]
                if not half_ws:
                    raise ValueError("路径与原图无对应像素")

            median_half = float(np.median(half_ws))
            width256 = float(np.clip(2 * median_half * scale,
                                     MIN_STROKE_WIDTH, MAX_STROKE_WIDTH))
            luma255 = float(np.median(lums)) * 255.0

            r = g = b = int(round(luma255))
            if src_rgb is not None:
                best = min(pixs, key=lambda p: float(gray_n[p[1], p[0]]))
                r, g, b = [int(round(c)) for c in src_rgb[best[1], best[0]]]

            raw_widths.append(width256)
            luma_vals.append(luma255)
            colors.append((r, g, b))

        # 全图范围内把深浅映射到 [COLOR_LUMA_DARK, COLOR_LUMA_LIGHT]，拉开层次
        lv = np.array(luma_vals, dtype=np.float64)
        vmin, vmax = float(lv.min()), float(lv.max())
        has_contrast = (vmax - vmin) > 24  # 对比足够才拉开，否则统一用默认色
        if has_contrast:
            depth_norm = (lv - vmin) / (vmax - vmin)
            mapped = (COLOR_LUMA_DARK + depth_norm * (COLOR_LUMA_LIGHT - COLOR_LUMA_DARK)).astype(int)
        else:
            depth_norm = np.full(n, 0.5)
            mapped = None

        hex_colors = []
        for i in range(n):
            if mapped is None:
                hex_colors.append(DEFAULT_COLOR)
                continue
            r, g, b = colors[i]
            if src_rgb is not None:
                mid = int((COLOR_LUMA_DARK + COLOR_LUMA_LIGHT) / 2)
                k = mapped[i] / max(1, mid)
                r, g, b = int(min(255, r * k)), int(min(255, g * k)), int(min(255, b * k))
            else:
                r = g = b = int(mapped[i])
            hex_colors.append("#%02x%02x%02x" % (r, g, b))

        return [round(w, 2) for w in raw_widths], depth_norm, hex_colors

    except Exception:
        return (None,) * 3


def compute_thumbnail(output_path):
    """计算缩略图路径（与 normalize_category_indexes.py 的约定一致）：
    有子目录 → <group>/<cat>/<id>.png；直接在 OUTPUT_DIR 下 → <group>/<id>.png。
    cat 取输出文件相对 OUTPUT_DIR 的直接上级目录名，id 取 JSON 文件名（不含扩展名）。"""
    group = THUMB_GROUP or os.path.basename(os.path.normpath(OUTPUT_DIR))
    rel = os.path.relpath(output_path, OUTPUT_DIR).replace("\\", "/")
    cid = os.path.splitext(os.path.basename(rel))[0]
    if "/" in rel:
        cat = rel.rsplit("/", 1)[0].split("/")[-1]
        return f"{group}/{cat}/{cid}.png"
    return f"{group}/{cid}.png"


def generate_thumbnail(input_path, output_png):
    """将原图转换为 PNG 作为封面"""
    try:
        img = Image.open(input_path)
        # 转换为 RGBA 模式
        if img.mode != "RGBA":
            img = img.convert("RGBA")
        # 缩放到目标尺寸
        img = img.resize((THUMB_SIZE, THUMB_SIZE), Image.LANCZOS)
        img.save(output_png, "PNG", optimize=True)
        return True
    except Exception as e:
        print(f"    [警告] 生成封面失败：{e}")
        return False


def convert_one(input_path, output_path, gen_thumbnail=False):
    """单张图片转换"""
    tmp_svg = output_path + ".lineart.svg"

    vtracer.convert_image_to_svg_py(
        input_path, tmp_svg,
        colormode="binary",
        mode="spline",
        filter_speckle=FILTER_SPECKLE,
        length_threshold=LENGTH_THRESHOLD,
        corner_threshold=CORNER_THRESHOLD,
    )

    try:
        raw_paths = extract_paths(tmp_svg)
    finally:
        if os.path.exists(tmp_svg):
            os.remove(tmp_svg)

    if not raw_paths:
        return 0

    paths = normalize(raw_paths)
    if not paths:
        return 0

    ordered = order_paths(paths)

    # 识别线宽与颜色深浅，让 JSON 更还原原图层次
    widths, luma, hex_colors = (None, None, None)
    if ANALYZE_TRAITS:
        widths, luma, hex_colors = analyze_traits(input_path, ordered)

    steps = []
    for i, pts in enumerate(ordered):
        width = widths[i] if widths else DEFAULT_WIDTH
        color = hex_colors[i] if hex_colors else DEFAULT_COLOR
        step = {
            "id": i + 1,
            "tip": "",
            "strokes": [{
                "width": width,
                "color": color,
                "fill": "none",
                "points": pts,
            }],
        }
        if luma is not None:
            step["depth"] = round(float(luma[i]), 3)
        steps.append(step)

    n = len(steps)
    difficulty = 1 if n <= 4 else (2 if n <= 7 else 3)
    name = os.path.splitext(os.path.basename(input_path))[0]

    result = {
        "id": name,
        "name": name,
        "tags": ["生成"],
        "difficulty": difficulty,
        "viewBox": [0, 0, TARGET_SIZE, TARGET_SIZE],
        "thumbnail": compute_thumbnail(output_path),
        "steps": steps,
    }

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, separators=(",", ":"))

    # 生成封面
    if gen_thumbnail:
        png_path = output_path.replace(".json", ".png")
        generate_thumbnail(input_path, png_path)

    return n


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    if not os.path.isdir(INPUT_DIR):
        print(f"[错误] 输入目录不存在：{os.path.abspath(INPUT_DIR)}")
        return

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # 收集图片文件（支持递归遍历子目录）
    files = []
    if RECURSIVE:
        for root, dirs, filenames in os.walk(INPUT_DIR):
            for fn in filenames:
                if os.path.splitext(fn)[1].lower() in IMAGE_EXTS:
                    # 存储相对路径，用于保持子目录结构
                    rel_path = os.path.relpath(os.path.join(root, fn), INPUT_DIR)
                    files.append((rel_path, fn))
    else:
        for fn in os.listdir(INPUT_DIR):
            if os.path.splitext(fn)[1].lower() in IMAGE_EXTS:
                files.append((fn, fn))

    files = sorted(files, key=lambda x: x[0])

    if not files:
        print(f"[错误] {INPUT_DIR} 下没有图片文件")
        return

    print(f"输入：{os.path.abspath(INPUT_DIR)}")
    print(f"输出：{os.path.abspath(OUTPUT_DIR)}")
    print(f"待处理：{len(files)} 张")
    print(f"递归遍历：{RECURSIVE}")
    print(f"生成封面：{GENERATE_THUMBNAIL}\n")

    ok, fail, skip = 0, 0, 0
    items = []

    # 获取类别名称（从目录名）
    category = os.path.basename(os.path.normpath(OUTPUT_DIR))

    for i, (rel_path, fn) in enumerate(files, 1):
        input_path = os.path.join(INPUT_DIR, rel_path)
        output_name = os.path.splitext(fn)[0] + ".json"

        # 如果递归遍历，保持子目录结构
        if RECURSIVE and os.path.dirname(rel_path):
            sub_dir = os.path.dirname(rel_path)
            output_dir = os.path.join(OUTPUT_DIR, sub_dir)
            os.makedirs(output_dir, exist_ok=True)
        else:
            output_dir = OUTPUT_DIR

        output_path = os.path.join(output_dir, output_name)

        # 如果已存在且不过覆盖，跳过并读取已有信息
        if not OVERWRITE and os.path.exists(output_path):
            skip += 1
            try:
                with open(output_path, "r", encoding="utf-8") as f:
                    existing_json = json.load(f)
                # 计算 thumbnail 路径（与 normalize_category_indexes.py 一致）
                items.append({
                    "id": existing_json.get("id", os.path.splitext(fn)[0]),
                    "name": existing_json.get("name", os.path.splitext(fn)[0]),
                    "thumbnail": compute_thumbnail(output_path),
                    "difficulty": existing_json.get("difficulty", 1),
                    "stepCount": len(existing_json.get("steps", []))
                })
                # 如果已存在的案例 JSON 里 thumbnail 缺失/不一致，顺手补上
                want_thumb = compute_thumbnail(output_path)
                if existing_json.get("thumbnail") != want_thumb:
                    existing_json["thumbnail"] = want_thumb
                    with open(output_path, "w", encoding="utf-8") as f:
                        json.dump(existing_json, f, ensure_ascii=False, separators=(",", ":"))
                # 如果生成封面且封面不存在，补生封面
                if GENERATE_THUMBNAIL:
                    png_path = output_path.replace(".json", ".png")
                    if not os.path.exists(png_path):
                        generate_thumbnail(input_path, png_path)
                print(f"[{i}/{len(files)}] {fn}: 跳过")
            except Exception as e:
                print(f"[{i}/{len(files)}] {fn}: [警告] 读取已存在文件失败 - {e}")
            continue

        try:
            n = convert_one(input_path, output_path, GENERATE_THUMBNAIL)
            if n == 0:
                print(f"[{i}/{len(files)}] {fn}: 无有效路径")
                fail += 1
            else:
                print(f"[{i}/{len(files)}] {fn}: {n} 步")
                items.append({
                    "id": os.path.splitext(fn)[0],
                    "name": os.path.splitext(fn)[0],
                    "thumbnail": compute_thumbnail(output_path),
                    "difficulty": 1 if n <= 4 else (2 if n <= 7 else 3),
                    "stepCount": n
                })
                ok += 1
        except Exception as e:
            print(f"[{i}/{len(files)}] {fn}: 失败 - {e}")
            fail += 1

    # 写入 index.json
    index_json = {
        "category": category,
        "name": category.capitalize(),
        "viewBox": [0, 0, TARGET_SIZE, TARGET_SIZE],
        "count": len(items),
        "items": items
    }
    index_path = os.path.join(OUTPUT_DIR, "index.json")
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(index_json, f, ensure_ascii=False, separators=(",", ":"))

    print("=" * 50)
    print(f"完成：成功 {ok}, 跳过 {skip}, 失败 {fail}, 共 {len(items)} 条")
    print(f"已生成 index.json: {index_path}")


if __name__ == "__main__":
    main()
