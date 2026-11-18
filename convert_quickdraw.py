#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
将 Quick Draw 的 .ndjson 转换成本项目格式:
  - 每个案例单独一个 json 文件
  - 每个类别一个索引文件
  - 一个总索引文件

用法:
    python convert_quickdraw.py

输入: ./quickdraw_animals/*.ndjson
输出: ./data/
"""

import json
import os
import sys
import math

# ==================== 配置 ====================
SRC_DIR = "quickdraw_animals"
OUT_DIR = "quickdraw_animals_json"

PER_CATEGORY = 0   # 每类最多转换多少条; 0 = 全部(不推荐)
MAX_STROKES = 0      # 超过该笔画数跳过; 0 = 不过滤
SIMPLIFY_EPS = 1.0   # 路径简化阈值; 0 = 不简化
STROKE_WIDTH = 3
VIEWBOX = [0, 0, 256, 256]
CATEGORY_TAG = "动物"

NAME_MAP = {
    "cat": "猫", "dog": "狗", "rabbit": "兔子", "elephant": "大象",
    "bird": "鸟", "fish": "鱼", "bear": "熊", "horse": "马",
    "cow": "牛", "pig": "猪", "lion": "狮子", "monkey": "猴子",
    "owl": "猫头鹰", "panda": "熊猫", "raccoon": "浣熊",
    "hedgehog": "刺猬", "dolphin": "海豚", "tiger": "老虎",
    "sheep": "羊", "chicken": "鸡", "duck": "鸭子", "frog": "青蛙",
}
# =============================================


def dist_point_seg(p, a, b):
    x, y = p
    x1, y1 = a
    x2, y2 = b
    dx, dy = x2 - x1, y2 - y1
    if dx == 0 and dy == 0:
        return math.hypot(x - x1, y - y1)
    t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    return math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))


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
            d = dist_point_seg(points[k], points[i], points[j])
            if d > max_d:
                max_d, idx = d, k
        if idx != -1 and max_d > eps:
            keep[idx] = True
            stack.append((i, idx))
            stack.append((idx, j))
    return [p for p, k in zip(points, keep) if k]


def convert_record(rec, category):
    drawing = rec.get("drawing") or []
    steps = []

    for stroke in drawing:
        if not stroke or len(stroke) < 2:
            continue
        xs, ys = stroke[0], stroke[1]
        pts = [[int(round(x)), int(round(y))] for x, y in zip(xs, ys)]
        pts = rdp(pts, SIMPLIFY_EPS)

        dedup = [pts[0]]
        for p in pts[1:]:
            if p != dedup[-1]:
                dedup.append(p)

        if len(dedup) < 2:
            continue

        steps.append({
            "id": 0,
            "tip": "",
            "strokes": [{"width": STROKE_WIDTH, "points": dedup}],
        })

    if not steps:
        return None
    if MAX_STROKES and len(steps) > MAX_STROKES:
        return None

    for i, s in enumerate(steps, 1):
        s["id"] = i

    n = len(steps)
    difficulty = 1 if n <= 4 else (2 if n <= 7 else 3)

    return {
        "id": str(rec.get("key_id", "")),
        "name": NAME_MAP.get(category, rec.get("word", category)),
        "tags": [CATEGORY_TAG, category],
        "difficulty": difficulty,
        "viewBox": VIEWBOX,
        "thumbnail": "",
        "steps": steps,
    }


def safe_filename(s):
    """id 只保留安全字符，防止路径问题"""
    return "".join(c for c in s if c.isalnum() or c in "-_")


def process_category(src, category):
    """处理一个 ndjson，返回该类的索引项列表"""
    cat_dir = os.path.join(OUT_DIR, category)
    os.makedirs(cat_dir, exist_ok=True)

    total = kept = skipped = 0
    seen_ids = set()
    index_items = []

    with open(src, "r", encoding="utf-8", errors="ignore") as fi:
        for line in fi:
            line = line.strip()
            if not line:
                continue
            total += 1

            if PER_CATEGORY and kept >= PER_CATEGORY:
                break

            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                skipped += 1
                continue

            item = convert_record(rec, category)
            if item is None:
                skipped += 1
                continue

            cid = safe_filename(item["id"])
            if not cid or cid in seen_ids:
                skipped += 1
                continue
            seen_ids.add(cid)

            # 单条案例写独立文件，紧凑格式
            case_path = os.path.join(cat_dir, f"{cid}.json")
            with open(case_path, "w", encoding="utf-8") as fo:
                json.dump(item, fo, ensure_ascii=False, separators=(",", ":"))

            kept += 1
            index_items.append({
                "id": cid,
                "name": item["name"],
                "difficulty": item["difficulty"],
                "stepCount": len(item["steps"]),
            })

    # 该类索引
    cat_index_path = os.path.join(cat_dir, "index.json")
    with open(cat_index_path, "w", encoding="utf-8") as fo:
        json.dump({
            "category": category,
            "name": NAME_MAP.get(category, category),
            "viewBox": VIEWBOX,
            "count": kept,
            "items": index_items,
        }, fo, ensure_ascii=False, separators=(",", ":"))

    return total, kept, skipped, index_items


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    if not os.path.isdir(SRC_DIR):
        print(f"[错误] 输入目录不存在: {os.path.abspath(SRC_DIR)}")
        return

    os.makedirs(OUT_DIR, exist_ok=True)

    files = sorted(f for f in os.listdir(SRC_DIR) if f.lower().endswith(".ndjson"))
    if not files:
        print(f"[错误] {SRC_DIR} 下没有 .ndjson 文件")
        return

    print(f"输入: {os.path.abspath(SRC_DIR)}")
    print(f"输出: {os.path.abspath(OUT_DIR)}")
    print(f"类别: {len(files)} 个, 每类上限: {PER_CATEGORY or '不限'}\n")

    categories = []

    for i, fn in enumerate(files, 1):
        category = os.path.splitext(fn)[0]
        src = os.path.join(SRC_DIR, fn)
        print(f"--- ({i}/{len(files)}) {category} ---")
        try:
            total, kept, skipped, _ = process_category(src, category)
        except Exception as e:
            print(f"[失败] {category}: {e}\n")
            continue

        cat_index_path = os.path.join(OUT_DIR, category, "index.json")
        size_kb = os.path.getsize(cat_index_path) / 1024
        print(f"  读取 {total}, 保留 {kept}, 跳过 {skipped}, "
              f"索引 {size_kb:.1f} KB")
        print()

        categories.append({
            "id": category,
            "name": NAME_MAP.get(category, category),
            "count": kept,
            "dir": category,
        })

    # 总索引：只有类别信息，不含任何案例条目
    root_index = os.path.join(OUT_DIR, "index.json")
    with open(root_index, "w", encoding="utf-8") as f:
        json.dump({
            "viewBox": VIEWBOX,
            "categories": categories,
        }, f, ensure_ascii=False, separators=(",", ":"))

    print("=" * 40)
    print(f"完成: {len(categories)} 个类别")
    print(f"总索引: {os.path.abspath(root_index)} "
          f"({os.path.getsize(root_index) / 1024:.1f} KB)")


if __name__ == "__main__":
    main()