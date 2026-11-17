// 一笔一笔 StepDraw - 分类列表页
const config = require('../../config');

Page({
  data: {
    BASE_URL: config.BASE_URL,
    categoryId: '',
    categoryName: '',
    drawings: [],
    filteredDrawings: [],
    selectedDifficulty: '全部',
    difficulties: ['全部', '入门', '简单', '进阶'],
    loading: true
  },

  onLoad(options) {
    const { id, name } = options;
    if (id) {
      const categoryName = decodeURIComponent(name || '');
      this.setData({
        categoryId: id,
        categoryName
      });
      // 设置导航栏标题为当前分类名称
      wx.setNavigationBarTitle({
        title: categoryName || '分类列表'
      });
      this.loadDrawings(id);
    }
  },

  loadDrawings(categoryId) {
    try {
      this.setData({ loading: true });

      wx.request({
        url: config.getCategoryUrl(categoryId),
        success: (res) => {
          console.log('分类数据响应:', res);
          const data = res.data;
          const drawings = data.items || [];
          this.setData({
            drawings,
            filteredDrawings: drawings,
            loading: false
          });
        },
        fail: (err) => {
          console.error('请求失败:', err);
          this.setData({ loading: false });
          wx.showToast({
            title: '加载失败',
            icon: 'none'
          });
        }
      });
    } catch (err) {
      console.error('加载图案失败:', err);
      this.setData({ loading: false });
      wx.showToast({
        title: '加载失败',
        icon: 'none'
      });
    }
  },

  onDifficultyChange(e) {
    const difficulty = e.currentTarget.dataset.difficulty;
    this.setData({ selectedDifficulty: difficulty });
    this.filterDrawings();
  },

  filterDrawings() {
    const { drawings, selectedDifficulty } = this.data;
    let filtered = drawings;

    if (selectedDifficulty !== '全部') {
      const diffMap = { '入门': 1, '简单': 2, '进阶': 3 };
      const targetDiff = diffMap[selectedDifficulty];
      filtered = filtered.filter(function(d) { return d.difficulty === targetDiff; });
    }

    this.setData({ filteredDrawings: filtered });
  },

  onDrawingTap(e) {
    const drawingId = e.currentTarget.dataset.id;
    wx.navigateTo({
      url: `/pages/detail/detail?id=${this.data.categoryId}/${drawingId}`
    });
  },

  onBack() {
    wx.navigateBack();
  },

  getDifficultyLabel(diff) {
    return diff === 1 ? '入门' : diff === 2 ? '简单' : '进阶';
  },

  onImageError(e) {
    console.log('图片加载失败:', e);
  },

  /**
   * 分享给朋友
   */
  onShareAppMessage() {
    const { categoryName, drawings } = this.data;
    const firstDrawing = drawings.length > 0 ? drawings[0] : null;
    return {
      title: `一笔一笔 StepDraw - 来画${categoryName}吧！`,
      path: `/pages/category/category?id=${this.data.categoryId}&name=${encodeURIComponent(categoryName)}`,
      imageUrl: firstDrawing && firstDrawing.thumbnail ? `${config.BASE_URL}/${firstDrawing.thumbnail}` : undefined
    };
  },

  /**
   * 分享到朋友圈
   */
  onShareTimeline() {
    const { categoryName, drawings } = this.data;
    const firstDrawing = drawings.length > 0 ? drawings[0] : null;
    return {
      title: `一笔一笔 StepDraw - 来画${categoryName}吧！`,
      query: `id=${this.data.categoryId}&name=${encodeURIComponent(categoryName)}`,
      imageUrl: firstDrawing && firstDrawing.thumbnail ? `${config.BASE_URL}/${firstDrawing.thumbnail}` : undefined
    };
  }
})
