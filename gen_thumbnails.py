#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
为案例 JSON 生成完整封面 PNG。

默认模式（不带参数）:
    扫描 DATA_DIR 下每个类别目录
    输入: data/<category>/<id>.json
    输出: data/<category>/<id>.png
    同时更新:
        data/<category>/index.json  里的 items[].thumbnail
        data/<category>/<id>.json    里的 thumbnail

单文件模式（带参数）:
    python gen_thumbnails.py 路径/to/案例.json [更多.json ...]
    为每个 JSON 生成同名 PNG（写在 JSON 旁边），不改动 index.json。
    用于 web 端导出的用户绘制 JSON（顶层 steps[].strokes 格式）。

兼容的 JSON 笔画格式:
    - 标准: {"steps": [{"strokes": [{"points": [[x,y],...], "width": n}]}]}
    - 扁平: {"strokes": [{"points": [[x,y],...], "width": n}]}

用法:
    pip install Pillow
    python gen_thumbnails.py
    python gen_thumbnails.py 00000-用户绘制-xxx.json
"""

import json
import math
import os
import sys

from PIL import Image, ImageDraw

# ==================== 配置 ====================
DATA_DIR = "./web/public/data/coloring"
SIZE = 256                          # 封面边长(px)，可改 512
PADDING = 8                         # 边距(px)，基于 SIZE
BG_COLOR = (255, 255, 255, 255)     # 白底；透明改 (0,0,0,0)
LINE_COLOR = (51, 51, 51, 255)      # #333
LINE_WIDTH_BASE = 3                 # 与 JSON 中 width 对应
SMOOTH_SAMPLES = 8                  # 每段贝塞尔插值数；1 = 关闭平滑
OVERWRITE = False                   # True = 覆盖已存在的 PNG
# =============================================


def iter_strokes(case):
    """统一取出案例中的所有笔画，兼容两种格式:
    - 标准: {"steps": [{"strokes": [...] }]}
    - 扁平: {"strokes": [...]}（web 端早期导出 / 用户手绘）
    """
    for step in case.get("steps") or []:
        for stroke in step.get("strokes") or []:
            yield stroke
    for stroke in case.get("strokes") or []:
        yield stroke


def smooth_polyline(points, samples=8):
    """用中点二次贝塞尔把折线变成平滑点列"""
    if samples <= 1 or len(points) < 3:
        return points
    pts = [(float(x), float(y)) for x, y in points]
    out = [pts[0]]
    m_prev = ((pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2)
    out.append(m_prev)
    for i in range(1, len(pts) - 1):
        p0 = m_prev
        p1 = pts[i]
        m_next = ((pts[i][0] + pts[i + 1][0]) / 2,
                  (pts[i][1] + pts[i + 1][1]) / 2)
        for j in range(1, samples):
            t = j / samples
            x = (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t ** 2 * m_next[0]
            y = (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t ** 2 * m_next[1]
            out.append((x, y))
        out.append(m_next)
        m_prev = m_next
    out.append(pts[-1])
    return out


def _hex_to_rgba(color, alpha=255):
    """'#RRGGBB' / 'rgb()' / None -> (r,g,b,a)。解析失败返回默认 LINE_COLOR。"""
    if not color:
        return LINE_COLOR
    s = str(color).strip()
    if s.startswith("#"):
        h = s[1:]
        try:
            if len(h) == 3:
                h = "".join(c * 2 for c in h)
            if len(h) == 6:
                r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
                return (r, g, b, alpha)
        except ValueError:
            return LINE_COLOR
    return LINE_COLOR


def _draw_stroke(draw, img, pts, width, color, stroke_type):
    """按画笔类型绘制单个笔画（points 已映射到图像坐标，width 已换算成像素）。
    颜色来自 stroke['color']（缺省用 LINE_COLOR），类型来自 stroke['type']。"""
    fill = _hex_to_rgba(color)

    if stroke_type == "pencil":
        # 铅笔：低 alpha 短虚线，模拟铅笔颗粒感
        dash_layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        ddraw = ImageDraw.Draw(dash_layer)
        seg_len = max(2, width)
        for i in range(0, len(pts) - 1, seg_len * 2):
            seg = pts[i:min(i + seg_len, len(pts) - 1) + 1]
            ddraw.line(seg, fill=fill[:3] + (150,), width=width, joint="curve")
        img.alpha_composite(dash_layer)
        return

    if stroke_type == "marker":
        # 马克笔：半透明粗线
        layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        ddraw = ImageDraw.Draw(layer)
        ddraw.line(pts, fill=fill[:3] + (100,), width=max(1, int(width * 2)), joint="curve")
        img.alpha_composite(layer)
        return

    if stroke_type == "brush":
        # 毛笔：粗线 + 端点柔化（用多个低 alpha 圆叠加模拟）
        layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        ddraw = ImageDraw.Draw(layer)
        ddraw.line(pts, fill=fill[:3] + (150,), width=max(1, int(width * 1.5)), joint="curve")
        r = max(1, int(width * 0.75))
        for (x, y) in (pts[0], pts[-1]):
            ddraw.ellipse([x - r, y - r, x + r, y + r], fill=fill[:3] + (90,))
        img.alpha_composite(layer)
        return

    # pen / 默认：实心线
    draw.line(pts, fill=fill, width=width, joint="curve")


def draw_case(case, size, padding):
    """把一个案例的所有笔画画成一张完整图"""
    img = Image.new("RGBA", (size, size), BG_COLOR)
    draw = ImageDraw.Draw(img)

    vb = case.get("viewBox", [0, 0, 256, 256])
    vb_w = vb[2] - vb[0]
    vb_h = vb[3] - vb[1]
    if vb_w <= 0 or vb_h <= 0:
        return img

    scale = (size - 2 * padding) / max(vb_w, vb_h)
    offset_x = padding - vb[0] * scale
    offset_y = padding - vb[1] * scale

    for stroke in iter_strokes(case):
        pts = stroke.get("points") or []
        w = max(1, int(round(stroke.get("width", LINE_WIDTH_BASE) * scale)))
        # 兼容带 color/type 的用户绘制笔画；库内标准 JSON 无这两字段 -> 走默认 #333 钢笔
        color = stroke.get("color")
        stroke_type = stroke.get("type") or "pen"
        if len(pts) == 1:
            # 单点：画一个圆点（与 web 端渲染一致）
            x, y = pts[0][0] * scale + offset_x, pts[0][1] * scale + offset_y
            r = max(1, w / 2)
            draw.ellipse([x - r, y - r, x + r, y + r], fill=_hex_to_rgba(color))
            continue
        if len(pts) < 2:
            continue
        mapped = [(x * scale + offset_x, y * scale + offset_y) for x, y in pts]
        mapped = smooth_polyline(mapped, SMOOTH_SAMPLES)
        _draw_stroke(draw, img, mapped, w, color, stroke_type)

    return img


def load_category_index(cat_dir, cat):
    """优先读 index.json，没有则扫描目录兜底"""
    index_path = os.path.join(cat_dir, "index.json")
    if os.path.isfile(index_path):
        with open(index_path, "r", encoding="utf-8") as f:
            return json.load(f)

    items = []
    for fn in os.listdir(cat_dir):
        if not fn.endswith(".json") or fn == "index.json":
            continue
        try:
            with open(os.path.join(cat_dir, fn), "r", encoding="utf-8") as f:
                case = json.load(f)
            items.append({
                "id": case.get("id", os.path.splitext(fn)[0]),
                "name": case.get("name", ""),
                "difficulty": case.get("difficulty", 1),
                "stepCount": len(case.get("steps", [])),
            })
        except Exception:
            continue
    return {
        "category": cat, "name": cat,
        "viewBox": [0, 0, 256, 256],
        "count": len(items), "items": items,
    }


def process_category(cat_dir, cat):
    """处理一个类别目录，返回 (done, skip, fail)"""
    try:
        cat_index = load_category_index(cat_dir, cat)
    except Exception as e:
        print(f"[跳过] {cat}: {e}")
        return 0, 0, 0

    items = cat_index.get("items", [])
    print(f"--- {cat} ({len(items)} 条) ---")

    done = skip = fail = 0
    for item in items:
        cid = item.get("id")
        if not cid:
            fail += 1
            continue

        case_path = os.path.join(cat_dir, f"{cid}.json")
        png_path = os.path.join(cat_dir, f"{cid}.png")
        thumb_rel = f"{cat}/{cid}.png"

        if not os.path.isfile(case_path):
            fail += 1
            continue

        if os.path.isfile(png_path) and not OVERWRITE:
            item["thumbnail"] = thumb_rel
            skip += 1
            continue

        try:
            with open(case_path, "r", encoding="utf-8") as f:
                case = json.load(f)
            img = draw_case(case, SIZE, PADDING)
            img.save(png_path, "PNG", optimize=True)
            item["thumbnail"] = thumb_rel
            done += 1
        except Exception as e:
            print(f"  [失败] {cid}: {e}")
            fail += 1

    # 写回类别索引
    cat_index["items"] = items
    cat_index["count"] = len(items)
    index_path = os.path.join(cat_dir, "index.json")
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(cat_index, f, ensure_ascii=False, separators=(",", ":"))

    print(f"  生成 {done}, 跳过 {skip}, 失败 {fail}")
    return done, skip, fail


def process_flat_directory(data_dir):
    """直接处理 data_dir 下的所有 JSON 文件 (无子类别目录模式)"""
    cat_name = os.path.basename(os.path.abspath(data_dir))
    json_files = [
        fn for fn in os.listdir(data_dir)
        if fn.endswith(".json") and fn != "index.json"
    ]

    if not json_files:
        print("[错误] data/ 下没有 JSON 文件")
        return 0, 0, 0

    print(f"--- {cat_name} ({len(json_files)} 条) ---")

    done = skip = fail = 0
    items = []

    for fn in json_files:
        cid = os.path.splitext(fn)[0]
        case_path = os.path.join(data_dir, fn)
        png_path = os.path.join(data_dir, f"{cid}.png")
        thumb_rel = f"{cat_name}/{cid}.png"

        try:
            with open(case_path, "r", encoding="utf-8") as f:
                case = json.load(f)
        except Exception as e:
            print(f"  [失败] {cid}: {e}")
            fail += 1
            continue

        if os.path.isfile(png_path) and not OVERWRITE:
            skip += 1
        else:
            try:
                img = draw_case(case, SIZE, PADDING)
                img.save(png_path, "PNG", optimize=True)
                done += 1
            except Exception as e:
                print(f"  [失败] {cid}: {e}")
                fail += 1
                continue

        # 写回单个案例 JSON 的 thumbnail
        case["thumbnail"] = thumb_rel
        with open(case_path, "w", encoding="utf-8") as f:
            json.dump(case, f, ensure_ascii=False, separators=(",", ":"))

        # 收集 item 信息用于 index.json
        items.append({
            "id": case.get("id", cid),
            "name": case.get("name", ""),
            "difficulty": case.get("difficulty", 1),
            "stepCount": len(case.get("steps", [])),
            "thumbnail": thumb_rel,
        })

    # 写回 index.json
    index_path = os.path.join(data_dir, "index.json")
    cat_name = os.path.basename(data_dir)
    index_data = {
        "category": cat_name,
        "name": cat_name,
        "viewBox": [0, 0, 256, 256],
        "count": len(items),
        "items": items,
    }
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(index_data, f, ensure_ascii=False, separators=(",", ":"))

    print(f"  生成 {done}, 跳过 {skip}, 失败 {fail}")
    return done, skip, fail


def process_single_file(path):
    """为单个案例 JSON 生成同名 PNG（写在 JSON 旁边）。
    用于 web 端导出的用户绘制 JSON。不改动 index.json。
    返回 (done, skip, fail)。
    """
    if not os.path.isfile(path):
        print(f"[错误] 文件不存在：{os.path.abspath(path)}")
        return 0, 0, 1
    try:
        with open(path, "r", encoding="utf-8") as f:
            case = json.load(f)
    except Exception as e:
        print(f"[错误] 无法读取 {os.path.basename(path)}: {e}")
        return 0, 0, 1

    png_path = os.path.splitext(path)[0] + ".png"
    try:
        img = draw_case(case, SIZE, PADDING)
        img.save(png_path, "PNG", optimize=True)
        print(f"[完成] {os.path.basename(path)} -> {os.path.abspath(png_path)}")
        return 1, 0, 0
    except Exception as e:
        print(f"[失败] {os.path.basename(path)}: {e}")
        return 0, 0, 1


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    # 单文件模式: python gen_thumbnails.py a.json [b.json ...]
    if len(sys.argv) > 1:
        t_done = t_skip = t_fail = 0
        for p in sys.argv[1:]:
            d, s, f = process_single_file(p)
            t_done += d; t_skip += s; t_fail += f
        print("=" * 40)
        print(f"单文件模式：生成 {t_done}, 跳过 {t_skip}, 失败 {t_fail}")
        return

    if not os.path.isdir(DATA_DIR):
        print(f"[错误] 数据目录不存在：{os.path.abspath(DATA_DIR)}")
        return

    # 检查是否有子类别目录
    subdirs = sorted(
        d for d in os.listdir(DATA_DIR)
        if os.path.isdir(os.path.join(DATA_DIR, d))
    )

    total_done = total_skip = total_fail = 0

    if subdirs:
        # 有子类别目录：按原有逻辑处理
        for cat in subdirs:
            cat_dir = os.path.join(DATA_DIR, cat)
            done, skip, fail = process_category(cat_dir, cat)
            total_done += done
            total_skip += skip
            total_fail += fail
    else:
        # 没有子类别目录：直接处理当前目录
        print(f"没有子类别目录，直接处理 {os.path.abspath(DATA_DIR)}")
        done, skip, fail = process_flat_directory(DATA_DIR)
        total_done += done
        total_skip += skip
        total_fail += fail

    print("=" * 40)
    print(f"完成：生成 {total_done}, 跳过 {total_skip}, 失败 {total_fail}")


if __name__ == "__main__":
    main()
