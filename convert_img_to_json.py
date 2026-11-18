#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
批量将目录下的图片转换成分步线稿 JSON。

用法:
    python img_to_steps.py

配置:
    修改下方 INPUT_DIR 和 OUTPUT_DIR 即可。
"""

import json
import math
import os
import sys

import vtracer
from svgelements import SVG, Path, Shape, Move, Close, Line
from PIL import Image

# ==================== 配置 ====================
INPUT_DIR =  "E:/otherCode/ai-pose-gallery-zh/img/costume"        # 输入图片目录
OUTPUT_DIR = "./web/public/data/costume"        # 输出 JSON 目录
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
OVERWRITE = False  # 是否强制重新生成，设为 True 则覆盖已存在的文件
RECURSIVE = False   # 是否递归遍历子目录
GENERATE_THUMBNAIL = True  # 是否将原图转为 PNG 作为封面

TARGET_SIZE = 256
PADDING = 8
SAMPLES_PER_SEG = 8
SIMPLIFY_EPS = 0.8
THUMB_SIZE = 256  # 封面缩略图尺寸

# vtracer 参数
FILTER_SPECKLE = 4
LENGTH_THRESHOLD = 4.0
CORNER_THRESHOLD = 60
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


def order_paths(paths):
    """启发式笔顺排序：面积 → 长度 → 位置"""
    def sort_key(p):
        area, length = path_metrics(p)
        avg_x = sum(x for x, _ in p) / len(p)
        min_y = min(y for _, y in p)
        return (-round(area, -2), -round(length, -1), min_y, avg_x)

    return sorted(paths, key=sort_key)


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

    steps = []
    for i, pts in enumerate(ordered, 1):
        steps.append({
            "id": i,
            "tip": "",
            "strokes": [{
                "width": 2.0,
                "color": "#333333",
                "fill": "none",
                "points": pts,
            }],
        })

    n = len(steps)
    difficulty = 1 if n <= 4 else (2 if n <= 7 else 3)
    name = os.path.splitext(os.path.basename(input_path))[0]

    result = {
        "id": name,
        "name": name,
        "tags": ["生成"],
        "difficulty": difficulty,
        "viewBox": [0, 0, TARGET_SIZE, TARGET_SIZE],
        "thumbnail": "",
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
                # 计算 thumbnail 路径
                rel_thumb_path = os.path.relpath(output_path, OUTPUT_DIR).replace("\\", "/")[:-5]
                items.append({
                    "id": existing_json.get("id", os.path.splitext(fn)[0]),
                    "name": existing_json.get("name", os.path.splitext(fn)[0]),
                    "thumbnail": f"{category}/{rel_thumb_path}.png",
                    "difficulty": existing_json.get("difficulty", 1),
                    "stepCount": len(existing_json.get("steps", []))
                })
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
                # 计算 thumbnail 路径
                rel_thumb_path = os.path.relpath(output_path, OUTPUT_DIR).replace("\\", "/")[:-5]
                items.append({
                    "id": os.path.splitext(fn)[0],
                    "name": os.path.splitext(fn)[0],
                    "thumbnail": f"{category}/{rel_thumb_path}.png",
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
