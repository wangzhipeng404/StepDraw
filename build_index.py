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


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    if not os.path.isdir(DATA_DIR):
        print(f"[错误] 数据目录不存在: {os.path.abspath(DATA_DIR)}")
        return

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

        categories.append({
            "id": cat,
            "name": idx.get("name", cat),
            "count": count,
            "dir": cat,
        })

    index = {
        "viewBox": [0, 0, 256, 256],
        "categories": categories,
    }
    out_path = os.path.join(DATA_DIR, "index.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))

    print(f"合并 {len(categories)} 个类别 -> {os.path.abspath(out_path)}")
    print(f"大小: {os.path.getsize(out_path)/1024:.1f} KB\n")
    for c in categories:
        print(f"  {c['id']} ({c['name']}) - {c['count']} 条")


if __name__ == "__main__":
    main()