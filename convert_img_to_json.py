#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
批量将目录下的图片转换成分步线稿 JSON。

简化版策略：
  1. 边框：cv2 物理剥离，最先画（一刀尽量画完）
  2. 内容：区域树分物体 → 每个物体骨架追踪 → 折线
  3. 折线排序：从中心出发 + 就近衔接（不再分 5 层）
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

try:
    import cv2
    HAS_CV2 = True
except ImportError:
    HAS_CV2 = False

try:
    from skimage.morphology import skeletonize as sk_skeletonize
    HAS_SKIMAGE = True
except ImportError:
    HAS_SKIMAGE = False

# ==================== 配置 ====================
INPUT_DIR =  r"C:\Users\epro\Downloads\hiroshima\coloring_in"
OUTPUT_DIR = r"C:\Users\epro\Downloads\hiroshima\coloring"
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
OVERWRITE = True
RECURSIVE = True
GENERATE_THUMBNAIL = True

TARGET_SIZE = 256
PADDING = 8
SAMPLES_PER_SEG = 8
SIMPLIFY_EPS = 0.8
THUMB_SIZE = 256
THUMB_GROUP = None

MAX_STROKE_LEN = 120.0
FRAME_MAX_STROKE_LEN = 400.0
MIN_SEG_LEN = 1.5

# ===== 边框剥离（最可靠，优先 cv2） =====
DRAW_FRAME_FIRST = True
FRAME_TOL = 0.05
FRAME_COVER = 0.4
CV2_MIN_BOX_RATIO = 0.65
CV2_MIN_EDGE_MARGIN = 0.05
CV2_ERASER_SCALE = 1.5

# ===== 物体分离 =====
USE_OBJECT_SEPARATION = True
OBJECT_MODE = "region"           # "region" 区域树；"connected" 连通域；"none" 不分离
OBJECT_DILATE_RATIO = 0.015
OBJECT_MIN_AREA_RATIO = 0.003

# ===== 矢量提取（骨架追踪是核心） =====
VECTORIZER = "vtracer"             # "trace" 骨架追踪；"vtracer"
TRACE_MAX_TURN_DEG = 75.0
TRACE_MIN_POLYLINE_PIXELS = 3

# vtracer 参数（VECTORIZER="vtracer" 或追踪失败回退时使用）
FILTER_SPECKLE = 4
LENGTH_THRESHOLD = 4.0
CORNER_THRESHOLD = 60

# ===== 折线排序（简化：只需选起始策略） =====
ORDER_START_MODE = "center"      # "center" 离画面中心最近的折线先画；"top_left" 从上到下
ORDER_STEP_MODE = "nearest"      # "nearest" 就近衔接；"top_left" 纯书写顺序

# ===== 线条特征 =====
ANALYZE_TRAITS = True
MIN_STROKE_WIDTH = 1.0
MAX_STROKE_WIDTH = 5.0
COLOR_LUMA_DARK = 40
COLOR_LUMA_LIGHT = 150
DEFAULT_WIDTH = 2.0
DEFAULT_COLOR = "#333333"
# =============================================


# ==================== 基础工具 ====================

def rdp(points, eps):
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


def path_length(points):
    length = 0.0
    for i in range(len(points) - 1):
        length += math.hypot(points[i + 1][0] - points[i][0],
                             points[i + 1][1] - points[i][1])
    return length


def orient_path(points):
    """确定笔迹方向：从上往下、从左往右（屏幕坐标）。"""
    n = len(points)
    if n < 3:
        return points, path_length(points)
    total = path_length(points)
    if total <= 0:
        return points, total
    end_dist = math.hypot(points[-1][0] - points[0][0],
                          points[-1][1] - points[0][1])
    if end_dist > max(1.0, 0.2 * total):
        net_dx = points[-1][0] - points[0][0]
        net_dy = points[-1][1] - points[0][1]
        keep = net_dy > 0 if abs(net_dy) >= abs(net_dx) else net_dx > 0
        return (list(points) if keep else list(reversed(points))), total
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
    shoelace = 0.0
    for i in range(m):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % m]
        shoelace += x1 * y2 - x2 * y1
    step = 1 if shoelace >= 0 else -1
    rot = [ring[(idx + k * step) % m] for k in range(m)]
    return rot, total


def split_path(points, max_len=MAX_STROKE_LEN, min_len=MIN_SEG_LEN):
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

    wps = [(lens[k], points[k]) for k in range(n)]
    wps += [(a, point_at_arc(a)) for a in cut_arcs]
    wps.sort(key=lambda x: x[0])
    dedup = []
    for arc, p in wps:
        if dedup and arc - dedup[-1][0] < 1e-3:
            continue
        dedup.append((arc, p))

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


# ==================== 骨架追踪（最小转角） ====================

def _recent_direction(path, n=3):
    pts = path[-n:] if len(path) >= n else path
    if len(pts) < 2:
        return (0.0, 0.0)
    dy = pts[-1][0] - pts[0][0]
    dx = pts[-1][1] - pts[0][1]
    m = math.hypot(dy, dx)
    return (dy / m, dx / m) if m > 0 else (0.0, 0.0)


def _pixel_direction(a, b):
    dy, dx = b[0] - a[0], b[1] - a[1]
    m = math.hypot(dy, dx)
    return (dy / m, dx / m) if m > 0 else (0.0, 0.0)


def skeleton_trace_polylines(line_mask, max_turn_deg=TRACE_MAX_TURN_DEG,
                             min_pixels=TRACE_MIN_POLYLINE_PIXELS):
    """骨架化 + 逐像素追踪；交叉点按最小转角选择分支。"""
    if not HAS_SKIMAGE:
        return []
    skel = sk_skeletonize(line_mask > 0)
    pix = {(int(y), int(x)) for y, x in zip(*np.where(skel))}
    if not pix:
        return []

    NB8 = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]

    def nbrs(p):
        y, x = p
        return [(y + dy, x + dx) for dy, dx in NB8 if (y + dy, x + dx) in pix]

    deg = {p: len(nbrs(p)) for p in pix}
    endpoints = [p for p in pix if deg[p] == 1]
    junctions = [p for p in pix if deg[p] >= 3]

    used_edges = set()

    def trace_from(start, first):
        path = [start, first]
        used_edges.add(frozenset({start, first}))
        prev, cur = start, first
        while True:
            cand = [n for n in nbrs(cur)
                    if n != prev and frozenset({cur, n}) not in used_edges]
            if not cand:
                break

            if deg[cur] <= 2:
                if len(cand) != 1:
                    if start in cand:
                        path.append(start)
                    break
                best = cand[0]
            else:
                d_prev = _recent_direction(path, n=3)
                best, best_cos = None, -2.0
                for n in cand:
                    d = _pixel_direction(cur, n)
                    c = d_prev[0] * d[0] + d_prev[1] * d[1]
                    if c > best_cos:
                        best_cos, best = c, n
                if best is None:
                    break
                turn = math.degrees(math.acos(max(-1.0, min(1.0, best_cos))))
                if turn > max_turn_deg:
                    break

            used_edges.add(frozenset({cur, best}))
            prev, cur = cur, best
            path.append(cur)
        return path

    result_pix = []
    for ep in endpoints:
        for n in nbrs(ep):
            if frozenset({ep, n}) in used_edges:
                continue
            path = trace_from(ep, n)
            if len(path) >= min_pixels:
                result_pix.append(path)

    for j in junctions:
        for n in nbrs(j):
            if frozenset({j, n}) in used_edges:
                continue
            path = trace_from(j, n)
            if len(path) >= min_pixels:
                result_pix.append(path)

    for p in pix:
        for n in nbrs(p):
            if frozenset({p, n}) in used_edges:
                continue
            path = trace_from(p, n)
            if len(path) >= min_pixels:
                result_pix.append(path)

    results = []
    for path in result_pix:
        xy = []
        for (y, x) in path:
            if not xy or xy[-1] != (x, y):
                xy.append((x, y))
        if len(xy) >= 2:
            results.append([[float(x), float(y)] for (x, y) in xy])
    return results


# ==================== 边框剥离 ====================

def _find_contours_compat(binary, mode=None):
    if mode is None:
        mode = cv2.RETR_EXTERNAL
    result = cv2.findContours(binary, mode, cv2.CHAIN_APPROX_NONE)
    if len(result) == 2:
        return result[0], result[1]
    return result[1], result[2]


def detect_and_strip_outer_frame(image_path):
    if not HAS_CV2:
        return None, None, None
    try:
        img = cv2.imread(image_path, cv2.IMREAD_GRAYSCALE)
        if img is None:
            return None, None, None
        H, W = img.shape

        _, binary = cv2.threshold(
            img, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

        contours, _ = _find_contours_compat(binary, cv2.RETR_EXTERNAL)
        if not contours:
            return None, None, (W, H)

        best, best_area = None, 0.0
        for cnt in contours:
            x, y, w, h = cv2.boundingRect(cnt)
            if w < CV2_MIN_BOX_RATIO * W or h < CV2_MIN_BOX_RATIO * H:
                continue
            margin_x = min(x, W - (x + w))
            margin_y = min(y, H - (y + h))
            if (margin_x > CV2_MIN_EDGE_MARGIN * W and
                    margin_y > CV2_MIN_EDGE_MARGIN * H):
                continue
            area = cv2.contourArea(cnt)
            if area > best_area:
                best_area, best = area, cnt

        if best is None:
            return None, None, (W, H)

        frame_pts = best.reshape(-1, 2).astype(float).tolist()
        if frame_pts[0] != frame_pts[-1]:
            frame_pts.append(frame_pts[0])

        dist = cv2.distanceTransform(binary, cv2.DIST_L2, 5)
        nz = dist[binary > 0]
        if len(nz) == 0:
            return None, None, (W, H)
        median_w = float(np.median(nz)) * 2.0
        eraser_width = max(3, int(round(median_w * CV2_ERASER_SCALE)))

        content_mask = binary.copy()
        cv2.drawContours(content_mask, [best], -1, 0, thickness=eraser_width)

        content_img = 255 - content_mask
        return frame_pts, content_img, (W, H)
    except Exception as e:
        print(f"    [警告] cv2 外框检测失败：{e}")
        return None, None, None


# ==================== 物体分离 ====================

def separate_objects_region(content_img,
                            dilate_ratio=OBJECT_DILATE_RATIO,
                            min_area_ratio=OBJECT_MIN_AREA_RATIO):
    """封闭区域树分离。涂色线稿的物体 = 最外层封闭区域。"""
    if not HAS_CV2:
        return None
    try:
        binary = (255 - content_img).astype(np.uint8)
        H, W = binary.shape
        min_area = H * W * max(0.0005, min_area_ratio * 0.5)

        best_contours = None
        best_score = -1.0
        base = dilate_ratio if dilate_ratio > 0 else 0.015
        for k_ratio in [base * 0.3, base * 0.5, base * 0.7,
                        base, base * 1.4, base * 2.0]:
            k = max(3, int(min(H, W) * k_ratio))
            if k % 2 == 0:
                k += 1
            kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
            closed = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)
            cs, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL,
                                     cv2.CHAIN_APPROX_NONE)
            valid = [c for c in cs if cv2.contourArea(c) >= min_area]
            n = len(valid)
            if n < 2:
                continue
            coverage = sum(cv2.contourArea(c) for c in valid) / (H * W)
            if coverage < 0.15:
                continue
            if 2 <= n <= 8:
                score = 100.0 - abs(n - 5) * 5.0
            elif n <= 20:
                score = 50.0 - (n - 8) * 2.0
            else:
                score = 10.0
            score += coverage * 25.0
            if score > best_score:
                best_score = score
                best_contours = valid

        if not best_contours:
            return None

        items = []
        for c in best_contours:
            a = cv2.contourArea(c)
            bbox = cv2.boundingRect(c)
            items.append({'contour': c, 'bbox': bbox, 'area': a})
        items.sort(key=lambda x: -x['area'])

        occupied = np.zeros_like(binary)
        result = []
        for item in items:
            obj_mask = np.zeros_like(binary)
            cv2.drawContours(obj_mask, [item['contour']], -1, 255, -1)
            obj_mask = cv2.bitwise_and(obj_mask, cv2.bitwise_not(occupied))
            if np.count_nonzero(obj_mask) < min_area * 0.5:
                continue
            occupied = cv2.bitwise_or(occupied, obj_mask)
            obj_lines = cv2.bitwise_and(binary, obj_mask)
            if np.count_nonzero(obj_lines) < 100:
                continue
            result.append({
                'img': 255 - obj_lines,
                'bbox': item['bbox'],
                'area': int(np.count_nonzero(obj_lines)),
            })

        remaining = cv2.bitwise_and(binary, cv2.bitwise_not(occupied))
        if np.count_nonzero(remaining) > H * W * 0.002:
            ys, xs = np.where(remaining > 0)
            bbox = (int(xs.min()), int(ys.min()),
                    int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1))
            result.append({
                'img': 255 - remaining,
                'bbox': bbox,
                'area': int(np.count_nonzero(remaining)),
            })

        return result if result else None
    except Exception as e:
        print(f"    [警告] 区域分离失败：{e}")
        return None


def separate_content_objects(content_img):
    """连通域分离（OBJECT_MODE="connected" 时使用）。"""
    if not HAS_CV2:
        return None
    try:
        binary = (255 - content_img).astype(np.uint8)
        H, W = binary.shape
        kernel_size = max(3, int(min(H, W) * OBJECT_DILATE_RATIO))
        if kernel_size % 2 == 0:
            kernel_size += 1
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE,
                                           (kernel_size, kernel_size))
        dilated = cv2.dilate(binary, kernel)
        num, labels, stats, _ = cv2.connectedComponentsWithStats(dilated)
        min_area = H * W * OBJECT_MIN_AREA_RATIO
        objects = []
        for i in range(1, num):
            x, y, w, h, area = (int(stats[i][0]), int(stats[i][1]),
                                int(stats[i][2]), int(stats[i][3]),
                                int(stats[i][4]))
            if area < min_area:
                continue
            obj_mask = (labels == i).astype(np.uint8) * 255
            obj_lines = cv2.bitwise_and(binary, obj_mask)
            if obj_lines.sum() == 0:
                continue
            objects.append({"img": 255 - obj_lines,
                            "bbox": (x, y, w, h), "area": area})
        return objects if objects else None
    except Exception as e:
        print(f"    [警告] 连通域分离失败：{e}")
        return None


# ==================== 回退：路径级启发式分边框 ====================

def _global_bbox(paths):
    xs = [p[0] for path in paths for p in path]
    ys = [p[1] for path in paths for p in path]
    return min(xs), min(ys), max(xs), max(ys)


def _is_edge_point(p, gx0, gy0, gx1, gy1, tol):
    gw = gx1 - gx0
    gh = gy1 - gy0
    if gw <= 0 or gh <= 0:
        return False
    return (p[0] - gx0 <= tol * gw or gx1 - p[0] <= tol * gw or
            p[1] - gy0 <= tol * gh or gy1 - p[1] <= tol * gh)


def _split_by_flags(pts, flags):
    n = len(pts)
    if n == 0:
        return []
    segments = []
    start = 0
    cur_flag = flags[0]
    for i in range(1, n):
        if flags[i] != cur_flag:
            segments.append((cur_flag, pts[start:i]))
            cur_flag = flags[i]
            start = i - 1
    segments.append((cur_flag, pts[start:]))
    return [(f, s) for f, s in segments if len(s) >= 2]


def separate_outer_frame(paths, tol=FRAME_TOL, cover=FRAME_COVER):
    if len(paths) <= 1:
        return [], paths

    gx0, gy0, gx1, gy1 = _global_bbox(paths)
    gw = gx1 - gx0
    gh = gy1 - gy0
    if gw <= 0 or gh <= 0:
        return [], paths

    has_frame = False
    for pts in paths:
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        w = max(xs) - min(xs)
        h = max(ys) - min(ys)
        if w <= 0 or h <= 0:
            continue
        near_top = min(ys) - gy0 <= tol * gh
        near_bottom = gy1 - max(ys) <= tol * gh
        near_left = min(xs) - gx0 <= tol * gw
        near_right = gx1 - max(xs) <= tol * gw
        spans_w = w >= cover * gw
        spans_h = h >= cover * gh
        if (spans_w and spans_h and (near_top or near_bottom or near_left or near_right)) \
                or (spans_w and (near_top or near_bottom)) \
                or (spans_h and (near_left or near_right)):
            has_frame = True
            break

    if not has_frame:
        return [], paths

    frame_paths, content_paths = [], []
    for pts in paths:
        flags = [_is_edge_point(p, gx0, gy0, gx1, gy1, tol) for p in pts]
        n_edge, n = sum(flags), len(pts)
        if n_edge == 0:
            content_paths.append(pts)
        elif n_edge == n:
            frame_paths.append(pts)
        else:
            for is_edge, seg in _split_by_flags(pts, flags):
                if is_edge:
                    if path_length(seg) >= MIN_SEG_LEN:
                        frame_paths.append(seg)
                else:
                    content_paths.append(seg)
    return frame_paths, content_paths


# ==================== 归一化 ====================

def compute_norm_params(paths):
    xs = [p[0] for path in paths for p in path]
    ys = [p[1] for path in paths for p in path]
    if not xs or not ys:
        return None
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    w, h = maxx - minx, maxy - miny
    if w <= 0 or h <= 0:
        return None
    inner = TARGET_SIZE - 2 * PADDING
    scale = inner / max(w, h)
    ox = (TARGET_SIZE - w * scale) / 2 - minx * scale
    oy = (TARGET_SIZE - h * scale) / 2 - miny * scale
    return {"scale": scale, "ox": ox, "oy": oy}


def apply_norm(paths, params):
    if not params:
        return []
    scale, ox, oy = params["scale"], params["ox"], params["oy"]
    result = []
    for path in paths:
        norm = [[round(x * scale + ox, 2), round(y * scale + oy, 2)] for x, y in path]
        norm = rdp(norm, SIMPLIFY_EPS)
        if len(norm) >= 2:
            result.append(norm)
    return result


# ==================== 简化排序：就近衔接，不分公司层 ====================

def _order_nearest_from(group, start_idx):
    if len(group) <= 1:
        return list(group)
    remaining = list(range(len(group)))
    remaining.remove(start_idx)
    ordered = [group[start_idx]]
    cur_end = group[start_idx][-1]
    while remaining:
        nxt = min(remaining,
                  key=lambda i: ((group[i][0][0] - cur_end[0]) ** 2
                                 + (group[i][0][1] - cur_end[1]) ** 2))
        ordered.append(group[nxt])
        cur_end = group[nxt][-1]
        remaining.remove(nxt)
    return ordered


def _order_top_left(group):
    def key(pts):
        sy = min(p[1] for p in pts)
        sx = min(p[0] for p in pts if p[1] == sy)
        return (round(sy, 1), round(sx, 1))
    return sorted(group, key=key)


def order_paths(paths):
    """简化排序：起点决定方向，之后就近衔接。

    ORDER_START_MODE:
        "center"   → 起点选离画面中心最近的折线（从中心出发）
        "top_left" → 起点选最左上角的折线
    ORDER_STEP_MODE:
        "nearest"  → 之后每次选离上一笔终点最近的
        "top_left" → 纯从上到下、从左到右
    """
    if not paths:
        return []

    # 先 orient（从上到下/从左往右）
    oriented = []
    for pts in paths:
        o, _ = orient_path(pts)
        oriented.append(o)

    if ORDER_STEP_MODE == "top_left":
        ordered = _order_top_left(oriented)
    else:
        if ORDER_START_MODE == "top_left":
            start_idx = min(range(len(oriented)),
                            key=lambda i: (oriented[i][0][1], oriented[i][0][0]))
        else:
            xs = [p[0] for pts in oriented for p in pts]
            ys = [p[1] for pts in oriented for p in pts]
            cx = (min(xs) + max(xs)) / 2.0
            cy = (min(ys) + max(ys)) / 2.0
            start_idx = min(range(len(oriented)),
                            key=lambda i: ((oriented[i][0][0] - cx) ** 2
                                           + (oriented[i][0][1] - cy) ** 2))
        ordered = _order_nearest_from(oriented, start_idx)

    steps = []
    for pts in ordered:
        for seg in split_path(pts):
            steps.append(seg)
    return steps


# ==================== 线宽/颜色分析 ====================

def _otsu_threshold(gray):
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
    return gray_n < thr, gray_n


def analyze_traits(image_path, paths, norm_params=None):
    n = len(paths)
    try:
        pil_img = Image.open(image_path)
        max_dim = 700
        w0, h0 = pil_img.size
        factor = min(1.0, max_dim / max(w0, h0))
        if factor < 1.0:
            pil_img = pil_img.resize((max(1, int(w0 * factor)),
                                      max(1, int(h0 * factor))), Image.LANCZOS)
        gray = np.asarray(pil_img.convert("L"))
        img_h, img_w = gray.shape

        mask, gray_n = _otsu_threshold(gray)
        if not mask.any() or mask.mean() > 0.9:
            raise ValueError("二值化掩膜无效")
        dist = distance_transform_edt(mask)

        if norm_params is not None:
            scale, ox, oy = norm_params["scale"], norm_params["ox"], norm_params["oy"]
        else:
            ys, xs = np.where(mask)
            minx, maxx = int(xs.min()), int(xs.max())
            miny, maxy = int(ys.min()), int(ys.max())
            bw, bh = maxx - minx, maxy - miny
            if bw <= 0 or bh <= 0:
                raise ValueError("内容为空")
            scale = (TARGET_SIZE - 2 * PADDING) / max(bw, bh)
            ox = (TARGET_SIZE - bw * scale) / 2 - minx * scale
            oy = (TARGET_SIZE - bh * scale) / 2 - miny * scale

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
            x = (p[0] - ox) / scale * factor
            y = (p[1] - oy) / scale * factor
            return (max(0, min(img_w - 1, int(round(x)))),
                    max(0, min(img_h - 1, int(round(y)))))

        raw_widths, luma_vals, colors = [], [], []
        for pts in paths:
            m = len(pts) // 2
            samples = [pts[m], pts[max(0, m - 1)], pts[min(m, len(pts) - 1)],
                       pts[0], pts[-1]]
            pixs = [to_px(p) for p in samples]
            half_ws = [float(dist[iy, ix]) for ix, iy in pixs]
            lums = []
            for ix, iy in pixs:
                x0, x1 = max(0, ix - 1), min(img_w, ix + 2)
                y0, y1 = max(0, iy - 1), min(img_h, iy + 2)
                lums.append(float(gray_n[y0:y1, x0:x1].min()))
            if max(half_ws) < 0.25:
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

        lv = np.array(luma_vals, dtype=np.float64)
        vmin, vmax = float(lv.min()), float(lv.max())
        has_contrast = (vmax - vmin) > 24
        if has_contrast:
            depth_norm = (lv - vmin) / (vmax - vmin)
            mapped = (COLOR_LUMA_DARK + depth_norm *
                      (COLOR_LUMA_LIGHT - COLOR_LUMA_DARK)).astype(int)
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


# ==================== 缩略图 & 矢量提取 ====================

def compute_thumbnail(output_path):
    group = THUMB_GROUP or os.path.basename(os.path.normpath(OUTPUT_DIR))
    rel = os.path.relpath(output_path, OUTPUT_DIR).replace("\\", "/")
    cid = os.path.splitext(os.path.basename(rel))[0]
    if "/" in rel:
        cat = rel.rsplit("/", 1)[0].split("/")[-1]
        return f"{group}/{cat}/{cid}.png"
    return f"{group}/{cid}.png"


def generate_thumbnail(input_path, output_png):
    try:
        img = Image.open(input_path)
        if img.mode != "RGBA":
            img = img.convert("RGBA")
        img = img.resize((THUMB_SIZE, THUMB_SIZE), Image.LANCZOS)
        img.save(output_png, "PNG", optimize=True)
        return True
    except Exception as e:
        print(f"    [警告] 生成封面失败：{e}")
        return False


def _run_vtracer(src_path, dst_svg):
    vtracer.convert_image_to_svg_py(
        src_path, dst_svg,
        colormode="binary", mode="spline",
        filter_speckle=FILTER_SPECKLE,
        length_threshold=LENGTH_THRESHOLD,
        corner_threshold=CORNER_THRESHOLD,
    )


def _vtracer_from_array(arr_black_lines, output_path, suffix):
    tmp_png = f"{output_path}.{suffix}.png"
    tmp_svg = f"{output_path}.{suffix}.svg"
    try:
        Image.fromarray(arr_black_lines.astype(np.uint8)).save(tmp_png)
        _run_vtracer(tmp_png, tmp_svg)
        return extract_paths(tmp_svg)
    except Exception:
        return []
    finally:
        for p in (tmp_png, tmp_svg):
            if os.path.exists(p):
                os.remove(p)


def _extract_from_array(arr_black_lines, output_path, suffix):
    if VECTORIZER == "trace" and HAS_SKIMAGE:
        binary = (255 - arr_black_lines) > 127
        polylines = skeleton_trace_polylines(
            binary, max_turn_deg=TRACE_MAX_TURN_DEG,
            min_pixels=TRACE_MIN_POLYLINE_PIXELS)
        if polylines:
            return polylines
        return _vtracer_from_array(arr_black_lines, output_path, suffix)
    return _vtracer_from_array(arr_black_lines, output_path, suffix)


# ==================== 主流程 ====================

def _build_from_cv2(input_path, output_path):
    frame_pts, content_img, _ = detect_and_strip_outer_frame(input_path)
    if frame_pts is None or content_img is None:
        return None, None

    frame_raw = [frame_pts]

    # 物体分离
    objects = None
    if USE_OBJECT_SEPARATION:
        if OBJECT_MODE == "region":
            objects = separate_objects_region(content_img)
            if objects is not None and len(objects) <= 1:
                conn = separate_content_objects(content_img)
                if conn and len(conn) > 1:
                    objects = conn
        elif OBJECT_MODE == "connected":
            objects = separate_content_objects(content_img)

    object_paths_list = []
    if objects and len(objects) >= 1:
        # 物体排序：离画面中心近的先画，同距离按面积降序
        all_xs = [o['bbox'][0] for o in objects] + [o['bbox'][0] + o['bbox'][2] for o in objects]
        all_ys = [o['bbox'][1] for o in objects] + [o['bbox'][1] + o['bbox'][3] for o in objects]
        cx = (min(all_xs) + max(all_xs)) / 2.0
        cy = (min(all_ys) + max(all_ys)) / 2.0
        g_diag = math.hypot(max(all_xs) - min(all_xs), max(all_ys) - min(all_ys))
        if g_diag <= 0:
            g_diag = 1.0

        def obj_key(o):
            bx, by, bw, bh = o['bbox']
            ocx, ocy = bx + bw / 2.0, by + bh / 2.0
            dist = math.hypot(ocx - cx, ocy - cy)
            return (round(dist / g_diag * 10), -o['area'])

        objects.sort(key=obj_key)

        for idx, obj in enumerate(objects):
            paths = _extract_from_array(obj['img'], output_path, f"obj{idx}")
            if paths:
                object_paths_list.append(paths)

    if not object_paths_list:
        paths = _extract_from_array(content_img, output_path, "content")
        if paths:
            object_paths_list.append(paths)

    if not object_paths_list:
        return None, None

    all_content_paths = [p for sub in object_paths_list for p in sub]
    norm_params = compute_norm_params(frame_raw + all_content_paths)
    if not norm_params:
        return None, None

    ordered = []
    # 边框：一刀尽量画完
    for pts in apply_norm(frame_raw, norm_params):
        is_closed = (len(pts) >= 3 and pts[0] == pts[-1])
        if not is_closed:
            pts, _ = orient_path(pts)
        ordered.extend(split_path(pts, max_len=FRAME_MAX_STROKE_LEN))

    # 内容：逐物体简化排序（就近衔接，不分公司层）
    for paths in object_paths_list:
        norm_paths = apply_norm(paths, norm_params)
        ordered.extend(order_paths(norm_paths))

    return ordered, norm_params


def _build_from_fallback(input_path, output_path):
    tmp_svg = output_path + ".lineart.svg"
    _run_vtracer(input_path, tmp_svg)
    try:
        all_paths = extract_paths(tmp_svg)
    finally:
        if os.path.exists(tmp_svg):
            os.remove(tmp_svg)
    if not all_paths:
        return None, None

    if DRAW_FRAME_FIRST:
        frame_raw, content_raw = separate_outer_frame(all_paths)
    else:
        frame_raw, content_raw = [], all_paths

    if not frame_raw and not content_raw:
        return None, None

    norm_params = compute_norm_params(frame_raw + content_raw)
    if not norm_params:
        return None, None

    ordered = []
    for pts in apply_norm(frame_raw, norm_params):
        is_closed = (len(pts) >= 3 and pts[0] == pts[-1])
        if not is_closed:
            pts, _ = orient_path(pts)
        ordered.extend(split_path(pts, max_len=FRAME_MAX_STROKE_LEN))
    ordered.extend(order_paths(apply_norm(content_raw, norm_params)))
    return ordered, norm_params


def convert_one(input_path, output_path, gen_thumbnail=False):
    ordered = None
    norm_params = None

    if HAS_CV2 and DRAW_FRAME_FIRST:
        ordered, norm_params = _build_from_cv2(input_path, output_path)

    if not ordered:
        ordered, norm_params = _build_from_fallback(input_path, output_path)

    if not ordered or not norm_params:
        return 0

    widths, luma, hex_colors = (None, None, None)
    if ANALYZE_TRAITS:
        widths, luma, hex_colors = analyze_traits(input_path, ordered, norm_params)

    steps = []
    for i, pts in enumerate(ordered):
        step = {
            "id": i + 1,
            "tip": "",
            "strokes": [{
                "width": widths[i] if widths else DEFAULT_WIDTH,
                "color": hex_colors[i] if hex_colors else DEFAULT_COLOR,
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

    files = []
    if RECURSIVE:
        for root, _, filenames in os.walk(INPUT_DIR):
            for fn in filenames:
                if os.path.splitext(fn)[1].lower() in IMAGE_EXTS:
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
    print(f"cv2: {HAS_CV2}  |  skimage: {HAS_SKIMAGE}")
    print(f"边框剥离：{'cv2 物理擦除' if (HAS_CV2 and DRAW_FRAME_FIRST) else '路径级启发式'}")
    print(f"物体分离：{OBJECT_MODE if USE_OBJECT_SEPARATION else '关闭'}")
    print(f"矢量提取：{VECTORIZER} "
          f"({'骨架追踪' if VECTORIZER == 'trace' and HAS_SKIMAGE else 'vtracer'})")
    print(f"折线排序：起点={ORDER_START_MODE}，步进={ORDER_STEP_MODE}（不分公司层）\n")

    ok, fail, skip = 0, 0, 0
    items = []
    category = os.path.basename(os.path.normpath(OUTPUT_DIR))

    for i, (rel_path, fn) in enumerate(files, 1):
        input_path = os.path.join(INPUT_DIR, rel_path)
        output_name = os.path.splitext(fn)[0] + ".json"

        if RECURSIVE and os.path.dirname(rel_path):
            sub_dir = os.path.dirname(rel_path)
            output_dir = os.path.join(OUTPUT_DIR, sub_dir)
            os.makedirs(output_dir, exist_ok=True)
        else:
            output_dir = OUTPUT_DIR
        output_path = os.path.join(output_dir, output_name)

        if not OVERWRITE and os.path.exists(output_path):
            skip += 1
            try:
                with open(output_path, "r", encoding="utf-8") as f:
                    ej = json.load(f)
                items.append({
                    "id": ej.get("id", os.path.splitext(fn)[0]),
                    "name": ej.get("name", os.path.splitext(fn)[0]),
                    "thumbnail": compute_thumbnail(output_path),
                    "difficulty": ej.get("difficulty", 1),
                    "stepCount": len(ej.get("steps", []))
                })
                want_thumb = compute_thumbnail(output_path)
                if ej.get("thumbnail") != want_thumb:
                    ej["thumbnail"] = want_thumb
                    with open(output_path, "w", encoding="utf-8") as f:
                        json.dump(ej, f, ensure_ascii=False, separators=(",", ":"))
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