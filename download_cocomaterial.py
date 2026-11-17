#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
通过 CocoMaterial API 按 tag 批量下载 SVG（同时下载线稿与彩色版）。
"""

import os
import re
import sys
import time
import requests
from urllib.parse import quote

# ==================== 配置 ====================
BASE_URL = "https://cocomaterial.com/api/vectors/"
TAGS = ["family", "Buildings", "Read"]          # 可填多个，如 ["animals", "plants", "food"]
PAGE_SIZE = 40
DEST_ROOT = "cocomaterial_svg"

MAX_RETRY = 3
TIMEOUT = 30
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/120.0.0.0 Safari/537.36"
}
# =============================================

def build_api_url(tag: str, page: int = 1) -> str:
    return (f"{BASE_URL}?page={page}"
            f"&page_size={PAGE_SIZE}"
            f"&tags={quote(tag)}")

def safe_filename(name: str) -> str:
    name = re.sub(r"[^\w\s-]", "", name).strip()
    name = re.sub(r"[-\s]+", "_", name)
    return name or "untitled"

def download_file(url: str, out_path: str) -> bool:
    if not url:
        return False
    if os.path.exists(out_path) and os.path.getsize(out_path) > 0:
        return True

    tmp_path = out_path + ".part"
    for attempt in range(1, MAX_RETRY + 1):
        try:
            with requests.get(url, headers=HEADERS, timeout=TIMEOUT, stream=True) as r:
                r.raise_for_status()
                with open(tmp_path, "wb") as f:
                    for chunk in r.iter_content(chunk_size=8192):
                        if chunk:
                            f.write(chunk)
            os.replace(tmp_path, out_path)
            return True
        except Exception as e:
            print(f"    [失败] {e}")
            if os.path.exists(tmp_path):
                try: os.remove(tmp_path)
                except OSError: pass
            if attempt < MAX_RETRY:
                time.sleep(2 * attempt)
    return False

def fetch_tag(tag: str, dest_dir: str):
    print(f"\n{'='*50}\n分类: {tag}\n目录: {os.path.abspath(dest_dir)}\n{'='*50}\n")
    line_dir = os.path.join(dest_dir, "line")
    color_dir = os.path.join(dest_dir, "color")
    os.makedirs(line_dir, exist_ok=True)
    os.makedirs(color_dir, exist_ok=True)

    next_url = build_api_url(tag)
    page = 0
    ok = fail = 0

    while next_url:
        page += 1
        print(f"--- 第 {page} 页 ---")
        try:
            resp = requests.get(next_url, headers=HEADERS, timeout=TIMEOUT)
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            print(f"[错误] 请求 API 失败: {e}")
            break

        results = data.get("results", [])
        if not results:
            break

        for item in results:
            svg_url = item.get("svg")
            colored_url = item.get("coloredSvg")
            name = item.get("name") or f"vector_{item.get('id')}"
            filename = safe_filename(name) + ".svg"

            line_path = os.path.join(line_dir, filename)
            color_path = os.path.join(color_dir, filename)

            print(f"[{name}]")
            success_line = download_file(svg_url, line_path)
            success_color = download_file(colored_url, color_path)

            if success_line or success_color:
                ok += 1
            else:
                fail += 1

        next_url = data.get("next")
        time.sleep(1) # 温和请求，避免被封

    print(f"\n[{tag}] 完成: 成功 {ok}, 失败 {fail}")

def main():
    try: sys.stdout.reconfigure(encoding="utf-8")
    except Exception: pass
    if not TAGS: return

    total_ok = total_fail = 0
    for tag in TAGS:
        dest_dir = os.path.join(DEST_ROOT, safe_filename(tag))
        fetch_tag(tag, dest_dir)

if __name__ == "__main__":
    main()