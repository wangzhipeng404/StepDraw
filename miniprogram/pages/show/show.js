// 计算两点之间的距离
function distance(p1, p2) {
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  return Math.sqrt(dx * dx + dy * dy);
}

// 计算一个笔画的总长度
function getStrokeLength(stroke) {
  const points = stroke.points;
  if (points.length < 2) return 0;

  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += distance(points[i - 1], points[i]);
  }
  return length;
}

// 计算一个步骤的总长度（所有笔画长度之和）
function getStepLength(step) {
  return step.strokes.reduce((sum, stroke) => sum + getStrokeLength(stroke), 0);
}

// 一笔一笔 StepDraw - 小程序展示模式页
// 长按分类卡片进入：页面没有任何按钮，进入后自动播放绘制动画（播放逻辑与详情页一致）
const config = require('../../config');

Page({
  data: {
    drawing: null,
    currentStep: 0,
    progress: 0,
    playing: false,
    speed: 1,
    totalSteps: 0,
    globalProgress: 0,
    canvasSize: 0
  },

  // 单层画布：只播放图案，没有用户绘制，不需要三层
  outlineCanvas: null,
  outlineCtx: null,
  canvasesReady: false,

  // 离屏缓存：轮廓底图（灰色全图案）、已完成步骤
  outlineCache: null,
  doneCache: null,

  onLoad(options) {
    const drawingId = options.id ? decodeURIComponent(options.id) : '';
    this.drawingId = drawingId; // 保存 drawingId 用于分享
    this.loadDrawing(drawingId);

    // 获取屏幕尺寸，计算 Canvas 大小（正方形）
    const systemInfo = wx.getSystemInfoSync();
    const rpxToPx = systemInfo.windowWidth / 750;

    // 容器 margin: 20rpx + padding: 20rpx，每边 40rpx，两边 80rpx
    const containerMargin = 80 * rpxToPx;
    const canvasSize = systemInfo.windowWidth - containerMargin;

    this.setData({
      canvasSize
    });
  },

  onReady() {
    const query = wx.createSelectorQuery().in(this);
    query.select('#outlineCanvas').fields({ node: true, size: true });
    query.exec((res) => {
      if (!res[0]) return;

      const canvas = res[0].node;
      // 小程序 Canvas 2D 直接使用 CSS 像素，不需要乘以 devicePixelRatio
      canvas.width = res[0].width;
      canvas.height = res[0].height;

      this.outlineCanvas = canvas;
      this.outlineCtx = canvas.getContext('2d');
      this.canvasWidth = res[0].width;
      this.canvasHeight = res[0].height;
      this.canvasesReady = true;

      // 数据已加载完成则立即绘制并开播
      if (this.data.drawing) {
        this.drawOutlineLayer();
        this.startAutoPlay();
      }
    });
  },

  loadDrawing(id) {
    wx.showLoading();
    wx.request({
      url: config.getDrawingUrl(id),
      success: (res) => {
        const drawing = res.data;
        wx.hideLoading();
        this.setData({
          drawing,
          totalSteps: drawing.steps.length,
          globalProgress: 0
        }, () => {
          // Canvas 已初始化则立即绘制并开播
          if (this.canvasesReady) {
            this.drawOutlineLayer();
            this.startAutoPlay();
          }
        });
      },
      fail: (err) => {
        wx.hideLoading();
        console.error('加载图案失败:', err);
        wx.showToast({
          title: '加载失败',
          icon: 'none'
        });
      }
    });
  },

  // 进入即自动播放（只触发一次，避免数据/画布就绪顺序不同导致重复开播）
  startAutoPlay() {
    if (this._autoPlayStarted) return;
    if (!this.data.drawing || !this.canvasesReady) return;
    this._autoPlayStarted = true;

    this.setData({ playing: true });
    this.startPlay();
  },

  // 获取画布变换矩阵（viewBox -> 画布 CSS 像素）
  getTransform() {
    const width = this.canvasWidth;
    const height = this.canvasHeight;
    const { viewBox } = this.data.drawing;

    const patternWidth = viewBox[2] - viewBox[0];
    const patternHeight = viewBox[3] - viewBox[1];
    const scale = Math.min(width / patternWidth, height / patternHeight);
    const offsetX = (width - patternWidth * scale) / 2 - viewBox[0] * scale;
    const offsetY = (height - patternHeight * scale) / 2 - viewBox[1] * scale;
    return { scale, offsetX, offsetY };
  },

  // 创建离屏画布
  createLayer() {
    return wx.createOffscreenCanvas({
      type: '2d',
      width: this.canvasWidth,
      height: this.canvasHeight
    });
  },

  // 重建已完成步骤的离屏缓存（只在步骤切换时调用）
  rebuildDoneCache() {
    if (!this.outlineCtx) return;
    const { drawing, currentStep } = this.data;
    const { scale, offsetX, offsetY } = this.getTransform();

    const cache = this.createLayer();
    const ctx = cache.getContext('2d');
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);
    for (let i = 0; i < currentStep; i++) {
      for (const stroke of drawing.steps[i].strokes) {
        this.drawStroke(ctx, stroke, 1, '#000', false, scale);
      }
    }
    ctx.restore();
    this.doneCache = cache;
  },

  // 重建轮廓底图的离屏缓存（展示模式轮廓常显，构建一次即可）
  rebuildOutlineCache() {
    if (!this.outlineCtx) return;
    const { drawing } = this.data;
    const { scale, offsetX, offsetY } = this.getTransform();

    const cache = this.createLayer();
    const ctx = cache.getContext('2d');
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);
    ctx.globalAlpha = 0.15;
    for (const step of drawing.steps) {
      for (const stroke of step.strokes) {
        this.drawStroke(ctx, stroke, 1, '#333', false, scale);
      }
    }
    ctx.restore();
    this.outlineCache = cache;
  },

  // 绘制图案层（轮廓底图 + 已完成步骤 + 当前动画笔画）
  // 性能要点：静态内容走离屏缓存，每帧只在缓存间 drawImage 一次全图 + 一笔动画笔画
  drawOutlineLayer() {
    if (!this.outlineCtx || !this.data.drawing) return;

    const { drawing, currentStep, progress } = this.data;
    const ctx = this.outlineCtx;

    // 失效检查：步骤变化后重建静态缓存
    if (this.doneCache === null || this._doneStep !== currentStep) {
      this.rebuildDoneCache();
      this._doneStep = currentStep;
    }
    if (!this._outlineBuilt) {
      this.rebuildOutlineCache();
      this._outlineBuilt = true;
    }

    ctx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
    if (this.outlineCache) ctx.drawImage(this.outlineCache, 0, 0);
    if (this.doneCache) ctx.drawImage(this.doneCache, 0, 0);

    // 当前步骤的动画部分
    const { scale, offsetX, offsetY } = this.getTransform();
    const currentStepData = drawing.steps[currentStep];
    if (!currentStepData || currentStepData.strokes.length === 0) return;

    const strokes = currentStepData.strokes;
    const totalStrokes = strokes.length;
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);

    if (progress >= 1) {
      for (const stroke of strokes) {
        this.drawStroke(ctx, stroke, 1, '#000', false, scale);
      }
    } else {
      const strokesProgress = progress * totalStrokes;
      const completedStrokes = Math.floor(strokesProgress);
      const currentStrokeProgress = strokesProgress - completedStrokes;

      // 绘制当前步骤内已完成的笔画
      for (let i = 0; i < completedStrokes; i++) {
        this.drawStroke(ctx, strokes[i], 1, '#000', false, scale);
      }

      // 绘制当前正在动画的笔画
      if (completedStrokes < totalStrokes) {
        const currentStroke = strokes[completedStrokes];
        if (currentStroke) {
          this.drawStroke(ctx, currentStroke, currentStrokeProgress, config.PLAY_STROKE_COLOR, true, scale);
        }
      }
    }
    ctx.restore();
  },

  drawStroke(ctx, stroke, progress, color, isCurrent, userScale) {
    const points = stroke.points;
    if (points.length < 2) return;

    ctx.beginPath();
    ctx.strokeStyle = color;
    // 原始图案笔画按 viewBox 比例转换
    ctx.lineWidth = stroke.width / this.canvasWidth * 256;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (isCurrent && progress < 1) {
      // 进度为 0 时不绘制（零长度线段 + round 线帽会画出一个起点圆点）
      if (progress <= 0) return;

      // 按进度绘制（基于长度而非点数）
      const totalLength = this.getStrokeLength(points);
      if (totalLength === 0) return;

      const targetLength = progress * totalLength;
      let accumulatedLength = 0;

      ctx.moveTo(points[0][0], points[0][1]);

      for (let i = 1; i < points.length; i++) {
        const dx = points[i][0] - points[i - 1][0];
        const dy = points[i][1] - points[i - 1][1];
        const segmentLength = Math.sqrt(dx * dx + dy * dy);

        if (accumulatedLength + segmentLength >= targetLength) {
          // 插值当前线段
          const remaining = targetLength - accumulatedLength;
          const segmentProgress = remaining / segmentLength;
          ctx.lineTo(
            points[i - 1][0] + (points[i][0] - points[i - 1][0]) * segmentProgress,
            points[i - 1][1] + (points[i][1] - points[i - 1][1]) * segmentProgress
          );
          break;
        }
        ctx.lineTo(points[i][0], points[i][1]);
        accumulatedLength += segmentLength;
      }
    } else {
      // 完整绘制
      ctx.moveTo(points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i][0], points[i][1]);
      }
    }

    ctx.stroke();
  },

  // 计算笔画的总长度
  getStrokeLength(points) {
    if (points.length < 2) return 0;

    let length = 0;
    for (let i = 1; i < points.length; i++) {
      const dx = points[i][0] - points[i - 1][0];
      const dy = points[i][1] - points[i - 1][1];
      length += Math.sqrt(dx * dx + dy * dy);
    }
    return length;
  },

  // 播放逻辑与详情页一致：按步骤笔画长度匀速绘制
  startPlay() {
    const { speed, drawing } = this.data;

    // 计算所有步骤的总长度
    const stepLengths = drawing.steps.map(step => getStepLength(step));

    // 基础速度：每秒绘制 100 像素
    const basePixelsPerSecond = 100;
    const interval = 50; // 50ms 间隔
    const pixelsPerInterval = (basePixelsPerSecond / speed) * (interval / 1000);

    this.playTimer = setInterval(() => {
      const { currentStep, progress, totalSteps } = this.data;
      const currentStepLength = stepLengths[currentStep] || 1;

      if (progress < 1) {
        // 根据当前步骤长度计算进度增量
        const progressIncrement = pixelsPerInterval / currentStepLength;
        const newProgress = progress + progressIncrement;

        if (newProgress >= 1) {
          // 当前步骤完成
          if (currentStep < totalSteps - 1) {
            this.setData({
              currentStep: currentStep + 1,
              progress: 0,
              globalProgress: (currentStep + 1) / totalSteps
            });
          } else {
            // 全部完成
            this.setData({
              progress: 1,
              globalProgress: 1
            });
          }
        } else {
          // 计算全局进度：已完成步骤 + 当前步骤进度
          const globalProgress = (currentStep + newProgress) / totalSteps;
          this.setData({ progress: newProgress, globalProgress });
        }
        this.drawOutlineLayer();
      } else if (currentStep < totalSteps - 1) {
        this.setData({
          currentStep: currentStep + 1,
          progress: 0,
          globalProgress: (currentStep + 1) / totalSteps
        });
        this.drawOutlineLayer();
      } else {
        // 播放结束
        this.setData({ playing: false });
        clearInterval(this.playTimer);
      }
    }, interval);
  },

  // 分享给朋友：封面用图案封面图，跳回展示页
  onShareAppMessage() {
    const { drawing } = this.data;
    const drawingId = this.drawingId || '';
    return {
      title: drawing ? `我发现一个宝藏小程序 Step Draw，一起来看${drawing.name}怎么画！` : '我发现一个宝藏小程序 Step Draw，一起来画画吧',
      // id 含多级路径（如 quickdraw/cat/xxx），必须整体编码，否则微信分享会按 / 截断
      path: `/pages/show/show?id=${encodeURIComponent(drawingId)}`,
      imageUrl: drawing && drawing.thumbnail ? config.getAssetUrl(drawing.thumbnail) : undefined
    };
  },

  // 分享到朋友圈（与分享朋友圈要求一致：带封面图）
  onShareTimeline() {
    const { drawing } = this.data;
    const drawingId = this.drawingId || '';
    return {
      title: drawing ? `我发现一个宝藏小程序 Step Draw，一起来看${drawing.name}怎么画！` : '我发现一个宝藏小程序 Step Draw，一起来画画吧',
      query: `id=${encodeURIComponent(drawingId)}`,
      imageUrl: drawing && drawing.thumbnail ? config.getAssetUrl(drawing.thumbnail) : undefined
    };
  },

  onUnload() {
    if (this.playTimer) {
      clearInterval(this.playTimer);
    }
  }
})
