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

  // ========== 隐藏彩蛋：长按画布 -> 询问 -> 把这段播放存成视频 ==========
  // 架构（与可见播放完全解耦）：录制是一个自包含的"从头模拟渲染 + 逐帧捕获"循环。
  //   场景画在【离屏 WebGL 画布】上（离屏 canvas 能稳定拿到 webgl 上下文；页面内 <canvas>
  //   节点拿不到 —— 之前误报"设备不支持"的根因），渲染进度用独立的 _rec 模拟状态从 0 推进。
  //   每帧 await requestFrame() 后再画下一帧（官方文档示例的节奏：requestFrame 决定输出帧）。
  //   用户【不需要】盯着看录制过程：可见页照常自己播，离屏录制跑自己的进度，两者时长相同
  //   （同一套速度逻辑），渲染循环播完 -> stop -> 存相册。
  _recorder: null,        // wx.createMediaRecorder 实例（WebGL 录制器）
  _recordMirror: null,    // 录制画布 {canvas(离屏WebGL), gl, prog, tex, ctx(2D场景), width, height}
  _recording: false,      // start 成功后为 true；请求 stop 时立刻置 false（兼作防重复 stop 的闸）
  _recordStarting: false, // start() 的 await 窗口内为 true，防二次进入
  _recordDiscard: false,  // 长按 = 取消，stop 回来后丢弃不存相册
  _rec: null,             // 录制渲染模拟状态 {phase, step, progress, stepLengths, endStep, ui, uIndex, uProgress, uLens}
  _recMaxDurSec: 600,     // 录制器兜底时长上界（秒），同时用作渲染循环的超时保护
  _recDone: false,        // 渲染循环已到达终点（定格收尾用）
  _recErr: null,          // 渲染循环捕获的错误信息（非空 = 异常终止，丢弃不存）

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
      // 取整：WebGL 的 texImage2D/viewport 收 GLsizei，getImageData 与它的舍入若不一致
      // 会导致上传偶发静默失败（"前几帧好、后面坏"的一类隐患）
      canvas.width = Math.floor(res[0].width);
      canvas.height = Math.floor(res[0].height);

      this.outlineCanvas = canvas;
      this.outlineCtx = canvas.getContext('2d');
      this.canvasWidth = Math.floor(res[0].width);
      this.canvasHeight = Math.floor(res[0].height);
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
    // 平滑：中点二次贝塞尔（与详情页 drawUserStroke 同算法，回放/录制画面一致）
    ctx.moveTo(target[0][0], target[0][1]);
    if (target.length === 2) {
      ctx.lineTo(target[1][0], target[1][1]);
    } else {
      for (let i = 1; i < target.length - 1; i++) {
        const midX = (target[i][0] + target[i + 1][0]) / 2;
        const midY = (target[i][1] + target[i + 1][1]) / 2;
        ctx.quadraticCurveTo(target[i][0], target[i][1], midX, midY);
      }
      const last = target[target.length - 1];
      ctx.lineTo(last[0], last[1]);
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (type === 'pencil') {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash([width, width / 2]);
      ctx.globalAlpha = 0.7;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    } else if (type === 'marker') {
      ctx.strokeStyle = color;
      ctx.lineWidth = width * 2;
      ctx.globalAlpha = 0.4;
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (type === 'brush') {
      // 毛笔：沿笔迹由淡入浓（与详情页同逻辑：按段插值透明度，淡浓跟着手走）
      ctx.strokeStyle = color;
      ctx.lineWidth = width * 1.5;
      const n = target.length;
      const mid = (i, j) => [(target[i][0] + target[j][0]) / 2, (target[i][1] + target[j][1]) / 2];
      for (let i = 0; i < n - 1; i++) {
        const t = n > 2 ? i / (n - 2) : 1;
        ctx.beginPath();
        const from = i === 0 ? target[0] : mid(i - 1, i);
        const to = i === n - 2 ? target[n - 1] : mid(i, i + 1);
        if (i === 0) {
          ctx.moveTo(from[0], from[1]);
          ctx.lineTo(to[0], to[1]);
        } else {
          ctx.moveTo(from[0], from[1]);
          ctx.quadraticCurveTo(target[i][0], target[i][1], to[0], to[1]);
        }
        ctx.globalAlpha = 0.6 * (0.25 + 0.75 * t);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
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
        }
      }
    }, interval);
  },

  // 分享给朋友：封面用图案封面图，跳回展示页
  onShareAppMessage() {
    const { drawing } = this.data;
    const drawingId = this.drawingId || '';
    return {
      title: drawing ? `我发现一个宝藏小程序 Step Draw，一起来看${drawing.name}怎么画！` : '我发现一个宝藏小程序 Step Draw，一起来看${drawing.name}怎么画吧',
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
      title: drawing ? `我发现一个宝藏小程序 Step Draw，一起来看${drawing.name}怎么画！` : '我发现一个宝藏小程序 Step Draw，一起来看${drawing.name}怎么画吧',
      query: `id=${encodeURIComponent(drawingId)}`,
      imageUrl: drawing && drawing.thumbnail ? config.getAssetUrl(drawing.thumbnail) : undefined
    };
  },

  // ========== 隐藏彩蛋：长按画布 -> 询问 -> 把这段播放存成视频 ==========
  // 确认后走 startRecording：离屏自包含渲染循环，录完存相册。与可见播放互不影响。
  // 录制中再长按 = 取消（丢弃不存）。
  async onCanvasLongPress() {
    // 录制中再长按 = 取消（丢弃不存）
    if (this._recording && this._recorder) {
      this._stopRecording(true);
      return;
    }
    // 正在启动/没有图案/画布未就绪：忽略
    if (!this.data.drawing || !this.canvasesReady || this._recordStarting) {
      return;
    }
    // 环境能力检查：createMediaRecorder + 离屏 canvas，缺一不可
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
      console.warn('创建录制画布异常', e);
      result = { ok: false, reason: '创建录制画布异常：' + (e && e.message || e) };
    }
    if (!result.ok) {
      // 如实上报具体原因（不要笼统说"设备不支持"——设备通常支持，多为建上下文失败）
      console.warn('[record] 录制画布创建失败：' + result.reason);
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
    wx.stopPullDownRefresh();
    // 录制中：重播会和录制抢场景画布，忽略（取消请长按画布）
    if (this._recording || this._recordStarting) return;
    if (!this.data.drawing || !this.canvasesReady) {
      return;
    }
    this.replayFromStart();
  },

  // 从头重新播放（下拉触发）。复位播放与用户回放状态，清掉进行中的定时器再开播。
  replayFromStart() {
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

  // 创建录制画布：离屏 WebGL canvas（wx.createOffscreenCanvas({type:'webgl'})）。
  // 页面里只留一张 2D 画布（播放/录制场景），WebGL 录制画布离屏创建——
  // 实机验证过直传 canvas 纹理源后离屏同样可用，且页面更干净。
  // 场景画在【可见 2D 画布】（outlineCanvas），texImage2D 直接以它为纹理源
  // （_probeCanvasTexture 探测支持性），省掉 getImageData 的 GPU→CPU→GPU 往返。
  // 返回 {ok, mirror, reason}：失败带具体原因，调用方如实上报（不笼统说"不支持"）。
  async buildRecordMirror() {
    const w = this.canvasWidth, h = this.canvasHeight;
    if (!w || !h) return { ok: false, reason: '画布尺寸未就绪' };

    let glCanvas;
    try {
      glCanvas = wx.createOffscreenCanvas({ type: 'webgl', width: w, height: h });
    } catch (e) {
      console.warn('[record] createOffscreenCanvas(webgl) 异常', e);
      return { ok: false, reason: '创建离屏画布失败' };
    }
    if (!glCanvas) return { ok: false, reason: '创建离屏画布失败' };

    // preserveDrawingBuffer：录制器在 requestFrame() 时读 drawing buffer，
    // 不开则该 buffer 在合成后被清（表现为"画面冻结/空白"）。
    let gl;
    try {
      gl = glCanvas.getContext('webgl', { preserveDrawingBuffer: true });
    } catch (e) {
      console.warn('[record] getContext(webgl) 异常', e);
      gl = null;
    }
    if (!gl) return { ok: false, reason: 'WebGL 上下文创建失败' };
    let attrs = null;
    try { attrs = gl.getContextAttributes(); } catch (e) { /* 忽略 */ }
    console.log('[record] 离屏 WebGL preserveDrawingBuffer=' +
      (attrs ? attrs.preserveDrawingBuffer : 'unknown'));
    console.log('[record] 使用离屏 WebGL 画布录制');

    // 全屏四边形 shader：采样 uTex 铺满屏幕
    const VERT = 'attribute vec4 aPos;varying vec2 vUV;void main(){vUV=aPos.zw;gl_Position=vec4(aPos.xy,0.,1.);}';
    const FRAG = ['precision mediump float;', 'uniform sampler2D uTex;', 'varying vec2 vUV;', 'void main(){gl_FragColor=texture2D(uTex,vUV);}'].join('\n');
    const mkShader = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.warn('[record] shader 编译失败', gl.getShaderInfoLog(sh));
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
      console.warn('[record] program 链接失败', gl.getProgramInfoLog(prog));
      return { ok: false, reason: 'shader 链接失败' };
    }

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

    // 场景绘制目标（可见 2D 画布）在 startRecording 里挂进来（mirror.sceneCanvas/sceneCtx）。
    // 纹理源直接传 sceneCanvas（texImage2D 直传，省 getImageData 往返），不再需要 scratch。

    return { ok: true, mirror: { canvas: glCanvas, gl, prog, tex, width: w, height: h } };
  },

  // 把模拟进度合成到【可见 2D 画布】（sceneCtx，播放同源、真机可靠）。每帧只做"3 张增量层
  // drawImage + 最多 1 笔生长笔画"，不重画已完成内容。坐标/变换与可见画布一致（同一
  // getTransform），录出来和页面看的一样。层次（由下至上）：
  //   fillLayer(白底+填充) -> lineLayer(已完成图案步骤) -> 生长中的图案笔画 -> userLayer(用户笔画)
  _renderRecordFrame(sim) {
    const m = this._recordMirror;
    if (!m || !m.sceneCtx || !this.data.drawing) return;
    const ctx = m.sceneCtx;
    const w = m.width, h = m.height;
    const drawing = this.data.drawing;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // 白底 + 已到达的填充（填充垫在图案线之下，涂色本效果）
    ctx.drawImage(sim.fillLayer, 0, 0);
    // 已完成的图案步骤
    ctx.drawImage(sim.lineLayer, 0, 0);

    // 当前生长中的图案笔画（唯一每帧重画的部分）
    const { scale, offsetX, offsetY } = this.getTransform();
    if (sim.phase === 'pattern' && sim.step <= sim.endStep) {
      const st = drawing.steps[sim.step];
      if (st && st.strokes.length > 0) {
        const strokes = st.strokes;
        const totalStrokes = strokes.length;
        const strokesProgress = Math.min(sim.stepPx / (sim.stepLengths[sim.step] || 1), 1) * totalStrokes;
        const completedStrokes = Math.floor(strokesProgress);
        const currentStrokeProgress = strokesProgress - completedStrokes;
        ctx.save();
        ctx.translate(offsetX, offsetY);
        ctx.scale(scale, scale);
        for (let i = 0; i < completedStrokes; i++) this.drawStroke(ctx, strokes[i], 1, '#000', false, scale);
        if (completedStrokes < totalStrokes && strokes[completedStrokes]) {
          this.drawStroke(ctx, strokes[completedStrokes], currentStrokeProgress, config.PLAY_STROKE_COLOR, true, scale);
        }
        ctx.restore();
      }
    }
    // 用户笔画（图案线之上）：userLayer 已完成 + 当前生长的一笔
    if (sim.phase === 'user') {
      ctx.drawImage(sim.userLayer, 0, 0);
      const cur = this.userActions[sim.uIndex];
      if (cur && cur.kind === 'stroke' && sim.uProgress > 0) {
        this.drawUserStroke(ctx, cur.stroke, sim.uProgress);
      }
    }
  },

  // 把场景内容传成 WebGL 纹理并画全屏四边形，供录制器在 requestFrame() 时捕获。
  // 两条上传路径：
  //   A) texImage2D 直传 2D canvas 对象（m.texCanvas）：GPU 直接读 2D 画布，省掉
  //      getImageData 的 GPU→CPU→GPU 往返（~58MB/s，持续跑会触发节流→~1s 后停更，
  //      实机已定位到这一步）。是否支持在 startRecording 里探测后决定。
  //   B) 回退 getImageData（部分基础库不支持 canvas 直传时）。
  // 返回场景位图指纹（诊断用）：画面在动则逐帧变化、停住则不变。
  _captureRecordFrame() {
    const m = this._recordMirror;
    if (!m || !m.gl || !m.sceneCtx) return 0;
    const gl = m.gl;
    const w = m.width, h = m.height;
    let fp = 0;

    gl.useProgram(m.prog);
    gl.bindTexture(gl.TEXTURE_2D, m.tex);
    if (m.texCanvas) {
      // 路径 A：直接以 2D canvas 为纹理源（零 CPU 往返）。朝向同前：canvas 原点在左上，
      // v=0 对应顶边，无需 FLIP_Y。
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, m.sceneCanvas);
      } catch (e) {
        // 个别机型中途抛错：降级到 getImageData 路径，保证画面不丢
        m.texCanvas = false;
        console.warn('[record] texImage2D(canvas) 异常，降级 getImageData', e);
      }
      if (!m.texCanvas) {
        const img = m.sceneCtx.getImageData(0, 0, w, h);
        const px = img.data;
        for (let i = 0; i < px.length; i += 64 * 4) fp = (Math.imul(fp, 31) + px[i]) | 0;
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE,
          new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength));
      }
    } else {
      // 路径 B：getImageData（同时算场景指纹供诊断）
      const img = m.sceneCtx.getImageData(0, 0, w, h);
      const px = img.data;
      for (let i = 0; i < px.length; i += 64 * 4) fp = (Math.imul(fp, 31) + px[i]) | 0;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength));
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // GL 错误检查（前几次都打，静默失败是问题核心，不能只记一次）
    const err = gl.getError();
    if (err !== gl.NO_ERROR && m._glErrCount < 5) {
      console.warn('[record] GL 错误 0x' + err.toString(16) + '（' + (m.texCanvas ? 'canvas直传' : 'getImageData') + '）');
      m._glErrCount = (m._glErrCount || 0) + 1;
    }
    // 直传路径不做 getImageData（零往返），无场景像素可读，返回 -1 表示"未采样"
    return m.texCanvas ? -1 : fp;
  },

  // 能力探测：texImage2D 是否接受 2D canvas 作为纹理源（部分基础库支持、部分静默失败/抛错）。
  // 探测后 readPixels 读回校验真的画上了（不只看 getError，防"接受但渲染黑帧"）。
  _probeCanvasTexture(m) {
    const gl = m.gl, w = m.width, h = m.height;
    let ok = false;
    try {
      gl.useProgram(m.prog);
      gl.bindTexture(gl.TEXTURE_2D, m.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, m.sceneCanvas);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (gl.getError() === gl.NO_ERROR) {
        // 读回中心一小块：非全黑即认为生效（场景是白底+黑线，中心几乎不会是纯黑空帧）
        const px = new Uint8Array(8 * 8 * 4);
        gl.readPixels(w >> 1, h >> 1, 8, 8, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let s = 0;
        for (let i = 0; i < px.length; i++) s += px[i];
        ok = s > 0;
        console.log('[record] texImage2D(canvas) 探测 readPixels 总和=' + s);
      }
    } catch (e) {
      ok = false;
    }
    console.log('[record] texImage2D(canvas) 支持=' + ok);
    return ok;
  },

  // 每秒诊断用：readPixels 读回 WebGL 画布（= 录制器真正捕获的内容）多处，算指纹。
  // 与"场景指纹"对照：场景在动但 WebGL 停滞 = 上传/draw 停更（本次病位）。
  _glReadFp(m) {
    const gl = m.gl, w = m.width, h = m.height;
    let fp = 0;
    const buf = new Uint8Array(8 * 8 * 4);
    const pts = [[w >> 1, h >> 1], [w >> 2, h >> 2], [(w * 3) >> 2, (h * 3) >> 2],
      [w >> 1, h >> 2], [(w * 3) >> 2, h >> 2]];
    for (let k = 0; k < pts.length; k++) {
      try { gl.readPixels(pts[k][0], pts[k][1], 8, 8, gl.RGBA, gl.UNSIGNED_BYTE, buf); }
      catch (e) { continue; }
      for (let i = 0; i < buf.length; i += 16) fp = (Math.imul(fp, 31) + buf[i]) | 0;
    }
    return fp;
  },

  // 诊断日志：每秒汇总一次——抓帧数 + 场景指纹 + WebGL 画布指纹 + 模拟进度。
  // 场景侧：getImageData 路径算场景位图指纹（fp）；直传路径零往返、不读场景像素（fp=-1），
  //         此时场景是否更新直接看 WebGL 指纹（读回的就是场景内容）。
  // WebGL 侧：readPixels 读回录制画布（= 录制器真正捕获的内容）。
  //   WebGL 在动 & 进度在推进   -> 正常，视频应完整
  //   WebGL【停滞】& 进度在推进 -> 上传/draw 停更
  //   进度停滞                  -> 模拟推进问题（renderTick）
  _logRecordFrame(fp) {
    const now = Date.now();
    let cur = this._recLog;
    const noSceneFp = fp === -1; // 直传路径：没有场景位图指纹
    if (!cur || now - cur.at >= 1000) {
      // 读到"当前"WebGL 画布指纹（= 录制器捕获的内容）。"上一窗口 WebGL 是否变化"
      // = 当前 vs 上一边界存下的基准 cur.glRef（每秒才 readPixels 一次，平时不读省开销）。
      let glFp = null;
      if (this._recordMirror) {
        try { glFp = this._glReadFp(this._recordMirror); } catch (e) { glFp = null; }
      }
      const glChanged = !!(cur && glFp !== null && cur.glRef !== null && glFp !== cur.glRef);
      if (cur && this._rec) {
        const sim = this._rec;
        const scene = noSceneFp ? '直传不采样' : (cur.changed ? '在动' : '【停滞】');
        console.log(
          '[record] 上1s ' + cur.count + '帧, 场景' + scene +
          ', WebGL' + (glChanged ? '在动' : '【停滞】') +
          ' | ' + sim.phase + ' step=' + sim.step +
          (sim.phase === 'pattern'
            ? ' 进度' + (sim.stepPx / (sim.stepLengths[sim.step] || 1)).toFixed(2)
            : ' uIndex=' + sim.uIndex)
        );
      }
      // 建新窗口：带上当次 WebGL 指纹作下次的比较基准；场景指纹以本次 fp 起步（-1 表示不采样）
      this._recLog = { at: now, count: 0, lastFp: fp, changed: false, glRef: glFp, glChanged: false };
    }
    cur = this._recLog;
    if (!noSceneFp && cur.lastFp !== null && cur.lastFp !== -1 && fp !== cur.lastFp) cur.changed = true;
    cur.lastFp = fp;
    cur.count += 1;
  },

  // 驱动录制器捕获一帧，返回 Promise<boolean>（false = 失败，调用方据此终止）。
  // 手动模式（fps:0）下 requestFrame() 是同步方法：直接把当前 Canvas 画面写进视频帧，
  // 不做节流——节流（20fps）由渲染循环的帧间隔保证。抛出异常才算失败。
  _requestFrame() {
    const r = this._recorder;
    if (!r || typeof r.requestFrame !== 'function') return Promise.resolve(false);
    try {
      r.requestFrame();
      return Promise.resolve(true);
    } catch (e) {
      console.warn('[record] requestFrame 异常', e);
      return Promise.resolve(false);
    }
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

  // 推进渲染模拟：进度按【真实墙钟时间】推进（与可见播放同款速度 100px/s ÷ speed），
  // 而不是按"每帧固定增量"——帧率掉下去（比如复杂图案）也不会让视频变慢/变短，
  // 录出的播放节奏和页面一致、总时长 = 总像素 ÷ 速度（与估算一致）。
  // 推进过程中把"完成的部分"烙进增量层，_renderRecordFrame 只做三层合成。
  _renderTick() {
    const sim = this._rec;
    if (!sim || this._recDone) return;
    const now = Date.now();
    const dt = Math.min((now - this._recLastTick) / 1000, 1); // 夹一下，防切后台回来跳一大截
    this._recLastTick = now;
    // 速度与可见播放同公式：100/speed px/s（speed=0.5 即 200px/s），估算时长同口径
    const px = (100 / this._recSpeed) * dt;

    if (sim.phase === 'pattern') {
      sim.stepPx += px;
      while (sim.step <= sim.endStep) {
        const len = sim.stepLengths[sim.step];
        const done = len > 0 ? sim.stepPx >= len : true; // 空步骤直接完成
        if (!done) break;
        this._commitPatternStep(sim, sim.step);
        sim.stepPx = len > 0 ? sim.stepPx - len : 0;
        sim.step += 1;
      }
      if (sim.step > sim.endStep) {
        if (this.userActions.length > 0) {
          sim.phase = 'user'; // 衔接用户内容回放
        } else {
          this._finishRecordRender();
        }
      }
    } else if (sim.phase === 'user') {
      const actions = this.userActions;
      let remaining = px;
      while (sim.uIndex < actions.length) {
        const a = actions[sim.uIndex];
        if (a.kind === 'fill') {
          // 填充无动画，当帧出现
          if (a.fill && a.fill.mask) this._commitUserFill(sim, a.fill);
          sim.uIndex += 1;
          continue;
        }
        // 笔画：按弧长生长
        const len = sim.uLens[sim.uIndex] || 0;
        if (len <= 0) {
          this._commitUserStroke(sim, a.stroke);
          sim.uIndex += 1;
          continue;
        }
        const need = len * (1 - sim.uProgress);
        if (remaining < need) {
          sim.uProgress += remaining / len;
          remaining = 0;
          break;
        }
        // 这一 tick 内画完当前笔画，余量留给下一条
        this._commitUserStroke(sim, a.stroke);
        remaining -= need;
        sim.uIndex += 1;
        sim.uProgress = 0;
      }
      if (sim.uIndex >= actions.length) this._finishRecordRender();
    }
    this._renderRecordFrame(sim);
  },

  // 把一个已完成的图案步骤烙进 lineLayer（之后不再重画）
  _commitPatternStep(sim, stepIndex) {
    const st = this.data.drawing.steps[stepIndex];
    if (!st || !st.strokes.length) return;
    const { scale, offsetX, offsetY } = this.getTransform();
    const ctx = sim.lineLayerCtx;
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);
    for (const stroke of st.strokes) this.drawStroke(ctx, stroke, 1, '#000', false, scale);
    ctx.restore();
  },

  // 把一个填充烙进 fillLayer（白底之上、图案线之下）
  _commitUserFill(sim, fill) {
    let tinted = sim.ui[fill.key];
    if (!tinted) {
      tinted = tintMask(fill.mask, fill.color, () => this.createLayer());
      sim.ui[fill.key] = tinted;
    }
    sim.fillLayerCtx.drawImage(tinted, 0, 0);
  },

  // 把一条已画完的用户笔画烙进 userLayer
  _commitUserStroke(sim, stroke) {
    this.drawUserStroke(sim.userLayerCtx, stroke, 1);
  },

  // 渲染模拟到达终点：置 _recDone（状态此时已全部烙进增量层，_renderRecordFrame 自然出定格画面）
  _finishRecordRender() {
    this._recDone = true;
  },

  // 自包含渲染 + 捕获循环（录制主体）。手动模式（fps:0）下循环自己当"时钟"：
  //   await requestFrame()  —— 同步捕获当前 WebGL 画面写进视频帧（不节流）
  //   render()              —— 推进一帧模拟并上传（供下一次捕获）
  //   补睡到帧间隔          —— 节流在此（20fps），视频时长 = 帧数/20 = 播放时长，不会偏快
  // 整个循环墙钟超 _recMaxDurSec 强制结束（绝不卡死/无限循环）。
  // 与可见播放互不影响；取消（_recording=false）时静默退出（_stopRecording 已收尾）。
  async renderRecordLoop() {
    const REC_FPS = 20;
    const frameMs = 1000 / REC_FPS;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    this._recErr = null;
    this._recDone = false;
    this._recLog = null;
    let n = 0;
    const cancelled = () => !this._recording;

    try {
      // 首帧：白底空场景（避免视频开头黑屏/上一帧残留）
      this._renderRecordFrame(this._rec);
      const fp0 = this._captureRecordFrame();
      this._logRecordFrame(fp0);

      let last = Date.now();
      const loopStart = last;
      // 模拟进度基准对齐到循环真正开始的时刻（startRecording 里隔过 createMediaRecorder+start 的 await）
      this._recLastTick = last;
      while (true) {
        if (cancelled()) return; // 长按取消：_stopRecording 已收尾
        // 安全网：整个循环墙钟超兜底上界就强制结束（正常由渲染播完先 break，这里只兜底）
        if (Date.now() - loopStart > (this._recMaxDurSec || 600) * 1000) {
          console.warn('[record] 循环超时，强制结束（可能录制不完整）');
          break;
        }

        // 捕获当前 WebGL 画面（手动模式：同步写一帧进视频，不节流）
        const frame = await this._requestFrame();
        if (cancelled()) return;
        if (frame === false) { this._recErr = 'requestFrame 失败'; break; }
        n += 1;

        // 播放全部渲染完成：再定格捕获几帧让结尾稳定，然后结束
        if (this._recDone) {
          for (let hold = 0; hold < 6; hold++) {
            if (cancelled()) return;
            if (!(await this._requestFrame())) break;
            const el = Date.now() - last;
            if (el < frameMs) await sleep(frameMs - el);
            last = Date.now();
          }
          break;
        }

        // 推进一帧模拟并画场景 + 上传（供下一次捕获）
        try {
          this._renderTick();
          const fp = this._captureRecordFrame();
          this._logRecordFrame(fp);
          // GL 上下文丢失（静默失效的头号来源）：录制器绑定的上下文已废，重建能否让录制器
          // 跟着走没有文档保证，索性丢弃让用户重试（日志已标明原因，好定位）。
          const m = this._recordMirror;
          if (m && m.gl && m.gl.isContextLost && m.gl.isContextLost()) {
            console.warn('[record] WebGL 上下文丢失，终止本次录制');
            this._recErr = 'WebGL 上下文丢失';
            break;
          }
        } catch (e) {
          console.warn('[record] 渲染一帧失败', e);
          this._recErr = '渲染失败：' + (e && e.message || e);
          break;
        }

        // 帧间隔节流：手动模式下这里就是视频帧率（20fps）的来源
        const elapsed = Date.now() - last;
        if (elapsed < frameMs) await sleep(frameMs - elapsed);
        last = Date.now();
      }

      if (cancelled()) return; // 取消路径 _stopRecording 已收尾
      // 无论成败都要 stop 录制器：成功 -> 存相册；出错 -> 丢弃并释放。
      // （之前出错时漏了 stop，录制器会空转到 duration 上界、_recording 卡死）
      if (this._recErr) {
        console.warn('[record] 录制中止：' + this._recErr);
        this._stopRecording(true);
      } else {
        this._stopRecording(false); // 正常播完 -> 存相册
      }
    } catch (e) {
      console.warn('[record] 渲染循环异常', e);
      if (!cancelled()) {
        this._recErr = String(e && e.message || e);
        this._stopRecording(true); // 异常 -> 丢弃
      }
    }
  },

  // 释放录制资源（取消 / 失败 / 结束后）
  releaseRecordMirror(mirror) {
    const m = mirror || this._recordMirror;
    if (!m || !m.gl) {
      this._recordMirror = null;
      return;
    }
    try {
      m.gl.deleteTexture(m.tex);
      m.gl.deleteProgram(m.prog);
    } catch (e) { /* 忽略 */ }
    this._recordMirror = null;
  },

  // 估算播放总时长（秒）：图案已播部分（100px/基准速度）+ 用户笔画总长，用于弹窗文案。
  // 与渲染循环用的同一套速度逻辑，所以估算 ≈ 实际录制时长。
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

  // 从头模拟渲染并录制。与可见播放解耦：可见页自己照常播，这里用独立的 _rec 状态从 0 渲染，
  // 离屏画一帧 -> requestFrame 捕获一帧，直到播完。用户无需盯着看录制过程。
  async startRecording(mirror) {
    if (this._recording || this._recordStarting || !mirror) return;
    this._recordStarting = true;
    this._recordMirror = mirror;

    // 构建渲染模拟状态：与可见播放同款速度（100px/s ÷ speed），但独立推进。
    // 进度按"真实墙钟时间"推进（见 _renderTick），帧率掉下去也不会让视频变慢/变短。
    const { drawing, totalSteps } = this.data;
    const endStep = this._patternEndStep != null
      ? Math.min(this._patternEndStep, totalSteps - 1)
      : totalSteps - 1;
    const stepLengths = drawing.steps.map(step => getStepLength(step));
    const uLens = this.userActions.map(a => a.kind === 'stroke' ? this.getStrokeLength(a.stroke.points || []) : 0);
    // 增量层：fillLayer=白底+已到达填充（图案线之下）、lineLayer=已完成图案步骤、
    // userLayer=已完成用户笔画（图案线之上）。每帧只合成这三层 + 一笔生长笔画，
    // 帧成本恒定不随图案长度增长（每帧重画全部笔画是掉到十几 fps 的主因）。
    const fillLayer = this.createLayer();
    const fillLayerCtx = fillLayer.getContext('2d');
    fillLayerCtx.fillStyle = '#FFFFFF';
    fillLayerCtx.fillRect(0, 0, mirror.width, mirror.height);
    const lineLayer = this.createLayer();
    const userLayer = this.createLayer();
    this._rec = {
      phase: 'pattern',
      step: 0, stepPx: 0,        // 图案：当前步骤 + 该步骤内已推进像素
      stepLengths, endStep,
      ui: {},                    // 填充上色缓存
      uIndex: 0, uProgress: 0, uLens,
      fillLayer, fillLayerCtx,
      lineLayer, lineLayerCtx: lineLayer.getContext('2d'),
      userLayer, userLayerCtx: userLayer.getContext('2d')
    };
    // duration 只是"最长录多久"的安全上界：给足余量，绝不让录制器先于模拟播完而自动 stop
    // 把图案截断（实机验证过：视频时长会以 duration 为准提前收尾，上界偏小就"画到一半就没了"）。
    // 正常结束永远由模拟播完后的主动 stop() 收尾，这里只是最后兜底。
    const est = this.estimatePlaybackDuration();
    this._recMaxDurSec = Math.max(60, Math.min(7200, Math.ceil(est * 4) + 10));
    this._recDone = false;
    this._recErr = null;
    this._recSpeed = this.data.speed;   // 录制期间固定速度（页面没有速度入口，锁住防意外）
    this._recLastTick = Date.now();     // 上次推进模拟的墙钟时间戳（按真实时间推进进度）

    // 场景绘制目标 = 【可见 2D 画布】（播放一直在用它、真机证明可靠）。2D 画布常驻可见、
    // 永远不做透明度切换——不可见/透明画布的位图不保证继续合成，是"录到 1 秒就冻住"的
    // 头号嫌疑（实机日志"场景停滞、进度在推进"即此形态）。读取端直接 sceneCtx.getImageData()
    // 读 context 自己的位图，不经过画布合成，读到的必是刚画上去的最新帧。
    if (this.outlineCanvas && this.outlineCtx) {
      mirror.sceneCanvas = this.outlineCanvas;
      mirror.sceneCtx = this.outlineCtx;
    } else {
      this._recordStarting = false;
      return;
    }
    // 能力探测：texImage2D 直传 2D canvas（跳过 getImageData 的 GPU→CPU→GPU 往返，
    // 持续 ~58MB/s 是"~1s 后 WebGL 停更"的头号嫌疑）。支持则走直传，否则回退 getImageData。
    // 首帧场景先画一次（探测要读到非空内容）
    this._renderRecordFrame(this._rec);
    mirror.texCanvas = this._probeCanvasTexture(mirror);

    // 暂停可见播放：它的定时器也在往 outlineCanvas 上画，必须停掉避免与录制渲染互踩。
    // 记录暂停状态，录完 _restoreVisiblePlay 恢复（从当前进度续播）。
    if (this.data.playing) {
      this._pausedForRecord = true;
      if (this.playTimer) { clearInterval(this.playTimer); this.playTimer = null; }
    } else {
      this._pausedForRecord = false;
    }

    // 创建录制器并启动（recorder 对着 WebGL 录制画布；2D 画布常驻可见，无需切换显隐）
    let recorder = null;
    try {
      // fps: 0 = 手动录制模式：start 后需主动 requestFrame 才录一帧（同步方法）。
      // 自动模式（fps>0）下该设备 requestFrame 报 "is not a function"（实机日志 APIScopeError），
      // 手动模式是唯一可用的录制路径。帧率由渲染循环的帧间隔控制（20fps）。
      recorder = wx.createMediaRecorder(mirror.canvas, {
        width: mirror.width,
        height: mirror.height,
        fps: 0
      });
      await this._mediaRecorderStart(recorder);
    } catch (e) {
      console.warn('[record] createMediaRecorder 启动失败', e);
      this._restoreVisiblePlay();
      this.releaseRecordMirror(mirror);
      wx.showModal({
        title: '提示',
        content: '录制启动失败：' + (e && e.message || e),
        showCancel: false
      });
      this._recordStarting = false;
      return;
    }
    this._recorder = recorder;
    this._recording = true;
    this._recordStarting = false;

    // 渲染循环跑自己的节奏（20fps）；可见播放已暂停（共用场景画布），录完自动恢复
    this.renderRecordLoop();
    wx.showToast({ title: '正在录制视频，长按画布可取消', icon: 'none', duration: 2000 });
  },

  // 停止录制并收尾（正常结束 / 长按取消 / 异常 共用）。异步：等 stop 出结果再释放资源。
  // 出错或取消则丢弃不存；正常则存相册。
  async _stopRecording(discard) {
    if (!this._recording && !this._recorder) return;
    const err = this._recErr;
    const shouldDiscard = discard || !!err;
    this._recording = false; // 让渲染循环停止推进（静默退出）
    const recorder = this._recorder;
    this._recorder = null;
    this._rec = null;
    this._recErr = null;
    this._recordDiscard = shouldDiscard;
    // 低版本兼容：<2.16.1 的 stop 不返回 Promise（文档给了 on('stop') 兼容写法），两种都兜住；
    // 结果路径字段以官方文档的 tempFilePath 为准
    const done = new Promise((resolve) => {
      if (recorder && recorder.on) recorder.on('stop', resolve);
      try {
        const p = recorder.stop();
        if (p && typeof p.then === 'function') p.then(resolve, resolve);
        else resolve();
      } catch (e) {
        resolve();
      }
    });
    const res = await done;
    this.releaseRecordMirror(this._recordMirror);
    if (recorder && typeof recorder.destroy === 'function') {
      try { recorder.destroy(); } catch (e) { /* 忽略 */ }
    }
    // 恢复可见播放（录制期间暂停了，从当前进度续播）
    this._restoreVisiblePlay();
    if (shouldDiscard) {
      wx.showToast({ title: err ? '录制出错，已取消' : '已取消保存', icon: 'none' });
      return;
    }
    this._onRecordStopped(res && res.tempFilePath);
  },

  // 恢复录制前暂停的可见播放（startRecording 里记了 _pausedForRecord）。
  _restoreVisiblePlay() {
    const wasPaused = !!this._pausedForRecord;
    this._pausedForRecord = false;
    if (!wasPaused || !this.outlineCtx || !this.data.drawing) return;
    this.setData({ playing: true });
    this.drawOutlineLayer();
    if (this._phase === 'user') {
      this.startUserPlayback(false); // 从当前 userIndex/userProgress 续播
    } else {
      this.startPlay();              // 图案阶段从当前 step/progress 续播
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
    // 录制中退出页面：丢弃（不存相册），释放 WebGL 资源
    if (this._recording || this._recorder) {
      this._stopRecording(true);
    } else {
      this._recording = false;
      this.releaseRecordMirror(this._recordMirror);
    }
  },

  // 画布点击：单击 停止/启动播放，双击 显示/隐藏轮廓
  onCanvasTap() {
    // 录制中点画布：不响应（播放与录制共用一张场景画布，避免互踩）；取消走长按
    if (this._recording || this._recordStarting) return;
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
