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
    canvasSize: 0,
    // 绘图模式相关
    userStrokes: [],
    currentStroke: null,
    strokeColor: '#000000',
    strokeWidth: 4,
    strokeType: 'pen', // pen, pencil, marker, brush
    strokeTypes: [
      { key: 'pen', name: '钢笔', icon: '🖊️' },
      { key: 'pencil', name: '铅笔', icon: '✏️' },
      { key: 'marker', name: '马克笔', icon: '🖍️' },
      { key: 'brush', name: '毛笔', icon: '🖌️' }
    ],
    colorOptions: ['#E53935', '#1E88E5', '#43A047', '#FB8C00', '#8E24AA', '#000000']
  },

  canvasContext: null,
  canvas: null,
  canvasRect: null, // 存储 Canvas 位置信息

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
    const query = wx.createSelectorQuery().in(this);
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

          // 使用 setTimeout 确保 DOM 已完全渲染
          setTimeout(() => {
            const rectQuery = wx.createSelectorQuery().in(this);
            rectQuery.select('#drawingCanvas').boundingClientRect().exec((rectRes) => {
              if (rectRes[0]) {
                this.canvasRect = {
                  left: rectRes[0].left,
                  top: rectRes[0].top
                };
                console.log('Canvas rect:', this.canvasRect);
              }
            });
          }, 100);

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
          this.drawStroke(ctx, stroke, 1, '#333', false, scale);
        }
      }
      ctx.globalAlpha = 1;
    }

    // 绘制已完成步骤
    for (let i = 0; i < currentStep; i++) {
      for (const stroke of drawing.steps[i].strokes) {
        this.drawStroke(ctx, stroke, 1, '#000', false, scale);
      }
    }

    // 绘制当前步骤
    const currentStepData = drawing.steps[currentStep];
    if (currentStepData && currentStepData.strokes.length > 0) {
      const strokes = currentStepData.strokes;
      const totalStrokes = strokes.length;

      if (progress >= 1) {
        for (const stroke of strokes) {
          this.drawStroke(ctx, stroke, 1, '#000', false, scale);
        }
      } else {
        const strokesProgress = progress * totalStrokes;
        const completedStrokes = Math.floor(strokesProgress);
        const currentStrokeProgress = strokesProgress - completedStrokes;

        // 绘制已完成的笔画
        for (let i = 0; i < completedStrokes; i++) {
          this.drawStroke(ctx, strokes[i], 1, '#000', false, scale);
        }

        // 绘制当前正在绘制的笔画
        if (completedStrokes < totalStrokes) {
          const currentStroke = strokes[completedStrokes];
          if (currentStroke) {
            this.drawStroke(ctx, currentStroke, currentStrokeProgress, '#E53935', true, scale);
          }
        }
      }
    }

    // 用户笔画需要在变换后单独绘制（坐标已经是 CSS 像素，不需要再缩放）
    // 先恢复坐标系，再绘制用户笔画
    ctx.restore();

    // 绘制用户笔画（不使用 scale 变换，直接使用 CSS 像素坐标）
    for (const stroke of this.data.userStrokes) {
      this.drawUserStroke(ctx, stroke);
    }
    // 绘制当前正在绘制的笔画
    if (this.data.currentStroke && this.data.currentStroke.points.length >= 2) {
      this.drawUserStroke(ctx, this.data.currentStroke);
    }

    ctx.restore();
  },

  drawStroke(ctx, stroke, progress, color, isCurrent, userScale) {
    const points = stroke.points;
    if (points.length < 2) return;

    ctx.beginPath();
    ctx.strokeStyle = color;
    // 用户绘制的笔画：stroke.width 是 CSS 像素值
    // 原始图案的笔画：stroke.width 是 viewBox 中的值
    const isUserStroke = stroke.color !== undefined;
    if (isUserStroke) {
      // 用户笔画的宽度已经是 CSS 像素，但绘制时会被 scale 缩放，所以需要除以 scale
      ctx.lineWidth = stroke.width / userScale;
    } else {
      // 原始图案笔画按 viewBox 比例转换
      ctx.lineWidth = stroke.width / this.canvasWidth * 256;
    }
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

  // 绘制用户笔画（不使用 viewBox 变换，直接使用 CSS 像素坐标）
  drawUserStroke(ctx, stroke) {
    const points = stroke.points;
    if (points.length < 1) return;

    const color = stroke.color || '#E53935';
    const width = stroke.width || 4;
    const strokeType = stroke.type || 'pen';

    ctx.beginPath();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (points.length === 1) {
      // 单个点：绘制一个圆形
      const [x, y] = points[0];
      const radius = width / 2;

      if (strokeType === 'pencil') {
        // 铅笔：绘制不规则的小点
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.8;
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
        // 添加一些噪点效果
        for (let i = 0; i < 3; i++) {
          const angle = Math.random() * Math.PI * 2;
          const dist = Math.random() * radius * 0.5;
          const nx = x + Math.cos(angle) * dist;
          const ny = y + Math.sin(angle) * dist;
          ctx.beginPath();
          ctx.arc(nx, ny, radius * 0.3, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      } else if (strokeType === 'marker') {
        // 马克笔：绘制椭圆形（模拟斜头笔）
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.4;
        ctx.ellipse(x, y, radius * 1.5, radius, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      } else if (strokeType === 'brush') {
        // 毛笔：绘制有渐变效果的圆
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.6;
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
        gradient.addColorStop(0, color);
        gradient.addColorStop(1, color + '00'); // 透明
        ctx.fillStyle = gradient;
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      } else {
        // 钢笔：实心圆
        ctx.fillStyle = color;
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      // 多个点：绘制路径
      ctx.moveTo(points[0][0], points[0][1]);

      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i][0], points[i][1]);
      }

      if (strokeType === 'pencil') {
        // 铅笔：虚线效果
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.setLineDash([width, width / 2]);
        ctx.globalAlpha = 0.7;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      } else if (strokeType === 'marker') {
        // 马克笔：半透明粗线
        ctx.strokeStyle = color;
        ctx.lineWidth = width * 2;
        ctx.globalAlpha = 0.4;
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else if (strokeType === 'brush') {
        // 毛笔：渐变透明效果
        const gradient = ctx.createLinearGradient(
          points[0][0], points[0][1],
          points[points.length - 1][0], points[points.length - 1][1]
        );
        gradient.addColorStop(0, color + '40'); // 半透明
        gradient.addColorStop(1, color);
        ctx.strokeStyle = gradient;
        ctx.lineWidth = width * 1.5;
        ctx.globalAlpha = 0.6;
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else {
        // 钢笔：实线
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.stroke();
      }
    }
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
  },

  // ========== 绘图模式相关方法 ==========

  // 触摸开始
  onTouchStart(e) {
    if (!this.canvasRect) return;

    const touches = e.touches[0];
    if (touches) {
      const { strokeColor, strokeWidth, strokeType } = this.data;
      // 使用 clientX/clientY 获取触摸位置（相对于视口）
      const x = touches.clientX - this.canvasRect.left;
      const y = touches.clientY - this.canvasRect.top;

      this.setData({
        currentStroke: {
          points: [[x, y]],
          width: strokeWidth,
          color: strokeColor,
          type: strokeType
        }
      });
    }
  },

  // 触摸移动
  onTouchMove(e) {
    if (!this.data.currentStroke || !this.canvasRect) return;

    const touches = e.touches[0];
    if (touches) {
      const x = touches.clientX - this.canvasRect.left;
      const y = touches.clientY - this.canvasRect.top;

      const currentStroke = this.data.currentStroke;
      currentStroke.points.push([x, y]);
      this.setData({ currentStroke });
      this.draw();
    }
  },

  // 触摸结束
  onTouchEnd(e) {
    if (!this.data.currentStroke) return;

    const currentStroke = this.data.currentStroke;
    // 保存完成的笔画（即使只有一个点也保存）
    const userStrokes = [...this.data.userStrokes, currentStroke];
    this.setData({
      userStrokes,
      currentStroke: null
    });
    this.draw();
  },

  // 切换画笔类型
  onStrokeTypeSelect(e) {
    const strokeType = e.currentTarget.dataset.type;
    this.setData({ strokeType });
  },

  // 切换颜色
  onColorSelect(e) {
    const strokeColor = e.currentTarget.dataset.color;
    this.setData({ strokeColor });
  },

  // 切换笔画粗细
  onStrokeWidthSelect(e) {
    const strokeWidth = e.currentTarget.dataset.width;
    this.setData({ strokeWidth });
  },

  // 清除用户绘制
  onClearUserDrawings() {
    wx.showModal({
      title: '确认清除',
      content: '确定要清除所有绘制内容吗？',
      success: (res) => {
        if (res.confirm) {
          this.setData({
            userStrokes: [],
            currentStroke: null
          });
          this.draw();
          wx.showToast({
            title: '已清除',
            icon: 'success'
          });
        }
      }
    });
  },

  // 导出图片
  onExportDrawing() {
    if (!this.canvasContext || !this.canvas) return;

    wx.showLoading({ title: '导出中...' });

    // 先重新绘制一次确保所有内容都在
    this.draw();

    // 导出为图片
    this.canvas.toTempFilePath({
      x: 0,
      y: 0,
      width: this.canvasWidth,
      height: this.canvasHeight,
      destWidth: this.canvasWidth,
      destHeight: this.canvasHeight,
      success: (res) => {
        const tempFilePath = res.tempFilePath;

        // 保存到相册
        wx.saveImageToPhotosAlbum({
          filePath: tempFilePath,
          success: () => {
            wx.showToast({
              title: '已保存到相册',
              icon: 'success'
            });
          },
          fail: (err) => {
            console.error('保存失败:', err);
            wx.showToast({
              title: '保存失败',
              icon: 'none'
            });
          },
          complete: () => {
            wx.hideLoading();
          }
        });
      },
      fail: (err) => {
        console.error('导出失败:', err);
        wx.showToast({
          title: '导出失败',
          icon: 'none'
        });
        wx.hideLoading();
      }
    });
  },

  // 撤销上一笔
  onUndo() {
    const userStrokes = this.data.userStrokes.slice(0, -1);
    this.setData({ userStrokes });
    this.draw();
  }
})
