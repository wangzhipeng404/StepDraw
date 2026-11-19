// 一笔一笔 StepDraw - 主分类下的子分类页
const config = require('../../config');

Page({
  data: {
    BASE_URL: config.BASE_URL,
    groupId: '',
    groupName: '',
    categories: [],
    loading: true
  },

  onLoad(options) {
    const { id, name } = options;
    if (!id) return;
    const groupName = decodeURIComponent(name || '');
    this.setData({ groupId: id, groupName });
    wx.setNavigationBarTitle({
      title: groupName || '子分类'
    });
    this.loadCategories(id);
  },

  onPullDownRefresh() {
    this.loadCategories(this.data.groupId);
    wx.stopPullDownRefresh();
  },

  loadCategories(groupId) {
    const { categories, loading } = this.data;
    // 首页已加载过主索引，这里优先用缓存
    if (categories.length > 0) {
      this.setData({ loading: false });
      return;
    }

    try {
      this.setData({ loading: true });
      wx.request({
        url: config.getCategoryIndexUrl(),
        success: (res) => {
          const data = res.data;
          const all = data.categories || [];
          // 分类按 dir 精确等于或前缀匹配归入分组（目录结构保证唯一）
          const bgColors = ['#FFE5E5', '#E5F3FF', '#FFF5E5', '#F0F5E5', '#FFE5FF', '#E5FFE5', '#E5F5FF', '#FFF5F5', '#F5E5FF', '#FFE5F5'];
          const textColors = ['#FF6B6B', '#4A90D9', '#FFA500', '#8BC34A', '#9C27B0', '#4CAF50', '#00BCD4', '#E91E63', '#673AB7', '#FF4081'];
          const cats = all
            .filter((cat) => cat.id === groupId || cat.dir.startsWith(groupId + '/'))
            .map((cat) => ({
              ...cat,
              icon: cat.emoji || cat.name.charAt(0),
              iconBg: bgColors[cat.id.length % bgColors.length],
              iconColor: textColors[cat.id.length % textColors.length]
            }));
          this.setData({ categories: cats, loading: false });
        },
        fail: (err) => {
          console.error('请求失败:', err);
          this.setData({ loading: false });
          wx.showToast({ title: '加载失败', icon: 'none' });
        }
      });
    } catch (err) {
      console.error('加载分类失败:', err);
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  onCategoryTap(e) {
    const { id, name } = e.currentTarget.dataset;
    wx.navigateTo({
      url: `/pages/category/category?id=${id}&name=${encodeURIComponent(name)}`
    });
  },

  onShareAppMessage() {
    return {
      title: `一笔一笔 StepDraw - 来画${this.data.groupName}吧！`,
      path: `/pages/home/home`
    };
  }
})
