#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
将 cocomaterial_svg/<tag>/ 下的 SVG 转成本项目结构。
- 使用 line/ 生成纯线稿 JSON
- 使用 color/ 生成彩色封面 PNG（彻底修复颜色提取继承问题）
"""

import json
import os
import re
import sys
import math

from svgelements import SVG, Path, Shape, Move, Close, Line, Color
from PIL import Image, ImageDraw

# ==================== 配置 ====================
SRC_ROOT = "cocomaterial_svg"
OUT_ROOT = "./web/public/data"
OVERWRITE = False  # 强制重新生成，确保覆盖之前错误的黑白封面

TARGET_SIZE = 256
SAMPLES_PER_SEG = 10
SIMPLIFY_EPS = 0.6
STROKE_WIDTH = 2.0
PATHS_PER_STEP = 1

PADDING = 8
BG_COLOR = (255, 255, 255, 255)
THUMB_SIZE = 256

JSON_STROKE_COLOR = "#333333"
JSON_FILL = "none"

TAG_NAME_MAP = {
    "others": "精选",
    "animals": "动物", "plants": "植物", "food": "食物",
    "people": "人物", "objects": "物品", "nature": "自然",
    "transport": "交通", "sports": "运动", "weather": "天气",
    "family": "家庭", "Buildings": "建筑", "Read": "阅读",
}
# =============================================


def dist_point_seg(p, a, b):
    x, y = p; x1, y1 = a; x2, y2 = b
    dx, dy = x2 - x1, y2 - y1
    if dx == 0 and dy == 0: return math.hypot(x - x1, y - y1)
    t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    return math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))


def rdp(points, eps):
    if eps <= 0 or len(points) < 3: return points
    keep = [False] * len(points); keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1: continue
        max_d, idx = 0.0, -1
        for k in range(i + 1, j):
            d = dist_point_seg(points[k], points[i], points[j])
            if d > max_d: max_d, idx = d, k
        if idx != -1 and max_d > eps:
            keep[idx] = True
            stack.append((i, idx)); stack.append((idx, j))
    return [p for p, k in zip(points, keep) if k]


def color_to_hex(val, default):
    """正确转换各种颜色格式（包括命名颜色），并处理 none"""
    if val is None: return default
    
    # 处理 svgelements 的 Color 对象
    if isinstance(val, Color):
        return val.hex
    
    # 处理字符串
    if isinstance(val, str):
        v = val.strip().lower()
        if v == "none": return "none"
        # 支持 #FFF, #FFFFFF, red, rgb(255,0,0) 等
        return v
        
    return default


def extract_subpaths(svg_path, keep_color=True):
    """提取路径，并通过 element.values 处理继承和 CSS 样式"""
    try:
        svg = SVG.parse(svg_path)
    except Exception as e:
        raise RuntimeError(f"解析 SVG 失败: {e}")

    raw_paths = []
    for element in svg.elements():
        if not isinstance(element, Shape): continue
        
        if keep_color:
            # 使用 element.values 获取合并了继承和 CSS 后的最终样式
            fill_val = element.values.get('fill', getattr(element, 'fill', None))
            stroke_val = element.values.get('stroke', getattr(element, 'stroke', None))
            
            stroke_color = color_to_hex(stroke_val, "#333333")
            # SVG 默认 fill 是黑色，如果没写且没继承，默认用 none 以免遮挡
            fill_color = color_to_hex(fill_val, "none") 
        else:
            stroke_color = JSON_STROKE_COLOR
            fill_color = JSON_FILL

        try:
            path_obj = element if isinstance(element, Path) else Path(element)
            subpaths = list(path_obj.as_subpaths())
        except Exception as e:
            continue

        for sub in subpaths:
            pts = []
            for seg in sub:
                if isinstance(seg, (Move, Close)): continue
                if isinstance(seg, Line):
                    try: pts.append([float(seg.end.x), float(seg.end.y)])
                    except Exception: pass
                else:
                    for i in range(1, SAMPLES_PER_SEG + 1):
                        t = i / float(SAMPLES_PER_SEG)
                        try:
                            pt = seg.point(t)
                            pts.append([float(pt.x), float(pt.y)])
                        except Exception: pass

            if len(pts) >= 2:
                raw_paths.append({"points": pts, "color": stroke_color, "fill": fill_color})

    if not raw_paths: return []

    # 包围盒归一化
    xs = [p[0] for path in raw_paths for p in path["points"]]
    ys = [p[1] for path in raw_paths for p in path["points"]]
    minx, maxx = min(xs), max(xs); miny, maxy = min(ys), max(ys)
    w, h = maxx - minx, maxy - miny
    if w <= 0 or h <= 0: return []

    inner = TARGET_SIZE - 2 * PADDING
    scale = inner / max(w, h)
    ox = (TARGET_SIZE - w * scale) / 2 - minx * scale
    oy = (TARGET_SIZE - h * scale) / 2 - miny * scale

    result = []
    for path in raw_paths:
        norm = [[round(x * scale + ox, 2), round(y * scale + oy, 2)] for x, y in path["points"]]
        norm = rdp(norm, SIMPLIFY_EPS)
        dedup = [norm[0]]
        for p in norm[1:]:
            if p != dedup[-1]: dedup.append(p)
        if len(dedup) >= 2:
            path["points"] = dedup
            result.append(path)
    return result


def draw_thumbnail(case, out_png):
    img = Image.new("RGBA", (THUMB_SIZE, THUMB_SIZE), BG_COLOR)
    draw = ImageDraw.Draw(img)
    scale = (THUMB_SIZE - 2 * PADDING) / TARGET_SIZE
    ox = oy = PADDING

    for step in case.get("steps", []):
        for stroke in step.get("strokes", []):
            pts = [(x * scale + ox, y * scale + oy) for x, y in stroke["points"]]
            if len(pts) < 2: continue
            
            fill_color = stroke.get("fill", "none")
            line_color = stroke.get("color", "#333333")
            w = max(1, int(round(stroke.get("width", STROKE_WIDTH) * scale)))

            # 画填充色块
            if fill_color and fill_color != "none":
                try: draw.polygon(pts, fill=fill_color)
                except Exception: pass
            
            # 画描边
            if line_color and line_color != "none":
                draw.line(pts, fill=line_color, width=w, joint="curve")
                
    img.save(out_png, "PNG", optimize=True)


def process_tag(tag, tag_src_dir):
    out_dir = os.path.join(OUT_ROOT, tag)
    os.makedirs(out_dir, exist_ok=True)
    
    line_dir = os.path.join(tag_src_dir, "line")
    color_dir = os.path.join(tag_src_dir, "color")
    
    if not os.path.isdir(line_dir):
        print(f"[跳过] {tag}: 没有 line 目录")
        return

    svg_files = sorted(f for f in os.listdir(line_dir) if f.lower().endswith(".svg"))
    items, done, skip, fail = [], 0, 0, 0

    for i, fn in enumerate(svg_files, 1):
        case_id = re.sub(r"[^\w-]", "_", os.path.splitext(fn)[0]).strip("_") or "case"
        case_path = os.path.join(out_dir, f"{case_id}.json")
        png_path = os.path.join(out_dir, f"{case_id}.png")

        # 修复点：如果跳过覆盖，必须读取已有的 JSON 信息补全 items 列表
        if not OVERWRITE and os.path.exists(case_path):
            skip += 1
            try:
                with open(case_path, "r", encoding="utf-8") as f:
                    existing_case = json.load(f)
                items.append({
                    "id": existing_case.get("id", case_id),
                    "name": existing_case.get("name", case_id),
                    "thumbnail": f"{tag}/{case_id}.png",
                    "difficulty": existing_case.get("difficulty", 1),
                    "stepCount": len(existing_case.get("steps", []))
                })
            except Exception as e:
                print(f"  [{i}/{len(svg_files)}] [警告] 读取已存在文件失败 {case_id}: {e}")
            continue

        line_svg = os.path.join(line_dir, fn)
        color_svg = os.path.join(color_dir, fn)
        
        try:
            # 1. 解析线稿，生成 JSON
            line_paths = extract_subpaths(line_svg, keep_color=False)
            if not line_paths:
                print(f"  [{i}/{len(svg_files)}] [跳过] {fn}: 线稿无有效路径")
                fail += 1
                continue

            steps = []
            for j in range(0, len(line_paths), PATHS_PER_STEP):
                group = line_paths[j:j + PATHS_PER_STEP]
                steps.append({
                    "id": len(steps) + 1, "tip": "",
                    "strokes": [{"width": STROKE_WIDTH, "color": JSON_STROKE_COLOR, "fill": JSON_FILL, "points": p["points"]} for p in group]
                })

            n = len(steps)
            difficulty = 1 if n <= 4 else (2 if n <= 7 else 3)
            case_json = {
                "id": case_id, "name": os.path.splitext(fn)[0], "tags": [TAG_NAME_MAP.get(tag, tag), tag],
                "difficulty": difficulty, "viewBox": [0, 0, TARGET_SIZE, TARGET_SIZE], "thumbnail": f"{tag}/{case_id}.png", "steps": steps
            }
            with open(case_path, "w", encoding="utf-8") as f:
                json.dump(case_json, f, ensure_ascii=False, separators=(",", ":"))

            # 2. 解析彩色版，生成彩色封面
            if os.path.exists(color_svg):
                color_paths = extract_subpaths(color_svg, keep_color=True)
                color_steps = []
                for j in range(0, len(color_paths), PATHS_PER_STEP):
                    group = color_paths[j:j + PATHS_PER_STEP]
                    color_steps.append({
                        "id": len(color_steps) + 1, "tip": "",
                        "strokes": [{"width": STROKE_WIDTH, "color": p["color"], "fill": p["fill"], "points": p["points"]} for p in group]
                    })
                color_case = dict(case_json)
                color_case["steps"] = color_steps
                draw_thumbnail(color_case, png_path)
            else:
                print(f"    [警告] 找不到彩色 SVG: {color_svg}，使用线稿作为封面")
                draw_thumbnail(case_json, png_path)

            items.append({
                "id": case_id, "name": case_json["name"], 
                "thumbnail": f"{tag}/{case_id}.png", "difficulty": case_json["difficulty"], 
                "stepCount": len(case_json["steps"])
            })
            done += 1
            print(f"  [{i}/{len(svg_files)}] {case_id}: {len(case_json['steps'])} 步")

        except Exception as e:
            print(f"  [{i}/{len(svg_files)}] [失败] {fn}: {e}")
            fail += 1

    # 写入类别索引
    cat_index = {
        "category": tag, "name": TAG_NAME_MAP.get(tag, tag),
        "viewBox": [0, 0, TARGET_SIZE, TARGET_SIZE], "count": len(items), "items": items
    }
    with open(os.path.join(out_dir, "index.json"), "w", encoding="utf-8") as f:
        json.dump(cat_index, f, ensure_ascii=False, separators=(",", ":"))
    print(f"[{tag}] 转换 {done}, 跳过 {skip}, 失败 {fail}, 共 {len(items)} 条\n")

def main():
    try: sys.stdout.reconfigure(encoding="utf-8")
    except Exception: pass

    if not os.path.isdir(SRC_ROOT): return
    tags = sorted(d for d in os.listdir(SRC_ROOT) if os.path.isdir(os.path.join(SRC_ROOT, d)))
    if not tags: return

    os.makedirs(OUT_ROOT, exist_ok=True)
    for tag in tags:
        process_tag(tag, os.path.join(SRC_ROOT, tag))
    print("=" * 50)
    print("转换结束。请运行 build_index.py 生成总索引。")

if __name__ == "__main__":
    main()