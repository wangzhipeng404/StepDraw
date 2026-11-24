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
// 入口一：长按分类卡片（?id=xxx），进入即自动播放绘制动画
// 入口二：详情页"放映"按钮，globalData.replayPayload 携带 {drawing, userActions, id}，
//         先播放参考图案，再按时间序回放用户内容（phase 2）：
//         笔画按弧长生长，填充直接填入（无生长动画），填充垫在图案黑线之下
const config = require('../../config');
const { tintMask } = require('../../utils/fill');

Page({
  data: {
    drawing: null,
    currentStep: 0,
    progress: 0,
    playing: false,
    speed: 0.5,
    totalSteps: 0,
    globalProgress: 0,
    canvasSize: 0,
    // 轮廓默认隐藏，双击画布切换显示
    showOutline: false,
    // 用户是否画过（放映回放模式下决定是否在图案播完后接用户内容回放）
    hasUserStrokes: false,
    // 用户内容回放阶段的提示文案（非空时覆盖右下角步骤提示）
    phaseText: ''
  },

  // 单层画布：只播放图案，没有用户绘制，不需要三层
  outlineCanvas: null,
  outlineCtx: null,
  canvasesReady: false,

  // 离屏缓存：轮廓底图（灰色全图案）、已完成步骤
  outlineCache: null,
  doneCache: null,

  // ========== 用户内容回放（放映模式，phase 2） ==========
  // 按详情页 userActions 的时间序回放：笔画按弧长生长，填充直接填入（无生长动画）。
  // 逐帧状态放实例字段，不进 data（不需要驱动视图，省 setData）
  userActions: [],    // 时间序混排 {kind:'stroke',stroke} | {kind:'fill',fill}
  userIndex: 0,       // 下一个要回放的 action 下标
  userProgress: 0,    // 当前笔画的弧长进度 0~1（填充没有进度，直接出现）
  _phase: 'pattern',  // 'pattern' 播放图案 | 'user' 回放用户内容 | 'done' 全部结束
  _fillTintCache: {}, // fill.key -> 上色后的位图（tintMask 开销大，每个填充只算一次）
  // 放映上限：从 detail 进入时 = 详情页播放到的步骤下标，图案动画播到该步即止
  // （不提前露出未播步骤）；长按卡片进入 = null，无上限
  _patternEndStep: null,

  // ========== 隐藏彩蛋：下拉保存视频（Canvas 2D 画面录制，基础库 2.11.0+） ==========
  // 触发方式：页面下拉 -> 弹确认框 -> 确认后从头重播并同步录制 outlineCanvas，
  // 播完自动 stop 存相册。无按钮、无入口，纯隐藏功能。
  _recorder: null,
  _recording: false,     // start() 后为 true；一旦请求 stop() 立刻置 false（兼作防重复 stop 的闸）
  _recordDiscard: false, // 录制中点画布 = 取消，stop 回来后丢弃不存相册

  onLoad(options) {
    const drawingId = options.id ? decodeURIComponent(options.id) : '';
    this.drawingId = drawingId; // 保存 drawingId 用于分享

    // 放映入口：detail 页经 globalData 传了 {drawing, userActions, id}。
    // userActions 是时间序混排的笔画+填充；有内容就进回放模式。
    const app = getApp();
    const payload = app.globalData.replayPayload;
    app.globalData.replayPayload = null; // 取出即清，避免分享重进 show 页时重复回放
    if (payload && payload.drawing) {
      this.userActions = payload.userActions || [];
      if (payload.id) this.drawingId = payload.id; // 分享用
      // 放映上限：只播到详情页当时的步骤（含该步），不提前露出未播步骤
      this._patternEndStep =
        typeof payload.playedStep === 'number'
          ? payload.playedStep
          : payload.drawing.steps.length - 1;
      this.setData({
        drawing: payload.drawing,
        totalSteps: payload.drawing.steps.length,
        globalProgress: 0,
        hasUserStrokes: this.userActions.length > 0
      });
      wx.setNavigationBarTitle({
        title: payload.drawing.name || '放映'
      });
    } else {
      this._patternEndStep = null; // 长按卡片进入：无上限，完整播放
      this.loadDrawing(drawingId);
    }

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

  // 重建轮廓底图的离屏缓存（构建一次即可，显隐由 showOutline 控制）
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
    if (this.outlineCache && this.data.showOutline) ctx.drawImage(this.outlineCache, 0, 0);

    // 放映回放 phase 2：填充垫在图案黑线之下（涂色本效果），先画填充再画图案线条
    const inUserPhase = this._phase === 'user' || this._phase === 'done';
    if (inUserPhase) this.drawUserFills(ctx);

    if (this.doneCache) ctx.drawImage(this.doneCache, 0, 0);

    // 当前步骤的动画部分（参考图案）
    const { scale, offsetX, offsetY } = this.getTransform();
    const currentStepData = drawing.steps[currentStep];
    if (currentStepData && currentStepData.strokes.length > 0) {
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
    }

    // 放映回放 phase 2：用户笔画画在图案黑线之上（与详情页一致）。
    // phase='done' 时定格最终画面（图案 + 全部填充 + 全部笔画）。
    if (inUserPhase) this.drawUserStrokes(ctx);
  },

  // 用户填充回放：按时间序画已"到达"的填充（垫在图案黑线之下，涂色本效果）。
  // 填充在回放中直接出现（无生长动画），到达时刻 = 其下标 <= 当前 userIndex。
  // tintMask 开销大（整幅 getImageData），按 fill.key 缓存上色结果，每个填充只算一次。
  drawUserFills(ctx) {
    const actions = this.userActions;
    const limit = this._phase === 'done' ? actions.length : this.userIndex + 1;
    // phase='user' 且当前这条是填充时它也应已出现（见 startUserPlayback 的处理），
    // 所以取到 userIndex（含）为止；正在生长中的那条是笔画，不画填充。
    for (let i = 0; i < limit && i < actions.length; i++) {
      const a = actions[i];
      if (a.kind !== 'fill' || !a.fill || !a.fill.mask) continue;
      let tinted = this._fillTintCache[a.fill.key];
      if (!tinted) {
        tinted = tintMask(a.fill.mask, a.fill.color, () => this.createLayer());
        this._fillTintCache[a.fill.key] = tinted;
      }
      ctx.drawImage(tinted, 0, 0);
    }
  },

  // 用户笔画回放：按时间序画已完成的笔画 + 正在生长的当前笔画（画在图案线之上）。
  drawUserStrokes(ctx) {
    const actions = this.userActions;
    const doneCount = this._phase === 'done' ? actions.length : this.userIndex;
    for (let i = 0; i < doneCount && i < actions.length; i++) {
      const a = actions[i];
      if (a.kind === 'stroke') this.drawUserStroke(ctx, a.stroke, 1);
    }
    if (this._phase === 'user' && this.userIndex < actions.length) {
      const cur = actions[this.userIndex];
      if (cur && cur.kind === 'stroke' && this.userProgress > 0) {
        this.drawUserStroke(ctx, cur.stroke, this.userProgress);
      }
    }
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

  // 绘制用户笔迹（画布 CSS 像素坐标，与详情页 drawUserStroke 同逻辑）。
  // progress<1 时按弧长截断生长；颜色/宽度/画笔类型来自用户绘制时的选择。
  drawUserStroke(ctx, stroke, progress) {
    const points = stroke.points;
    if (!points || points.length < 2) return;
    const color = stroke.color || '#000000';
    const width = stroke.width || 4;
    const type = stroke.type || 'pen';

    // 生长进度 -> 截取点列（与 drawStroke 相同的长度插值）
    let target = points;
    if (progress < 1) {
      if (progress <= 0) return;
      const totalLength = this.getStrokeLength(points);
      if (totalLength === 0) return;
      const targetLength = progress * totalLength;
      target = [points[0]];
      let acc = 0;
      for (let i = 1; i < points.length; i++) {
        const dx = points[i][0] - points[i - 1][0];
        const dy = points[i][1] - points[i - 1][1];
        const seg = Math.sqrt(dx * dx + dy * dy);
        if (acc + seg >= targetLength) {
          const t = (targetLength - acc) / seg;
          target.push([points[i - 1][0] + dx * t, points[i - 1][1] + dy * t]);
          break;
        }
        target.push(points[i]);
        acc += seg;
      }
    }

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(target[0][0], target[0][1]);
    for (let i = 1; i < target.length; i++) {
      ctx.lineTo(target[i][0], target[i][1]);
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (type === 'pencil') {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash([width, width / 2]);
      ctx.globalAlpha = 0.7;
      ctx.stroke();
    } else if (type === 'marker') {
      ctx.strokeStyle = color;
      ctx.lineWidth = width * 2;
      ctx.globalAlpha = 0.4;
      ctx.stroke();
    } else if (type === 'brush') {
      ctx.strokeStyle = color;
      ctx.lineWidth = width * 1.5;
      ctx.globalAlpha = 0.6;
      ctx.stroke();
    } else {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.stroke();
    }
    ctx.restore();
  },

  // 用户内容回放（phase 2）：与 startPlay 同速度的 50ms 定时器。
  // 按时间序逐条回放：笔画按弧长匀速生长；填充直接填入（无生长动画，当帧出现）。
  // restart=true 时从头开始（结束后重播）；不传则从当前进度续播（暂停后恢复）。
  startUserPlayback(restart) {
    if (restart) {
      this.userIndex = 0;
      this.userProgress = 0;
    }
    this._phase = 'user';
    this.setData({ phaseText: '你的作品' });

    const speed = this.data.speed;
    const actions = this.userActions;
    // 注意用页面方法 this.getStrokeLength(points)（参数是点列）；
    // 模块级 getStrokeLength(stroke) 参数是笔画对象，别混用。填充没有长度，记 0。
    const lens = actions.map(a => a.kind === 'stroke' ? this.getStrokeLength(a.stroke.points || []) : 0);
    const pixelsPerInterval = (100 / speed) * (50 / 1000);

    this.playTimer = setInterval(() => {
      // 连续多条填充在同一帧内直接出现（填充无动画，不占时长）
      while (this.userIndex < actions.length && actions[this.userIndex].kind === 'fill') {
        this.userIndex += 1;
      }

      if (this.userIndex >= actions.length) {
        // 全部回放完成
        this._phase = 'done';
        this.setData({ playing: false, phaseText: '' });
        clearInterval(this.playTimer);
        this.playTimer = null;
        this.drawOutlineLayer();
        this.onPlaybackFinished();
        return;
      }

      // 当前是笔画：按弧长生长
      const len = lens[this.userIndex] || 1;
      this.userProgress += pixelsPerInterval / len;

      if (this.userProgress >= 1) {
        this.userIndex += 1;
        this.userProgress = 0;
        if (this.userIndex >= actions.length) {
          this.drawOutlineLayer();
          return; // 下一 tick 收尾
        }
      }
      this.drawOutlineLayer();
    }, 50);
  },

  // 播放逻辑与详情页一致：按步骤笔画长度匀速绘制。
  // 放映回放模式下图案只播到 _patternEndStep（详情页当时播到的步）即衔接用户内容，
  // 不提前露出未播步骤；普通模式无上限。
  startPlay() {
    const { speed, drawing, totalSteps } = this.data;
    // 图案播放上限：放映=detail 当时的步骤，普通模式=最后一步
    const endStep = this._patternEndStep != null
      ? Math.min(this._patternEndStep, totalSteps - 1)
      : totalSteps - 1;

    // 计算所有步骤的总长度
    const stepLengths = drawing.steps.map(step => getStepLength(step));

    // 基础速度：每秒绘制 100 像素
    const basePixelsPerSecond = 100;
    const interval = 50; // 50ms 间隔
    const pixelsPerInterval = (basePixelsPerSecond / speed) * (interval / 1000);

    this.playTimer = setInterval(() => {
      const { currentStep, progress } = this.data;
      const currentStepLength = stepLengths[currentStep] || 1;
      const patternTotal = endStep + 1; // 只播已播放的步骤，进度按这些步骤归一化

      if (progress < 1) {
        // 根据当前步骤长度计算进度增量
        const progressIncrement = pixelsPerInterval / currentStepLength;
        const newProgress = progress + progressIncrement;

        if (newProgress >= 1) {
          // 当前步骤完成
          if (currentStep < endStep) {
            this.setData({
              currentStep: currentStep + 1,
              progress: 0,
              globalProgress: (currentStep + 1) / patternTotal
            });
          } else {
            // 已播放步骤全部完成（停在放映上限步）
            this.setData({
              progress: 1,
              globalProgress: 1
            });
          }
        } else {
          // 计算全局进度：已完成步骤 + 当前步骤进度（只算已播放的步骤）
          const globalProgress = (currentStep + newProgress) / patternTotal;
          this.setData({ progress: newProgress, globalProgress });
        }
        this.drawOutlineLayer();
      } else if (currentStep < endStep) {
        this.setData({
          currentStep: currentStep + 1,
          progress: 0,
          globalProgress: (currentStep + 1) / patternTotal
        });
        this.drawOutlineLayer();
      } else {
        // 图案播完（到放映上限）：有用户内容则衔接回放，否则结束
        if (this.data.hasUserStrokes) {
          clearInterval(this.playTimer);
          this.playTimer = null;
          this.setData({ playing: true });
          this.startUserPlayback(true);
        } else {
          this.setData({ playing: false });
          clearInterval(this.playTimer);
          this.playTimer = null;
          this.onPlaybackFinished();
        }
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

  // ========== 隐藏彩蛋：页面下拉 -> 询问 -> 保存当前播放为视频 ==========
  // 用 wx.createCanvasRecorderManager（Canvas 2D 画面录制器，基础库 2.11.0+）。
  // wx.createMediaRecorder 是 WebGL 录制器，录不了 type="2d" 画布，不可用。
  // 录制内容 = show 页当前画面：放映入口是"已播步骤 + 用户作品"，长按入口是完整图案。
  onPullDownRefresh() {
    // 没有图案/画布未就绪/正在录：直接收尾下拉
    if (!this.data.drawing || !this.canvasesReady || this._recording) {
      wx.stopPullDownRefresh();
      return;
    }
    // 创建/复用录制器（一次性绑定 stop/error 回调）
    if (wx.createCanvasRecorderManager) {
      if (!this._recorder) {
        const recorder = wx.createCanvasRecorderManager();
        recorder.onStop((res) => {
          this._recording = false;
          // 录制中点画布取消的：丢弃不存相册
          if (this._recordDiscard) {
            this._recordDiscard = false;
            wx.showToast({ title: '已取消保存', icon: 'none' });
            return;
          }
          this._onRecordStopped(res && res.tempVideoPath);
        });
        recorder.onError(() => {
          this._recording = false;
          if (this.playTimer) {
            clearInterval(this.playTimer);
            this.playTimer = null;
          }
          this.setData({ playing: false });
          wx.showModal({
            title: '提示',
            content: '当前环境不支持画面录制',
            showCancel: false
          });
        });
        this._recorder = recorder;
      }
    } else {
      wx.showModal({
        title: '提示',
        content: '当前微信版本较低，暂不支持保存视频',
        showCancel: false
      });
      wx.stopPullDownRefresh();
      return;
    }

    wx.showModal({
      title: '保存视频',
      content: '是否把这段播放保存为视频到相册？（约 ' + this.estimatePlaybackDuration() + ' 秒）',
      confirmText: '保存',
      cancelText: '取消',
      success: (m) => {
        wx.stopPullDownRefresh();
        if (m.confirm) this.startRecording();
      }
    });
  },

  // 估算播放总时长（秒）：图案已播部分（100px/基准速度）+ 用户笔画总长，
  // 用于弹窗文案，估算值即可
  estimatePlaybackDuration() {
    const { drawing, speed, totalSteps } = this.data;
    const endStep = this._patternEndStep != null
      ? Math.min(this._patternEndStep, totalSteps - 1)
      : totalSteps - 1;
    let px = 0;
    for (let i = 0; i <= endStep; i++) {
      px += getStepLength(drawing.steps[i]);
    }
    for (const a of this.userActions) {
      if (a.kind === 'stroke') px += this.getStrokeLength(a.stroke.points || []);
    }
    return Math.max(1, Math.round(px / (100 / speed)));
  },

  // 从头重播并同步开录。录制从播放第一帧开始，保证视频 = 完整播放过程
  startRecording() {
    if (this._recording || !this._recorder || !this.outlineCanvas) return;
    this._recordDiscard = false;
    this._fillTintCache = {};
    this.userIndex = 0;
    this.userProgress = 0;
    this._phase = 'pattern';
    this._doneStep = -1;
    this.setData({
      currentStep: 0,
      progress: 0,
      globalProgress: 0,
      phaseText: '',
      showOutline: false
    });
    this.drawOutlineLayer();

    // 清掉可能还在跑的播放定时器（用户可能在播放中触发了录制），避免双定时器双倍速
    if (this.playTimer) {
      clearInterval(this.playTimer);
      this.playTimer = null;
    }

    // timeLimit 单位为毫秒：取预估时长的 1.5 倍兜底（封顶 10 分钟），
    // 正常路径由播放结束分支主动 stop()
    const limit = Math.min(600000, Math.ceil(this.estimatePlaybackDuration() * 1.5 * 1000));
    this._recorder.start({
      canvas: this.outlineCanvas,
      timeLimit: limit
    });
    this._recording = true;
    this.setData({ playing: true });
    this.startPlay();
    // 一次性告知取消方式（隐藏功能不常驻提示，只在录制启动时提示一次）
    wx.showToast({ title: '录制中，点画布可取消', icon: 'none', duration: 1800 });
  },

  // 播放全部结束（startPlay / startUserPlayback 的两个收尾分支都会调到这里）
  onPlaybackFinished() {
    if (this._recording && this._recorder) {
      this._recording = false;
      this._recorder.stop();
    }
  },

  // 录制停止：存相册（首次弹授权，拒绝则给引导）
  _onRecordStopped(tempVideoPath) {
    if (!tempVideoPath) {
      wx.showModal({
        title: '提示',
        content: '视频生成失败，请重试',
        showCancel: false
      });
      return;
    }
    wx.saveVideoToPhotosAlbum({
      filePath: tempVideoPath,
      success: () => {
        wx.showToast({ title: '已保存到相册', icon: 'success' });
      },
      fail: (err) => {
        if (err && err.errMsg && /auth|deny|cancel/.test(err.errMsg)) {
          wx.showModal({
            title: '保存失败',
            content: '需要你的授权才能保存到相册',
            confirmText: '去设置',
            success: (m) => {
              if (m.confirm) wx.openSetting();
            }
          });
        } else {
          wx.showModal({
            title: '提示',
            content: '保存失败，请重试',
            showCancel: false
          });
        }
      }
    });
  },

  onUnload() {
    if (this.playTimer) {
      clearInterval(this.playTimer);
    }
    if (this._tapTimer) {
      clearTimeout(this._tapTimer);
    }
    // 录制中退出页面：停掉定时器，录制器随页面销毁
    this._recording = false;
  },

  // 画布点击：单击 停止/启动播放，双击 显示/隐藏轮廓
  onCanvasTap() {
    // 录制中点一下 = 取消录制（丢弃，不存相册），避免暂停/切轮廓录进视频
    if (this._recording && this._recorder) {
      this._recordDiscard = true;
      this._recorder.stop();
      return;
    }
    if (this._tapTimer) {
      // 双击：取消单击逻辑，切换轮廓显隐
      clearTimeout(this._tapTimer);
      this._tapTimer = null;
      this.setData({ showOutline: !this.data.showOutline }, () => {
        this.drawOutlineLayer();
      });
      return;
    }
    this._tapTimer = setTimeout(() => {
      this._tapTimer = null;
      this.togglePlay();
    }, 300);
  },

  // 停止/启动播放。按阶段分支：
  // - 图案阶段：暂停/恢复；图案已画完且有用户笔迹 -> 进入用户回放
  // - 用户回放阶段：暂停/恢复；已放完 -> 整个放映（图案+笔迹）从头重播
  // - 普通模式全部结束 -> 从头重播图案
  togglePlay() {
    const { playing, drawing, currentStep, progress, totalSteps, hasUserStrokes } = this.data;
    if (!drawing) return;

    if (playing) {
      clearInterval(this.playTimer);
      this.playTimer = null;
      this.setData({ playing: false });
      return;
    }

    // 用户回放阶段（暂停恢复 / 放完重播）
    if (this._phase === 'user') {
      this.setData({ playing: true });
      this.startUserPlayback(false);
      return;
    }
    if (this._phase === 'done' && hasUserStrokes) {
      // 放映全部结束：从头重播（图案 + 用户笔迹）
      this._phase = 'pattern';
      this.userIndex = 0;
      this.userProgress = 0;
      this._doneStep = -1; // 强制重建"已完成步骤"缓存（会回到第 0 步）
      this.setData({ currentStep: 0, progress: 0, globalProgress: 0, playing: true });
      this.drawOutlineLayer();
      this.startPlay();
      return;
    }

    // 图案阶段
    // 放映上限：只播到 _patternEndStep，普通模式无上限（=最后一步）
    const endStep = this._patternEndStep != null
      ? Math.min(this._patternEndStep, totalSteps - 1)
      : totalSteps - 1;
    const finished = progress >= 1 && currentStep >= endStep;
    if (finished) {
      if (hasUserStrokes) {
        // 已播放步骤画完、还没播用户内容：直接开始回放
        this.setData({ playing: true });
        this.startUserPlayback(true);
        return;
      }
      this._doneStep = -1; // 从头重播，强制重建缓存
      this.setData({ currentStep: 0, progress: 0, globalProgress: 0 });
    }
    this.setData({ playing: true });
    this.drawOutlineLayer();
    this.startPlay();
  },
})
