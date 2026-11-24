// 一笔一笔 StepDraw - 主分类下的子分类页
const config = require('../../config');

Page({
  data: {
    BASE_URL: config.BASE_URL,
    groupId: '',
    groupName: '',
    groupEmoji: '',
    categories: [],
    loading: true
  },

  onLoad(options) {
    const { id, name } = options;
    if (!id) return;
    const groupName = decodeURIComponent(name || '');
    this.setData({ groupId: id, groupName });
    tt.setNavigationBarTitle({
      title: groupName || '子分类'
    });
    this.loadCategories(id);
  },

  onPullDownRefresh() {
    this.loadCategories(this.data.groupId);
    tt.stopPullDownRefresh();
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
      tt.request({
        url: config.getCategoryIndexUrl(),
        success: (res) => {
          const data = res.data;
          // 取主分类的 emoji（groups 配置里）
          const groupInfo = (data.groups || []).find((g) => g.id === groupId);
          if (groupInfo && groupInfo.emoji) {
            this.setData({ groupEmoji: groupInfo.emoji });
          }
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
          tt.showToast({ title: '加载失败', icon: 'none' });
        }
      });
    } catch (err) {
      console.error('加载分类失败:', err);
      this.setData({ loading: false });
      tt.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  onCategoryTap(e) {
    const { id, name } = e.currentTarget.dataset;
    tt.navigateTo({
      url: `/pages/category/category?id=${id}&name=${encodeURIComponent(name)}`
    });
  },

  onShareAppMessage() {
    // 抖音用 extra 传参（重开当前页），不传 path
    return {
      title: `我发现一个宝藏小程序 Step Draw，一起来画${this.data.groupName}吧！`,
      extra: `id=${encodeURIComponent(this.data.groupId)}&name=${encodeURIComponent(this.data.groupName)}`,
      imageUrl: `${config.BASE_URL}/../cover.png`
    };
  }
})
