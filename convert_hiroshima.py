#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把广岛大学单笔草图数据集（每行 "t x y" 的 txt）转换成本项目格式:
  - 每个案例单独一个 json 文件
  - 一个类别索引文件
  - 一个总索引文件

输出结构与 convert_quickdraw.py 完全一致，前端加载逻辑不用改。

用法:
    python convert_hiroshima.py
"""

import glob
import json
import os
import sys

# ==================== 配置 ====================
SRC_DIR = r"C:\Users\epro\Downloads\hiroshima\dataset"        # 输入目录（放 .txt）
OUT_DIR = r"C:\Users\epro\Downloads\hiroshima\hiroshima_json_out"   # 输出目录

CATEGORY = "single_stroke"       # 类别 id（也是子目录名）
CATEGORY_NAME = "单笔草图"        # 类别中文名
CATEGORY_TAG = "草图"             # 每个案例的 tag

PER_CATEGORY = 0                 # 最多转换多少条; 0 = 全部
TARGET_SIZE = 256                # 输出 viewBox 边长
STROKE_WIDTH = 3.0               # 默认笔宽
KEEP_TIME = False                # True = 点写成 [x, y, t]，t 归一化到 0~1
SPLIT_ON_TIME_BACK = True        # True = 时间回退时切成新笔
PAD = 8.0                        # 缩放后四周留白
# =============================================


def parse_txt(path):
    """解析 't x y' 文本 -> [[(x, y, t), ...], ...]"""
    strokes = []
    cur = []
    last_t = None

    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.replace(",", " ").split()
            if len(parts) < 3:
                continue
            try:
                t = float(parts[0])
                x = float(parts[1])
                y = float(parts[2])
            except ValueError:
                continue

            if SPLIT_ON_TIME_BACK and last_t is not None \
                    and t < last_t - 1e-6 and cur:
                strokes.append(cur)
                cur = []

            cur.append((x, y, t))
            last_t = t

    if cur:
        strokes.append(cur)
    return [s for s in strokes if len(s) >= 2]


def dedup(pts):
    out = [pts[0]]
    for p in pts[1:]:
        if abs(p[0] - out[-1][0]) > 1e-9 or abs(p[1] - out[-1][1]) > 1e-9:
            out.append(p)
    return out


def normalize(strokes, target, pad):
    """按包围盒等比缩放并居中到 target×target"""
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

    return [[(p[0] * scale + ox, p[1] * scale + oy, p[2]) for p in s]
            for s in strokes]


def normalize_time(strokes):
    """时间归一化到 0~1"""
    ts = [p[2] for s in strokes for p in s]
    if not ts:
        return strokes
    tmin, tmax = min(ts), max(ts)
    span = max(tmax - tmin, 1e-9)
    return [[(x, y, (t - tmin) / span) for (x, y, t) in s] for s in strokes]


def pack_points(pts):
    out = []
    for p in pts:
        x = round(p[0], 2)
        y = round(p[1], 2)
        if KEEP_TIME:
            out.append([x, y, round(p[2], 4)])
        else:
            out.append([x, y])
    return out


def convert_file(path):
    strokes = parse_txt(path)
    if not strokes:
        return None

    strokes = [dedup(s) for s in strokes]
    strokes = [s for s in strokes if len(s) >= 2]
    if not strokes:
        return None

    if KEEP_TIME:
        strokes = normalize_time(strokes)
    strokes = normalize(strokes, TARGET_SIZE, PAD)

    steps = []
    for i, s in enumerate(strokes, 1):
        steps.append({
            "id": i,
            "tip": "",
            "strokes": [{
                "width": round(STROKE_WIDTH, 2),
                "points": pack_points(s),
            }],
        })

    n = len(steps)
    difficulty = 1 if n <= 4 else (2 if n <= 7 else 3)

    return {
        "id": "",
        "name": "",
        "tags": [CATEGORY_TAG],
        "difficulty": difficulty,
        "viewBox": [0, 0, TARGET_SIZE, TARGET_SIZE],
        "thumbnail": "",
        "steps": steps,
    }


def safe_filename(s):
    return "".join(c for c in s if c.isalnum() or c in "-_") or "unnamed"


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    if not os.path.isdir(SRC_DIR):
        print(f"[错误] 输入目录不存在: {os.path.abspath(SRC_DIR)}")
        return

    files = sorted(glob.glob(os.path.join(SRC_DIR, "*.txt")))
    if not files:
        print(f"[错误] {SRC_DIR} 下没有 .txt 文件")
        return

    cat_dir = os.path.join(OUT_DIR, CATEGORY)
    os.makedirs(cat_dir, exist_ok=True)

    print(f"输入: {os.path.abspath(SRC_DIR)}")
    print(f"输出: {os.path.abspath(OUT_DIR)}")
    print(f"文件: {len(files)} 个, 上限: {PER_CATEGORY or '不限'}\n")

    seen = set()
    items = []
    kept = 0
    skipped = 0

    for path in files:
        if PER_CATEGORY and kept >= PER_CATEGORY:
            break

        stem = os.path.splitext(os.path.basename(path))[0]
        cid = safe_filename(stem)
        if not cid or cid in seen:
            skipped += 1
            continue

        try:
            item = convert_file(path)
        except Exception as e:
            print(f"  [失败] {stem}: {e}")
            skipped += 1
            continue

        if item is None:
            print(f"  [跳过] {stem}: 解析不到有效笔划")
            skipped += 1
            continue

        seen.add(cid)
        item["id"] = cid
        item["name"] = stem

        case_path = os.path.join(cat_dir, f"{cid}.json")
        with open(case_path, "w", encoding="utf-8") as fo:
            json.dump(item, fo, ensure_ascii=False, separators=(",", ":"))

        kept += 1
        items.append({
            "id": cid,
            "name": stem,
            "difficulty": item["difficulty"],
            "stepCount": len(item["steps"]),
        })

    # 类别索引
    cat_index = os.path.join(cat_dir, "index.json")
    with open(cat_index, "w", encoding="utf-8") as fo:
        json.dump({
            "category": CATEGORY,
            "name": CATEGORY_NAME,
            "viewBox": [0, 0, TARGET_SIZE, TARGET_SIZE],
            "count": kept,
            "items": items,
        }, fo, ensure_ascii=False, separators=(",", ":"))

    # 总索引
    root_index = os.path.join(OUT_DIR, "index.json")
    with open(root_index, "w", encoding="utf-8") as f:
        json.dump({
            "viewBox": [0, 0, TARGET_SIZE, TARGET_SIZE],
            "categories": [{
                "id": CATEGORY,
                "name": CATEGORY_NAME,
                "count": kept,
                "dir": CATEGORY,
            }],
        }, f, ensure_ascii=False, separators=(",", ":"))

    print("=" * 44)
    print(f"完成: 保留 {kept}, 跳过 {skipped}")
    print(f"类别索引: {os.path.abspath(cat_index)} "
          f"({os.path.getsize(cat_index) / 1024:.1f} KB)")
    print(f"总索引: {os.path.abspath(root_index)} "
          f"({os.path.getsize(root_index) / 1024:.1f} KB)")


if __name__ == "__main__":
    main()