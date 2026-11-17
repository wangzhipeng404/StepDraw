#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
批量下载 Google Quick Draw 动物类别简化版数据（不过滤，原样保存）。

用法:
    pip install requests
    python download_quickdraw.py
"""

import os
import sys
import time
import requests

# ==================== 配置 ====================
BASE_URL = "https://storage.googleapis.com/quickdraw_dataset/full/simplified/{}.ndjson"

ANIMALS = [
    "cat", "dog", "rabbit", "elephant",
    "bird", "fish", "bear", "horse",
    "cow", "pig",
]

DEST_DIR = "quickdraw_animals"
CHUNK_SIZE = 256 * 1024
MAX_RETRY = 3
# =============================================


def human_size(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}TB"


def download_one(category: str) -> bool:
    url = BASE_URL.format(category)
    out_path = os.path.join(DEST_DIR, f"{category}.ndjson")

    if os.path.exists(out_path) and os.path.getsize(out_path) > 0:
        print(f"[跳过] {out_path} 已存在 ({human_size(os.path.getsize(out_path))})")
        return True

    tmp_path = out_path + ".part"

    for attempt in range(1, MAX_RETRY + 1):
        try:
            print(f"[下载] {category}  第 {attempt} 次尝试")
            with requests.get(url, stream=True, timeout=60) as r:
                r.raise_for_status()
                total = int(r.headers.get("Content-Length", 0))
                done = 0
                start = time.time()

                with open(tmp_path, "wb") as f:
                    for chunk in r.iter_content(chunk_size=CHUNK_SIZE):
                        if not chunk:
                            continue
                        f.write(chunk)
                        done += len(chunk)
                        elapsed = time.time() - start + 1e-6
                        speed = done / elapsed
                        if total:
                            pct = min(100.0, done / total * 100)
                            sys.stdout.write(
                                f"\r  {category}: {pct:5.1f}%  "
                                f"{human_size(done)}/{human_size(total)}  "
                                f"{human_size(speed)}/s"
                            )
                        else:
                            sys.stdout.write(
                                f"\r  {category}: {human_size(done)}  "
                                f"{human_size(speed)}/s"
                            )
                        sys.stdout.flush()

            sys.stdout.write("\n")
            os.replace(tmp_path, out_path)
            print(f"[完成] {out_path} ({human_size(os.path.getsize(out_path))})")
            return True

        except Exception as e:
            print(f"\n[失败] {category}: {e}")
            if os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass
            if attempt < MAX_RETRY:
                wait = 2 * attempt
                print(f"[重试] {wait}s 后再试...")
                time.sleep(wait)

    print(f"[放弃] {category} 多次尝试均失败")
    return False


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    os.makedirs(DEST_DIR, exist_ok=True)
    print(f"保存目录: {os.path.abspath(DEST_DIR)}")
    print(f"待下载类别: {len(ANIMALS)} 个\n")

    ok, fail = [], []
    for i, cat in enumerate(ANIMALS, 1):
        print(f"--- ({i}/{len(ANIMALS)}) {cat} ---")
        (ok if download_one(cat) else fail).append(cat)
        print()

    print("=" * 40)
    print(f"成功: {len(ok)} 个")
    if fail:
        print(f"失败: {len(fail)} 个 -> {', '.join(fail)}")
        print("重新运行即可，已成功的会自动跳过。")
    else:
        print("全部完成。")


if __name__ == "__main__":
    main()