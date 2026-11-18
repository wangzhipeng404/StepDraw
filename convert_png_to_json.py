#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
将 ai-pose-gallery-zh/img 下的 PNG 线稿转换为 JSON 格式。
- 不遍历二级目录
- 原图作为封面保存
- 按原文件名输出 JSON
"""

import json
import os
import math
from PIL import Image, ImageDraw

# ==================== 配置 ====================
SRC_DIR = r"E:\otherCode\ai-pose-gallery-zh\img"
OUT_ROOT = "./web/public/data/pose"

TARGET_SIZE = 512
STROKE_COLOR = "#333333"
STROKE_WIDTH = 2.0
PADDING = 8
SIMPLIFY_EPS = 1.0
# =============================================


def dist_point_seg(p, a, b):
    """计算点到线段的距离"""
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
    """Ramer-Douglas-Peucker 算法简化折线"""
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


def extract_contour_points(png_path, target_size):
    """从 PNG 提取轮廓点"""
    try:
        img = Image.open(png_path)
        if img.mode != "RGBA":
            img = img.convert("RGBA")

        width, height = img.size

        # 缩放到目标尺寸
        scale = target_size / max(width, height)
        new_width = int(width * scale)
        new_height = int(height * scale)

        resized = img.resize((new_width, new_height), Image.LANCZOS)

        # 居中计算偏移
        paste_x = (target_size - new_width) // 2
        paste_y = (target_size - new_height) // 2

        # 创建白色背景
        result = Image.new("RGBA", (target_size, target_size), (255, 255, 255, 255))
        result.paste(resized, (paste_x, paste_y), resized)

        # 获取像素数据
        pixels = result.load()

        # 采样轮廓点
        points = []

        # 水平扫描
        step_y = max(1, target_size // 100)
        for y in range(0, target_size, step_y):
            # 找左边第一个非白点
            for x in range(target_size):
                r, g, b, a = pixels[x, y]
                if a < 240 or (r < 240 and g < 240 and b < 240):
                    points.append([round(x, 2), round(y, 2)])
                    break

            # 找右边第一个非白点
            for x in range(target_size - 1, -1, -1):
                r, g, b, a = pixels[x, y]
                if a < 240 or (r < 240 and g < 240 and b < 240):
                    points.append([round(x, 2), round(y, 2)])
                    break

        # 垂直扫描
        step_x = max(1, target_size // 100)
        for x in range(0, target_size, step_x):
            # 找上边第一个非白点
            for y in range(target_size):
                r, g, b, a = pixels[x, y]
                if a < 240 or (r < 240 and g < 240 and b < 240):
                    points.append([round(x, 2), round(y, 2)])
                    break

            # 找下边第一个非白点
            for y in range(target_size - 1, -1, -1):
                r, g, b, a = pixels[x, y]
                if a < 240 or (r < 240 and g < 240 and b < 240):
                    points.append([round(x, 2), round(y, 2)])
                    break

        # 去重
        unique_points = []
        seen = set()
        for p in points:
            key = (round(p[0]), round(p[1]))
            if key not in seen:
                seen.add(key)
                unique_points.append(p)

        if len(unique_points) >= 2:
            # 简化
            unique_points = rdp(unique_points, SIMPLIFY_EPS)
            return unique_points
        else:
            return [[0, 0], [target_size, target_size]]

    except Exception as e:
        print(f"    [错误] 处理 {png_path} 失败：{e}")
        return [[0, 0], [target_size, target_size]]


def process_png_files():
    """处理所有 PNG 文件（不遍历子目录）"""
    if not os.path.isdir(SRC_DIR):
        print(f"错误：源目录不存在：{SRC_DIR}")
        return

    # 创建输出目录
    os.makedirs(OUT_ROOT, exist_ok=True)

    # 获取所有 PNG 文件（不遍历子目录）
    png_files = [f for f in os.listdir(SRC_DIR) if f.lower().endswith(".png")]

    if not png_files:
        print(f"错误：{SRC_DIR} 中没有 PNG 文件")
        return

    print(f"找到 {len(png_files)} 个 PNG 文件")

    items = []

    for fn in sorted(png_files):
        png_path = os.path.join(SRC_DIR, fn)

        # 生成 ID（去掉 .png 后缀）
        case_id = os.path.splitext(fn)[0]

        # 提取轮廓点
        points = extract_contour_points(png_path, TARGET_SIZE)

        # 创建 JSON 结构
        steps = [{
            "id": 1,
            "tip": "",
            "strokes": [{
                "width": STROKE_WIDTH,
                "color": STROKE_COLOR,
                "fill": "none",
                "points": points
            }]
        }]

        # 难度根据点数估算
        difficulty = min(3, max(1, len(points) // 50))

        case_json = {
            "id": case_id,
            "name": case_id,
            "difficulty": difficulty,
            "viewBox": [0, 0, TARGET_SIZE, TARGET_SIZE],
            "thumbnail": f"pose/{case_id}.png",
            "steps": steps
        }

        # 写入 JSON
        json_path = os.path.join(OUT_ROOT, f"{case_id}.json")
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(case_json, f, ensure_ascii=False, separators=(",", ":"))

        # 复制原图作为封面
        thumb_path = os.path.join(OUT_ROOT, f"{case_id}.png")
        try:
            img = Image.open(png_path)
            img.save(thumb_path, "PNG", optimize=True)
        except Exception as e:
            print(f"    [警告] 复制封面失败 {case_id}: {e}")

        items.append({
            "id": case_id,
            "name": case_id,
            "thumbnail": f"pose/{case_id}.png",
            "difficulty": difficulty,
            "stepCount": 1
        })

        print(f"  转换：{case_id}")

    # 写入总索引
    cat_index = {
        "category": "pose",
        "name": "姿势",
        "viewBox": [0, 0, TARGET_SIZE, TARGET_SIZE],
        "count": len(items),
        "items": items
    }

    index_path = os.path.join(OUT_ROOT, "index.json")
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(cat_index, f, ensure_ascii=False, separators=(",", ":"))

    print(f"\n总计：{len(items)} 个姿势")
    print(f"输出目录：{OUT_ROOT}")


def main():
    try:
        import sys
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    print("=" * 50)
    print("开始转换 PNG 线稿为 JSON...")
    print(f"源目录：{SRC_DIR}")
    print(f"输出目录：{OUT_ROOT}")
    print("=" * 50)

    process_png_files()

    print("=" * 50)
    print("转换完成！")


if __name__ == "__main__":
    main()
