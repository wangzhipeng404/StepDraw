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
    phaseText: '',
    // 录制中：true 时隐藏 2D 画布、露出 WebGL 画布（wxml 切换），用户看到的是正在录制的画面
    recording: false
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

  // ========== 隐藏彩蛋：长按画布 -> 询问 -> 保存当前播放为视频 ==========
  // 用 wx.createMediaRecorder（WebGL 画面录制器，基础库 2.11.0+）录页面内 WebGL 画布
  // （#recordCanvas，录制时露出盖住 2D 画布）：场景由 2D 画布 blit 到离屏 scratch ->
  // 传成 WebGL 纹理 -> 画全屏四边形。
  // 为什么录页面内画布而不是离屏：官方文档主示例录的就是页面内 canvas 节点，
  // 录离屏画布实测"前 1 秒正常、之后冻结"（capture 路径不可靠）。
  // 抓帧策略：挂进 drawOutlineLayer（与播放 tick 同频 50ms）——不开独立定时器
  // （独立 30fps 定时器实测跟播放抢单线程，把播放饿死）。
  _recorder: null,        // wx.createMediaRecorder 实例（WebGL 录制器）
  _recordMirror: null,    // 录制镜像 {canvas(页面内WebGL), gl, prog, tex, scratch, scratchCtx}
  _recording: false,      // start 成功后为 true；请求 stop 时立刻置 false（兼作防重复 stop 的闸）
  _recordStarting: false, // start() 的 await 窗口内为 true，防二次进入
  _recordDiscard: false,  // 长按 = 取消，stop 回来后丢弃不存相册
  _recordCtxRecovering: false, // GL 上下文丢失、异步重建镜像中（防重复重建）
  _recordFpLog: null,     // 诊断日志游标 {at, count, lastFp, changed}

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

    // 隐藏彩蛋：录制中，每次播放重绘（= 每个播放 tick，50ms）都抓一帧。
    // 与播放同频、共用同一定时器：抓到的必是刚画完的新画面，
    // 且不会像独立 30fps 定时器那样跟播放抢线程把播放饿死。
    if (this._recording && this._recordMirror) {
      this._recordFrame(this._recordMirror);
    }
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

  // ========== 隐藏彩蛋：长按画布 -> 询问 -> 保存当前播放为视频 ==========
  // 用 wx.createMediaRecorder（WebGL 画面录制器，基础库 2.11.0+）录页面内的 WebGL 画布
  // （#recordCanvas）：场景由 2D 画布 blit 到离屏 scratch -> 传成 WebGL 纹理 -> 画全屏四边形。
  // 录制时隐藏 2D 画布、露出 WebGL 画布（wxml 里 recording 切换）。
  // 录制内容 = show 页当前画面：放映入口是"已播步骤 + 用户作品"，长按卡片入口是完整图案。
  async onCanvasLongPress() {
    // 录制中再长按 = 取消（丢弃不存），避免暂停/切轮廓录进视频
    if (this._recording && this._recorder) {
      this._stopRecording(true);
      return;
    }
    // 正在启动/没有图案/画布未就绪：忽略
    if (!this.data.drawing || !this.canvasesReady || this._recordStarting) {
      return;
    }
    // 环境能力检查：createMediaRecorder + 离屏 WebGL 上下文，缺一不可
    if (typeof wx.createMediaRecorder !== 'function' || !wx.createOffscreenCanvas) {
      wx.showModal({
        title: '提示',
        content: '当前微信版本较低，暂不支持保存视频',
        showCancel: false
      });
      return;
    }
    let result;
    try {
      result = await this.buildRecordMirror();
    } catch (e) {
      console.warn('创建 WebGL 录制镜像异常', e);
      result = { ok: false, reason: '创建镜像异常：' + (e && e.message || e) };
    }
    if (!result.ok) {
      // 如实上报具体原因（之前笼统报"设备不支持"是误报——设备通常支持，
      // 多为取不到画布节点/建 WebGL 上下文失败）
      console.warn('[record] 录制镜像创建失败：' + result.reason);
      wx.showModal({
        title: '提示',
        content: '无法初始化录制：' + result.reason,
        showCancel: false
      });
      return;
    }
    const mirror = result.mirror;

    wx.showModal({
      title: '保存视频',
      content: '是否把这段播放保存为视频到相册？（约 ' + this.estimatePlaybackDuration() + ' 秒）',
      confirmText: '保存',
      cancelText: '取消',
      success: (m) => {
        if (m.confirm) {
          this.startRecording(mirror);
        } else {
          this.releaseRecordMirror(mirror);
        }
      }
    });
  },

  // 页面下拉 = 重新播放（从头开始：图案 + 用户作品）。隐藏彩蛋已挪到长按画布。
  onPullDownRefresh() {
    if (!this.data.drawing || !this.canvasesReady) {
      wx.stopPullDownRefresh();
      return;
    }
    this.replayFromStart();
    wx.stopPullDownRefresh();
  },

  // 从头重新播放（下拉触发）。复位播放与用户回放状态，清掉进行中的定时器再开播。
  // 若正在录制则先取消录制（丢弃），避免重播被录进视频。
  replayFromStart() {
    if (this._recording && this._recorder) {
      this._stopRecording(true);
    }
    if (this.playTimer) {
      clearInterval(this.playTimer);
      this.playTimer = null;
    }
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
      showOutline: false,
      playing: true
    });
    this.drawOutlineLayer();
    this.startPlay();
  },

  // 创建"录制镜像"：页面内的 WebGL canvas（#recordCanvas，供录制）+ 离屏 2D scratch（场景绘制源）。
  // 为什么 WebGL 画布放页面里而不是离屏：wx.createMediaRecorder 的官方主示例录的就是页面内
  // canvas 节点，离屏只是次要路径；录离屏画布实测"前 1 秒正常、之后冻结"，换回页面内 canvas。
  // 画布常驻页面（不 display:none，隐藏 canvas 取节点/建上下文会失败），平时垫在 2D 画布后面。
  // 返回 {ok, mirror, reason}：失败时带具体原因，调用方如实上报（不要笼统说"设备不支持"）。
  async buildRecordMirror() {
    const w = this.canvasWidth, h = this.canvasHeight;
    if (!w || !h) return { ok: false, reason: '画布尺寸未就绪' };

    // 取页面内 WebGL 画布节点（异步）
    const glCanvas = await new Promise((resolve) => {
      wx.createSelectorQuery().in(this).select('#recordCanvas')
        .fields({ node: true, size: true })
        .exec((res) => resolve(res && res[0] ? res[0].node : null));
    });
    if (!glCanvas) return { ok: false, reason: '取不到 #recordCanvas 节点' };
    glCanvas.width = w;
    glCanvas.height = h;
    // preserveDrawingBuffer：录制器在 requestFrame() 时读 drawing buffer，
    // 不开启该选项 buffer 会在合成后被清（表现就是"画面冻结成最后一帧"）。
    let gl = null;
    try {
      gl = glCanvas.getContext('webgl', { preserveDrawingBuffer: true });
    } catch (e) {
      console.warn('[record] getContext(webgl) 异常', e);
    }
    if (!gl) return { ok: false, reason: 'WebGL 上下文创建失败' };

    // 顶点同时带 (x, y, u, v)：位置取 xy，纹理坐标取 zw
    const VERT = 'attribute vec4 aPos;varying vec2 vUV;void main(){vUV=aPos.zw;gl_Position=vec4(aPos.xy,0.,1.);}';
    const FRAG = [
      'precision mediump float;',
      'uniform sampler2D uTex;',
      'varying vec2 vUV;',
      'void main(){gl_FragColor=texture2D(uTex,vUV);}'
    ].join('\n');
    const mkShader = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.warn('shader 编译失败', gl.getShaderInfoLog(sh));
        return null;
      }
      return sh;
    };
    const vs = mkShader(gl.VERTEX_SHADER, VERT);
    const fs = mkShader(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return { ok: false, reason: 'shader 编译失败' };

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn('program 链接失败', gl.getProgramInfoLog(prog));
      return { ok: false, reason: 'shader 链接失败' };
    }

    // 全屏四边形
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 0, 1,
      1, -1, 1, 1,
      -1, 1, 0, 0,
      1, 1, 1, 0
    ]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    const uTex = gl.getUniformLocation(prog, 'uTex');
    gl.useProgram(prog);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 4, gl.FLOAT, false, 0, 0);
    gl.uniform1i(uTex, 0);
    gl.viewport(0, 0, w, h);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    // 离屏 2D 画布：场景绘制源（把可见 2D 画布的内容 blit 上来再传 WebGL 纹理）
    const scratch = wx.createOffscreenCanvas({ type: '2d', width: w, height: h });
    const scratchCtx = scratch.getContext('2d');

    return { ok: true, mirror: { canvas: glCanvas, gl, prog, tex, scratch, scratchCtx } };
  },

  // 把"当前可见画面"喂给 WebGL 镜像：可见画布是透明底（CSS 白底不在位图里），
  // 所以先把 scratch 填白，再把可见画布整体 blit 上去（单次 GPU 拷贝，不重跑矢量绘制），
  // 然后上传成 WebGL 纹理并画全屏四边形。只读，不改任何播放进度。
  drawRecordFrame(mirror) {
    const ctx = mirror.scratchCtx;
    const w = this.canvasWidth, h = this.canvasHeight;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, w, h);
    if (this.outlineCanvas) ctx.drawImage(this.outlineCanvas, 0, 0);

    // 上传纹理 + 画全屏四边形。
    // 朝向：2D 画布 getImageData() 的首个像素是左上角，不翻转上传则纹理 v=0 对应画布顶边；
    // 四边形顶点已让屏幕顶边(y=+1)采 v=0、底边采 v=1，故画面与屏幕同向，无需 FLIP_Y。
    // 用"裸 Uint8Array + 显式宽高"的 texImage2D 重载（比直接传 ImageData 兼容性更好）。
    const gl = mirror.gl;
    const img = ctx.getImageData(0, 0, w, h);
    // 源画面指纹：按固定间隔采样像素做散列（不遍历全图，开销可忽略）。
    // 画面在动则逐帧变化，冻结则停滞——供 _logRecordFrame 判断"源是否还在画"。
    let fp = 0;
    const px = img.data;
    const stride = 1024 * 4; // 每 1024 个像素采 1 个
    for (let i = 0; i < px.length; i += stride) {
      fp = (Math.imul(fp, 31) + px[i]) | 0;
    }
    gl.useProgram(mirror.prog);
    gl.bindTexture(gl.TEXTURE_2D, mirror.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, img.data);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // GL 错误检查：texImage2D/drawArrays 静默失败时（上下文问题等），录制器会一直
    // 抓同一帧旧 buffer——表现为"帧在产、画面冻结"。只打一次防刷屏
    if (!mirror._glErrLogged) {
      const err = gl.getError();
      if (err !== gl.NO_ERROR) {
        console.warn('[record] GL 错误 0x' + err.toString(16) + '（画面会冻结）');
        mirror._glErrLogged = true;
      }
    }
    return fp;
  },

  // 启动录制器（兼容低版本）：基础库 ≥2.16.1 的 start() 返回 Promise；
  // 更早版本没有 Promise，用文档给的 on('start') 兼容写法。3s 超时兜底，防止未知事件挂死。
  _mediaRecorderStart(recorder) {
    const p = recorder.start();
    if (p && typeof p.then === 'function') {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('start timeout')), 3000);
        p.then((r) => { clearTimeout(t); resolve(r); }, (e) => { clearTimeout(t); reject(e); });
      });
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('start timeout')), 3000);
      const ok = () => { clearTimeout(t); resolve(); };
      const bad = (e) => { clearTimeout(t); reject(e || new Error('start error')); };
      if (recorder.on) {
        recorder.on('start', ok);
        recorder.on('error', bad);
      } else {
        // 极端兜底：无事件也无 Promise，直接视为已启动
        ok();
      }
    });
  },

  // 抓帧（同步调用，"永不抛出"）：把可见画面 blit 进 WebGL 镜像并驱动录制器捕获一帧。
  // 由 drawOutlineLayer（播放 tick）每 50ms 调用一次，返回源画面指纹供诊断日志。
  _recordFrame(mirror) {
    let fp = 0;
    try {
      fp = this.drawRecordFrame(mirror);
    } catch (e) {
      // 绘制失败：若是 GL 上下文丢失，则异步重建镜像（不阻塞播放 tick）；
      // 其他异常丢弃这一帧（但仍驱动 requestFrame 保持视频帧数）
      if (mirror.gl && mirror.gl.isContextLost && mirror.gl.isContextLost() && !this._recordCtxRecovering) {
        this._recordCtxRecovering = true;
        this.buildRecordMirror().then((result) => {
          this._recordCtxRecovering = false;
          if (!this._recording) return;
          if (result.ok) {
            const m2 = result.mirror;
            this.releaseRecordMirror(mirror);
            this._recordMirror = m2;
            try { this._recordFrame(m2); } catch (e2) { console.warn('[record] 重建后绘制仍失败', e2); }
          } else {
            // 重建失败：停止录制并丢弃，避免录出一段空白视频
            console.warn('[record] 重建镜像失败：' + result.reason);
            this._stopRecording(true);
          }
        }).catch(() => { this._recordCtxRecovering = false; });
      }
      console.warn('[record] 帧绘制失败（丢弃该帧）', e);
    }
    // 先记诊断日志再驱动录制器：即使 requestFrame 挂死，也能看到"源画面是否还在动"
    this._logRecordFrame(fp);
    // 驱动录制器捕获一帧（fire-and-forget：低版本回调式/高版本 Promise 式都兼容，
    // 内部 try/catch 兜住；不 await，避免阻塞播放 tick）
    this._driveRequestFrame().catch(() => {});
    return fp;
  },

  // 诊断日志：每 1 秒汇总一次——上一秒产帧数 + 该窗口内源指纹是否变化 + 当前播放状态。
  // 定位"前1秒正常、之后冻结"用：
  //   指纹逐秒"变化" & 状态在推进  -> 源画面在动，冻结在录制器/WebGL 侧
  //   状态停滞（step/progress 不动） -> 播放在第 1 秒就停了（查 startPlay 定时器/setData）
  //   状态推进 & 指纹【停滞】        -> 可见画布没跟上 data（查 drawOutlineLayer/缓存失效）
  _logRecordFrame(fp) {
    const now = Date.now();
    let cur = this._recordFpLog;
    if (!cur || now - cur.at >= 1000) {
      // 打印"上一个窗口"的汇总（首窗无历史，跳过）
      if (cur) {
        const d = this.data;
        console.log(
          '[record] 上1s ' + cur.count + ' 帧, 源指纹' + (cur.changed ? '变化' : '【停滞】') +
          ' | step=' + d.currentStep + ' progress=' + d.progress.toFixed(2) +
          ' phase=' + this._phase
        );
      }
      cur = { at: now, count: 0, lastFp: null, changed: false };
      this._recordFpLog = cur;
    }
    // 窗口内任一帧与上一帧不同 => 该窗口"源画面在动"
    if (cur.lastFp !== null && fp !== cur.lastFp) cur.changed = true;
    cur.lastFp = fp;
    cur.count += 1;
  },

  // 驱动录制器捕获一帧。低版本（<2.16.1）requestFrame 是回调式、高版本返回 Promise。
  // 按形参个数区分，且只调用一次（避免重复抓帧/无回调调用抛错），统一返回 Promise 便于 await。
  _driveRequestFrame() {
    const r = this._recorder;
    if (!r || typeof r.requestFrame !== 'function') return Promise.resolve();
    if (r.requestFrame.length >= 1) {
      // 回调式：requestFrame(callback)
      return new Promise((resolve) => {
        try { r.requestFrame(resolve); } catch (e) { resolve(); }
      });
    }
    // Promise 式：requestFrame() -> Promise
    try {
      const p = r.requestFrame();
      return (p && typeof p.then === 'function') ? p : Promise.resolve();
    } catch (e) {
      return Promise.resolve();
    }
  },

  // 释放录制镜像（取消 / 失败 / 结束后）
  releaseRecordMirror(mirror) {
    if (!mirror || !mirror.gl) return;
    try {
      mirror.gl.deleteTexture(mirror.tex);
      mirror.gl.deleteProgram(mirror.prog);
    } catch (e) { /* 忽略 */ }
    this._recordMirror = null;
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

  // 从头重播并同步开录。
  // 关键顺序：先 setData({recording:true}) 且等视图更新完成（画布真的可见）后，
  // 再 createMediaRecorder + start —— display:none 的 canvas 可能没有可捕获的合成 buffer。
  async startRecording(mirror) {
    if (this._recording || this._recordStarting || !mirror) return;
    this._recordStarting = true;
    this._recordMirror = mirror;

    // 1) 让 WebGL 画布显示（盖住 2D 画布），并绘制首帧白底，等视图更新完成
    await new Promise((resolve) => {
      this.setData({ recording: true }, resolve);
    });
    this._recordFrame(mirror); // 同步绘制到 WebGL，供录制器捕获第一帧

    // 2) 创建录制器并启动（此时 WebGL 画布已在页面中可见）
    let recorder = null;
    try {
      recorder = wx.createMediaRecorder(mirror.canvas, {
        // 兜底时长（秒）：预估 * 1.5，按文档要求钳在 [5, 600]。正常由播放结束主动 stop()
        duration: Math.max(5, Math.min(600, Math.ceil(this.estimatePlaybackDuration() * 1.5))),
        // 与播放 tick 同频（50ms）：抓帧挂在播放 tick 上，帧率 20，
        // 视频时长 = 帧数/20 = 播放时长，不会偏快
        fps: 20
      });
      await this._mediaRecorderStart(recorder);
    } catch (e) {
      console.warn('createMediaRecorder 启动失败', e);
      this.setData({ recording: false });
      this.releaseRecordMirror(mirror);
      this._recordMirror = null;
      wx.showModal({
        title: '提示',
        content: '当前设备不支持画面录制',
        showCancel: false
      });
      this._recordStarting = false;
      return;
    }
    this._recorder = recorder;
    this._recording = true;
    this._recordStarting = false;

    // 3) 复位播放状态，从头开播
    if (this.playTimer) {
      clearInterval(this.playTimer);
      this.playTimer = null;
    }
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
    this.drawOutlineLayer(); // 末尾钩子抓一帧（录制已启动）

    this.setData({ playing: true });
    this.startPlay();
    wx.showToast({ title: '录制中，长按画布可取消', icon: 'none', duration: 1800 });
  },

  // 播放全部结束（startPlay / startUserPlayback 的两个收尾分支都会调到这里）
  onPlaybackFinished() {
    this._stopRecording(false);
  },

  // 停止录制并收尾（正常结束 / 长按取消共用）。异步：等 stop 出结果再释放资源。
  // 抓帧挂在播放 tick 上，_recording=false 后 drawOutlineLayer 的钩子自动停抓，无需清定时器。
  async _stopRecording(discard) {
    if (!this._recording || !this._recorder) return;
    this._recording = false;
    this._recordDiscard = discard;
    if (this.playTimer) {
      clearInterval(this.playTimer);
      this.playTimer = null;
    }
    const recorder = this._recorder;
    const mirror = this._recordMirror;
    this._recorder = null;
    // 立即切回 2D 画布（2D 一直在后台重绘、与 WebGL 同步，恢复显示即当前画面）；
    // 存相册在下方 done 之后异步进行
    this.setData({ recording: false });
    // 低版本兼容：<2.16.1 的 stop 不返回 Promise（文档给了 on('stop') 兼容写法），两种都兜住；
    // 结果路径字段以官方文档的 tempFilePath 为准
    const done = new Promise((resolve) => {
      if (recorder.on) recorder.on('stop', resolve);
      try {
        const p = recorder.stop();
        if (p && typeof p.then === 'function') p.then(resolve, resolve);
        else resolve();
      } catch (e) {
        resolve();
      }
    });
    const res = await done;
    this.releaseRecordMirror(mirror);
    if (recorder && typeof recorder.destroy === 'function') {
      try { recorder.destroy(); } catch (e) { /* 忽略 */ }
    }
    if (this._recordDiscard) {
      this._recordDiscard = false;
      wx.showToast({ title: '已取消保存', icon: 'none' });
      return;
    }
    this._onRecordStopped(res && res.tempFilePath);
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
    // 录制中退出页面：丢弃（不存相册），释放 WebGL 资源
    this._recording = false;
    this.releaseRecordMirror(this._recordMirror);
  },

  // 画布点击：单击 停止/启动播放，双击 显示/隐藏轮廓
  onCanvasTap() {
    // 录制中点一下 = 取消录制（丢弃，不存相册），避免暂停/切轮廓录进视频
    if (this._recording && this._recorder) {
      this._stopRecording(true);
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
