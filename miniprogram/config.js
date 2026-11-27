// 一笔一笔 StepDraw - 全局配置

// 基础 URL 配置
// const BASE_URL = 'http://localhost:5173/data';

const BASE_URL = 'https://wangzhipeng404.github.io/StepDraw/data';

// 播放时"正在绘制"笔画的颜色
const PLAY_STROKE_COLOR = '#ff7875';

// ICP 备案号（各端不同：微信小程序与抖音小程序各自备案，故放在各自 config，不写死在页面里）
const ICP_NUMBER = '粤ICP备2026189971号-1X';
// ICP 备案查询官网：点击备案号引导用户去查询（小程序不能直接打开外部网址，走复制链接）
const ICP_VERIFY_URL = 'https://beian.miit.gov.cn/';

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
  return `${BASE_URL}/${normalizedPath}`;
}

module.exports = {
  BASE_URL,
  PLAY_STROKE_COLOR,
  ICP_NUMBER,
  ICP_VERIFY_URL,
  getCategoryIndexUrl,
  getCategoryUrl,
  getDrawingUrl,
  getAssetUrl
};
