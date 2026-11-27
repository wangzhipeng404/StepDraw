// 一笔一笔 StepDraw - 分栏(横屏/平板/PC)右侧的绘制工作台组件
//
// 布局（用户要求）：
//   上 —— 绘画工具（画笔类型 / 自定义颜色 / 自定义粗细 / 撤销 / 清除）
//   右 —— 保存类按钮（保存图片 / 回放 / 录制视频 / 导入JSON / 导出JSON）
//   下 —— 播放控制（轮廓 / 上一步·播放·下一步·重播 / 单步循环 / 倍速 / 进度条）
//   中 —— 绘制区域，占满中间所有剩余空间，整块都可以绘制（canvas 自适应填满成矩形，
//         图案按 getTransform 居中留边距，边距区域也能画）。
//
// 逻辑与竖屏详情页 DrawingDetail 同一套（复用 useDrawingPlayer / useDrawingCanvas /
// canvas.ts），区别只在布局与 canvas 填满整块。竖屏详情页保持原样、互不影响。
//
// 新增（参考小程序 show 页）：
//   - 回放：图案逐笔生长播完 + 用户内容（填充瞬间出现、笔画按弧长生长）按时间序回放，
//           独立 rAF 循环驱动，与正常播放互不影响；结束回到正常状态。
//   - 录制视频：canvas.captureStream + MediaRecorder 录"所见"（含回放/绘制），
//           录完直接触发浏览器下载（web 没有"存相册"概念）。
//   - 导入JSON：读一个图案 JSON 文件设为当前绘制图案（替换右侧）。
//
// web 端按用户要求**不做分享**。

import { useEffect, useState, useRef, useCallback } from 'react';
import type { Drawing, UserAction, UserStroke, StrokeType, UserFill } from '../types';
import { STROKE_TYPES } from '../types';
import { useDrawingPlayer } from '../hooks/useDrawingPlayer';
import { useDrawingCanvas } from '../hooks/useDrawingCanvas';
import { toImagePoint, applyViewTransform, zoomAnchored, IDENTITY_VIEW, buildUnderlay, floodFill, lassoFill, isPointInMask, pickLineForRecolor, pickUserActionIndex, thinStrokePoints, snapStrokeToLine, calculateStrokeLengths, getStrokePlayLength, startCanvasRecording, downloadBlob } from '../utils/canvas';
import type { ViewTransform } from '../utils/canvas';
import { useStudio } from '../context/StudioContext';
import preIcon from '../assets/pre.png';
import playIcon from '../assets/play.png';
import stopIcon from '../assets/stop.png';
import nextIcon from '../assets/next.png';
import refreshIcon from '../assets/refresh.png';
import resetIcon from '../assets/reset.png';
import outlineIcon from '../assets/cat-solid.png';
import outlineIconActive from '../assets/cat-solid-active.png';
import undoIcon from '../assets/undo.png';
import clearIcon from '../assets/clear.png';
import saveIcon from '../assets/save.png';
import stepLoopIcon from '../assets/stepLoop.png';
import stepLoopIconActive from '../assets/stepLoopActive.png';
import './DrawingStudio.css';

// 视图缩放范围
const MIN_SCALE = 0.3;
const MAX_SCALE = 5;
const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

// 活动指针（pan / pinch 用）
interface ActivePointer { id: number; x: number; y: number; }
const getPointerDistance = (a: ActivePointer, b: ActivePointer) => Math.hypot(b.x - a.x, b.y - a.y);

// 回放模拟状态（逐帧推进，与小程序 show 页 _rec 同套速度逻辑）
interface ReplaySim {
  phase: 'pattern' | 'user';
  step: number;
  stepPx: number;
  stepLengths: number[];
  endStep: number;
  uIndex: number;
  uProgress: number;
  uLens: number[];
  last: number;
  done: boolean;
}

interface DrawingStudioProps {
  drawing: Drawing;
  // 分栏模式下由 SplitLayout 注入：切换左侧图案导航抽屉（整页模式不传，按钮不显示）
  onToggleNav?: () => void;
}

export function DrawingStudio({ drawing, onToggleNav }: DrawingStudioProps) {
  const { state, actions, getGlobalProgress } = useDrawingPlayer({ drawing, mode: 'continuous' });
  const { outlineRef, historyRef, brushRef, render, exportToDataURL } = useDrawingCanvas();
  const { selectDrawing } = useStudio();
  const renderRef = useRef(render);
  renderRef.current = render;

  // 用户操作栈：笔画与填充按时间序混排
  const [userActions, setUserActions] = useState<UserAction[]>([]);
  // 撤销增量栈：add 追加 / erase 按位删除 / clear 整体，撤销即逆操作
  type UndoDelta =
    | { type: 'add' }
    | { type: 'erase'; index: number; action: UserAction }
    | { type: 'clear'; actions: UserAction[] };
  const undoStackRef = useRef<UndoDelta[]>([]);
  // userActions 的同步镜像（快速连续操作时闭包里的 state 已过期）
  const userActionsRef = useRef<UserAction[]>([]);
  useEffect(() => { userActionsRef.current = userActions; }, [userActions]);

  const pushAction = useCallback((action: UserAction) => {
    const next = [...userActionsRef.current, action];
    userActionsRef.current = next;
    undoStackRef.current.push({ type: 'add' });
    setUserActions(next);
  }, []);

  const [strokeColor, setStrokeColor] = useState('#000000');
  const [strokeWidth, setStrokeWidth] = useState(4);
  const [strokeType, setStrokeType] = useState<StrokeType>('pen');
  const [drawingMode, setDrawingMode] = useState(false);
  const [fillHint, setFillHint] = useState<string | null>(null);
  const fillHintTimerRef = useRef<number | null>(null);
  const showFillHint = useCallback((msg: string) => {
    setFillHint(msg);
    if (fillHintTimerRef.current) window.clearTimeout(fillHintTimerRef.current);
    fillHintTimerRef.current = window.setTimeout(() => setFillHint(null), 2600);
  }, []);
  useEffect(() => () => {
    if (fillHintTimerRef.current) window.clearTimeout(fillHintTimerRef.current);
  }, []);

  const canvasRectRef = useRef<{ left: number; top: number; width: number; height: number } | null>(null);
  const viewRef = useRef<ViewTransform>({ ...IDENTITY_VIEW });
  const activePointersRef = useRef<Map<number, ActivePointer>>(new Map());
  const gestureModeRef = useRef<'none' | 'pan' | 'pinch' | 'pinchpan' | 'draw' | 'erase' | 'lasso'>('none');
  const pinchStartRef = useRef<{ dist: number; view: ViewTransform; cx: number; cy: number } | null>(null);
  const drawPointerIdRef = useRef<number | null>(null);
  const currentStrokeRef = useRef<UserStroke | null>(null);
  // 套索填充：圈选中的套索点列（图像 CSS 像素），抬起时与线条取交集形成封闭区域再填充
  const lassoPointsRef = useRef<[number, number][]>([]);
  // 右键平移状态：canvas 的 pointermove 会被右键的 contextmenu/pointercancel 打断，
  // 所以右键平移单独用 document 级 mousemove/mouseup 驱动，状态也独立于此 ref（不受 handlePointerUp 影响）。
  const rightPanRef = useRef<{ active: boolean; x: number; y: number }>({ active: false, x: 0, y: 0 });

  // 回放（独立于正常播放）
  const [replaying, setReplaying] = useState(false);
  const replayRef = useRef<(ReplaySim & { active: boolean }) | null>(null);
  // 录制视频：captureStream 只能捕获单个 canvas 的位图，而画面是三层(图案/已完成笔画/
  // 当前笔)叠加 + 白色底(CSS 提供)——单录任一层都会缺内容、且背景透明(导出黑底)。
  // 所以用一个离屏合成画布：每帧把 白底 + 三层可见画布 合成上去，再 captureStream 它。
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<ReturnType<typeof startCanvasRecording> | null>(null);
  const recCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // 导入 JSON 的隐藏文件选择器
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 获取 Canvas 位置与尺寸（事件挂在顶层 brushCanvas）。
  // 除了窗口 resize，还要监听画布自身尺寸变化（ResizeObserver）：
  // 分栏布局下画布大小会随布局变化（抽屉、分栏切换等），而那不触发窗口 resize 事件。
  // rect 一旦过期，toImagePoint 的屏幕->图像坐标换算整体偏移，笔画/套索都会画错位置。
  useEffect(() => {
    const updateCanvasRect = () => {
      const canvas = brushRef.current;
      if (canvas) {
        const rect = canvas.getBoundingClientRect();
        canvasRectRef.current = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      }
    };
    updateCanvasRect();
    window.addEventListener('resize', updateCanvasRect);
    const canvas = brushRef.current;
    let ro: ResizeObserver | null = null;
    if (canvas && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(updateCanvasRect);
      ro.observe(canvas);
    }
    return () => {
      window.removeEventListener('resize', updateCanvasRect);
      if (ro) ro.disconnect();
    };
  }, [brushRef]);

  // 录制合成：把 白底 + 三层可见画布 合成到离屏画布（captureStream 录它）。
  // 三层画布已含全部内容且各自已应用视图变换，直接按设备像素叠加即可。
  const compositeForRecord = useCallback(() => {
    const rec = recCanvasRef.current;
    if (!rec) return;
    const source = outlineRef.current;
    if (!source) return;
    // 尺寸跟随图案层（三层同尺寸）
    if (rec.width !== source.width || rec.height !== source.height) {
      rec.width = source.width;
      rec.height = source.height;
    }
    const ctx = rec.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, rec.width, rec.height);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, rec.width, rec.height);
    // 由下至上：图案层 -> 已完成笔画层 -> 当前笔层（与可见合成顺序一致）
    for (const layer of [outlineRef.current, historyRef.current, brushRef.current]) {
      if (layer) ctx.drawImage(layer, 0, 0);
    }
  }, [outlineRef, historyRef, brushRef]);

  // 持续重绘（视图变换通过 viewRef 实时读取）。回放期间交给回放循环渲染，这里空转。
  // 套索预览：render 每帧清空 brush 层（当前一笔层），之后把圈选中的套索画上去，
  // 跟随视图缩放/平移（applyViewTransform 与 render 内一致）。
  const drawLassoPreview = useCallback(() => {
    if (gestureModeRef.current !== 'lasso') return;
    const canvas = brushRef.current;
    const rect = canvasRectRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !rect) return;
    const pts = lassoPointsRef.current;
    if (pts.length < 2) return;
    const dpr = window.devicePixelRatio || 1;
    const s = viewRef.current.scale;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    applyViewTransform(ctx, dpr, rect.width, rect.height, viewRef.current);
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.fillStyle = 'rgba(229, 57, 53, 0.12)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(229, 57, 53, 0.9)';
    ctx.lineWidth = 1.5 / s; // 屏幕像素恒定，不随视图缩放变粗
    ctx.setLineDash([6 / s, 4 / s]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }, [brushRef]);

  useEffect(() => {
    let animationId: number;
    const draw = () => {
      if (!replayRef.current?.active) {
        renderRef.current({
          drawing,
          currentStep: state.currentStep,
          stepProgress: state.progress,
          showOutline: state.showOutline,
          userActions,
          currentStroke: currentStrokeRef.current,
          view: viewRef.current
        });
        drawLassoPreview();
        // 录制中（非回放，如录用户实时绘制）：每帧合成到离屏画布供 captureStream 捕获。
        // 回放+录制时由回放循环负责合成，这里不重复。
        if (recorderRef.current) compositeForRecord();
      }
      animationId = requestAnimationFrame(draw);
    };
    animationId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animationId);
  }, [drawing, state.currentStep, state.progress, state.showOutline, userActions, compositeForRecord, drawLassoPreview]);

  // 回放循环：与正常播放同速度（100px/s × speed）逐帧推进，独立驱动画布。
  useEffect(() => {
    if (!replaying) return;
    const sim = replayRef.current;
    if (!sim) { setReplaying(false); return; }
    sim.active = true;
    const actionsArr = userActionsRef.current;
    const total = drawing.steps.length;
    let animationId: number;

    const finish = () => {
      replayRef.current = null;
      setReplaying(false);
      // 录制中回放结束 -> 自动收尾录制并下载
      if (recorderRef.current) {
        const rec = recorderRef.current;
        recorderRef.current = null;
        setRecording(false);
        rec.stop().then(blob => { if (blob) downloadBlob(blob, `${drawing.name || 'drawing'}-${Date.now()}.webm`); });
      }
    };

    const tick = (now: number) => {
      const s = replayRef.current;
      if (!s) return;
      const dt = Math.min((now - s.last) / 1000, 0.1);
      s.last = now;
      // 与 useDrawingPlayer 同口径：100 * speed px/s（speed=2 即 200px/s，更快）。
      // 注意小程序 show 页用的是 100/speed（那边的 speed 语义相反），web 端必须匹配 web 播放器。
      const px = 100 * state.speed * dt;

      // ---- 推进模拟（与小程序 show 页 _renderTick 同逻辑）----
      if (s.phase === 'pattern') {
        s.stepPx += px;
        while (s.step <= s.endStep) {
          const len = s.stepLengths[s.step] || 0;
          const done = len > 0 ? s.stepPx >= len : true;
          if (!done) break;
          s.stepPx = len > 0 ? s.stepPx - len : 0;
          s.step += 1;
        }
        if (s.step > s.endStep) {
          if (actionsArr.length > 0) s.phase = 'user';
          else s.done = true;
        }
      } else {
        let remaining = px;
        while (s.uIndex < actionsArr.length) {
          const a = actionsArr[s.uIndex];
          if (a.kind === 'fill') { s.uIndex += 1; continue; }
          const len = s.uLens[s.uIndex] || 0;
          if (len <= 0) { s.uIndex += 1; s.uProgress = 0; continue; }
          const need = len * (1 - s.uProgress);
          if (remaining < need) { s.uProgress += remaining / len; remaining = 0; break; }
          remaining -= need;
          s.uIndex += 1;
          s.uProgress = 0;
        }
        if (s.uIndex >= actionsArr.length) s.done = true;
      }

      // ---- 由模拟推导当前帧的渲染参数 ----
      let currentStep: number;
      let stepProgress: number;
      let currentStroke: UserStroke | null = null;
      let currentStrokeProgress = 1;
      let revealed: UserAction[];

      if (s.phase === 'pattern') {
        currentStep = Math.min(s.step, total - 1);
        const len = s.stepLengths[s.step] || 1;
        stepProgress = s.step > s.endStep ? 1 : Math.min(s.stepPx / len, 1);
        revealed = []; // 图案阶段不显示用户内容（与 show 页一致）
      } else {
        currentStep = s.endStep;
        stepProgress = 1; // 图案已全部画完
        // 已"到达"的内容（下标 < uIndex）：填充瞬间出现、笔画已完成
        revealed = actionsArr.slice(0, s.uIndex);
        const cur = actionsArr[s.uIndex];
        if (cur && cur.kind === 'stroke') {
          currentStroke = cur.stroke;
          currentStrokeProgress = s.uProgress;
        }
      }

      renderRef.current({
        drawing,
        currentStep,
        stepProgress,
        showOutline: false,
        userActions: revealed,
        currentStroke,
        currentStrokeProgress,
        view: viewRef.current
      });
      // 录制中（回放即录制）：每帧合成到离屏画布供 captureStream 捕获
      if (recorderRef.current) compositeForRecord();

      if (s.done) { finish(); return; }
      animationId = requestAnimationFrame(tick);
    };

    sim.last = performance.now();
    animationId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationId);
  }, [replaying, drawing, state.speed, compositeForRecord]);

  // 开始回放：从头构建模拟状态（图案从第 0 步，用户内容从第 0 条）
  const startReplay = useCallback(() => {
    if (replayRef.current?.active) return;
    if (drawing.steps.length === 0) return;
    const steps = drawing.steps;
    // 填色步骤不占时长（到达即整块出现，同 useDrawingPlayer 的 getStrokeLength）
    const stepLengths = steps.map(st => st.strokes.reduce((sum, s) => sum + getStrokePlayLength(s), 0));
    const actionsArr = userActionsRef.current;
    const uLens = actionsArr.map(a => a.kind === 'stroke' ? calculateStrokeLengths(a.stroke.points).totalLength : 0);
    replayRef.current = {
      active: true,
      phase: 'pattern',
      step: 0, stepPx: 0,
      stepLengths, endStep: steps.length - 1,
      uIndex: 0, uProgress: 0, uLens,
      last: performance.now(),
      done: false
    };
    setReplaying(true);
  }, [drawing.steps]);

  // 停止回放
  const stopReplay = useCallback(() => {
    if (replayRef.current) replayRef.current.active = false;
    replayRef.current = null;
    setReplaying(false);
  }, []);

  const handleToggleReplay = useCallback(() => {
    if (replaying) stopReplay();
    else if (!recording) startReplay(); // 录制中不单独切回放（避免两个控制源）
  }, [replaying, recording, startReplay, stopReplay]);

  // 录制视频：离屏合成画布 + captureStream + MediaRecorder，录完下载。
  // 点一下开始（自动开始回放，录到的就是播放过程），再点一下停止并保存。
  const handleRecordVideo = useCallback(() => {
    if (recording) {
      const rec = recorderRef.current;
      recorderRef.current = null;
      recCanvasRef.current = null;
      setRecording(false);
      stopReplay();
      if (rec) rec.stop().then(blob => { if (blob) downloadBlob(blob, `${drawing.name || 'drawing'}-${Date.now()}.webm`); });
      return;
    }
    if (!outlineRef.current) return;
    // 离屏合成画布（每帧由主循环 compositeForRecord 填充），录它而非单张可见层。
    // 立即按图案层尺寸建好，避免 captureStream 抓到 0×0 首帧。
    const recCanvas = document.createElement('canvas');
    recCanvas.width = outlineRef.current.width;
    recCanvas.height = outlineRef.current.height;
    recCanvasRef.current = recCanvas;
    const rec = startCanvasRecording(recCanvas, 30);
    if (!rec.supported) {
      recCanvasRef.current = null;
      alert(rec.reason || '当前浏览器不支持视频录制');
      return;
    }
    recorderRef.current = rec;
    setRecording(true);
    startReplay(); // 开始回放，录制的就是这段播放
  }, [recording, drawing.name, outlineRef, startReplay, stopReplay]);

  // 卸载 / 切换图案：停止回放与录制（组件按 drawing.id 重建，切换即触发清理）
  useEffect(() => () => {
    if (recorderRef.current) {
      recorderRef.current.stop().then(blob => { if (blob) downloadBlob(blob, `${drawing.name || 'drawing'}-recording.webm`); });
      recorderRef.current = null;
    }
    recCanvasRef.current = null;
    replayRef.current = null;
    lassoPointsRef.current = [];
    gestureModeRef.current = 'none';
  }, [drawing.name]);

  const toImage = useCallback((clientX: number, clientY: number): [number, number] | null => {
    const rect = canvasRectRef.current;
    if (!rect) return null;
    return toImagePoint(clientX, clientY, rect.left, rect.top, rect.width, rect.height, viewRef.current);
  }, []);

  // 收尾当前笔画：抽稀 + 直线化后入栈（与竖屏详情/小程序端一致）
  const commitStroke = useCallback(() => {
    const currentStroke = currentStrokeRef.current;
    if (!currentStroke) return;
    let points = currentStroke.points;
    if (points.length > 2) {
      points = thinStrokePoints(points);
      const snapped = snapStrokeToLine(points);
      if (snapped) points = snapped;
    }
    const newStroke: UserStroke = { points, width: currentStroke.width, color: currentStroke.color, type: currentStroke.type };
    pushAction({ kind: 'stroke', stroke: newStroke });
    currentStrokeRef.current = null;
    drawPointerIdRef.current = null;
  }, [pushAction]);

  const strokeCount = userActions.filter(a => a.kind === 'stroke').length;

  // 油漆桶
  const applyFill = useCallback((clientX: number, clientY: number) => {
    const rect = canvasRectRef.current;
    if (!rect) return;
    const dpr = window.devicePixelRatio || 1;
    const p = toImagePoint(clientX, clientY, rect.left, rect.top, rect.width, rect.height, viewRef.current);
    if (!p) return;
    const px = p[0] * dpr, py = p[1] * dpr;

    const recolor = pickLineForRecolor(drawing, userActions, { cssW: rect.width, cssH: rect.height, dpr }, p[0], p[1], strokeColor, state.currentStep, state.progress);
    if (recolor) { pushAction({ kind: 'stroke', stroke: recolor }); return; }

    for (let i = userActions.length - 1; i >= 0; i--) {
      const a = userActions[i];
      if (a.kind !== 'fill') continue;
      if (a.fill.strokeCount !== strokeCount) continue;
      if (isPointInMask(a.fill.mask, px, py)) {
        const fill: UserFill = { key: `fill-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, seed: p, color: strokeColor, mask: a.fill.mask, strokeCount };
        pushAction({ kind: 'fill', fill });
        return;
      }
    }

    const under = buildUnderlay({ cssW: rect.width, cssH: rect.height, dpr }, drawing, userActions, state.currentStep, state.progress);
    if (!under) return;
    const res = floodFill(under, px, py);
    if (!res.ok) {
      if (res.reason === 'border') showFillHint('这个区域不封闭（线条有缺口），颜色会流出去');
      else if (res.reason === 'online') showFillHint('点这里的是线条，请点在线条围出的空白处');
      return;
    }
    const fill: UserFill = { key: `fill-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, seed: p, color: strokeColor, mask: res.canvas, strokeCount };
    pushAction({ kind: 'fill', fill });
  }, [drawing, userActions, strokeColor, showFillHint, strokeCount, pushAction, state.currentStep, state.progress]);

  // 套索填充收尾：套索点列（图像 CSS 像素）与可见线条取交集，
  // 封闭在区域内的块填入当前色（区域外/不封闭部分不填，与油漆桶共用"墙"）。
  // 不做"复用旧掩码"捷径：套索没有单一落点可判定"点在哪个已涂区域"，
  // 直接重算掩码（同油漆桶一次 flood 的开销），结果永远正确。
  const commitLasso = useCallback(() => {
    const pts = lassoPointsRef.current;
    lassoPointsRef.current = [];
    // 实时取画布位置尺寸（不信任可能过期的 canvasRectRef）：
    // 分栏布局下画布尺寸会变，记录过期会导致套索/笔画坐标整体错位
    const canvas = brushRef.current;
    const rect = canvas ? canvas.getBoundingClientRect() : canvasRectRef.current;
    if (!rect || pts.length < 3) return;
    const dpr = window.devicePixelRatio || 1;

    const under = buildUnderlay({ cssW: rect.width, cssH: rect.height, dpr }, drawing, userActions, state.currentStep, state.progress);
    if (!under) return;
    const res = lassoFill(under, pts, dpr);
    if (!res.ok) {
      if (res.reason === 'empty') showFillHint('套索区域太小');
      else if (res.reason === 'nothing') showFillHint('圈住的区域没有被线条封闭（线条有缺口）');
      return;
    }
    // 落点取套索内首个掩码像素（回放/拾取参考点），否则取套索首点
    const mctx = res.canvas.getContext('2d');
    let seed: [number, number] = pts[0];
    if (mctx) {
      const md = mctx.getImageData(0, 0, res.canvas.width, res.canvas.height).data;
      for (let i = 0; i < md.length; i += 4) {
        if (md[i + 3] >= 128) { seed = [i / 4 % res.canvas.width / dpr, Math.floor(i / 4 / res.canvas.width) / dpr]; break; }
      }
    }
    const fill: UserFill = { key: `fill-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, seed, color: strokeColor, mask: res.canvas, strokeCount };
    pushAction({ kind: 'fill', fill });
  }, [drawing, userActions, strokeColor, showFillHint, strokeCount, pushAction, state.currentStep, state.progress]);

  // 橡皮擦：整笔擦除
  const eraseAt = useCallback((clientX: number, clientY: number) => {
    const rect = canvasRectRef.current;
    if (!rect) return;
    const p = toImagePoint(clientX, clientY, rect.left, rect.top, rect.width, rect.height, viewRef.current);
    if (!p) return;
    const dpr = window.devicePixelRatio || 1;
    const actions = userActionsRef.current;
    const idx = pickUserActionIndex(actions, { cssW: rect.width, cssH: rect.height, dpr }, p[0], p[1]);
    if (idx >= 0) {
      const action = actions[idx];
      if (action) {
        const next = actions.filter((_, i) => i !== idx);
        userActionsRef.current = next;
        undoStackRef.current.push({ type: 'erase', index: idx, action });
        setUserActions(next);
      }
    }
  }, []);

  // 取色器：采样三层可见画布该处像素设为当前色
  const applyColorPick = useCallback((clientX: number, clientY: number) => {
    const rect = canvasRectRef.current;
    if (!rect) return;
    const dpr = window.devicePixelRatio || 1;
    const dx = Math.floor((clientX - rect.left) * dpr);
    const dy = Math.floor((clientY - rect.top) * dpr);
    const w = Math.round(rect.width * dpr), h = Math.round(rect.height * dpr);
    if (dx < 0 || dy < 0 || dx >= w || dy >= h) return;

    const probe = document.createElement('canvas');
    probe.width = w; probe.height = h;
    const ctx = probe.getContext('2d');
    if (!ctx) return;
    // 三层可见画布已含全部内容（图案 + 当前动画笔画 + 用户内容，已应用视图变换）
    for (const layer of [outlineRef.current, historyRef.current, brushRef.current]) {
      if (layer) ctx.drawImage(layer, 0, 0);
    }
    const d = ctx.getImageData(dx, dy, 1, 1).data;
    // 空白区是透明的（背景由容器 CSS 提供）
    if (d[3] < 16) { showFillHint('这里没有颜色（是空白）'); return; }
    const [r, g, b] = [d[0], d[1], d[2]];
    const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
    setStrokeColor(hex);
  }, [outlineRef, historyRef, brushRef, showFillHint]);

  // 指针按下
  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const rect = canvasRectRef.current;
    if (!rect) return;

    // 右键拖动 = 平移画面（任何模式下都可用）。这里【不捕获指针】——capture 会把指针事件
    // 重定向到 canvas 并可能触发 pointercancel 打断手势（之前"右键拖动无效"的根因）。
    // 平移改由 document 级 pointermove 驱动（见下方 effect），状态记在 rightPanRef
    // （handlePointerUp 不碰它，所以 pointercancel/onPointerCancel 也断不掉）。
    if (e.button === 2) {
      gestureModeRef.current = 'pan';
      rightPanRef.current = { active: true, x: e.clientX, y: e.clientY };
      return;
    }

    (e.target as Element).setPointerCapture?.(e.pointerId);
    activePointersRef.current.set(e.pointerId, { id: e.pointerId, x: e.clientX, y: e.clientY });
    const pointers = Array.from(activePointersRef.current.values());

    if (pointers.length === 2) {
      if (drawingMode) {
        if (currentStrokeRef.current) {
          if (currentStrokeRef.current.points.length > 1) commitStroke();
          else { currentStrokeRef.current = null; drawPointerIdRef.current = null; }
        }
        // 套索中落下第二指：放弃圈选，交给缩放/平移
        if (gestureModeRef.current === 'lasso') {
          lassoPointsRef.current = [];
          drawPointerIdRef.current = null;
        }
        const [a, b] = pointers;
        const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
        pinchStartRef.current = {
          dist: getPointerDistance(a, b),
          view: { ...viewRef.current },
          cx: midX - rect.left - rect.width / 2,
          cy: midY - rect.top - rect.height / 2
        };
        gestureModeRef.current = 'pinchpan';
        return;
      }
      const [a, b] = pointers;
      const midX = (a.x + b.x) / 2 - rect.left - rect.width / 2;
      const midY = (a.y + b.y) / 2 - rect.top - rect.height / 2;
      pinchStartRef.current = { dist: getPointerDistance(a, b), view: { ...viewRef.current }, cx: midX, cy: midY };
      gestureModeRef.current = 'pinch';
      return;
    }

    if (pointers.length > 2) return;

    if (drawingMode) {
      if (strokeType === 'fill') {
        applyFill(e.clientX, e.clientY);
        gestureModeRef.current = 'none';
      } else if (strokeType === 'lassofill') {
        const p = toImage(e.clientX, e.clientY);
        if (!p) return;
        lassoPointsRef.current = [p];
        drawPointerIdRef.current = e.pointerId; // move/up 靠它识别"是哪根手指在圈"
        gestureModeRef.current = 'lasso';
      } else if (strokeType === 'eraser') {
        eraseAt(e.clientX, e.clientY);
        gestureModeRef.current = 'erase';
      } else if (strokeType === 'colorpick') {
        applyColorPick(e.clientX, e.clientY);
        gestureModeRef.current = 'none';
      } else {
        const p = toImage(e.clientX, e.clientY);
        if (!p) return;
        currentStrokeRef.current = { points: [p], width: strokeWidth, color: strokeColor, type: strokeType };
        drawPointerIdRef.current = e.pointerId;
        gestureModeRef.current = 'draw';
      }
    } else {
      gestureModeRef.current = 'pan';
    }
  }, [drawingMode, strokeWidth, strokeColor, strokeType, toImage, applyFill, eraseAt, applyColorPick, commitStroke]);

  // 指针移动
  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    // 右键平移由 document 级 mousemove 驱动（pointercancel 会打断 canvas pointer 序列），
    // 这里跳过，避免同一帧里 canvas pointermove 也平移导致双倍位移。
    if (rightPanRef.current.active) return;
    const rect = canvasRectRef.current;
    if (!rect) return;
    const mode = gestureModeRef.current;

    if (mode === 'pinch') {
      const stored = activePointersRef.current.get(e.pointerId);
      if (stored) { stored.x = e.clientX; stored.y = e.clientY; }
      const pointers = Array.from(activePointersRef.current.values());
      if (pointers.length >= 2 && pinchStartRef.current) {
        const ps = pinchStartRef.current;
        const dist = getPointerDistance(pointers[0], pointers[1]);
        if (ps.dist > 0 && dist > 0) {
          const newScale = clampScale((ps.view.scale * dist) / ps.dist);
          viewRef.current = zoomAnchored(ps.view, newScale, ps.cx, ps.cy);
        }
      }
      return;
    }

    if (mode === 'pan') {
      const stored = activePointersRef.current.get(e.pointerId);
      if (!stored) return;
      viewRef.current = { ...viewRef.current, tx: viewRef.current.tx + (e.clientX - stored.x), ty: viewRef.current.ty + (e.clientY - stored.y) };
      stored.x = e.clientX; stored.y = e.clientY;
      return;
    }

    if (mode === 'pinchpan') {
      const stored = activePointersRef.current.get(e.pointerId);
      if (!stored) return;
      stored.x = e.clientX; stored.y = e.clientY;
      const pointers = Array.from(activePointersRef.current.values());
      const ps = pinchStartRef.current;
      if (pointers.length >= 2 && ps && ps.dist > 0) {
        const dist = getPointerDistance(pointers[0], pointers[1]);
        if (dist > 0) {
          const newScale = clampScale((ps.view.scale * dist) / ps.dist);
          const anchored = zoomAnchored(ps.view, newScale, ps.cx, ps.cy);
          const midX = (pointers[0].x + pointers[1].x) / 2 - rect.left - rect.width / 2;
          const midY = (pointers[0].y + pointers[1].y) / 2 - rect.top - rect.height / 2;
          viewRef.current = { scale: newScale, tx: anchored.tx + (midX - ps.cx), ty: anchored.ty + (midY - ps.cy) };
        }
      }
      return;
    }

    if (mode === 'lasso') {
      if (e.pointerId !== drawPointerIdRef.current) return;
      const p = toImage(e.clientX, e.clientY);
      if (p) {
        const pts = lassoPointsRef.current;
        const last = pts[pts.length - 1];
        // 抽稀：距上一个点 ≥1.5px 才追加，避免点过密拖慢填充
        if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= 1.5) pts.push(p);
      }
      return;
    }

    if (mode === 'draw' && currentStrokeRef.current && e.pointerId === drawPointerIdRef.current) {
      const p = toImage(e.clientX, e.clientY);
      if (p) currentStrokeRef.current.points.push(p);
    }

    if (mode === 'erase') eraseAt(e.clientX, e.clientY);
  }, [toImage, eraseAt]);

  // 指针抬起
  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const mode = gestureModeRef.current;
    activePointersRef.current.delete(e.pointerId);
    const remaining = activePointersRef.current.size;

    if (mode === 'draw' && e.pointerId === drawPointerIdRef.current) commitStroke();

    if (mode === 'pinch') {
      if (remaining === 1) {
        const [last] = Array.from(activePointersRef.current.values());
        gestureModeRef.current = last ? 'pan' : 'none';
      } else {
        gestureModeRef.current = remaining === 0 ? 'none' : 'pinch';
      }
      if (remaining < 2) pinchStartRef.current = null;
    } else if (mode === 'pinchpan') {
      if (remaining < 2) pinchStartRef.current = null;
      if (remaining < 2) gestureModeRef.current = 'none';
    } else if (mode === 'lasso') {
      if (e.pointerId !== drawPointerIdRef.current) {
        // 第二根手指落进套索手势：撤销圈选（多指时交给 pinch，套索预览已无意义）
        lassoPointsRef.current = [];
        drawPointerIdRef.current = null;
        gestureModeRef.current = 'none';
      } else if (lassoPointsRef.current.length >= 3) {
        drawPointerIdRef.current = null;
        commitLasso(); // 圈内与线条取交集，封闭块填充
      } else {
        // 圈得太小（拖成了一次点击）：不产生填充，直接丢弃
        lassoPointsRef.current = [];
        drawPointerIdRef.current = null;
        gestureModeRef.current = 'none';
      }
    } else if ((mode === 'pan' || mode === 'erase') && remaining === 0) {
      gestureModeRef.current = 'none';
    }
  }, [commitStroke, commitLasso]);

  // 撤销
  const handleUndo = useCallback(() => {
    const delta = undoStackRef.current.pop();
    if (!delta) return;
    let next: UserAction[];
    if (delta.type === 'add') next = userActionsRef.current.slice(0, -1);
    else if (delta.type === 'erase') { next = [...userActionsRef.current]; next.splice(delta.index, 0, delta.action); }
    else next = delta.actions;
    userActionsRef.current = next;
    setUserActions(next);
  }, []);

  // 清除
  const handleClear = useCallback(() => {
    if (window.confirm('确定要清除所有绘制内容吗？')) {
      if (userActionsRef.current.length > 0) undoStackRef.current.push({ type: 'clear', actions: [...userActionsRef.current] });
      userActionsRef.current = [];
      setUserActions([]);
      currentStrokeRef.current = null;
      lassoPointsRef.current = [];
      gestureModeRef.current = 'none';
    }
  }, []);

  // 切换画笔
  const handleStrokeTypeSelect = useCallback((key: StrokeType) => {
    if (drawingMode && strokeType === key) {
      setDrawingMode(false);
      commitStroke();
    } else {
      // 圈选中的套索在换工具时丢弃（半截圈选无意义）
      lassoPointsRef.current = [];
      if (gestureModeRef.current === 'lasso') gestureModeRef.current = 'none';
      setStrokeType(key);
      setDrawingMode(true);
    }
  }, [drawingMode, strokeType, commitStroke]);

  // 复位视图
  const handleViewReset = useCallback(() => {
    viewRef.current = { ...IDENTITY_VIEW };
    pinchStartRef.current = null;
  }, []);

  // 滚轮缩放
  useEffect(() => {
    const canvas = brushRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvasRectRef.current;
      if (!rect) return;
      const view = viewRef.current;
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const newScale = clampScale(view.scale * factor);
      viewRef.current = zoomAnchored(view, newScale, e.clientX - rect.left - rect.width / 2, e.clientY - rect.top - rect.height / 2);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [brushRef]);

  // 禁止浏览器右键菜单（绘制模式下右键=平移）。
  // document 级【捕获阶段】监听：事件从 document 向下派发时先经过这里，早于任何子元素
  // 处理器、也早于浏览器弹出菜单，能可靠 preventDefault。无条件拦（本绘制应用不需要右键菜单）。
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => e.preventDefault();
    document.addEventListener('contextmenu', onContextMenu, true);
    return () => document.removeEventListener('contextmenu', onContextMenu, true);
  }, []);

  // 右键平移：canvas 的 pointermove 会被右键触发的 contextmenu/pointercancel 打断
  // （见 handlePointerDown 里 button===2 分支把状态记到 rightPanRef）。所以右键拖动改用
  // document 级 mousemove/mouseup 驱动平移——物理鼠标一定派发 mousemove/mouseup，
  // 不依赖 canvas 的 pointer 事件序列，pointercancel 也不影响。
  const handleRightPanUp = useCallback(() => {
    rightPanRef.current.active = false;
    gestureModeRef.current = 'none';
  }, []);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const rp = rightPanRef.current;
      if (!rp.active) return;
      viewRef.current = { ...viewRef.current, tx: viewRef.current.tx + (e.clientX - rp.x), ty: viewRef.current.ty + (e.clientY - rp.y) };
      rp.x = e.clientX; rp.y = e.clientY;
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', handleRightPanUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', handleRightPanUp);
    };
  }, [handleRightPanUp]);

  // 保存图片
  const handleExport = useCallback(() => {
    try {
      const dataUrl = exportToDataURL(drawing, state.currentStep, state.progress);
      if (!dataUrl) return;
      const link = document.createElement('a');
      link.download = `${drawing.name || 'drawing'}-${Date.now()}.png`;
      link.href = dataUrl;
      link.click();
    } catch (err) {
      console.error('导出失败:', err);
      alert('导出失败，请重试');
    }
  }, [exportToDataURL, drawing, state.currentStep, state.progress]);

  // 导出用户绘制路径 JSON（与竖屏详情同逻辑：viewBox 坐标）
  const handleExportJson = useCallback(() => {
    const strokesInStack = userActions.filter((a): a is Extract<UserAction, { kind: 'stroke' }> => a.kind === 'stroke');
    if (strokesInStack.length === 0) { alert('还没有可导出的笔画（填充不导出 JSON），先画几笔再导出吧～'); return; }
    try {
      const cv = brushRef.current || outlineRef.current;
      const w = cv ? cv.clientWidth : 600;
      const h = cv ? cv.clientHeight : 600;
      const [vx0, vy0, vx1, vy1] = drawing.viewBox;
      const vw = vx1 - vx0, vh = vy1 - vy0;
      const scale = Math.min(w / vw, h / vh) * 0.8; // 与 getTransform 一致（留 10% 边距）
      const offsetX = (w - vw * scale) / 2 - vx0 * scale;
      const offsetY = (h - vh * scale) / 2 - vy0 * scale;

      const strokes = strokesInStack.map(a => ({
        width: Math.round((a.stroke.width / scale) * 100) / 100,
        color: a.stroke.color,
        type: a.stroke.type,
        points: a.stroke.points.map(p => [Math.round((p[0] - offsetX) / scale * 100) / 100, Math.round((p[1] - offsetY) / scale * 100) / 100])
      }));

      const pad = 8;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, maxHalfWidth = 0;
      for (const s of strokes) {
        const half = s.width / 2;
        if (half > maxHalfWidth) maxHalfWidth = half;
        for (const [x, y] of s.points) {
          if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y;
        }
      }
      const margin = pad + maxHalfWidth;
      const viewBox: [number, number, number, number] = [
        Math.min(vx0, Math.round(minX - margin)), Math.min(vy0, Math.round(minY - margin)),
        Math.max(vx1, Math.round(maxX + margin)), Math.max(vy1, Math.round(maxY + margin))
      ];
      if (viewBox[2] - viewBox[0] < 2 * margin) viewBox[2] = viewBox[0] + 2 * margin;
      if (viewBox[3] - viewBox[1] < 2 * margin) viewBox[3] = viewBox[1] + 2 * margin;

      const payload = { id: `user-${Date.now()}`, name: drawing.name ? `${drawing.name}-用户绘制` : '用户绘制', viewBox, steps: [{ id: 1, tip: '', strokes }] };
      downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `${payload.name}-${Date.now()}.json`);
    } catch (err) {
      console.error('导出 JSON 失败:', err);
      alert('导出失败，请重试');
    }
  }, [userActions, drawing.name, drawing.viewBox]);

  // 导入 JSON：读一个图案文件（{viewBox, steps}，或 {drawing:{...}}）设为当前绘制图案
  const handleImportFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // 允许重复导入同一文件
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const d = parsed && parsed.viewBox && Array.isArray(parsed.steps) ? parsed
        : (parsed && parsed.drawing && parsed.drawing.viewBox && Array.isArray(parsed.drawing.steps) ? parsed.drawing : null);
      if (!d) { alert('JSON 格式不正确（需要 viewBox 和 steps 字段）'); return; }
      const imported: Drawing = {
        id: typeof d.id === 'string' ? d.id : `import-${Date.now()}`,
        name: typeof d.name === 'string' ? d.name : '导入的图案',
        tags: Array.isArray(d.tags) ? d.tags : [],
        difficulty: typeof d.difficulty === 'number' ? d.difficulty : 1,
        viewBox: d.viewBox,
        thumbnail: d.thumbnail,
        steps: d.steps
      };
      selectDrawing(imported);
    } catch (err) {
      console.error('导入 JSON 失败:', err);
      alert('导入失败：不是有效的 JSON 文件');
    }
  }, [selectDrawing]);

  const currentStepData = drawing.steps[state.currentStep];
  const globalProgress = getGlobalProgress();

  return (
    <div className="studio">
      {/* 上：绘画工具（单行：[图案导航抽屉开关] 画笔 + 自定义颜色 + 自定义粗细 + 撤销/清除） */}
      <div className="studio-top">
        {/* 分栏模式：切换左侧图案导航抽屉（默认收起） */}
        {onToggleNav && (
          <button className="studio-tool-btn nav-toggle-btn" onClick={onToggleNav} title="图案导航">
            <svg className="tool-btn-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-label="图案导航">
              <path d="M3 6h18" />
              <path d="M3 12h18" />
              <path d="M3 18h18" />
            </svg>
          </button>
        )}
        <div className="studio-stroke-types">
          {STROKE_TYPES.map((type) => (
            <button
              key={type.key}
              className={`stroke-type-item ${drawingMode && strokeType === type.key ? 'active' : ''}`}
              onClick={() => handleStrokeTypeSelect(type.key)}
              title={drawingMode && strokeType === type.key ? `${type.name}（点击退出）` : type.name}
            >
              <img
                className="stroke-type-icon"
                src={drawingMode && strokeType === type.key ? type.iconActive : type.icon}
                alt={type.name}
              />
            </button>
          ))}
        </div>
        <label className="color-picker-label" title="自定义颜色">
          <input type="color" value={strokeColor} onChange={(e) => setStrokeColor(e.target.value)} className="color-picker-input" />
          <span className="color-circle" style={{ backgroundColor: strokeColor }} />
        </label>
        <div className="studio-width-slider" title="自定义画笔大小">
          <input type="range" min="1" max="20" value={strokeWidth} onChange={(e) => setStrokeWidth(parseInt(e.target.value))} className="stroke-width-slider" />
          <span className="stroke-width-value">{strokeWidth}</span>
        </div>
        <button className="studio-tool-btn" onClick={handleUndo} title="撤销">
          <img className="tool-btn-icon" src={undoIcon} alt="撤销" />
        </button>
        <button className="studio-tool-btn" onClick={handleClear} title="清除">
          <img className="tool-btn-icon" src={clearIcon} alt="清除" />
        </button>
        <div className="studio-tool-sep" />
        <button className="studio-tool-btn" onClick={handleViewReset} title="复位视图（缩放/平移归位）">
          <img className="tool-btn-icon" src={resetIcon} alt="复位视图" />
        </button>
      </div>

      {/* 中：绘制区 + 右：保存按钮 */}
      <div className="studio-body">
        <div className="studio-canvas">
          <div className="studio-canvas-stack">
            <canvas ref={outlineRef} className="drawing-canvas" />
            <canvas ref={historyRef} className="drawing-canvas" />
            <canvas
              ref={brushRef}
              className="drawing-canvas"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              onContextMenu={(e) => e.preventDefault()}
              style={{ touchAction: 'none', cursor: drawingMode ? 'crosshair' : 'grab' }}
            />
          </div>
          {/* 步骤提示右下角 */}
          <div className="studio-step-tip">
            <span className="tip-text">{currentStepData?.tip || ''}</span>
          </div>
          {/* 填充失败提示 */}
          {fillHint && (
            <div className="studio-fill-hint">
              <span className="fill-hint-text">{fillHint}</span>
            </div>
          )}
          {/* 回放/录制状态徽标 */}
          {(replaying || recording) && (
            <div className="studio-status-badge">
              {recording ? '● 录制中' : '▶ 回放中'}
            </div>
          )}
        </div>

        <aside className="studio-right">
          <button className="studio-save-btn" onClick={handleExport} title="保存图片">
            <img className="tool-btn-icon" src={saveIcon} alt="保存图片" />
            <span>保存</span>
          </button>
          <button
            className={`studio-save-btn ${replaying ? 'active' : ''} ${recording ? 'disabled' : ''}`}
            onClick={handleToggleReplay}
            disabled={recording}
            title={replaying ? '停止回放' : '回放（图案 + 你的作品）'}
          >
            <svg className="tool-btn-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" />
            </svg>
            <span>{replaying ? '停止' : '回放'}</span>
          </button>
          <button
            className={`studio-save-btn ${recording ? 'recording' : ''}`}
            onClick={handleRecordVideo}
            title={recording ? '停止并保存视频' : '录制视频（自动回放）'}
          >
            <svg className="tool-btn-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
              <path d="M4 8V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2" />
            </svg>
            <span>{recording ? '停止录制' : '录视频'}</span>
          </button>
          <button className="studio-save-btn" onClick={() => fileInputRef.current?.click()} title="导入 JSON 图案">
            <svg className="tool-btn-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <path d="M12 16V11" /><path d="M9.5 12.5 12 10l2.5 2.5" />
            </svg>
            <span>导入</span>
          </button>
          <button className="studio-save-btn" onClick={handleExportJson} title="导出绘制路径 JSON">
            <svg className="tool-btn-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3v12" /><path d="M7 11l5 5 5-5" /><path d="M4 20h16" />
            </svg>
            <span>导出</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={handleImportFile}
          />
        </aside>
      </div>

      {/* 下：播放控制（单行：按钮 + 进度条） */}
      <div className="studio-bottom">
        <div className="studio-controls">
          <button className={`control-btn outline-btn ${state.showOutline ? 'active' : ''}`} onClick={actions.toggleOutline} title="轮廓">
            <img className="outline-icon" src={state.showOutline ? outlineIconActive : outlineIcon} alt="轮廓" />
          </button>
          <button className="control-btn" onClick={actions.prevStep} title="上一步">
            <img className="btn-icon" src={preIcon} alt="上一步" />
          </button>
          <button className={`control-btn play-btn ${state.playing ? 'playing' : ''}`} onClick={actions.togglePlay} title={state.playing ? '暂停' : '播放'}>
            <img className="btn-icon" src={state.playing ? stopIcon : playIcon} alt={state.playing ? '暂停' : '播放'} />
          </button>
          <button className="control-btn" onClick={actions.nextStep} title="下一步">
            <img className="btn-icon" src={nextIcon} alt="下一步" />
          </button>
          <button className="control-btn" onClick={actions.reset} title="重播">
            <img className="btn-icon" src={refreshIcon} alt="重播" />
          </button>
          <button className={`control-btn speed-btn ${state.speed === 0.5 ? 'active' : ''}`} onClick={actions.toggleSpeed} title="切换倍速">
            <span className="speed-text">{state.speed}x</span>
          </button>
          <button className={`control-btn loop-btn ${state.loopCurrentStep ? 'active' : ''}`} onClick={actions.toggleLoop} title={state.loopCurrentStep ? '单步循环（开）' : '单步循环（关）'}>
            <img className="loop-icon" src={state.loopCurrentStep ? stepLoopIconActive : stepLoopIcon} alt="单步循环" />
          </button>
          <input type="range" min="0" max="1" step="0.01" value={globalProgress} onChange={(e) => actions.setGlobalProgress(parseFloat(e.target.value))} className="progress-bar" title="进度" />
        </div>
      </div>
    </div>
  );
}
