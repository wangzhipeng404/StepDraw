#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
扫描 data/ 下所有带 index.json 的子目录，合并生成 data/index.json。
不关心数据来自哪个转换脚本，只按目录聚合。

用法:
    python build_index.py
"""

import json
import os
import sys

DATA_DIR = "web/public/data"
EMOJI_MAP = {
    "others": "✨",
    "animals": "🐾",
    "plants": "🌿",
    "Buildings": "🏛️",
    "Read": "📚",
    "bear": "🐻",
    "bird": "🐦",
    "cat": "🐱",
    "cow": "🐮",
    "dog": "🐶",
    "elephant": "🐘",
    "family": "👨‍👩‍👧‍👦",
    "fish": "🐟",
    "horse": "🐴",
    "panda": "🐼",
    "pig": "🐷",
    "rabbit": "🐰",
}


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    if not os.path.isdir(DATA_DIR):
        print(f"[错误] 数据目录不存在：{os.path.abspath(DATA_DIR)}")
        return

    # 读取现有的 index.json，保留 emoji 字段
    existing_index = {}
    existing_path = os.path.join(DATA_DIR, "index.json")
    if os.path.isfile(existing_path):
        try:
            with open(existing_path, "r", encoding="utf-8") as f:
                existing_index = json.load(f)
        except Exception:
            pass

    # 构建现有 emoji 映射
    emoji_map = {}
    for cat in existing_index.get("categories", []):
        if "emoji" in cat:
            emoji_map[cat["id"]] = cat["emoji"]

    categories = []

    for cat in sorted(os.listdir(DATA_DIR)):
        cat_dir = os.path.join(DATA_DIR, cat)
        if not os.path.isdir(cat_dir):
            continue

        idx_path = os.path.join(cat_dir, "index.json")
        if not os.path.isfile(idx_path):
            print(f"[跳过] {cat}: 没有 index.json")
            continue

        try:
            with open(idx_path, "r", encoding="utf-8") as f:
                idx = json.load(f)
        except Exception as e:
            print(f"[跳过] {cat}: {e}")
            continue

        count = idx.get("count", len(idx.get("items", [])))
        if count == 0:
            print(f"[跳过] {cat}: 0 条")
            continue

        # 优先使用已存在的 emoji，否则使用默认映射
        emoji = emoji_map.get(cat, EMOJI_MAP.get(cat))

        categories.append({
            "id": cat,
            "name": idx.get("name", cat),
            "emoji": emoji,
            "count": count,
            "dir": cat,
        })

    index = {
        "viewBox": [0, 0, 256, 256],
        "categories": categories,
    }
    out_path = os.path.join(DATA_DIR, "index.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)

    print(f"合并 {len(categories)} 个类别 -> {os.path.abspath(out_path)}")
    print(f"大小：{os.path.getsize(out_path)/1024:.1f} KB\n")
    for c in categories:
        print(f"  {c['id']} ({c['name']}) {c['emoji']} - {c['count']} 条")


if __name__ == "__main__":
    main()
