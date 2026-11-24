// 一笔一笔 StepDraw - 小程序设置页
Page({
  data: {
    defaultMode: 'continuous',
    defaultSpeed: 1,
    autoPlay: false
  },

  onLoad() {
    this.loadSettings();
  },

  loadSettings() {
    // TODO: 从本地存储加载设置
    const settings = {
      defaultMode: 'continuous',
      defaultSpeed: 1,
      autoPlay: false
    };
    this.setData(settings);
  },

  saveSettings() {
    // TODO: 保存到本地存储
  },

  onModeChange(e) {
    const mode = e.detail.value;
    this.setData({ defaultMode: mode });
    this.saveSettings();
  },

  onSpeedChange(e) {
    const speed = e.detail.value;
    this.setData({ defaultSpeed: speed });
    this.saveSettings();
  },

  onAutoPlayChange(e) {
    const autoPlay = e.detail.value;
    this.setData({ autoPlay });
    this.saveSettings();
  },

  onClearCache() {
    tt.showModal({
      title: '提示',
      content: '确定要清空缓存吗？',
      success: (res) => {
        if (res.confirm) {
          // TODO: 清空缓存
          tt.showToast({
            title: '缓存已清空',
            icon: 'success'
          });
        }
      }
    });
  }
})
