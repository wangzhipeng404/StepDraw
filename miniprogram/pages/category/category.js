// 一笔一笔 StepDraw - 分类列表页
const config = require('../../config');

const LOAD_MORE_COUNT = 20;

Page({
  data: {
    BASE_URL: config.BASE_URL,
    categoryId: '',
    categoryName: '',
    drawings: [],
    filteredDrawings: [],
    displayedDrawings: [],
    selectedDifficulty: '全部',
    difficulties: ['全部', '入门', '简单', '进阶'],
    loading: true,
    displayCount: LOAD_MORE_COUNT,
    isLoadingMore: false,
    hasMore: true
  },

  onLoad(options) {
    const { id, name } = options;
    if (id) {
      // 分享链接的 id 是编码过的（含 / 的多级路径），先解码
      const categoryId = decodeURIComponent(id);
      const categoryName = decodeURIComponent(name || '');
      this.setData({
        categoryId,
        categoryName
      });
      // 设置导航栏标题为当前分类名称
      wx.setNavigationBarTitle({
        title: categoryName || '分类列表'
      });
      this.loadDrawings(categoryId);
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
          const displayCount = Math.min(LOAD_MORE_COUNT, drawings.length);
          this.setData({
            drawings,
            filteredDrawings: drawings,
            displayedDrawings: drawings.slice(0, displayCount),
            loading: false,
            displayCount: displayCount,
            hasMore: drawings.length > LOAD_MORE_COUNT
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

    const displayCount = Math.min(LOAD_MORE_COUNT, filtered.length);
    this.setData({
      filteredDrawings: filtered,
      displayedDrawings: filtered.slice(0, displayCount),
      displayCount: displayCount,
      hasMore: filtered.length > LOAD_MORE_COUNT
    });
  },

  onDrawingTap(e) {
    // 长按进入过展示模式后，抬手还会补发一次 tap，忽略它避免误跳详情页
    if (this._longPressFired) {
      this._longPressFired = false;
      if (this._longPressTapGuard) {
        clearTimeout(this._longPressTapGuard);
        this._longPressTapGuard = null;
      }
      return;
    }
    const drawingId = e.currentTarget.dataset.id;
    wx.navigateTo({
      url: `/pages/detail/detail?id=${this.data.categoryId}/${drawingId}`
    });
  },

  // 长按图案卡片：进入展示模式（无按钮，进入即播放绘制）
  onDrawingLongPress(e) {
    const drawingId = e.currentTarget.dataset.id;
    // 标记本次长按，屏蔽随后抬手触发的 tap
    this._longPressFired = true;
    if (this._longPressTapGuard) clearTimeout(this._longPressTapGuard);
    this._longPressTapGuard = setTimeout(() => {
      this._longPressFired = false;
      this._longPressTapGuard = null;
    }, 500);
    wx.navigateTo({
      url: `/pages/show/show?id=${this.data.categoryId}/${drawingId}`
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
      title: `我发现一个宝藏小程序 Step Draw，一起来画${categoryName}吧！`,
      // id 含多级路径（如 quickdraw/cat），必须整体编码，否则微信分享会按 / 截断
      path: `/pages/category/category?id=${encodeURIComponent(this.data.categoryId)}&name=${encodeURIComponent(categoryName)}`,
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
      title: `我发现一个宝藏小程序 Step Draw，一起来画${categoryName}吧！`,
      query: `id=${encodeURIComponent(this.data.categoryId)}&name=${encodeURIComponent(categoryName)}`,
      imageUrl: firstDrawing && firstDrawing.thumbnail ? `${config.BASE_URL}/${firstDrawing.thumbnail}` : undefined
    };
  },

  /**
   * 滚动到底部触发加载更多
   */
  onReachBottom() {
    const { displayCount, filteredDrawings, isLoadingMore, hasMore } = this.data;

    if (isLoadingMore || !hasMore) return;

    this.setData({ isLoadingMore: true });

    setTimeout(() => {
      const newDisplayCount = displayCount + LOAD_MORE_COUNT;
      this.setData({
        displayedDrawings: filteredDrawings.slice(0, newDisplayCount),
        displayCount: newDisplayCount,
        isLoadingMore: false,
        hasMore: newDisplayCount < filteredDrawings.length
      });
    }, 300);
  },

  /**
   * 页面滚动监听
   */
  onPageScroll(e) {
    // 可用来优化滚动体验
  }
})
