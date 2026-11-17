#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
为 data/ 下每个案例 JSON 生成完整封面 PNG。

输入:
    data/<category>/<id>.json
输出:
    data/<category>/<id>.png
同时更新:
    data/<category>/index.json  里的 items[].thumbnail
    data/<category>/<id>.json    里的 thumbnail

用法:
    pip install Pillow
    python gen_thumbnails.py
"""

import json
import os
import sys

from PIL import Image, ImageDraw

# ==================== 配置 ====================
DATA_DIR = "./web/public/data"
SIZE = 256                          # 封面边长(px)，可改 512
PADDING = 8                         # 边距(px)，基于 SIZE
BG_COLOR = (255, 255, 255, 255)     # 白底；透明改 (0,0,0,0)
LINE_COLOR = (51, 51, 51, 255)      # #333
LINE_WIDTH_BASE = 3                 # 与 JSON 中 width 对应
SMOOTH_SAMPLES = 8                  # 每段贝塞尔插值数；1 = 关闭平滑
OVERWRITE = False                   # True = 覆盖已存在的 PNG
# =============================================


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

    for step in case.get("steps", []):
        for stroke in step.get("strokes", []):
            pts = stroke.get("points") or []
            if len(pts) < 2:
                continue
            mapped = [(x * scale + offset_x, y * scale + offset_y) for x, y in pts]
            mapped = smooth_polyline(mapped, SMOOTH_SAMPLES)
            w = max(1, int(round(stroke.get("width", LINE_WIDTH_BASE) * scale)))
            draw.line(mapped, fill=LINE_COLOR, width=w, joint="curve")

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


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    if not os.path.isdir(DATA_DIR):
        print(f"[错误] 数据目录不存在: {os.path.abspath(DATA_DIR)}")
        return

    categories = sorted(
        d for d in os.listdir(DATA_DIR)
        if os.path.isdir(os.path.join(DATA_DIR, d))
    )
    if not categories:
        print("[错误] data/ 下没有类别目录")
        return

    total_done = total_skip = total_fail = 0

    for cat in categories:
        cat_dir = os.path.join(DATA_DIR, cat)
        try:
            cat_index = load_category_index(cat_dir, cat)
        except Exception as e:
            print(f"[跳过] {cat}: {e}")
            continue

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
        total_done += done
        total_skip += skip
        total_fail += fail

    print("=" * 40)
    print(f"完成: 生成 {total_done}, 跳过 {total_skip}, 失败 {total_fail}")


if __name__ == "__main__":
    main()