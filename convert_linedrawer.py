#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 LineDrawer(港科大广州 SketchKit 矢量笔序) 的 JSON 转换成本项目格式:
  - 每个案例单独一个 json 文件
  - 一个类别索引文件
  - 一个总索引文件

输出结构与 convert_quickdraw.py 完全一致，前端加载逻辑不用改。

用法:
    python convert_linedrawer.py

第一次跑建议先设 INSPECT_ONLY = True，看清 JSON 结构再转。
"""

import glob
import json
import math
import os
import sys

# ==================== 配置 ====================
SRC_DIR = r"E:\otherCode\SketchKit\sketch\json"          # 输入目录（放 LineDrawer 的 .json）
OUT_DIR = "linedrawer_json_out"      # 输出目录

CATEGORY = "linedrawer"              # 类别 id（也是子目录名）
CATEGORY_NAME = "线稿"                # 类别中文名
EXTRA_TAGS = ["线稿", "LineDrawer"]   # 每个案例的 tags

PER_CATEGORY = 0                     # 最多转换多少条; 0 = 全部
TARGET_SIZE = 256                    # 输出 viewBox 边长
RESCALE = True                       # 按包围盒等比缩放居中到 TARGET_SIZE
STROKE_WIDTH = 3.0                   # 默认笔宽
FORCE_WIDTH = 0                      # >0 时强制统一笔宽; 0 = 用数据里的/默认值
BEZIER_SEG = 8                       # 贝塞尔曲线采样段数
FORCE_BEZIER = False                 # True = 把每笔划按三次贝塞尔解读
RECURSIVE = True                     # True = 递归子目录找 .json

INSPECT_ONLY = False                 # True = 只看结构不转换
INSPECT_FILES = 3                    # 检查前几个文件
# =============================================

POINT_KEYS = ("points", "path", "pts", "vertices", "samples",
              "coords", "xy", "data", "pointlist", "stroke")
CURVE_KEYS = ("curves", "bezier", "beziers", "cubic", "cubics",
              "segments", "spans", "paths")


# ---------------- 单点解析 ----------------

def parse_point(p):
    """任意形态的单点 -> (x, y, w|None, t|None)"""
    if isinstance(p, dict):
        low = {k.lower(): v for k, v in p.items()}

        def g(*keys):
            for k in keys:
                v = low.get(k)
                if isinstance(v, (int, float)) and not isinstance(v, bool):
                    return float(v)
            return None

        x, y = g("x"), g("y")
        if x is None or y is None:
            if "0" in low and "1" in low:
                try:
                    x, y = float(low["0"]), float(low["1"])
                except (TypeError, ValueError):
                    return None
            else:
                return None
        return (x, y,
                g("w", "width", "pressure", "thickness", "weight"),
                g("t", "time", "timestamp", "dt"))

    if isinstance(p, (list, tuple)):
        if len(p) < 2:
            return None
        if not all(isinstance(v, (int, float)) and not isinstance(v, bool)
                   for v in p[:2]):
            return None
        x, y = float(p[0]), float(p[1])
        w = t = None
        if len(p) >= 3 and isinstance(p[2], (int, float)) \
                and not isinstance(p[2], bool):
            w = float(p[2])
        if len(p) >= 4 and isinstance(p[3], (int, float)) \
                and not isinstance(p[3], bool):
            t = float(p[3])
        return (x, y, w, t)

    return None


def parse_points(seq):
    """点序列 -> [(x,y,w,t), ...]"""
    if not isinstance(seq, (list, tuple)) or len(seq) < 2:
        return None

    # 扁平数组: [x1,y1,x2,y2,...]
    if all(isinstance(v, (int, float)) and not isinstance(v, bool)
           for v in seq):
        if len(seq) % 2:
            return None
        return [(float(seq[i]), float(seq[i + 1]), None, None)
                for i in range(0, len(seq), 2)]

    pts = []
    for p in seq:
        q = parse_point(p)
        if q is None:
            return None
        pts.append(q)
    return pts if len(pts) >= 2 else None


def parse_parallel(obj):
    """平行数组结构 {"x":[...], "y":[...], "w":[...], "t":[...]}"""
    if not isinstance(obj, dict):
        return None
    low = {k.lower(): v for k, v in obj.items()}
    xs, ys = low.get("x"), low.get("y")
    if not (isinstance(xs, list) and isinstance(ys, list)):
        return None
    if not xs or len(xs) != len(ys):
        return None

    ws = low.get("w") or low.get("width") or low.get("pressure")
    ts = low.get("t") or low.get("time") or low.get("timestamp")
    if not isinstance(ws, list) or len(ws) != len(xs):
        ws = None
    if not isinstance(ts, list) or len(ts) != len(xs):
        ts = None

    pts = []
    for i, (x, y) in enumerate(zip(xs, ys)):
        if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
            return None
        w = ws[i] if ws and isinstance(ws[i], (int, float)) else None
        t = ts[i] if ts and isinstance(ts[i], (int, float)) else None
        pts.append((float(x), float(y),
                    float(w) if w is not None else None,
                    float(t) if t is not None else None))
    return pts if len(pts) >= 2 else None


# ---------------- 贝塞尔采样 ----------------

def _cubic(p0, p1, p2, p3, n):
    out = []
    for i in range(n + 1):
        t = i / n
        mt = 1.0 - t
        a, b, c, d = mt ** 3, 3 * mt * mt * t, 3 * mt * t * t, t ** 3
        out.append((a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
                    a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
                    p0[2], None))
    return out


def _quad(p0, p1, p2, n):
    out = []
    for i in range(n + 1):
        t = i / n
        mt = 1.0 - t
        a, b, c = mt * mt, 2 * mt * t, t * t
        out.append((a * p0[0] + b * p1[0] + c * p2[0],
                    a * p0[1] + b * p1[1] + c * p2[1],
                    p0[2], None))
    return out


def bezier_chain_to_points(cps, n):
    """控制点链 -> 折线采样点。
    支持 4 点(单段三次)、3 点(二次)、3k+1 点(连续三次，格式为
    p0 c1 c2 p3 c1 c2 p6 ...，即每 3 个一组新增一段)
    """
    if len(cps) == 3:
        return _quad(cps[0], cps[1], cps[2], n)
    if len(cps) == 4:
        return _cubic(cps[0], cps[1], cps[2], cps[3], n)
    if len(cps) >= 4 and (len(cps) - 1) % 3 == 0:
        out = []
        for i in range(0, len(cps) - 1, 3):
            seg = _cubic(cps[i], cps[i + 1], cps[i + 2], cps[i + 3], n)
            if out:
                seg = seg[1:]
            out.extend(seg)
        return out
    return list(cps)


def curves_to_points(curves, n):
    """曲线容器 -> 折线采样点"""
    out = []
    for c in curves:
        cps = None
        if isinstance(c, dict):
            low = {k.lower(): v for k, v in c.items()}
            for names in (("p0", "p1", "p2", "p3"),
                          ("start", "c1", "c2", "end"),
                          ("s", "c1", "c2", "e"),
                          ("a", "b", "c", "d")):
                if all(k in low for k in names):
                    cps = [parse_point(low[k]) for k in names]
                    if any(v is None for v in cps):
                        cps = None
                    break
            if cps is None:
                for v in c.values():
                    if isinstance(v, (list, tuple)):
                        cps = parse_points(v)
                        if cps:
                            break
        else:
            cps = parse_points(c)
        if not cps:
            continue
        seg = bezier_chain_to_points(cps, n)
        if out and seg:
            if abs(out[-1][0] - seg[0][0]) < 1e-6 and \
               abs(out[-1][1] - seg[0][1]) < 1e-6:
                seg = seg[1:]
        out.extend(seg)
    return out


# ---------------- 笔划提取 ----------------

def iter_strokes(obj, depth=0):
    """递归挖出所有笔划，每个笔划是 [(x,y,w,t), ...]"""
    if depth > 8:
        return

    if isinstance(obj, dict):
        low = {k.lower(): k for k in obj}

        # 1) 平行数组
        pts = parse_parallel(obj)
        if pts:
            yield pts
            return

        # 2) 曲线容器
        for key in CURVE_KEYS:
            if key in low:
                v = obj[low[key]]
                if isinstance(v, (list, tuple)) and v:
                    s = curves_to_points(v, BEZIER_SEG)
                    if len(s) >= 2:
                        yield s
                        return

        # 3) 点容器
        for key in POINT_KEYS:
            if key in low:
                pts = parse_points(obj[low[key]])
                if pts:
                    yield pts
                    return

        # 4) 继续下钻
        for v in obj.values():
            for s in iter_strokes(v, depth + 1):
                yield s

    elif isinstance(obj, (list, tuple)):
        if not obj:
            return
        pts = parse_points(obj)
        if pts:
            if FORCE_BEZIER:
                pts = bezier_chain_to_points(pts, BEZIER_SEG)
            yield pts
        else:
            for v in obj:
                for s in iter_strokes(v, depth + 1):
                    yield s


# ---------------- 几何处理 ----------------

def dedup(pts):
    out = [pts[0]]
    for p in pts[1:]:
        if abs(p[0] - out[-1][0]) > 1e-9 or abs(p[1] - out[-1][1]) > 1e-9:
            out.append(p)
    return out


def normalize(strokes, target, pad=8.0):
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
    return [[(p[0] * scale + ox, p[1] * scale + oy, p[2], p[3])
             for p in s] for s in strokes]


def calc_width(pts, default):
    ws = [p[2] for p in pts
          if p[2] is not None and not math.isnan(p[2])]
    if not ws:
        return default
    w = sum(ws) / len(ws)
    if w <= 0:
        return default
    if w <= 1.5:                       # 归一化压力值 0~1
        return round(1.0 + 5.0 * min(w, 1.0), 2)
    return round(min(max(w, 0.5), 12.0), 2)


# ---------------- 单文件转换 ----------------

def convert_file(path):
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        raw = json.load(f)

    strokes = [dedup(s) for s in iter_strokes(raw)]
    strokes = [s for s in strokes if len(s) >= 2]
    if not strokes:
        return None

    if RESCALE:
        strokes = normalize(strokes, TARGET_SIZE)
    else:
        mx = max(p[0] for s in strokes for p in s)
        my = max(p[1] for s in strokes for p in s)
        if max(mx, my) <= 1.5:         # 归一化坐标 -> 像素
            strokes = [[(p[0] * TARGET_SIZE, p[1] * TARGET_SIZE, p[2], p[3])
                        for p in s] for s in strokes]

    steps = []
    for i, s in enumerate(strokes, 1):
        w = FORCE_WIDTH if FORCE_WIDTH else calc_width(s, STROKE_WIDTH)
        steps.append({
            "id": i,
            "tip": "",
            "strokes": [{
                "width": w,
                "points": [[round(p[0], 2), round(p[1], 2)] for p in s],
            }],
        })

    n = len(steps)
    difficulty = 1 if n <= 4 else (2 if n <= 7 else 3)

    return {
        "id": "",
        "name": "",
        "tags": list(EXTRA_TAGS),
        "difficulty": difficulty,
        "viewBox": [0, 0, TARGET_SIZE, TARGET_SIZE],
        "thumbnail": "",
        "steps": steps,
    }


def safe_filename(s):
    return "".join(c for c in s if c.isalnum() or c in "-_") or "unnamed"


# ---------------- 目录处理 ----------------

def collect_files(src):
    out = []
    out_abs = os.path.abspath(OUT_DIR)
    if RECURSIVE:
        for root, _, files in os.walk(src):
            if os.path.abspath(root).startswith(out_abs):
                continue
            for f in files:
                if f.lower().endswith(".json") and f != "index.json":
                    out.append(os.path.join(root, f))
    else:
        for p in glob.glob(os.path.join(src, "*.json")):
            if os.path.isfile(p) and os.path.basename(p) != "index.json":
                out.append(p)
    return sorted(out)


def inspect_files(files):
    for path in files[:INSPECT_FILES]:
        print("=" * 62)
        print(os.path.basename(path), f"({os.path.getsize(path) / 1024:.1f} KB)")
        try:
            with open(path, "r", encoding="utf-8", errors="ignore") as f:
                raw = json.load(f)
        except Exception as e:
            print("  读取失败:", e)
            continue

        print("顶层类型:", type(raw).__name__)
        if isinstance(raw, dict):
            print("顶层键:", list(raw.keys())[:20])
        print("片段:", json.dumps(raw, ensure_ascii=False)[:900])

        found = [s for s in iter_strokes(raw) if len(s) >= 2]
        print(f"\n>>> 解析出笔划: {len(found)} 条")
        if found:
            s = found[0]
            print(f">>> 首笔划点数: {len(s)}  首点: {s[0]}  末点: {s[-1]}")
            mx = max(p[0] for st in found for p in st)
            my = max(p[1] for st in found for p in st)
            print(f">>> 坐标最大值: x={mx:.2f}, y={my:.2f}")
        print()


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    if not os.path.isdir(SRC_DIR):
        print(f"[错误] 输入目录不存在: {os.path.abspath(SRC_DIR)}")
        return

    files = collect_files(SRC_DIR)
    if not files:
        print(f"[错误] {SRC_DIR} 下没有 .json 文件")
        return

    print(f"输入: {os.path.abspath(SRC_DIR)}")
    print(f"输出: {os.path.abspath(OUT_DIR)}")
    print(f"文件: {len(files)} 个, 上限: {PER_CATEGORY or '不限'}\n")

    if INSPECT_ONLY:
        inspect_files(files)
        print("[INSPECT_ONLY] 只检查结构，未转换。")
        return

    cat_dir = os.path.join(OUT_DIR, CATEGORY)
    os.makedirs(cat_dir, exist_ok=True)

    seen = set()
    items = []
    kept = skipped = 0

    for i, path in enumerate(files, 1):
        if PER_CATEGORY and kept >= PER_CATEGORY:
            break

        rel = os.path.relpath(path, SRC_DIR)
        stem = os.path.splitext(rel)[0].replace("\\", "_").replace("/", "_")
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
            print(f"  [跳过] {stem}: 未解析到笔划")
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

        if i % 50 == 0 or i == len(files):
            print(f"  进度 {i}/{len(files)}  保留 {kept}  跳过 {skipped}")

    cat_index = os.path.join(cat_dir, "index.json")
    with open(cat_index, "w", encoding="utf-8") as fo:
        json.dump({
            "category": CATEGORY,
            "name": CATEGORY_NAME,
            "viewBox": [0, 0, TARGET_SIZE, TARGET_SIZE],
            "count": kept,
            "items": items,
        }, fo, ensure_ascii=False, separators=(",", ":"))

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