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

// 一笔一笔 StepDraw - 小程序详情页
const config = require('../../config');

Page({
  data: {
    drawing: null,
    currentStep: 0,
    progress: 0,
    playing: false,
    speed: 1,
    speedIndex: 1,
    speedText: '1',
    showOutline: true,
    totalSteps: 0,
    globalProgress: 0,
    canvasSize: 0
  },

  canvasContext: null,
  canvas: null,

  onLoad(options) {
    const drawingId = options.id;
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
    // 初始化 Canvas 2D 接口
    const query = wx.createSelectorQuery();
    query.select('#drawingCanvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (res[0]) {
          const canvas = res[0].node;
          const ctx = canvas.getContext('2d');

          const canvasWidth = res[0].width;
          const canvasHeight = res[0].height;

          // 小程序 Canvas 2D 直接使用 CSS 像素，不需要乘以 devicePixelRatio
          canvas.width = canvasWidth;
          canvas.height = canvasHeight;

          this.canvasContext = ctx;
          this.canvas = canvas;
          this.canvasWidth = canvasWidth;
          this.canvasHeight = canvasHeight;

          // 加载完成后绘制
          if (this.data.drawing) {
            this.draw();
          }
        }
      });
  },

  loadDrawing(id) {
    try {
      const [categoryId, drawingId] = id.split('/');

      wx.request({
        url: config.getDrawingUrl(id),
        success: (res) => {
          const drawing = res.data;

          this.setData({
            drawing,
            totalSteps: drawing.steps.length,
            globalProgress: 0
          }, () => {
            // 如果 Canvas 已初始化，立即绘制
            if (this.canvasContext) {
              this.draw();
            }
          });

          // 设置导航栏标题为当前图案名称
          wx.setNavigationBarTitle({
            title: drawing.name || '图案详情'
          });
        },
        fail: (err) => {
          console.error('加载图案失败:', err);
          wx.showToast({
            title: '加载失败',
            icon: 'none'
          });
        }
      });
    } catch (err) {
      console.error('加载图案失败:', err);
      wx.showToast({
        title: '加载失败',
        icon: 'none'
      });
    }
  },

  draw() {
    if (!this.canvasContext || !this.data.drawing) return;

    const { drawing, currentStep, progress, showOutline } = this.data;
    const ctx = this.canvasContext;
    const { viewBox } = drawing;

    // 使用查询到的 Canvas CSS 尺寸
    const width = this.canvasWidth;
    const height = this.canvasHeight;

    // 清空画布（使用 CSS 尺寸）
    ctx.clearRect(0, 0, width, height);

    // 计算缩放比例（填满画布）
    const patternWidth = viewBox[2] - viewBox[0];
    const patternHeight = viewBox[3] - viewBox[1];
    const scale = Math.min(
      width / patternWidth,
      height / patternHeight
    );

    const offsetX = (width - patternWidth * scale) / 2 - viewBox[0] * scale;
    const offsetY = (height - patternHeight * scale) / 2 - viewBox[1] * scale;

    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);

    // 如果显示轮廓底图，先绘制完整图案
    if (showOutline) {
      ctx.globalAlpha = 0.15;
      for (const step of drawing.steps) {
        for (const stroke of step.strokes) {
          this.drawStroke(ctx, stroke, 1, '#333', false);
        }
      }
      ctx.globalAlpha = 1;
    }

    // 绘制已完成步骤
    for (let i = 0; i < currentStep; i++) {
      for (const stroke of drawing.steps[i].strokes) {
        this.drawStroke(ctx, stroke, 1, '#000', false);
      }
    }

    // 绘制当前步骤
    const currentStepData = drawing.steps[currentStep];
    if (currentStepData && currentStepData.strokes.length > 0) {
      const strokes = currentStepData.strokes;
      const totalStrokes = strokes.length;

      if (progress >= 1) {
        for (const stroke of strokes) {
          this.drawStroke(ctx, stroke, 1, '#000', false);
        }
      } else {
        const strokesProgress = progress * totalStrokes;
        const completedStrokes = Math.floor(strokesProgress);
        const currentStrokeProgress = strokesProgress - completedStrokes;

        // 绘制已完成的笔画
        for (let i = 0; i < completedStrokes; i++) {
          this.drawStroke(ctx, strokes[i], 1, '#000', false);
        }

        // 绘制当前正在绘制的笔画
        if (completedStrokes < totalStrokes) {
          const currentStroke = strokes[completedStrokes];
          if (currentStroke) {
            this.drawStroke(ctx, currentStroke, currentStrokeProgress, '#E53935', true);
          }
        }
      }
    }

    ctx.restore();
  },

  drawStroke(ctx, stroke, progress, color, isCurrent) {
    const points = stroke.points;
    if (points.length < 2) return;

    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = stroke.width / this.canvasWidth * 256; // 按 viewBox 比例调整线宽
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (isCurrent && progress < 1) {
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

  onPrevStep() {
    const { currentStep, progress } = this.data;
    if (progress > 0) {
      this.setData({ progress: 0 });
    } else if (currentStep > 0) {
      this.setData({
        currentStep: currentStep - 1,
        progress: 0,
        globalProgress: (currentStep - 1) / this.data.totalSteps
      });
    }
    this.draw();
  },

  onNextStep() {
    const { currentStep, progress, totalSteps } = this.data;
    if (progress < 1) {
      this.setData({ progress: 1 });
      this.draw();
    } else if (currentStep < totalSteps - 1) {
      this.setData({
        currentStep: currentStep + 1,
        progress: 0,
        globalProgress: (currentStep + 1) / totalSteps
      });
      this.draw();
    }
  },

  onReset() {
    this.setData({ currentStep: 0, progress: 0, playing: false, globalProgress: 0 });
    this.draw();
  },

  onTogglePlay() {
    const { currentStep, progress, totalSteps, playing } = this.data;

    // 如果已全部绘制完成，点击播放则重新开始
    if (!playing && currentStep === totalSteps - 1 && progress >= 1) {
      this.setData({
        currentStep: 0,
        progress: 0,
        globalProgress: 0,
        playing: true
      });
      this.draw();
      this.startPlay();
      return;
    }

    const newPlaying = !playing;
    this.setData({ playing: newPlaying });

    if (newPlaying) {
      this.startPlay();
    } else {
      // 暂停时清除定时器
      if (this.playTimer) {
        clearInterval(this.playTimer);
        this.playTimer = null;
      }
    }
  },

  startPlay() {
    const { speed, loopCurrentStep, drawing } = this.data;

    // 计算所有步骤的总长度
    const stepLengths = drawing.steps.map(step => getStepLength(step));
    const totalLength = stepLengths.reduce((sum, len) => sum + len, 0);

    // 基础速度：每秒绘制 100 像素
    const basePixelsPerSecond = 100;
    const interval = 50; // 50ms 间隔
    const pixelsPerInterval = (basePixelsPerSecond / speed) * (interval / 1000);

    this.playTimer = setInterval(() => {
      const { currentStep, progress, totalSteps } = this.data;
      const currentStepLength = stepLengths[currentStep] || 1;

      if (progress < 1) {
        // 根据当前步骤长度计算进度增量
        // 步骤越长，每次增加的进度越小
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
        this.draw();
      } else if (currentStep < totalSteps - 1) {
        this.setData({
          currentStep: currentStep + 1,
          progress: 0,
          globalProgress: (currentStep + 1) / totalSteps
        });
        this.draw();
      } else {
        // 播放结束
        this.setData({ playing: false });
        clearInterval(this.playTimer);
      }
    }, interval);
  },

  onSpeedChange(e) {
    const speeds = [0.5, 1, 2];
    const speedIndex = (this.data.speedIndex + 1) % speeds.length;
    this.setData({
      speedIndex,
      speed: speeds[speedIndex],
      speedText: speeds[speedIndex]
    });
  },

  onToggleOutline() {
    this.setData({ showOutline: !this.data.showOutline });
    this.draw();
  },

  onProgressChange(e) {
    const globalProgress = e.detail.value;
    const { totalSteps } = this.data;
    const step = Math.min(Math.floor(globalProgress * totalSteps), totalSteps - 1);
    const stepProgress = globalProgress - (step / totalSteps);

    this.setData({
      currentStep: step,
      progress: stepProgress * totalSteps,
      globalProgress
    });
    this.draw();
  },

  onStepTap(e) {
    const step = e.currentTarget.dataset.step;
    this.setData({
      currentStep: step,
      progress: 0,
      playing: false,
      globalProgress: step / this.data.totalSteps
    });
    this.draw();

    if (this.playTimer) {
      clearInterval(this.playTimer);
    }
  },

  onUnload() {
    if (this.playTimer) {
      clearInterval(this.playTimer);
    }
  },

  /**
   * 分享给朋友
   */
  onShareAppMessage() {
    const { drawing } = this.data;
    const drawingId = this.data.drawingId || '';

    return {
      title: drawing ? `一起来画${drawing.name}吧！` : '一笔一笔 StepDraw',
      path: `/pages/detail/detail?id=${drawingId}`,
      imageUrl: drawing && drawing.thumbnail ? config.getAssetUrl(drawing.thumbnail) : undefined
    };
  },

  /**
   * 分享到朋友圈
   */
  onShareTimeline() {
    const { drawing } = this.data;
    const drawingId = this.data.drawingId || '';

    return {
      title: drawing ? `一起来画${drawing.name}吧！` : '一笔一笔 StepDraw',
      query: `id=${drawingId}`,
      imageUrl: drawing && drawing.thumbnail ? config.getAssetUrl(drawing.thumbnail) : undefined
    };
  }
})
