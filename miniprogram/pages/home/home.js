// 一笔一笔 StepDraw - 小程序首页（二级分类：分组 + 分类卡片）
const config = require('../../config');

Page({
  data: {
    groups: [],
    loading: true
  },

  onLoad() {
    this.loadCategories();
  },

  onPullDownRefresh() {
    this.loadCategories();
    wx.stopPullDownRefresh();
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

            // 新结构：groups（一级分组）+ categories（二级分类，按 id 归属分组）
            // 兼容旧结构：没有 groups 时整体当作一个分组
            const categories = data.categories || [];
            const groupsRaw = data.groups || [{ id: 'all', name: '全部', emoji: '' }];

            const bgColors = ['#FFE5E5', '#E5F3FF', '#FFF5E5', '#F0F5E5', '#FFE5FF', '#E5FFE5', '#E5F5FF', '#FFF5F5', '#F5E5FF', '#FFE5F5'];
            const textColors = ['#FF6B6B', '#4A90D9', '#FFA500', '#8BC34A', '#9C27B0', '#4CAF50', '#00BCD4', '#E91E63', '#673AB7', '#FF4081'];

            const groups = groupsRaw.map((group) => {
              // 分类按 dir 精确等于或前缀匹配归入分组（目录结构保证唯一）
              const cats = categories
                .filter((cat) => cat.id === group.id || cat.dir.startsWith(group.id + '/'))
                .map((cat) => ({
                  ...cat,
                  icon: cat.emoji || cat.name.charAt(0),
                  iconBg: bgColors[cat.id.length % bgColors.length],
                  iconColor: textColors[cat.id.length % textColors.length]
                }));
              const total = cats.reduce((sum, cat) => sum + (cat.count || 0), 0);
              return {
                id: group.id,
                name: group.name,
                emoji: group.emoji || group.name.charAt(0),
                count: total,
                categoryCount: cats.length,
                categories: cats
              };
            }).filter((group) => group.categories.length > 0);

            this.setData({
              groups,
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

  onGroupTap(e) {
    const { id, name } = e.currentTarget.dataset;
    // 只有一个分类且就是组本身（如 linedrawer）：直接进入图案列表，少一次点击
    const group = this.data.groups.find((g) => g.id === id);
    if (group && group.categories.length === 1 && group.categories[0].id === group.id) {
      const cat = group.categories[0];
      wx.navigateTo({
        url: `/pages/category/category?id=${cat.id}&name=${encodeURIComponent(cat.name)}`
      });
      return;
    }
    wx.navigateTo({
      url: `/pages/group/group?id=${id}&name=${encodeURIComponent(name)}`
    });
  },

  /**
   * 分享给朋友
   */
  onShareAppMessage() {
    return {
      title: '我发现一个宝藏小程序 Step Draw，一起来学画画吧！',
      path: '/pages/home/home',
      imageUrl: `${config.BASE_URL}/../cover.png`
    };
  },

  /**
   * 分享到朋友圈
   */
  onShareTimeline() {
    return {
      title: '我发现一个宝藏小程序Step Draw，一起来学画画吧！',
      query: '',
      imageUrl: `${config.BASE_URL}/../cover.png`
    };
  }
})
