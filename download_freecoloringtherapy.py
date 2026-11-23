import os
import re
import time
import requests
from urllib.parse import urlparse

# --- 配置区 ---
SITEMAP_URL = "https://freecoloringtherapy.com/sitemap-images.xml"
DOWNLOAD_DIR = r"C:\Users\epro\Downloads\hiroshima\coloring_in\mix"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}
# 请求间隔，请保持礼貌
DELAY = 2

def get_image_urls_from_sitemap(sitemap_url):
    """从图片站点地图中解析出所有图片的基础 URL。"""
    print(f"正在获取图片站点地图: {sitemap_url}")
    try:
        resp = requests.get(sitemap_url, headers=HEADERS, timeout=15)
        resp.raise_for_status()
        # 正则匹配站点地图中所有以 .webp 或 .jpg 等结尾的图片 URL
        # 站点地图中的 URL 通常以 https:// 开头，直到空白字符或引号结束
        urls = re.findall(r'https://[^\s"<>]+?\.(?:webp|jpg|jpeg|png)', resp.text, re.I)
        # 去重并保持顺序
        seen = set()
        unique_urls = []
        for u in urls:
            if u not in seen:
                seen.add(u)
                unique_urls.append(u)
        print(f"从站点地图中找到了 {len(unique_urls)} 个图片链接。")
        return unique_urls
    except Exception as e:
        print(f"获取站点地图失败: {e}")
        return []

def download_as_png(image_url, save_dir):
    """下载图片，并请求将其转换为 PNG 格式。"""
    # 构造请求 PNG 格式的 URL (Supabase 图片转换参数)
    # 如果 URL 已有查询参数，则用 & 连接；否则用 ?
    separator = "&" if "?" in image_url else "?"
    png_url = f"{image_url}{separator}format=png"
    
    try:
        resp = requests.get(png_url, headers=HEADERS, timeout=30, stream=True)
        resp.raise_for_status()
        
        # 检查返回的内容类型，确认是否成功转换为 PNG
        content_type = resp.headers.get("Content-Type", "")
        if "image/png" not in content_type:
            # 如果服务器没有返回 PNG（可能不支持转换），则跳过或按原格式保存
            print(f"  警告: 服务器返回格式为 '{content_type}'，并非 PNG，跳过该文件。")
            return False
        
        # 从原始 URL 中提取文件名，并改为 .png 后缀
        original_filename = os.path.basename(urlparse(image_url).path)
        base_name = os.path.splitext(original_filename)[0]
        filename = f"{base_name}.png"
        # 清理文件名中的非法字符
        filename = re.sub(r'[\\/*?:"<>|]', "_", filename)
        
        filepath = os.path.join(save_dir, filename)
        if os.path.exists(filepath):
            print(f"  已存在，跳过: {filename}")
            return False
        
        with open(filepath, "wb") as f:
            for chunk in resp.iter_content(chunk_size=8192):
                f.write(chunk)
        print(f"  已下载 (PNG): {filename}")
        return True
    except Exception as e:
        print(f"  下载失败 {image_url}: {e}")
        return False

def main():
    os.makedirs(DOWNLOAD_DIR, exist_ok=True)
    
    image_urls = get_image_urls_from_sitemap(SITEMAP_URL)
    if not image_urls:
        print("未能获取图片链接，脚本终止。")
        return
    
    # 为了演示和避免请求过多，默认只处理前 20 个链接。
    # 你可以根据需要修改这个数字，但请务必保持较大的 DELAY 值。
    MAX_IMAGES = 20
    image_urls = image_urls[:MAX_IMAGES]
    
    print(f"\n开始处理前 {len(image_urls)} 个图片链接 (间隔 {DELAY} 秒)...\n")
    downloaded_count = 0
    
    for i, img_url in enumerate(image_urls, 1):
        print(f"[{i}/{len(image_urls)}] 处理: {img_url}")
        if download_as_png(img_url, DOWNLOAD_DIR):
            downloaded_count += 1
        
        if i < len(image_urls):
            time.sleep(DELAY)
    
    print(f"\n处理完成。共尝试下载 {downloaded_count} 个 PNG 文件，保存在 '{DOWNLOAD_DIR}' 文件夹中。")

if __name__ == "__main__":
    main()