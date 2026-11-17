// 一笔一笔 StepDraw - 小程序全局变量
App({
  onLaunch() {
    // 初始化
  },

  globalData: {
    favorites: [],
    settings: {
      defaultMode: 'continuous', // continuous | discrete
      defaultSpeed: 1, // 0.5 | 1 | 2
      autoPlay: false
    }
  }
})
