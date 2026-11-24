// 一笔一笔 StepDraw - 小程序收藏页
Page({
  data: {
    favoriteDrawings: []
  },

  onLoad() {
    this.loadFavorites();
  },

  onShow() {
    this.loadFavorites();
  },

  loadFavorites() {
    // TODO: 从本地存储加载收藏列表
    const favorites = [];
    this.setData({ favoriteDrawings: favorites });
  },

  onDrawingTap(e) {
    const drawingId = e.currentTarget.dataset.id;
    tt.navigateTo({
      url: `/pages/detail/detail?id=${drawingId}`
    });
  },

  onRemoveFavorite(e) {
    const drawingId = e.currentTarget.dataset.id;
    // TODO: 移除收藏
    this.loadFavorites();
  }
})
