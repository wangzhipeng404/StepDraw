// 一笔一笔 StepDraw - 小程序首页（二级分类：分组 + 分类卡片）
const config = require('../../config');

Page({
  data: {
    groups: [],
    loading: true,
    // ICP 备案号来自 config（各端不同），点一下引导去官网查询
    icpNumber: config.ICP_NUMBER
  },

  onLoad() {
    this.loadCategories();
  },

  onPullDownRefresh() {
    this.loadCategories();
    tt.stopPullDownRefresh();
  },

  async loadCategories() {
    try {
      this.setData({ loading: true });

      // 加载主索引
      return new Promise((resolve, reject) => {
        tt.request({
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
            tt.showToast({
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
      tt.showToast({
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
      tt.navigateTo({
        url: `/pages/category/category?id=${cat.id}&name=${encodeURIComponent(cat.name)}`
      });
      return;
    }
    tt.navigateTo({
      url: `/pages/group/group?id=${id}&name=${encodeURIComponent(name)}`
    });
  },

  /**
   * 分享给朋友
   */
  onShareAppMessage() {
    // 抖音不支持 path 跳转，用 extra 传参（重开当前页）
    return {
      title: '我发现一个宝藏小程序 Step Draw，一起来学画画吧！',
      extra: '',
      imageUrl: `${config.BASE_URL}/../cover.png`
    };
  },

  // 点击备案号：小程序不能直接打开外部网址，把查询官网地址复制到剪贴板并提示去浏览器打开
  onIcpTap() {
    tt.setClipboardData({
      data: config.ICP_VERIFY_URL,
      success: () => {
        // setClipboardData 成功后系统会默认弹"内容已复制"，这里补一个更明确的引导
        tt.showToast({
          title: '已复制备案查询网址，请到浏览器粘贴打开',
          icon: 'none',
          duration: 2600
        });
      },
      fail: () => {
        // 复制失败（少见）：直接展示网址让用户手动复制
        tt.showModal({
          title: 'ICP 备案查询',
          content: config.ICP_VERIFY_URL,
          showCancel: false
        });
      }
    });
  },

})
