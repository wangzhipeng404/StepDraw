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
    strokeColor: '#000000',
    strokeWidth: 4,
    strokeType: 'pen', // pen, pencil, marker, brush
    strokeTypes: [
      { key: 'pen', name: '钢笔', icon: '🖊️' },
      { key: 'pencil', name: '铅笔', icon: '✏️' },
      { key: 'marker', name: '马克笔', icon: '🖍️' },
      { key: 'brush', name: '毛笔', icon: '🖌️' }
    ],
    colorOptions: ['#E53935', '#1E88E5', '#43A047', '#FB8C00', '#8E24AA', '#000000'],
    // 自定义颜色弹层
    showColorPicker: false,
    isCustomColor: false, // 当前颜色是否为自定义（不在预设色板中）
    // 自定义画笔粗细（滑动条）
    isCustomWidth: false, // 当前粗细是否为自定义（不在预设档位中）
    presetWidths: [2, 4, 6, 8, 12],
    minWidth: 1,
    maxWidth: 40
  },

  // ========== 三层画布 ==========
  // 底层 outlineCanvas：JSON 图案数据（轮廓底图 + 已完成步骤 + 当前动画步骤）
  // 中层 historyCanvas：用户已完成的笔画（增量绘制，仅撤销/清除时重建）
  // 顶层 brushCanvas：当前正在绘制的笔画（每帧重画，但只有一笔）
  // 只有导出时才会把三层合并
  outlineCanvas: null,
  outlineCtx: null,
  historyCanvas: null,
  historyCtx: null,
  brushCanvas: null,
  brushCtx: null,
  canvasesReady: false,
  canvasRect: null, // 存储 Canvas 位置信息

  // 离屏缓存：轮廓底图（灰色全图案）、已完成步骤
  outlineCache: null,
  doneCache: null,

  // 用户笔画放在实例上，避免每次触摸都走 setData 序列化
  userStrokes: [],
  currentStroke: null,

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
    // 初始化三层 Canvas 2D 接口（底层 JSON 图案 / 中层用户历史 / 顶层当前画笔）
    const query = wx.createSelectorQuery().in(this);
    query.select('#outlineCanvas').fields({ node: true, size: true });
    query.select('#historyCanvas').fields({ node: true });
    query.select('#brushCanvas').fields({ node: true, size: true });
    query.exec((res) => {
      if (!res[0]) return;

      const initLayer = (canvas, sizeRes) => {
        const width = sizeRes ? sizeRes.width : res[0].width;
        const height = sizeRes ? sizeRes.height : res[0].height;
        // 小程序 Canvas 2D 直接使用 CSS 像素，不需要乘以 devicePixelRatio
        canvas.width = width;
        canvas.height = height;
        return { canvas, ctx: canvas.getContext('2d') };
      };

      const outline = initLayer(res[0].node, res[0]);
      const history = res[1] ? initLayer(res[1].node, res[0]) : null;
      const brush = res[2] ? initLayer(res[2].node, res[0]) : null;

      this.outlineCanvas = outline.canvas;
      this.outlineCtx = outline.ctx;
      if (history) {
        this.historyCanvas = history.canvas;
        this.historyCtx = history.ctx;
      }
      if (brush) {
        this.brushCanvas = brush.canvas;
        this.brushCtx = brush.ctx;
      }
      this.canvasWidth = res[0].width;
      this.canvasHeight = res[0].height;
      // 兼容旧导出逻辑
      this.canvasContext = this.outlineCtx;
      this.canvas = this.outlineCanvas;

      // 使用 setTimeout 确保 DOM 已完全渲染
      setTimeout(() => {
        const rectQuery = wx.createSelectorQuery().in(this);
        rectQuery.select('#outlineCanvas').boundingClientRect().exec((rectRes) => {
          if (rectRes[0]) {
            this.canvasRect = {
              left: rectRes[0].left,
              top: rectRes[0].top
            };
            console.log('Canvas rect:', this.canvasRect);
          }
        });
      }, 100);

      this.canvasesReady = true;
      this._historyCount = 0;

      // 加载完成后绘制
      if (this.data.drawing) {
        this.drawOutlineLayer();
      }
    });
  },

  loadDrawing(id) {
    wx.showLoading()
    try {
      const [categoryId, drawingId] = id.split('/');

      wx.request({
        url: config.getDrawingUrl(id),
        success: (res) => {
          const drawing = res.data;
          wx.hideLoading()
          this.setData({
            drawing,
            totalSteps: drawing.steps.length,
            globalProgress: 0
          }, () => {
            // 如果 Canvas 已初始化，立即绘制
            if (this.canvasesReady) {
              this.drawOutlineLayer();
            }
          });

          // 设置导航栏标题为当前图案名称
          wx.setNavigationBarTitle({
            title: drawing.name || '图案详情'
          });
        },
        fail: (err) => {
          wx.hideLoading()
          console.error('加载图案失败:', err);
          wx.showToast({
            title: '加载失败',
            icon: 'none'
          });
        }
      });
    } catch (err) {
      wx.hideLoading()
      console.error('加载图案失败:', err);
      wx.showToast({
        title: '加载失败',
        icon: 'none'
      });
    }
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

  // 重建轮廓底图的离屏缓存（切换轮廓显隐时调用）
  rebuildOutlineCache() {
    if (!this.outlineCtx) return;
    const { drawing, showOutline } = this.data;
    if (!showOutline) {
      this.outlineCache = null;
      return;
    }
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

  // 底层：绘制 JSON 图案数据（轮廓底图 + 已完成步骤 + 当前动画笔画）
  // 性能要点：静态内容走离屏缓存，每帧只在缓存间 drawImage 一次全图 + 一笔动画笔画
  drawOutlineLayer() {
    if (!this.outlineCtx || !this.data.drawing) return;

    const { drawing, currentStep, progress } = this.data;
    const ctx = this.outlineCtx;
    const width = this.canvasWidth;
    const height = this.canvasHeight;

    // 失效检查：步骤或轮廓设置变化后重建静态缓存
    if (this.doneCache === null || this._doneStep !== currentStep) {
      this.rebuildDoneCache();
      this._doneStep = currentStep;
    }
    if (this._outlineKey !== this.data.showOutline) {
      this.rebuildOutlineCache();
      this._outlineKey = this.data.showOutline;
    }

    ctx.clearRect(0, 0, width, height);
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
          this.drawStroke(ctx, currentStroke, currentStrokeProgress, '#E53935', true, scale);
        }
      }
    }
    ctx.restore();
  },

  // 中层：用户已完成的笔画
  // 增量绘制：新笔画只追加；撤销/清除时才整体重建
  drawHistoryLayer() {
    if (!this.historyCtx) return;
    const width = this.canvasWidth;
    const height = this.canvasHeight;
    const strokes = this.userStrokes;

    if (strokes.length > this._historyCount) {
      // 增量：只画新增的笔画
      for (let i = this._historyCount; i < strokes.length; i++) {
        this.drawUserStroke(this.historyCtx, strokes[i]);
      }
    } else {
      // 笔画数减少（撤销/清除）：整体重建
      this.historyCtx.clearRect(0, 0, width, height);
      for (const stroke of strokes) {
        this.drawUserStroke(this.historyCtx, stroke);
      }
    }
    this._historyCount = strokes.length;
  },

  // 顶层：当前正在绘制的笔画（每帧重画，但只有一笔，开销很小）
  drawBrushLayer() {
    if (!this.brushCtx) return;
    const width = this.canvasWidth;
    const height = this.canvasHeight;
    this.brushCtx.clearRect(0, 0, width, height);

    const stroke = this.currentStroke;
    if (stroke && stroke.points.length >= 1) {
      this.drawUserStroke(this.brushCtx, stroke);
    }
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
    this.drawOutlineLayer();
  },

  onNextStep() {
    const { currentStep, progress, totalSteps } = this.data;
    if (progress < 1) {
      this.setData({ progress: 1 });
      this.drawOutlineLayer();
    } else if (currentStep < totalSteps - 1) {
      this.setData({
        currentStep: currentStep + 1,
        progress: 0,
        globalProgress: (currentStep + 1) / totalSteps
      });
      this.drawOutlineLayer();
    }
  },

  onReset() {
    this.setData({ currentStep: 0, progress: 0, playing: false, globalProgress: 0 });
    this.drawOutlineLayer();
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
      this.drawOutlineLayer();
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
    this.drawOutlineLayer();
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
    this.drawOutlineLayer();
  },

  onStepTap(e) {
    const step = e.currentTarget.dataset.step;
    this.setData({
      currentStep: step,
      progress: 0,
      playing: false,
      globalProgress: step / this.data.totalSteps
    });
    this.drawOutlineLayer();

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
    const drawingId = this.drawingId || '';

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
    const drawingId = this.drawingId || '';

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

      // 当前笔画放实例上（不进 data），避免每帧 setData 序列化
      this.currentStroke = {
        points: [[x, y]],
        width: strokeWidth,
        color: strokeColor,
        type: strokeType
      };
      this.drawBrushLayer();
    }
  },

  // 触摸移动
  onTouchMove(e) {
    if (!this.currentStroke || !this.canvasRect) return;

    const touches = e.touches[0];
    if (touches) {
      const x = touches.clientX - this.canvasRect.left;
      const y = touches.clientY - this.canvasRect.top;

      // 追加坐标点，只重画顶层（当前一笔），不动底层/中层
      this.currentStroke.points.push([x, y]);
      this.drawBrushLayer();
    }
  },

  // 触摸结束
  onTouchEnd(e) {
    if (!this.currentStroke) return;

    const stroke = this.currentStroke;
    this.currentStroke = null;

    // 完成的笔画加入历史（实例上），增量绘制到中层，清空顶层
    this.userStrokes.push(stroke);
    this.drawHistoryLayer();
    this.drawBrushLayer();
  },

  // 切换画笔类型
  onStrokeTypeSelect(e) {
    const strokeType = e.currentTarget.dataset.type;
    this.setData({ strokeType });
  },

  // 切换颜色
  onColorSelect(e) {
    const strokeColor = e.currentTarget.dataset.color;
    const isCustomColor = !this.data.colorOptions.includes(strokeColor);
    this.setData({ strokeColor, isCustomColor });
  },

  // 打开自定义颜色弹层
  onCustomColorTap() {
    // 记录打开前的颜色，取消时可回退
    this._prevColor = this.data.strokeColor;
    const prevColor = this.data.strokeColor;
    const isCustomColor = !this.data.colorOptions.includes(prevColor);
    this.setData({ showColorPicker: true, isCustomColor });

    // 等弹层滑入动画结束后，重新测量 SV/色相条位置（组件初始在屏外，测量会偏差）
    setTimeout(() => {
      const cp = this.selectComponent('#colorPicker');
      if (cp && cp.measure) cp.measure();
    }, 320);
  },

  // 取消：回退到打开前的颜色
  onCancelColorPicker() {
    const prevColor = this._prevColor || this.data.strokeColor;
    const isCustomColor = !this.data.colorOptions.includes(prevColor);
    this.setData({
      showColorPicker: false,
      strokeColor: prevColor,
      isCustomColor
    });
  },

  // 颜色实时变化（组件内拖动/输入时触发，实时预览到画笔）
  onColorPickerChange(e) {
    const hex = e.detail.hex;
    this.setData({ strokeColor: hex, isCustomColor: true });
  },

  // 确定选择自定义颜色
  onConfirmColorPicker() {
    this.setData({ showColorPicker: false });
  },

  // 切换笔画粗细
  onStrokeWidthSelect(e) {
    const strokeWidth = Number(e.currentTarget.dataset.width);
    const isCustomWidth = !this.data.presetWidths.includes(strokeWidth);
    this.setData({ strokeWidth, isCustomWidth });
  },

  // 滑动条调整粗细（拖动中 bindchanging 与结束时 bindchange 都会触发，更新预览）
  onWidthSliderChange(e) {
    const strokeWidth = Number(e.detail.value);
    const isCustomWidth = !this.data.presetWidths.includes(strokeWidth);
    this.setData({ strokeWidth, isCustomWidth });
  },

  // 清除用户绘制
  onClearUserDrawings() {
    wx.showModal({
      title: '确认清除',
      content: '确定要清除所有绘制内容吗？',
      success: (res) => {
        if (res.confirm) {
          this.userStrokes = [];
          this.currentStroke = null;
          this._historyCount = 0;
          this.drawHistoryLayer();
          this.drawBrushLayer();
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
    if (!this.canvasContext || !this.canvas) {
      wx.showToast({
        title: 'Canvas 未初始化',
        icon: 'none'
      });
      return;
    }

    if (!this.data.drawing) {
      wx.showToast({
        title: '暂无图案内容',
        icon: 'none'
      });
      return;
    }

    wx.showLoading({ title: '导出中...' });

    // 合并三层画布导出
    // 等待一小段时间确保绘制完成
    setTimeout(() => {
      try {
        // 创建离屏 2D canvas 实例（尺寸与画布相同），用于合并
        const offscreenCanvas = wx.createOffscreenCanvas({
          type: '2d',
          width: this.canvasWidth,
          height: this.canvasHeight
        });
        const offscreenCtx = offscreenCanvas.getContext('2d');

        // 填充白色背景
        offscreenCtx.fillStyle = '#FFFFFF';
        offscreenCtx.fillRect(0, 0, this.canvasWidth, this.canvasHeight);

        // 按层序合成：底层 JSON 图案 -> 中层用户历史 -> 顶层当前笔画
        if (this.outlineCanvas) offscreenCtx.drawImage(this.outlineCanvas, 0, 0);
        if (this.historyCanvas) offscreenCtx.drawImage(this.historyCanvas, 0, 0);
        if (this.brushCanvas) offscreenCtx.drawImage(this.brushCanvas, 0, 0);

        // 使用 wx.getImageInfo 加载 Logo 图片
        const logoPath = `${config.BASE_URL}/../stepdraw.png`;

        wx.getImageInfo({
          src: logoPath,
          success: (info) => {
            const logoImage = offscreenCanvas.createImage();
            logoImage.src = info.path;

            logoImage.onload = () => {
              // 绘制小 Logo（右下角）
              const logoSize = this.canvasWidth * 0.1;
              const margin = this.canvasWidth * 0;
              const logoX = this.canvasWidth - logoSize - margin;
              const logoY = this.canvasHeight - logoSize - margin;

              offscreenCtx.drawImage(logoImage, logoX, logoY, logoSize, logoSize);

              this.exportCanvas(offscreenCanvas);
            };

            logoImage.onerror = () => {
              this.exportCanvas(offscreenCanvas);
            };
          },
          fail: () => {
            this.exportCanvas(offscreenCanvas);
          }
        });
      } catch (err) {
        console.error('导出异常:', err);
        wx.showToast({
          title: '导出失败',
          icon: 'none'
        });
        wx.hideLoading();
      }
    }, 100);
  },

  // 导出 Canvas 为图片的辅助方法
  exportCanvas(offscreenCanvas) {
    wx.canvasToTempFilePath({
      canvas: offscreenCanvas,
      x: 0,
      y: 0,
      width: this.canvasWidth,
      height: this.canvasHeight,
      destWidth: this.canvasWidth,
      destHeight: this.canvasHeight,
      success: (res) => {
        if (res && res.tempFilePath) {
          wx.saveImageToPhotosAlbum({
            filePath: res.tempFilePath,
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
        }
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
    if (this.userStrokes.length === 0) return;
    this.userStrokes.pop();
    // 笔画数减少，drawHistoryLayer 会自动重建中层
    this.drawHistoryLayer();
  }
})
