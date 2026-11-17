// 一笔一笔 StepDraw - 全局配置

// 基础 URL 配置
const BASE_URL = 'http://localhost:5173/data';

// const BASE_URL = 'https://www.opencax.cn/static_resource/stepdraw/data';

/**
 * 获取分类索引地址
 * @returns {string}
 */
function getCategoryIndexUrl() {
  return `${BASE_URL}/index.json?t=${Date.now()}`; // 添加时间戳以避免缓存
}

/**
 * 获取分类列表地址
 * @param {string} categoryId - 分类 ID
 * @returns {string}
 */
function getCategoryUrl(categoryId) {
  return `${BASE_URL}/${categoryId}/index.json?t=${Date.now()}`; // 添加时间戳以避免缓存
}

/**
 * 获取图案详情地址
 * @param {string} drawingId - 图案 ID（格式：categoryId/drawingId）
 * @returns {string}
 */
function getDrawingUrl(drawingId) {
  return `${BASE_URL}/${drawingId}.json?t=${Date.now()}`; // 添加时间戳以避免缓存
}

/**
 * 获取静态资源地址
 * @param {string} path - 资源路径
 * @returns {string}
 */
function getAssetUrl(path) {
  // 确保路径以 / 开头，然后拼接
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${BASE_URL}${normalizedPath}`;
}

module.exports = {
  BASE_URL,
  getCategoryIndexUrl,
  getCategoryUrl,
  getDrawingUrl,
  getAssetUrl
};
