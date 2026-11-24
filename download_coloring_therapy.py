import os
import time
import requests
from bs4 import BeautifulSoup
from urllib.parse import urljoin, urlparse, parse_qs

# ================= 配置 =================
BASE_URL = "https://freecoloringtherapy.com"
COLLECTIONS_URL = f"{BASE_URL}/collections"
DOWNLOAD_DIR = r"C:\Users\epro\Downloads\hiroshima\coloring_therapy_downloads"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    )
}
REQUEST_DELAY = 1.0
# =======================================


def get_soup(url):
    resp = requests.get(url, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    return BeautifulSoup(resp.text, "html.parser")


def get_collection_links():
    """从 /collections 页面提取所有合集子页面的链接。"""
    print(f"📡 正在解析合集列表页: {COLLECTIONS_URL}")
    soup = get_soup(COLLECTIONS_URL)
    links = set()
    for a_tag in soup.find_all("a", href=True):
        href = a_tag["href"].strip()
        full_url = urljoin(BASE_URL, href)
        parsed = urlparse(full_url)
        # 合集详情页通常包含 "coloring-pages" 或类似路径
        if parsed.netloc == urlparse(BASE_URL).netloc and parsed.path not in ("/collections", "/"):
            if "coloring-pages" in parsed.path or "adult-coloring-pages" in parsed.path:
                links.add(full_url)
    print(f"✅ 发现 {len(links)} 个可能的合集页面链接。")
    return sorted(links)


def find_pdf_viewer_links(collection_url):
    """
    在合集页面中寻找 "pdf-viewer?file=..." 形式的链接，
    并从中提取 file 参数值。
    """
    print(f"  🔍 正在分析合集页: {collection_url}")
    soup = get_soup(collection_url)

    file_slugs = set()
    # 直接查找所有 href 中包含 "pdf-viewer?file=" 的链接
    for a_tag in soup.find_all("a", href=True):
        href = a_tag["href"].strip()
        full_url = urljoin(collection_url, href)
        parsed = urlparse(full_url)
        query = parse_qs(parsed.query)

        if "pdf-viewer" in parsed.path and "file" in query:
            slug = query["file"][0].strip()
            if slug:
                file_slugs.add(slug)

    print(f"    -> 找到 {len(file_slugs)} 个 PDF 查看器链接 (file 参数)。")
    return sorted(file_slugs)


def candidate_pdf_urls(slug):
    """
    根据 file 参数，生成几个最可能的 PDF 文件 URL 候选。
    """
    return [
        f"{BASE_URL}/pdf/{slug}.pdf",
        f"{BASE_URL}/{slug}.pdf",
        f"{BASE_URL}/pdfs/{slug}.pdf",
    ]


def download_pdf_if_valid(pdf_url, save_dir, default_name):
    """
    尝试下载 PDF。先发送 HEAD 请求验证 Content-Type 是否为 PDF，
    确认后再进行流式下载。
    """
    os.makedirs(save_dir, exist_ok=True)

    # 1. 验证链接是否指向一个真实的 PDF 文件
    try:
        head_resp = requests.head(pdf_url, headers=HEADERS, timeout=15, allow_redirects=True)
        content_type = head_resp.headers.get("Content-Type", "").lower()
        if "application/pdf" not in content_type:
            return False  # 不是 PDF，跳过这个候选链接
    except Exception:
        return False

    # 2. 确认为 PDF 后，进行下载
    try:
        with requests.get(pdf_url, headers=HEADERS, stream=True, timeout=60, allow_redirects=True) as r:
            r.raise_for_status()
            filename = default_name
            cd = r.headers.get("Content-Disposition", "")
            if "filename=" in cd:
                fname = cd.split("filename=")[-1].strip().strip('"').strip("'")
                if fname:
                    filename = sanitize_filename(fname)
            if not filename.lower().endswith(".pdf"):
                filename += ".pdf"

            filepath = os.path.join(save_dir, filename)
            with open(filepath, "wb") as f:
                for chunk in r.iter_content(chunk_size=8192):
                    if chunk:
                        f.write(chunk)
        print(f"    ✅ 已保存: {filepath}")
        return True
    except Exception as e:
        print(f"    ❌ 下载失败 [{pdf_url}]: {e}")
        return False


def sanitize_filename(name):
    invalid_chars = '<>:"/\\|?*'
    for ch in invalid_chars:
        name = name.replace(ch, "_")
    return name.strip()[:120]


def main():
    os.makedirs(DOWNLOAD_DIR, exist_ok=True)

    collection_links = get_collection_links()
    if not collection_links:
        print("⚠️ 未在列表页找到任何合集链接，请检查页面结构是否已变化。")
        return

    total_slugs = 0
    success_count = 0

    for idx, col_url in enumerate(collection_links, 1):
        print(f"\n[{idx}/{len(collection_links)}] 处理合集: {col_url}")
        try:
            slugs = find_pdf_viewer_links(col_url)
        except Exception as e:
            print(f"  ⚠️ 获取合集页失败: {e}")
            time.sleep(REQUEST_DELAY)
            continue

        if not slugs:
            print("  ℹ️ 未在该合集页发现 pdf-viewer 链接。")
            time.sleep(REQUEST_DELAY)
            continue

        for slug in slugs:
            total_slugs += 1
            downloaded = False
            # 尝试所有候选 URL，直到有一个成功
            for candidate_url in candidate_pdf_urls(slug):
                print(f"  -> 尝试: {candidate_url}")
                if download_pdf_if_valid(candidate_url, DOWNLOAD_DIR, sanitize_filename(slug)):
                    success_count += 1
                    downloaded = True
                    break  # 成功下载一个即可，不再尝试其他模式
                time.sleep(0.5)  # 候选链接之间短暂停顿

            if not downloaded:
                print(f"  ❌ 未能为 '{slug}' 找到可下载的 PDF 文件。")
            time.sleep(0.5)

        time.sleep(REQUEST_DELAY)

    print(f"\n🎉 全部完成！共处理 {total_slugs} 个 PDF 标识符，成功下载 {success_count} 个。")
    print(f"📁 保存目录: {os.path.abspath(DOWNLOAD_DIR)}")


if __name__ == "__main__":
    main()