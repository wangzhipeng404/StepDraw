#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Omniglot 笔序数据转换（txt 版）
输入: strokes_*.zip 解压出的 *.txt（递归查找）
      每行 "x y t"（t 可缺省），笔画之间用 "START"/"BREAK" 或空行/NaN 行分隔
输出: 与 convert_quickdraw.py 一致（每案例一个 json + 类别索引 + 总索引）

用法:
    python convert_omniglot.py            # 正式转换
    python convert_omniglot.py --inspect  # 只看解析结果，不写文件
"""

import glob
import json
import os
import re
import sys

# ==================== 配置 ====================
SRC_DIR = r"C:\Users\epro\Downloads\hiroshima\omniglot\python\strokes_evaluation\strokes_evaluation"             # 解压后的根目录（递归找 txt）
OUT_DIR = r"C:\Users\epro\Downloads\hiroshima\omniglot\out\strokes_evaluation"

CATEGORY_DEPTH = 1               # 类别目录取 txt 往上几级；1=父目录, 2=祖父目录
MAX_PER_CATEGORY = 0             # 每类上限; 0 = 全部
TARGET_SIZE = 256
STROKE_WIDTH = 3.0
KEEP_TIME = False                # True = 点写成 [x,y,t]，t 归一化到 0~1
PAD = 8.0
MIN_POINTS = 2                   # 少于该点数的笔画丢弃
SPLIT_ON_BLANK = True            # 空行是否切笔
TAG = "Omniglot"
# =============================================

_SPLIT_RE = re.compile(r"[,\s]+")


# ---------------- 几何工具 ----------------

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
    return [[(p[0] * scale + ox, p[1] * scale + oy, p[2]) for p in s]
            for s in strokes]


def normalize_time(strokes):
    ts = [p[2] for s in strokes for p in s if p[2] is not None]
    if not ts:
        return strokes
    tmin, tmax = min(ts), max(ts)
    span = max(tmax - tmin, 1e-9)
    return [[(x, y, None if t is None else (t - tmin) / span)
             for (x, y, t) in s] for s in strokes]


def pack_points(pts):
    out = []
    for p in pts:
        x, y = round(p[0], 2), round(p[1], 2)
        if KEEP_TIME and p[2] is not None:
            out.append([x, y, round(p[2], 4)])
        else:
            out.append([x, y])
    return out


def build_item(strokes, cid, name):
    steps = []
    for i, s in enumerate(strokes, 1):
        steps.append({
            "id": i,
            "tip": "",
            "strokes": [{"width": round(STROKE_WIDTH, 2),
                         "points": pack_points(s)}],
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


# ---------------- txt 解析 ----------------

def parse_txt(path):
    """返回 [[(x, y, t), ...], ...]"""
    strokes, cur = [], []

    def flush():
        nonlocal cur
        if len(cur) >= MIN_POINTS:
            strokes.append(cur)
        cur = []

    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#"):
                if not line and SPLIT_ON_BLANK:
                    flush()
                continue

            low = line.lower()

            # 关键字行
            if low.startswith("break") or low.startswith("start"):
                flush()
                continue

            # 纯 NaN 行（mat 导出的常见分隔）
            if low in ("nan", "nan nan", "nan nan nan", "none"):
                flush()
                continue

            parts = [p for p in _SPLIT_RE.split(line) if p]
            if not parts:
                continue

            nums = []
            bad = False
            for p in parts[:3]:
                try:
                    nums.append(float(p))
                except ValueError:
                    if p.lower() == "nan":
                        nums.append(None)
                    else:
                        bad = True
                        break
            if bad or len(nums) < 2:
                continue
            # 整行都是 NaN -> 分隔
            if all(v is None for v in nums):
                flush()
                continue

            x = nums[0] if nums[0] is not None else 0.0
            y = nums[1] if len(nums) > 1 and nums[1] is not None else 0.0
            t = nums[2] if len(nums) > 2 else None
            cur.append((x, y, t))

    flush()
    return strokes


def convert_file(path):
    strokes = parse_txt(path)
    if not strokes:
        return None
    strokes = [dedup(s) for s in strokes]
    strokes = [s for s in strokes if len(s) >= MIN_POINTS]
    if not strokes:
        return None
    if KEEP_TIME:
        strokes = normalize_time(strokes)
    strokes = normalize(strokes, TARGET_SIZE, PAD)
    return strokes


# ---------------- 索引 ----------------

def safe_id(s):
    return "".join(c for c in s if c.isalnum() or c in "-_") or "x"


def build_cat_index(cat_dir, cat):
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
            "name": cat,
            "viewBox": [0, 0, TARGET_SIZE, TARGET_SIZE],
            "count": len(items),
            "items": items,
        }, fo, ensure_ascii=False, separators=(",", ":"))
    return len(items)


def category_of(path):
    d = os.path.dirname(os.path.abspath(path))
    for _ in range(CATEGORY_DEPTH):
        parent = os.path.dirname(d)
        if parent and parent != d:
            d = parent
    return safe_id(os.path.basename(d))


# ---------------- inspect ----------------

def inspect(files):
    print(f"找到 {len(files)} 个 txt，前 3 个解析预览:\n")
    for p in files[:3]:
        strokes = parse_txt(p)
        print(f"--- {os.path.relpath(p, SRC_DIR)}")
        print(f"    笔划数: {len(strokes)}")
        for i, s in enumerate(strokes[:5], 1):
            print(f"      第{i}笔: {len(s)} 点, 首点 {s[0]}, 末点 {s[-1]}")
        if len(strokes) > 5:
            print(f"      ... 共 {len(strokes)} 笔")
        print()


# ---------------- 主流程 ----------------

def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    do_inspect = "--inspect" in sys.argv

    if not os.path.isdir(SRC_DIR):
        print(f"[错误] 输入目录不存在: {os.path.abspath(SRC_DIR)}")
        return

    files = sorted(glob.glob(os.path.join(SRC_DIR, "**", "*.txt"),
                             recursive=True))
    if not files:
        print(f"[错误] {SRC_DIR} 下没找到 *.txt")
        return

    if do_inspect:
        inspect(files)
        return

    os.makedirs(OUT_DIR, exist_ok=True)
    print(f"输入: {os.path.abspath(SRC_DIR)}")
    print(f"输出: {os.path.abspath(OUT_DIR)}")
    print(f"txt 文件: {len(files)} 个\n")

    buckets = {}
    skipped = 0

    for path in files:
        cat = category_of(path)
        lst = buckets.setdefault(cat, [])
        if MAX_PER_CATEGORY and len(lst) >= MAX_PER_CATEGORY:
            continue
        lst.append(path)

    categories = []
    total = 0

    for cat in sorted(buckets):
        paths = buckets[cat]
        cat_dir = os.path.join(OUT_DIR, cat)
        os.makedirs(cat_dir, exist_ok=True)

        kept = 0
        for path in paths:
            stem = os.path.splitext(os.path.basename(path))[0]
            cid = safe_id(f"{cat}_{stem}")
            try:
                strokes = convert_file(path)
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

        cnt = build_cat_index(cat_dir, cat)
        print(f"=== {cat}: 写入 {kept}, 索引 {cnt} ===")
        total += cnt
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
    print(f"类别: {len(categories)}, 案例总数: {total}, 跳过: {skipped}")
    print(f"总索引: {os.path.abspath(root_index)}")


if __name__ == "__main__":
    main()