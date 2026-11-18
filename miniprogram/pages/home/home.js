// 一笔一笔 StepDraw - 小程序首页（分类卡片）
const config = require('../../config');

Page({
  data: {
    categories: [],
    loading: true
  },

  onLoad() {
    this.loadCategories();
  },

  async loadCategories() {
    try {
      this.setData({ loading: true });

      // 加载主索引
      return new Promise((resolve, reject) => {
        wx.request({
          url: config.getCategoryIndexUrl(),
          success: (res) => {
            console.log('完整响应:', res);
            // 微信小程序的 res.data 就是直接的数据
            const data = res.data;
            console.log('data 类型:', typeof data, Array.isArray(data) ? 'array' : 'object');

            // 为每个分类添加颜色
            const categoriesWithIcons = (data.categories || []).map((cat, index) => {
              const bgColors = ['#FFE5E5', '#E5F3FF', '#FFF5E5', '#F0F5E5', '#FFE5FF', '#E5FFE5', '#E5F5FF', '#FFF5F5', '#F5E5FF', '#FFE5F5'];
              const textColors = ['#FF6B6B', '#4A90D9', '#FFA500', '#8BC34A', '#9C27B0', '#4CAF50', '#00BCD4', '#E91E63', '#673AB7', '#FF4081'];
              return {
                ...cat,
                icon: cat.emoji || cat.name.charAt(0),
                iconBg: bgColors[index] || '#f5f5f5',
                iconColor: textColors[index] || '#999'
              };
            });

            this.setData({
              categories: categoriesWithIcons,
              loading: false
            });
            resolve();
          },
          fail: (err) => {
            console.error('请求失败:', err);
            this.setData({ loading: false });
            wx.showToast({
              title: '请求失败',
              icon: 'none'
            });
            reject(err);
          }
        });
      });
    } catch (err) {
      console.error('加载分类失败:', err);
      this.setData({ loading: false });
      wx.showToast({
        title: '加载失败',
        icon: 'none'
      });
    }
  },

  onCategoryTap(e) {
    const { id, name } = e.currentTarget.dataset;
    wx.navigateTo({
      url: `/pages/category/category?id=${id}&name=${encodeURIComponent(name)}`
    });
  },

  onPullDownRefresh() {
    this.loadCategories();
    wx.stopPullDownRefresh();
  },

  /**
   * 分享给朋友
   */
  onShareAppMessage() {
    return {
      title: '一笔一笔 StepDraw - 一起来学画画吧！',
      path: '/pages/home/home',
      imageUrl: `${config.BASE_URL}/plants/Cherry_tree.png`
    };
  },

  /**
   * 分享到朋友圈
   */
  onShareTimeline() {
    return {
      title: '一笔一笔 StepDraw - 一起来学画画吧！',
      query: '',
      imageUrl: `${config.BASE_URL}/plants/Cherry_tree.png`
    };
  }
})
