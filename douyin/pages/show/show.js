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
    // 是否正在录制（右下角悬浮按钮的录制态：显示红点，点击可取消）
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

  // ========== 录制发布：右下角悬浮按钮 -> 录完这段播放 -> 调抖音发布器发视频 ==========
  // 抖音发布必须走 <button open-type="uploadDouyinVideo">：点击触发异步钩子
  // onUploadDouyinVideo，钩子内 await 录完后 return {videoPath} 交给抖音官方发布器
  // （可加文字贴纸）。录制机制与官方示例（minicode tt-create-media-recorder）一致：
  //   场景画在【可见 2D 画布】上（录制器直接采它，官方示例同款；离屏 WebGL 镜像路线
  //   在 SDK 4.40 实机验证不可用——见 buildRecordMirror 注释），渲染进度用独立的 _rec
  //   模拟状态从 0 推进，时钟 = canvas.requestAnimationFrame（录制器附加后画布采样
  //   跟着 rAF 走，不调它录出来就是首帧不动）。
  //   自动模式 fps:20，录制器自己按 fps 采画布出视频帧；收口用 onStop 回调取
  //   res.filePath（on('stop') 在实机不存在，之前 stop 结果恒 undefined 即此因）。
  //   录制期间可见页暂停播放（共用画布），录完自动恢复；用户盯着画布看就是实时预览。
  //   录制中再点按钮 = 取消（丢弃）。
  _recorder: null,        // tt.createMediaRecorder 实例
  _recordMirror: null,    // 录制目标 {canvas(可见2D), sceneCanvas, sceneCtx, gl:null, width, height}
  _recording: false,      // start 成功后为 true；请求 stop 时立刻置 false（兼作防重复 stop 的闸）
  _recordStarting: false, // start() 的 await 窗口内为 true，防二次进入
  _recordAbort: false,    // 启动窗口内被点取消：录制器就绪后立刻收尾丢弃
  _recordDiscard: false,  // 点按钮取消 = true，stop 回来后丢弃不发布
  _rec: null,             // 录制渲染模拟状态 {phase, step, progress, stepLengths, endStep, ui, uIndex, uProgress, uLens}
  _recMaxDurSec: 600,     // 录制器兜底时长上界（秒），同时用作渲染循环的超时保护
  _recDone: false,        // 渲染循环已到达终点（定格收尾用）
  _recErr: null,          // 渲染循环捕获的错误信息（非空 = 异常终止，丢弃不存）
  _recWaiter: null,       // 发布钩子在等录制结束的 {resolve, reject}

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
      tt.setNavigationBarTitle({
        title: payload.drawing.name || '放映'
      });
    } else {
      this._patternEndStep = null; // 长按卡片进入：无上限，完整播放
      this.loadDrawing(drawingId);
    }

    // 获取屏幕尺寸，计算 Canvas 大小（正方形）
    const systemInfo = tt.getSystemInfoSync();
    const rpxToPx = systemInfo.windowWidth / 750;

    // 容器 margin: 20rpx + padding: 20rpx，每边 40rpx，两边 80rpx
    const containerMargin = 80 * rpxToPx;
    const canvasSize = systemInfo.windowWidth - containerMargin;

    this.setData({
      canvasSize
    });
  },

  onReady() {
    const query = tt.createSelectorQuery().in(this);
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
    tt.showLoading({ title: '加载中...' });
    tt.request({
      url: config.getDrawingUrl(id),
      success: (res) => {
        const drawing = res.data;
        tt.hideLoading();
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
        tt.hideLoading();
        console.error('加载图案失败:', err);
        tt.showToast({
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
  // 抖音的 createOffscreenCanvas 对 {type,width,height} 里的宽高不保证生效（那是微信
  // 基础库的扩展形式），会导致离屏缓存尺寸错误——之前步骤画进错尺寸的 buffer，
  // drawImage 回可见画布时就"消失"（只看到直接绘制的当前步）。这里创建后显式
  // 设置位图宽高（与 onReady 里可见画布同款写法），并对只认位置参数的旧库兜底。
  createLayer() {
    let c;
    try {
      c = tt.createOffscreenCanvas({
        type: '2d',
        width: this.canvasWidth,
        height: this.canvasHeight
      });
    } catch (e) {
      // 兜底：部分基础库 createOffscreenCanvas 只接受位置参数 (width, height)
      c = tt.createOffscreenCanvas(this.canvasWidth, this.canvasHeight);
    }
    if (!c) return c;
    // 显式锁定位图尺寸（options 里传的宽高可能没被采纳）
    c.width = this.canvasWidth;
    c.height = this.canvasHeight;
    return c;
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
  // 抖音适配：所有图案内容都直接绘制到可见画布（不走离屏缓存 blit）——
  // 抖音上"离屏画布 drawImage 回可见画布"不可靠，缓存内容会整片消失
  // （表现：进入下一步后之前步骤/灰色轮廓都没了，只剩当前步）。
  // 直绘与当前步共用同一套 viewBox 变换 + drawStroke，结果与微信版一致。
  // 性能：图案笔画量级下每帧直绘全部已完成内容开销可接受（播放本就 50ms/tick 节奏）。
  drawOutlineLayer() {
    if (!this.outlineCtx || !this.data.drawing) return;

    const { drawing, currentStep, progress } = this.data;
    const ctx = this.outlineCtx;
    const { scale, offsetX, offsetY } = this.getTransform();

    ctx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);

    // 灰色轮廓底图（双击切换显示）：直接绘制，全图案 @15%
    if (this.data.showOutline) {
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
    }

    // 放映回放 phase 2：填充垫在图案黑线之下（涂色本效果），先画填充再画图案线条
    const inUserPhase = this._phase === 'user' || this._phase === 'done';
    if (inUserPhase) this.drawUserFills(ctx);

    // 已完成步骤直接绘制（0..currentStep-1）
    if (currentStep > 0) {
      ctx.save();
      ctx.translate(offsetX, offsetY);
      ctx.scale(scale, scale);
      for (let i = 0; i < currentStep; i++) {
        const st = drawing.steps[i];
        if (!st) continue;
        for (const stroke of st.strokes) {
          this.drawStroke(ctx, stroke, 1, '#000', false, scale);
        }
      }
      ctx.restore();
    }

    // 当前步骤的动画部分（参考图案）
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
      // 抖音用 extra 传参（重开当前页）；id 含多级路径，必须整体编码
      extra: `id=${encodeURIComponent(drawingId)}`,
      imageUrl: drawing && drawing.thumbnail ? config.getAssetUrl(drawing.thumbnail) : undefined
    };
  },

  // ========== 录制发布：右下角悬浮按钮（open-type="uploadDouyinVideo"） ==========
  // 抖音发布必须走该 open-type：点击触发本钩子，钩子内 await 录完（离屏自包含渲染循环）
  // 后 return {videoPath, stickersConfig}，交给抖音官方发布器（用户可加贴纸/标题后发布）。
  // 首次点击=开始录制；录制中/启动中再点=取消（丢弃）。录制期间可见页照常播放，互不影响。
  async onUploadDouyinVideo(uploadOptions) {
    // 正在录制/启动中再点 = 取消（丢弃不发布）。
    if (this._recording || this._recordStarting) {
      if (this._recording && this._recorder) {
        this._stopRecording(true);
      } else {
        // 还在启动窗口内（录制器尚未就绪）：标记中止，startRecording 起来后立刻收尾
        this._recordAbort = true;
      }
      return null;
    }
    if (!this.data.drawing || !this.canvasesReady) {
      return null;
    }
    // 环境能力检查：createMediaRecorder + 离屏 canvas，缺一不可
    if (typeof tt.createMediaRecorder !== 'function' || !tt.createOffscreenCanvas) {
      tt.showModal({
        title: '提示',
        content: '当前抖音版本较低，暂不支持录制发布',
        showCancel: false
      });
      return null;
    }
    // 同步打开会话窗口：后续 await 期间（建 mirror / 启动录制器 / 录制中 / 收尾）的点按都
    // 走取消分支，防止二次进入再开一路录制（_recordStarting 直到 _stopRecording 结算才清除）
    this._recordStarting = true;
    this._recordAbort = false;
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
      tt.showModal({
        title: '提示',
        content: '无法初始化录制：' + result.reason,
        showCancel: false
      });
      this._recordStarting = false; // 建 mirror 失败：关会话窗口，按钮恢复可点
      this._recordAbort = false;
      return null;
    }
    const mirror = result.mirror;

    // 开始录制并等待录完（返回视频临时路径；取消/出错则 reject）。
    // 录完把路径交给抖音发布器；发布器被用户取消或失败时回退保存相册（见返回的 fail 回调）。
    let videoPath;
    try {
      videoPath = await this._startRecordAndAwait(mirror);
    } catch (e) {
      return null; // 取消或出错：不开发布器
    }
    if (!videoPath) return null;

    return {
      videoPath,
      success: (cb) => {
        console.log('[publish] 发布成功', cb);
        tt.showToast({ title: '已发布到抖音', icon: 'success' });
      },
      fail: (cb) => {
        console.log('[publish] 发布失败/取消', cb);
        // 发布器被取消或失败：回退保存相册，让用户至少留下视频
        this._onRecordStopped(videoPath);
      },
      complete: (cb) => {
        console.log('[publish] complete', cb);
      }
    };
  },

  // 开始录制并等待其结束：录完 resolve 视频临时路径；取消/出错 reject。
  // 供 onUploadDouyinVideo await——录制跑在后台，期间用户可再点按钮取消。
  _startRecordAndAwait(mirror) {
    return new Promise((resolve, reject) => {
      this._recWaiter = { resolve, reject };
      // startRecording 内部建 _rec、启动录制器并跑 renderRecordLoop（fire & forget）；
      // 循环结束后经 _stopRecording 结算本 waiter（resolve 视频路径 / reject 取消出错）。
      this.startRecording(mirror);
    });
  },

  // 页面下拉 = 重新播放（从头开始：图案 + 用户作品）。录制/发布走右下角悬浮按钮。
  onPullDownRefresh() {
    tt.stopPullDownRefresh();
    // 录制中：重播会和录制抢场景画布，忽略（取消请点右下角按钮）
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

  // 创建录制目标：【可见 2D 画布】（outlineCanvas）本身。
  // 实机结论（2026-11-26）：该抖音版本录制器的手动模式（requestFrame）未实现
  // （APIScopeError: o.requestFrame is not a function），自动模式又采不到"start() 后
  // 由 JS 上传纹理的 WebGL 画布"（drawing buffer 冻结、readPixels 恒不变，实机日志
  // 场景/WebGL 双停滞）——WebGL 镜像路线在此设备两条腿都断了。
  // 改录可见 2D 画布（官方文档示例的用法）：它的位图保证新鲜（用户看到动画在动
  // 即证明合成正常），不经过 GL 上下文、不存在被 native 接管的问题。
  // 录制期间模拟直接画在这张画布上（_renderRecordFrame），录制器自己采样（自动模式
  // 按 fps）或经 requestFrame 捕获（手动模式，若可用）。
  async buildRecordMirror() {
    const w = this.canvasWidth, h = this.canvasHeight;
    if (!w || !h) return { ok: false, reason: '画布尺寸未就绪' };
    if (!this.outlineCanvas || !this.outlineCtx) return { ok: false, reason: '画布未就绪' };
    // 打 SDK 版本：requestFrame 需要 2.52.0+，低于它的版本只能走自动模式，日志里一眼可辨
    let sdk = 'unknown';
    try { sdk = tt.getSystemInfoSync().SDKVersion || 'unknown'; } catch (e) { /* 忽略 */ }
    console.log('[record] 使用可见 2D 画布直录, SDKVersion=' + sdk);
    return {
      ok: true,
      mirror: {
        canvas: this.outlineCanvas,
        sceneCanvas: this.outlineCanvas,
        sceneCtx: this.outlineCtx,
        gl: null,
        width: w,
        height: h
      }
    };
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

  // 录制帧捕获 + 诊断指纹。
  // 2D 直录模式（m.gl 为 null）：录制器自己采样可见画布，这里无纹理要上传，
  // 只按秒级节流读一次场景位图算指纹（每帧 getImageData 太贵，且每秒日志才用一次）。
  // WebGL 镜像模式（旧路径，部分设备保留）：
  //   A) texImage2D 直传 2D canvas 对象（m.texCanvas）：GPU 直接读 2D 画布，省 getImageData 往返
  //   B) 回退 getImageData（部分基础库不支持 canvas 直传时）
  // 返回场景位图指纹（诊断用）：画面在动则逐帧变化、停住则不变。
  _captureRecordFrame() {
    const m = this._recordMirror;
    if (!m || !m.sceneCtx) return 0;
    if (!m.gl) {
      // 2D 直录：采样场景指纹（节流 500ms——必须比日志窗口 1s 短，否则采样与窗口
      // 相位锁死、changed 恒 false 误报"停滞"；步长 32=每 8 像素一点，细线条也能采到）
      const now = Date.now();
      if (m._lastFpAt && now - m._lastFpAt < 500) return m._lastFp || 0;
      try {
        const img = m.sceneCtx.getImageData(0, 0, m.width, m.height);
        const px = img.data;
        let fp = 0;
        for (let i = 0; i < px.length; i += 32) fp = (Math.imul(fp, 31) + px[i]) | 0;
        m._lastFp = fp;
        m._lastFpAt = now;
        return fp;
      } catch (e) {
        return 0;
      }
    }
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
  // 2D 直录模式（无 GL）没有纹理上传，直接返回 false。
  _probeCanvasTexture(m) {
    if (!m || !m.gl) return false;
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
    if (!m || !m.gl) return null;
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
      // 读到"当前"录制目标画面指纹。WebGL 镜像模式：readPixels 读 WebGL 画布（= 录制器
      // 捕获的内容），与场景指纹对照可定位"上传停更"。2D 直录模式（无 GL）：录制器直接
      // 采样场景画布，两者是同一张，只看场景指纹即可。
      const m = this._recordMirror;
      let glFp = null;
      if (m && m.gl) {
        try { glFp = this._glReadFp(m); } catch (e) { glFp = null; }
      }
      const glChanged = !!(cur && glFp !== null && cur.glRef !== null && glFp !== cur.glRef);
      if (cur && this._rec) {
        const sim = this._rec;
        const scene = noSceneFp ? '直传不采样' : (cur.changed ? '在动' : '【停滞】');
        const glPart = m && !m.gl ? '' :
          (', WebGL' + (glChanged ? '在动' : '【停滞】'));
        console.log(
          '[record] 上1s ' + cur.count + '帧, 场景' + scene + glPart +
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

  // 自包含渲染循环（录制主体）。机制与官方示例（minicode tt-create-media-recorder）一致：
  //   时钟 = canvas.requestAnimationFrame —— 录制器附加后画布的提交/采样跟着 rAF 走，
  //         不调它录制内容就是首帧不动（实机"场景停滞"的病根）
  //   每 tick = _renderTick 按墙钟推进一帧模拟（节奏=真实时间，屏幕 fps 波动也不影响时长）
  //   录制器自己按 fps 采画布出视频帧（自动模式，SDK 4.40 实机无 requestFrame 手动模式）
  // 播完再等 6 个 rAF tick 让尾部定格稳定，然后 _stopRecording 收尾。
  // 安全网：墙钟超 _recMaxDurSec 强制结束；取消（_recording=false）时 rAF 静默退出。
  renderRecordLoop() {
    this._recErr = null;
    this._recDone = false;
    this._recLog = null;
    const loopStart = Date.now();
    this._recLastTick = loopStart;
    let holdFrames = 0;

    // 结束渲染循环：正常 -> 交给发布器；出错 -> 丢弃。取消路径 _stopRecording 已收尾。
    const finish = () => {
      if (!this._recording) return;
      console.log('[record] 循环结束 reason=' +
        (this._recErr ? ('err:' + this._recErr) : '播放完成'));
      this._stopRecording(!!this._recErr);
    };

    const tick = () => {
      if (!this._recording) return; // 取消：_stopRecording 已收尾
      try {
        if (this._recDone) {
          // 尾部定格：再等几个 rAF tick 让结尾帧稳定
          if (++holdFrames >= 6) { finish(); return; }
        } else {
          this._renderTick(); // 推进一帧模拟并把场景画到可见画布（_renderTick 末尾自绘）
        }
        this._logRecordFrame(this._captureRecordFrame());
      } catch (e) {
        console.warn('[record] 渲染一帧失败', e);
        this._recErr = '渲染失败：' + (e && e.message || e);
        finish();
        return;
      }
      if (this._recErr) { finish(); return; } // onError 回调置的错误
      // 安全网：整个循环墙钟超兜底上界就强制结束
      if (Date.now() - loopStart > (this._recMaxDurSec || 600) * 1000) {
        console.warn('[record] 循环超时，强制结束（可能录制不完整）');
        finish();
        return;
      }
      // 下一帧：canvas.requestAnimationFrame（官方示例同款；个别环境缺失时退 setTimeout 50ms）
      const c = this._recordMirror && this._recordMirror.sceneCanvas;
      if (c && typeof c.requestAnimationFrame === 'function') c.requestAnimationFrame(tick);
      else setTimeout(tick, 50);
    };

    // 首帧：白底空场景（避免视频开头黑屏/上一帧残留），立即入队第一拍
    this._renderRecordFrame(this._rec);
    this._logRecordFrame(this._captureRecordFrame());
    tick();
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


  // 从头模拟渲染并录制。与可见播放解耦：可见页自己照常播，这里用独立的 _rec 状态从 0
  // 渲染到【可见 2D 画布】（录制器直接采它），直到播完。
  async startRecording(mirror) {
    if (this._recording || !mirror) return;
    this._recordStarting = true; // 会话窗口：钩子可能在建 mirror 前已开，录制就绪(见下)或失败收尾时清除
    this._recordMirror = mirror;
    // 启动窗口内已被点取消（此时录制器尚未创建）：直接放弃，释放已建的录制画布，清窗口
    if (this._recordAbort) {
      this._recordStarting = false;
      this._recordAbort = false;
      this.releaseRecordMirror(mirror);
      this._rejectRecordWaiter('cancelled');
      return;
    }

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
      this._rejectRecordWaiter('画布未就绪');
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

    // 创建录制器并启动（recorder 直接对着【可见 2D 画布】——buildRecordMirror 返回的
    // mirror.canvas 就是它，官方文档示例的用法）。
    // 与官方示例（minicode tt-create-media-recorder）完全一致：
    //   单个录制器、自动模式（fps:20）、事件用 onStart/onStop/onError 方法（不是 on('start')——
    //   on('stop') 不存在的实锤：之前 stop 结果永远 undefined 就是没接住回调）。
    //   不用手动模式：SDK 4.40 实机 requestFrame 报 APIScopeError（代理包装函数存在但原生
    //   未实现），且"先建手动再销毁重建自动"会在同一 canvas 上挂两个录制器，行为未定义。
    let recorder = null;
    try {
      recorder = tt.createMediaRecorder(mirror.canvas, {
        width: mirror.width,
        height: mirror.height,
        videoBitsPerSecond: 1000,
        gop: 12,
        fps: 20
      });
      if (typeof recorder.onStart === 'function') recorder.onStart(() => {
        console.log('[record] recorder onStart');
      });
      if (typeof recorder.onStop === 'function') recorder.onStop((res) => {
        console.log('[record] recorder onStop res=' +
          (function () { try { return JSON.stringify(res); } catch (e) { return String(res); } })());
        if (this._stopResolver) this._stopResolver(res);
      });
      if (typeof recorder.onError === 'function') recorder.onError((e) => {
        console.error('[record] recorder onError', e);
        const msg = (e && (e.errMsg || e.message)) || String(e);
        if (!this._recErr) this._recErr = '录制器错误：' + msg;
      });
      await this._mediaRecorderStart(recorder);
    } catch (e) {
      console.warn('[record] createMediaRecorder 启动失败', e);
      this._restoreVisiblePlay();
      this.releaseRecordMirror(mirror);
      tt.showModal({
        title: '提示',
        content: '录制启动失败：' + (e && e.message || e),
        showCancel: false
      });
      this._recordStarting = false;
      this._rejectRecordWaiter('录制启动失败');
      return;
    }
    // 启动窗口内被点取消（await start 期间）：录制器就绪后立刻收尾丢弃，不跑渲染循环
    if (this._recordAbort) {
      this._recordAbort = false;
      this._recordStarting = false;
      this._recorder = recorder;
      this._recording = true; // 让 _stopRecording 的守卫放行
      this._restoreVisiblePlay();
      this._stopRecording(true);
      return;
    }
    this._recorder = recorder;
    this._recording = true;
    this._recordStarting = false;
    this.setData({ recording: true }); // 右下角按钮切录制态（红点）

    // 渲染循环跑自己的节奏（20fps）；可见播放已暂停（共用场景画布），录完自动恢复
    this.renderRecordLoop();
    tt.showToast({ title: '正在录制视频，点右下角按钮可取消', icon: 'none', duration: 2000 });
  },

  // 拒绝发布钩子的录制等待（启动失败路径用）：让 onUploadDouyinVideo 拿到 reject 而返回 null。
  _rejectRecordWaiter(reason) {
    const w = this._recWaiter;
    this._recWaiter = null;
    if (w && w.reject) w.reject(reason);
  },

  // 停止录制并收尾（正常结束 / 点按钮取消 / 异常 共用）。异步：等 stop 出结果再释放资源。
  // 出错或取消则丢弃（reject 发布钩子的等待）；正常则把视频临时路径 resolve 给发布钩子，
  // 由 onUploadDouyinVideo 交给抖音发布器（发布器失败才回退 _onRecordStopped 存相册）。
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
    this.setData({ recording: false }); // 右下角按钮恢复常态
    // 等待 onStop 回调出结果（官方示例的收口方式）。onStop 已在 startRecording 里挂好，
    // 回调会 resolve 这里挂的 _stopResolver。5s 超时兜底：个别实现 stop 后不触发 onStop，
    // 避免永久挂起（超时则按"无结果"走下方分支，如实报"生成失败"）。
    // 之前用 recorder.on('stop') + 读 res.tempFilePath——on('stop') 不存在，回调永远不
    // 触发，stop 结果恒 undefined，是"录了却拿不到视频"的直接原因。
    const done = new Promise((resolve) => {
      let settled = false;
      const t = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, 5000);
      this._stopResolver = (res) => { if (!settled) { settled = true; clearTimeout(t); resolve(res); } };
      try {
        const p = recorder.stop();
        if (p && typeof p.then === 'function') {
          // 个别实现 stop 返回 Promise 直接带结果
          p.then((r) => { if (!settled) { settled = true; clearTimeout(t); resolve(r); } },
                 () => { /* 走 onStop 或超时 */ });
        }
      } catch (e) {
        if (!settled) { settled = true; clearTimeout(t); resolve(null); }
      }
    });
    const res = await done;
    this._stopResolver = null;
    // 决定性日志：onStop 的完整结果（官方示例字段为 filePath，文档为 tempFilePath，两者都打）
    console.log('[record] stop 结果 err=' + (err || 'none') + ' res=' +
      (function () { try { return JSON.stringify(res); } catch (e) { return String(res); } })());
    this.releaseRecordMirror(this._recordMirror);
    if (recorder && typeof recorder.destroy === 'function') {
      try { recorder.destroy(); } catch (e) { /* 忽略 */ }
    }
    // 恢复可见播放（录制期间暂停了，从当前进度续播）
    this._restoreVisiblePlay();
    // 结算发布钩子的录制等待
    const w = this._recWaiter;
    this._recWaiter = null;
    if (!w) return;
    if (shouldDiscard) {
      tt.showToast({ title: err ? '录制出错，已取消' : '已取消', icon: 'none' });
      if (w.reject) w.reject(err || 'cancelled');
      return;
    }
    // 视频路径：官方示例 onStop 回调字段为 filePath，文档为 tempFilePath，两个都取
    const path = (res && (res.filePath || res.tempFilePath));
    if (path) {
      if (w.resolve) w.resolve(path);
    } else {
      tt.showModal({
        title: '提示',
        content: '视频生成失败，请重试',
        showCancel: false
      });
      if (w.reject) w.reject('video generate failed');
    }
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

  // 发布器兜底：抖音发布被取消/失败时，把视频存相册（首次弹授权，拒绝则给引导）
  _onRecordStopped(tempVideoPath) {
    if (!tempVideoPath) {
      tt.showModal({
        title: '提示',
        content: '视频生成失败，请重试',
        showCancel: false
      });
      return;
    }
    tt.saveVideoToPhotosAlbum({
      filePath: tempVideoPath,
      success: () => {
        tt.showToast({ title: '已保存到相册', icon: 'success' });
      },
      fail: (err) => {
        if (err && err.errMsg && /auth|deny|cancel/.test(err.errMsg)) {
          tt.showModal({
            title: '保存失败',
            content: '需要你的授权才能保存到相册',
            confirmText: '去设置',
            success: (m) => {
              if (m.confirm) tt.openSetting();
            }
          });
        } else {
          tt.showModal({
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
    // 录制中退出页面：丢弃（不发布），释放资源；_stopRecording 会 reject 发布钩子的等待（不悬挂）
    if (this._recording || this._recorder) {
      this._stopRecording(true);
    } else {
      this._recording = false;
      this._recWaiter && (this._recWaiter.reject('page unload'), this._recWaiter = null);
      this.releaseRecordMirror(this._recordMirror);
    }
  },

  // 画布点击：单击 停止/启动播放，双击 显示/隐藏轮廓
  onCanvasTap() {
    // 录制中点画布：不响应（播放与录制共用一张场景画布，避免互踩）；取消走右下角按钮
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
