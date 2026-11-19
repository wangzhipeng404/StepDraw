#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
扫描 data/ 下所有类别目录，合并生成 data/index.json（两级结构）。

目录约定（group = 一级目录，category = 二级目录）:
    data/<group>/<cat>/index.json   普通类别（group 下有多个子目录）
    data/<group>/index.json         扁平类别（group 目录下直接是 JSON，如 linedrawer）

生成的 index.json:
    {
      "viewBox": [0, 0, 256, 256],
      "groups":     [{id, name, emoji}, ...],          // 一级分组，按 GROUPS 顺序
      "categories": [{id, name, emoji, count, dir}, ...]
    }
    其中 category.id / dir = "<group>/<cat>"（扁平类别为 "<group>"），
    前端用它拼 URL，例如 data/quickdraw/cat/index.json。

新增类别: 放好目录后重跑本脚本即可，不用改代码；
新 group 若未配置，自动追加到末尾（name=目录名，emoji 用 📁）。

注意: 会删除 group 一级目录下遗留的旧 index.json（两级结构下 group 不再有独立索引；
扁平类别如 linedrawer 的 index.json 是类别索引本身，不受影响）。

用法:
    python build_index.py
"""

import json
import os
import sys

DATA_DIR = "web/public/data"

# ==================== 一级分组配置（顺序即展示顺序） ====================
GROUPS = [
    {"id": "linedrawer",    "name": "精选", "emoji": "✨"},
    {"id": "quickdraw",     "name": "动物", "emoji": "🐾"},
    {"id": "tuberlin",      "name": "万物", "emoji": "🌍"},
    {"id": "aiposegallery", "name": "人物", "emoji": "🧍"},
    {"id": "cocomaterial",  "name": "综合", "emoji": "📦"},
]
# =======================================================================


def read_index(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def build():
    groups = {}
    categories = []

    for entry in sorted(os.listdir(DATA_DIR)):
        group_dir = os.path.join(DATA_DIR, entry)
        if not os.path.isdir(group_dir):
            continue

        subdirs = sorted(
            d for d in os.listdir(group_dir) if os.path.isdir(os.path.join(group_dir, d)))

        if subdirs:
            # 两级结构：删除 group 级遗留的旧索引
            stale = os.path.join(group_dir, "index.json")
            if os.path.isfile(stale):
                os.remove(stale)
                print(f"[清理] 删除遗留索引 {entry}/index.json")

            for cat in subdirs:
                cat_dir = os.path.join(group_dir, cat)
                idx_path = os.path.join(cat_dir, "index.json")
                if not os.path.isfile(idx_path):
                    print(f"[跳过] {entry}/{cat}: 没有 index.json")
                    continue
                try:
                    idx = read_index(idx_path)
                except Exception as e:
                    print(f"[跳过] {entry}/{cat}: {e}")
                    continue

                items = idx.get("items", [])
                if not items:
                    print(f"[跳过] {entry}/{cat}: 0 条")
                    continue

                cat_id = f"{entry}/{cat}"
                categories.append({
                    "id": cat_id,
                    "name": idx.get("name") or cat,
                    "emoji": idx.get("emoji") or "",
                    "count": idx.get("count", len(items)),
                    "dir": cat_id,
                })
        elif os.path.isfile(os.path.join(group_dir, "index.json")):
            # 扁平类别：group 目录本身就是类别
            try:
                idx = read_index(os.path.join(group_dir, "index.json"))
            except Exception as e:
                print(f"[跳过] {entry}: {e}")
                continue

            items = idx.get("items", [])
            if not items:
                print(f"[跳过] {entry}: 0 条")
                continue

            categories.append({
                "id": entry,
                "name": idx.get("name") or entry,
                "emoji": idx.get("emoji") or "",
                "count": idx.get("count", len(items)),
                "dir": entry,
            })
        else:
            print(f"[跳过] {entry}: 空目录")

        groups[entry] = True

    # 组装 groups：配置中的按配置顺序，未配置的新 group 追加到末尾
    group_list = []
    for g in GROUPS:
        if g["id"] in groups:
            group_list.append(g)
    for entry in sorted(groups):
        if not any(g["id"] == entry for g in group_list):
            print(f"[警告] group 未配置，自动追加: {entry}")
            group_list.append({"id": entry, "name": entry, "emoji": "📁"})

    index = {
        "viewBox": [0, 0, 256, 256],
        "groups": group_list,
        "categories": categories,
    }

    out_path = os.path.join(DATA_DIR, "index.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)

    # 汇总
    print(f"分组 {len(group_list)} 个, 类别 {len(categories)} 个 -> "
          f"{os.path.abspath(out_path)} ({os.path.getsize(out_path)/1024:.1f} KB)\n")
    for g in group_list:
        cats = [c for c in categories if c["dir"] == g["id"] or c["dir"].startswith(g["id"] + "/")]
        total = sum(c["count"] for c in cats)
        print(f"  {g['name']} [{g['id']}] {g['emoji']} - {len(cats)} 类 {total} 条")
        for c in cats:
            mark = " (无emoji)" if not c["emoji"] else ""
            print(f"      {c['dir']}  {c['name']}{mark} - {c['count']} 条")


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    if not os.path.isdir(DATA_DIR):
        print(f"[错误] 数据目录不存在：{os.path.abspath(DATA_DIR)}")
        return
    build()


if __name__ == "__main__":
    main()
