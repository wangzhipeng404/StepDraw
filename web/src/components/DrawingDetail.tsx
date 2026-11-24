// 一笔一笔 StepDraw - 绘画详情页组件

import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { Drawing, UserAction, UserStroke, StrokeType, UserFill } from '../types';
import { STROKE_TYPES } from '../types';
import { loadDrawing } from '../data/drawings';
import { useDrawingPlayer } from '../hooks/useDrawingPlayer';
import { useDrawingCanvas } from '../hooks/useDrawingCanvas';
import { toImagePoint, zoomAnchored, IDENTITY_VIEW, buildUnderlay, floodFill, isPointInMask, pickLineForRecolor, pickUserActionIndex } from '../utils/canvas';
import type { ViewTransform } from '../utils/canvas';
import { Navbar } from './Navbar';
import preIcon from '../assets/pre.png';
import playIcon from '../assets/play.png';
import stopIcon from '../assets/stop.png';
import nextIcon from '../assets/next.png';
import refreshIcon from '../assets/refresh.png';
import resetIcon from '../assets/reset.png';
import drawIcon from '../assets/draw.png';
import scaleMoveIcon from '../assets/scale_move.png';
import outlineIcon from '../assets/cat-solid.png';
import outlineIconActive from '../assets/cat-solid-active.png';
import undoIcon from '../assets/undo.png';
import clearIcon from '../assets/clear.png';
import saveIcon from '../assets/save.png';
import shareIcon from '../assets/share.png';
import stepLoopIcon from '../assets/stepLoop.png';
import stepLoopIconActive from '../assets/stepLoopActive.png';
import './DrawingDetail.css';

// 颜色选项
const COLOR_OPTIONS = ['#E53935', '#1E88E5', '#43A047', '#FB8C00', '#8E24AA', '#000000'];
// 笔画粗细选项
const STROKE_WIDTH_OPTIONS = [2, 4, 6, 8, 12];

// 视图缩放范围
const MIN_SCALE = 0.3;
const MAX_SCALE = 5;
const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

// 活动指针（pan / pinch 用）
interface ActivePointer { id: number; x: number; y: number; }
const getPointerDistance = (a: ActivePointer, b: ActivePointer) => Math.hypot(b.x - a.x, b.y - a.y);

// dataURL（PNG）-> Blob，供分享附带图片使用
function dataUrlToBlob(dataUrl: string): Blob {
  const [head, body] = dataUrl.split(',');
  const mime = /data:(.*?)(;|$)/.exec(head)?.[1] || 'image/png';
  const bin = atob(body || '');
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

interface DrawingCanvasProps {
  drawing: Drawing;
  onBack: () => void;
}

function DrawingCanvas({ drawing, onBack }: DrawingCanvasProps) {
  const { state, actions, getGlobalProgress } = useDrawingPlayer({
    drawing,
    mode: 'continuous'
  });

  const { outlineRef, historyRef, brushRef, render, exportToDataURL } = useDrawingCanvas();
  const renderRef = useRef(render);
  renderRef.current = render;

  // 绘图模式相关状态
  // 用户操作栈：笔画与填充按时间序混排
  const [userActions, setUserActions] = useState<UserAction[]>([]);
  // 撤销增量栈：记录每次修改（add 追加 / erase 按位删除），撤销即逆操作。
  // 橡皮擦会删掉中间某一条，"撤销=删最后一条"会删错对象；按增量逆操作才能
  // 把"刚擦掉的那块"原样放回原位。用 ref 存放，不参与渲染依赖。
  type UndoDelta =
    | { type: 'add' }
    | { type: 'erase'; index: number; action: UserAction }
    | { type: 'clear'; actions: UserAction[] };
  const undoStackRef = useRef<UndoDelta[]>([]);

  // 用户操作栈的同步镜像：快速连续操作（如橡皮擦一帧内划过多笔）时，
  // setState 尚未提交、闭包里的 userActions 已过期，读这个 ref 才能拿到最新栈。
  // 所有增删都经 pushAction / eraseAt / handleClear 同步更新它。
  const userActionsRef = useRef<UserAction[]>([]);
  useEffect(() => { userActionsRef.current = userActions; }, [userActions]);

  // 追加一个用户操作（笔画/填充），并记录撤销增量
  const pushAction = useCallback((action: UserAction) => {
    const next = [...userActionsRef.current, action];
    userActionsRef.current = next;
    undoStackRef.current.push({ type: 'add' });
    setUserActions(next);
  }, []);
  const [strokeColor, setStrokeColor] = useState('#000000');
  const [strokeWidth, setStrokeWidth] = useState(4);
  const [strokeType, setStrokeType] = useState<StrokeType>('pen');
  // 绘制模式：选中画笔进入，再点同一支退出；非绘制模式下画布可缩放/平移
  const [drawingMode, setDrawingMode] = useState(false);
  // 填充失败提示（不封闭等），画布上轻量显示，几秒后自动消失
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

  // 存储 Canvas 位置/尺寸信息（事件挂在顶层 brushCanvas，测量它即可代表三层公共位置）
  const canvasRectRef = useRef<{ left: number; top: number; width: number; height: number } | null>(null);

  // 视图变换（缩放/平移）：实例级，避免每帧 setState
  const viewRef = useRef<ViewTransform>({ ...IDENTITY_VIEW });
  // 手势状态：pan（单指/鼠标拖动）/ pinch（双指捏合）
  const activePointersRef = useRef<Map<number, ActivePointer>>(new Map());
  const gestureModeRef = useRef<'none' | 'pan' | 'pinch' | 'pinchpan' | 'draw' | 'erase'>('none');
  const pinchStartRef = useRef<{ dist: number; view: ViewTransform; cx: number; cy: number } | null>(null);
  // 绘制模式下的双指缩放/平移：手势起始状态（距离/中点/视图），见 handlePointerDown
  const drawPointerIdRef = useRef<number | null>(null);

  // 获取 Canvas 位置与尺寸（在组件挂载后获取，并在窗口大小变化时更新）
  useEffect(() => {
    const updateCanvasRect = () => {
      const canvas = brushRef.current;
      if (canvas) {
        const rect = canvas.getBoundingClientRect();
        canvasRectRef.current = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      }
    };

    updateCanvasRect();

    // 监听窗口大小变化
    window.addEventListener('resize', updateCanvasRect);
    return () => window.removeEventListener('resize', updateCanvasRect);
  }, [brushRef]);

  // 持续重绘循环（视图变换通过 viewRef 实时读取，无需进依赖）
  useEffect(() => {
    let animationId: number;

    const draw = () => {
      renderRef.current({
        drawing,
        currentStep: state.currentStep,
        stepProgress: state.progress,
        showOutline: state.showOutline,
        userActions,
        currentStroke: currentStrokeRef.current,
        view: viewRef.current
      });
      animationId = requestAnimationFrame(draw);
    };

    animationId = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(animationId);
    };
  }, [drawing, state.currentStep, state.progress, state.showOutline, userActions]);

  // 使用 ref 存储当前笔画（完全参考小程序逻辑）
  const currentStrokeRef = useRef<UserStroke | null>(null);

  // 指针 -> 图像坐标（含视图逆变换），绘制时把落点还原到未缩放/未平移的图
  const toImage = useCallback((clientX: number, clientY: number): [number, number] | null => {
    const rect = canvasRectRef.current;
    if (!rect) return null;
    return toImagePoint(clientX, clientY, rect.left, rect.top, rect.width, rect.height, viewRef.current);
  }, []);

  // 收尾当前笔画：按时间序入操作栈（即使只有一个点也保存）
  const commitStroke = useCallback(() => {
    const currentStroke = currentStrokeRef.current;
    if (!currentStroke) return;
    const newStroke: UserStroke = {
      points: [...currentStroke.points],
      width: currentStroke.width,
      color: currentStroke.color,
      type: currentStroke.type
    };
    pushAction({ kind: 'stroke', stroke: newStroke });
    currentStrokeRef.current = null;
    drawPointerIdRef.current = null;
  }, [pushAction]);

  // 当前手绘笔画数（墙版本标记）：线条增删后已喷涂区域的形状可能变化，旧掩码作废
  const strokeCount = userActions.filter(a => a.kind === 'stroke').length;

  // 油漆桶：点击落点处漫水填充当前颜色。
  // 再次喷涂同一区域：复用该区域已有的掩码（共享位图，不重算、不复制），只叠一层新颜色；
  // 区域不封闭/点在线条上时给轻量 hint。
  const applyFill = useCallback((clientX: number, clientY: number) => {
    const rect = canvasRectRef.current;
    if (!rect) return;
    const dpr = window.devicePixelRatio || 1;
    const p = toImagePoint(clientX, clientY, rect.left, rect.top, rect.width, rect.height, viewRef.current);
    if (!p) return;
    const px = p[0] * dpr;
    const py = p[1] * dpr;

    // 0) 点中线条：复制一份线盖在原线上、换成喷涂色（撤销时副本消失、原线还原）
    //    只拾取已播放的线条：未播放步骤不参与，避免把看不见的淡色引导线变出来
    const recolor = pickLineForRecolor(
      drawing,
      userActions,
      { cssW: rect.width, cssH: rect.height, dpr },
      p[0],
      p[1],
      strokeColor,
      state.currentStep,
      state.progress
    );
    if (recolor) {
      pushAction({ kind: 'stroke', stroke: recolor });
      return;
    }

    // 1) 命中已有填充区域：复用其掩码（墙没变过时），直接叠一层新颜色
    for (let i = userActions.length - 1; i >= 0; i--) {
      const a = userActions[i];
      if (a.kind !== 'fill') continue;
      if (a.fill.strokeCount !== strokeCount) continue; // 线条变过，旧区域形状不可信
      if (isPointInMask(a.fill.mask, px, py)) {
        const fill: UserFill = {
          key: `fill-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          seed: p,
          color: strokeColor,
          mask: a.fill.mask, // 共享同一份掩码位图
          strokeCount
        };
        pushAction({ kind: 'fill', fill });
        return;
      }
    }

    // 2) 未命中：对"已播放的线条墙"做漫水填充，算出区域掩码。
    //    只把已播放的步骤（+ 当前步骤已生长部分）当作墙，和屏幕所见一致；
    //    未播放步骤的线条不参与，避免能涂出"看不见线条围成的区域"。
    const under = buildUnderlay(
      { cssW: rect.width, cssH: rect.height, dpr },
      drawing,
      userActions,
      state.currentStep,
      state.progress
    );
    if (!under) return;
    const res = floodFill(under, px, py);
    if (!res.ok) {
      if (res.reason === 'border') {
        showFillHint('这个区域不封闭（线条有缺口），颜色会流出去');
      } else if (res.reason === 'online') {
        showFillHint('点这里的是线条，请点在线条围出的空白处');
      }
      return;
    }
    const fill: UserFill = {
      key: `fill-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      seed: p,
      color: strokeColor,
      mask: res.canvas,
      strokeCount
    };
    pushAction({ kind: 'fill', fill });
  }, [drawing, userActions, strokeColor, showFillHint, strokeCount, pushAction, state.currentStep, state.progress]);

  // 橡皮擦：整笔擦除。点击/拖动落点处命中的最上层用户操作（笔画或填充）整块移除。
  // 命中用 pickUserActionIndex（探针法，含填充掩码）；记录 {index, action} 增量，
  // 撤销时把这块按原下标放回（橡皮擦可能删的是中间某条，不能简单删最后一条）。
  const eraseAt = useCallback((clientX: number, clientY: number) => {
    const rect = canvasRectRef.current;
    if (!rect) return;
    const p = toImagePoint(clientX, clientY, rect.left, rect.top, rect.width, rect.height, viewRef.current);
    if (!p) return;
    const dpr = window.devicePixelRatio || 1;
    const actions = userActionsRef.current;
    const idx = pickUserActionIndex(
      actions,
      { cssW: rect.width, cssH: rect.height, dpr },
      p[0],
      p[1]
    );
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

  // 开始（指针按下）
  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const rect = canvasRectRef.current;
    if (!rect) return;

    activePointersRef.current.set(e.pointerId, { id: e.pointerId, x: e.clientX, y: e.clientY });
    const pointers = Array.from(activePointersRef.current.values());

    // 双指落下
    if (pointers.length === 2) {
      if (drawingMode) {
        // 绘制模式双指：收尾可能残留的一笔，转入双指缩放/平移（画着画着想挪画面/放大细节）
        if (currentStrokeRef.current) {
          if (currentStrokeRef.current.points.length > 1) {
            commitStroke();
          } else {
            // 只有一个点 = 手指刚落下还没移动：直接丢弃，避免在落点留下杂点
            // （第二指落下说明是捏合手势，第一笔多半是误触）
            currentStrokeRef.current = null;
            drawPointerIdRef.current = null;
          }
        }
        const [a, b] = pointers;
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        // 记录手势起始状态：缩放按起始距离比（锚定起始中点），
        // 平移按中点位移，二者都基于起始视图合成，避免逐帧累加漂移（与小程序端同逻辑）
        pinchStartRef.current = {
          dist: getPointerDistance(a, b),
          view: { ...viewRef.current },
          cx: midX - rect.left - rect.width / 2,
          cy: midY - rect.top - rect.height / 2
        };
        gestureModeRef.current = 'pinchpan';
        return;
      }
      // 非绘制模式：进入捏合缩放（以起始中点为锚点）
      const [a, b] = pointers;
      const midX = (a.x + b.x) / 2 - rect.left - rect.width / 2;
      const midY = (a.y + b.y) / 2 - rect.top - rect.height / 2;
      pinchStartRef.current = {
        dist: getPointerDistance(a, b),
        view: { ...viewRef.current },
        cx: midX,
        cy: midY
      };
      gestureModeRef.current = 'pinch';
      return;
    }

    if (pointers.length > 2) return;

    // 单指
    if (drawingMode) {
      // PC：右键拖动 = 平移画面（不绘制/填充/擦除）
      if (e.button === 2) {
        gestureModeRef.current = 'pan';
        return;
      }
      if (strokeType === 'fill') {
        // 填充：单击落点即填充当前颜色，不拖拽
        applyFill(e.clientX, e.clientY);
        gestureModeRef.current = 'none';
      } else if (strokeType === 'eraser') {
        // 橡皮擦：按下即擦一次，之后拖动持续擦（见 move 分支）
        eraseAt(e.clientX, e.clientY);
        gestureModeRef.current = 'erase';
      } else {
        // 绘制模式：开始一笔
        const p = toImage(e.clientX, e.clientY);
        if (!p) return;
        currentStrokeRef.current = {
          points: [p],
          width: strokeWidth,
          color: strokeColor,
          type: strokeType
        };
        drawPointerIdRef.current = e.pointerId;
        gestureModeRef.current = 'draw';
      }
    } else {
      // 非绘制模式：单指/鼠标拖动平移
      gestureModeRef.current = 'pan';
    }
  }, [drawingMode, strokeWidth, strokeColor, strokeType, toImage, applyFill, eraseAt, commitStroke]);

  // 指针移动：按手势模式分派（绘制 / 平移 / 捏合缩放）
  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = canvasRectRef.current;
    if (!rect) return;
    const mode = gestureModeRef.current;

    // 双指捏合缩放（触控板/触屏）
    if (mode === 'pinch') {
      const stored = activePointersRef.current.get(e.pointerId);
      if (stored) {
        stored.x = e.clientX;
        stored.y = e.clientY;
      }
      const pointers = Array.from(activePointersRef.current.values());
      if (pointers.length >= 2 && pinchStartRef.current) {
        const ps = pinchStartRef.current;
        const dist = getPointerDistance(pointers[0], pointers[1]);
        if (ps.dist > 0 && dist > 0) {
          const newScale = clampScale((ps.view.scale * dist) / ps.dist);
          // 以捏合起始中点为锚点缩放，保持该点位置不动
          viewRef.current = zoomAnchored(ps.view, newScale, ps.cx, ps.cy);
        }
      }
      return;
    }

    // 单指/鼠标平移（非绘制模式）
    if (mode === 'pan') {
      const stored = activePointersRef.current.get(e.pointerId);
      if (!stored) return;
      viewRef.current = {
        ...viewRef.current,
        tx: viewRef.current.tx + (e.clientX - stored.x),
        ty: viewRef.current.ty + (e.clientY - stored.y)
      };
      stored.x = e.clientX;
      stored.y = e.clientY;
      return;
    }

    // 绘制模式双指缩放/平移：缩放倍率来自两指间距变化（锚定起始中点），
    // 平移来自两指中点位移；都基于"起始视图"合成，不逐帧累加（与小程序端同逻辑）
    if (mode === 'pinchpan') {
      const stored = activePointersRef.current.get(e.pointerId);
      if (!stored) return;
      stored.x = e.clientX;
      stored.y = e.clientY;
      const pointers = Array.from(activePointersRef.current.values());
      const ps = pinchStartRef.current;
      if (pointers.length >= 2 && ps && ps.dist > 0) {
        const dist = getPointerDistance(pointers[0], pointers[1]);
        if (dist > 0) {
          const newScale = clampScale((ps.view.scale * dist) / ps.dist);
          const anchored = zoomAnchored(ps.view, newScale, ps.cx, ps.cy);
          const midX = (pointers[0].x + pointers[1].x) / 2 - rect.left - rect.width / 2;
          const midY = (pointers[0].y + pointers[1].y) / 2 - rect.top - rect.height / 2;
          viewRef.current = {
            scale: newScale,
            tx: anchored.tx + (midX - ps.cx),
            ty: anchored.ty + (midY - ps.cy)
          };
        }
      }
      return;
    }

    // 绘制（绘制模式）
    if (mode === 'draw' && currentStrokeRef.current && e.pointerId === drawPointerIdRef.current) {
      const p = toImage(e.clientX, e.clientY);
      if (p) currentStrokeRef.current.points.push(p);
    }

    // 橡皮擦拖动：持续擦除经过之处命中的用户内容
    if (mode === 'erase') {
      eraseAt(e.clientX, e.clientY);
    }
  }, [toImage, eraseAt]);

  // 指针抬起 / 离开 / 取消
  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const mode = gestureModeRef.current;
    activePointersRef.current.delete(e.pointerId);
    const remaining = activePointersRef.current.size;

    if (mode === 'draw' && e.pointerId === drawPointerIdRef.current) {
      commitStroke();
    }

    if (mode === 'pinch') {
      if (remaining === 1) {
        // 双指变单指：转为平移（从剩余指开始）
        const [last] = Array.from(activePointersRef.current.values());
        if (last) {
          gestureModeRef.current = 'pan';
        } else {
          gestureModeRef.current = 'none';
        }
      } else {
        gestureModeRef.current = remaining === 0 ? 'none' : 'pinch';
      }
      if (remaining < 2) pinchStartRef.current = null;
    } else if (mode === 'pinchpan') {
      // 绘制模式双指缩放/移动结束：不在剩余手指处自动起新笔（会落下杂点），
      // 新的一笔从下次按下开始
      if (remaining < 2) pinchStartRef.current = null;
      if (remaining < 2) gestureModeRef.current = 'none';
    } else if ((mode === 'pan' || mode === 'erase') && remaining === 0) {
      gestureModeRef.current = 'none';
    }
  }, [commitStroke]);

  // 撤销上一操作（笔画/填充/擦除共用增量栈）。
  // add 的逆操作=删最后一条；erase 的逆操作=把擦掉的按原下标放回；
  // clear 的逆操作=整体恢复。与橡皮擦"删中间某条"配合，撤销才不会删错对象。
  const handleUndo = useCallback(() => {
    const delta = undoStackRef.current.pop();
    if (!delta) return;
    let next: UserAction[];
    if (delta.type === 'add') {
      next = userActionsRef.current.slice(0, -1);
    } else if (delta.type === 'erase') {
      next = [...userActionsRef.current];
      next.splice(delta.index, 0, delta.action);
    } else {
      next = delta.actions;
    }
    userActionsRef.current = next;
    setUserActions(next);
  }, []);

  // 清除所有用户绘制（笔画 + 填充），记录整体快照供撤销恢复
  const handleClear = useCallback(() => {
    if (window.confirm('确定要清除所有绘制内容吗？')) {
      if (userActionsRef.current.length > 0) {
        undoStackRef.current.push({ type: 'clear', actions: [...userActionsRef.current] });
      }
      userActionsRef.current = [];
      setUserActions([]);
      currentStrokeRef.current = null;
    }
  }, []);

  // 导出为图片（按原始视图合并三层，不受当前缩放/平移影响）
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

  // 导出用户绘制路径为 JSON（输出本项目标准案例格式：steps[].strokes，
  // 与数据目录里的图案 JSON 一致，可直接被 gen_thumbnails.py 渲染）。
  // 填充是位图结果，不进入这套路径格式，只导出笔画部分。
  const handleExportJson = useCallback(() => {
    const strokesInStack = userActions.filter((a): a is Extract<UserAction, { kind: 'stroke' }> => a.kind === 'stroke');
    if (strokesInStack.length === 0) {
      alert('还没有可导出的笔画（填充不导出 JSON），先画几笔再导出吧～');
      return;
    }
    try {
      // 用户笔画存的是画布 CSS 像素坐标（绘制时的屏幕尺寸），
      // 这里用 getTransform 的逆变换换算回 viewBox 坐标
      // 画布尺寸直接读 clientWidth/Height（与 renderLayers 的 displayWidth/Height 同源）
      const cv = brushRef.current || outlineRef.current;
      const w = cv ? cv.clientWidth : 600;
      const h = cv ? cv.clientHeight : 600;
      const [vx0, vy0, vx1, vy1] = drawing.viewBox;
      const vw = vx1 - vx0;
      const vh = vy1 - vy0;
      const scale = Math.min(w / vw, h / vh) * 0.8; // 与 getTransform 一致（留 10% 边距）
      const offsetX = (w - vw * scale) / 2 - vx0 * scale;
      const offsetY = (h - vh * scale) / 2 - vy0 * scale;

      // 只导出笔画（填充是位图，不进入路径格式）
      const userStrokes = strokesInStack.map(a => a.stroke);
      // 换算后的 strokes（viewBox 坐标），保留用户选择的颜色与画笔类型
      // （gen_thumbnails.py 只读 points/width，多余字段会被忽略）
      const strokes = userStrokes.map(s => ({
        width: Math.round((s.width / scale) * 100) / 100,
        color: s.color,
        type: s.type,
        points: s.points.map(p => [
          Math.round((p[0] - offsetX) / scale * 100) / 100,
          Math.round((p[1] - offsetY) / scale * 100) / 100
        ])
      }));

      // 扩大 viewBox 以包含全部笔画（只扩不缩，保持原坐标系；
      // 用户在图案外围边距里画的内容不会超出 viewBox 被裁掉）
      const pad = 8; // 与 gen_thumbnails.py 的 PADDING 对应
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      let maxHalfWidth = 0;
      for (const s of strokes) {
        const half = s.width / 2;
        if (half > maxHalfWidth) maxHalfWidth = half;
        for (const [x, y] of s.points) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
      const margin = pad + maxHalfWidth;
      const viewBox: [number, number, number, number] = [
        Math.min(vx0, Math.round(minX - margin)),
        Math.min(vy0, Math.round(minY - margin)),
        Math.max(vx1, Math.round(maxX + margin)),
        Math.max(vy1, Math.round(maxY + margin))
      ];
      // 单点笔画（minX==maxX）时保证 viewBox 有最小尺寸
      if (viewBox[2] - viewBox[0] < 2 * margin) viewBox[2] = viewBox[0] + 2 * margin;
      if (viewBox[3] - viewBox[1] < 2 * margin) viewBox[3] = viewBox[1] + 2 * margin;

      const payload = {
        id: `user-${Date.now()}`,
        name: drawing.name ? `${drawing.name}-用户绘制` : '用户绘制',
        viewBox,
        steps: [{ id: 1, tip: '', strokes }]
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.download = `${payload.name}-${Date.now()}.json`;
      link.href = url;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('导出 JSON 失败:', err);
      alert('导出失败，请重试');
    }
  }, [userActions, drawing.name, drawing.viewBox]);

  // 分享：优先调用系统分享面板（支持时带上当前画面合成图），不支持时复制链接。
  // 合成图 = 参考图案（当前进度）+ 用户绘制（笔画/填充），与"保存图片"同源，
  // 让分享卡片直接展示用户临摹成果，而不是空白参考图。
  const handleShare = useCallback(() => {
    const url = window.location.href;
    if (navigator.share && window.isSecureContext) {
      // Web Share Level 2：可附带文件（图片）。不支持 files 的平台回退为纯链接分享。
      try {
        const dataUrl = exportToDataURL(drawing, state.currentStep, state.progress);
        if (dataUrl) {
          const blob = dataUrlToBlob(dataUrl);
          const file = new File([blob], `${drawing.name || 'drawing'}.png`, { type: 'image/png' });
          const shareData: ShareData & { files?: File[] } = { title: document.title, url, files: [file] };
          const canShareFiles = typeof (navigator as Navigator & { canShare?: (d: ShareData) => boolean }).canShare === 'function'
            ? (navigator as Navigator & { canShare: (d: ShareData) => boolean }).canShare(shareData)
            : true;
          if (canShareFiles) {
            navigator.share(shareData).catch(() => {});
            return;
          }
        }
      } catch (err) {
        // 合成失败（如导出报错）则退化为纯链接分享
        console.warn('分享附图失败，退化为链接分享:', err);
      }
      navigator.share({ title: document.title, url }).catch(() => {});
      return;
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(() => {
        alert('链接已复制，快去分享给朋友吧～');
      }).catch(() => alert(url));
    } else {
      alert(url);
    }
  }, [exportToDataURL, drawing, state.currentStep, state.progress]);

  // 切换画笔类型：点击某支画笔进入绘制模式，再点同一支则退出绘制模式
  const handleStrokeTypeSelect = useCallback((key: StrokeType) => {
    if (drawingMode && strokeType === key) {
      setDrawingMode(false);
      // 退出时收尾可能残留的笔画
      commitStroke();
    } else {
      setStrokeType(key);
      setDrawingMode(true);
    }
  }, [drawingMode, strokeType, commitStroke]);

  // 复位视图：缩放/平移恢复原始大小与位置。
  // 用户笔画以图像坐标存储，视图复位后自动按比例缩回、位置复原。
  const handleViewReset = useCallback(() => {
    viewRef.current = { ...IDENTITY_VIEW };
    pinchStartRef.current = null;
  }, []);

  // 快捷切换模式：绘制模式 <-> 缩放/移动模式。
  // 进入绘制模式时沿用当前选中的画笔。
  const handleToggleDrawMode = useCallback(() => {
    setDrawingMode(prev => !prev);
  }, []);

  // 滚轮缩放（鼠标 / 触控板）：以指针位置为锚点，绘制/缩放移动模式下均生效
  // （PC 上绘制时滚轮即放大缩小）。用原生非 passive 监听，才能 preventDefault 阻止页面滚动。
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
      // 以指针位置（相对画布中心）为锚点缩放
      const anchorX = e.clientX - rect.left - rect.width / 2;
      const anchorY = e.clientY - rect.top - rect.height / 2;
      viewRef.current = zoomAnchored(view, newScale, anchorX, anchorY);
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [brushRef]);

  const currentStepData = drawing.steps[state.currentStep];
  const globalProgress = getGlobalProgress();

  return (
    <div className="drawing-detail">
      {/* 导航栏 */}
      <Navbar showBack onBack={onBack} />

      {/* 主内容区域 */}
      <div className="main-content">
        {/* 画布区：三层 Canvas 叠加
            底层 outlineCanvas —— JSON 图案数据（轮廓/已完成步骤/动画笔画）
            中层 historyCanvas —— 用户已完成的笔画（增量绘制）
            顶层 brushCanvas   —— 当前正在绘制的笔画（指针事件挂在这层）
            三层只在导出时合并 */}
        <div className="canvas-wrapper">
          <div className="canvas-stack">
            <canvas
              ref={outlineRef}
              className="drawing-canvas"
            />
            <canvas
              ref={historyRef}
              className="drawing-canvas"
            />
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
          {/* 步骤提示固定在右下角 */}
          <div className="step-tip-overlay">
            <span className="tip-text">{currentStepData?.tip || ''}</span>
          </div>
          {/* 填充失败提示：画布顶部居中，轻量、自动消失 */}
          {fillHint && (
            <div className="fill-hint-overlay">
              <span className="fill-hint-text">{fillHint}</span>
            </div>
          )}
          {/* 右上角最边缘：视图复位按钮，点击恢复原始大小与位置 */}
          <button className="view-reset-btn" onClick={handleViewReset} title="复位视图">
            <img className="view-reset-icon" src={resetIcon} alt="复位视图" />
          </button>
          {/* 复位按钮左侧：模式快捷切换（绘制 <-> 缩放/移动） */}
          <button
            className="mode-toggle-btn"
            onClick={handleToggleDrawMode}
            title={drawingMode ? '切换到缩放/移动模式' : '切换到绘制模式'}
          >
            <img
              className="mode-toggle-icon"
              src={drawingMode ? scaleMoveIcon : drawIcon}
              alt={drawingMode ? '缩放/移动' : '绘制'}
            />
          </button>
        </div>

        {/* 工具栏区域 */}
        <div className="toolbar-wrapper">
          {/* 播放控制栏 */}
          <div className="control-bar">
            <div className="control-btn-row">
              <button
                className={`control-btn outline-btn ${state.showOutline ? 'active' : ''}`}
                onClick={actions.toggleOutline}
                title="轮廓"
              >
                <img className="outline-icon" src={state.showOutline ? outlineIconActive : outlineIcon} alt="轮廓" />
              </button>
              <button
                className="control-btn"
                onClick={actions.prevStep}
                title="上一步"
              >
                <img className="btn-icon" src={preIcon} alt="上一步" style={{ left: -3, top: 2 }} />
              </button>
              <button
                className={`control-btn play-btn ${state.playing ? 'playing' : ''}`}
                onClick={actions.togglePlay}
                title={state.playing ? '暂停' : '播放'}
              >
                <img className="btn-icon" src={state.playing ? stopIcon : playIcon} alt={state.playing ? '暂停' : '播放'} style={{ top: 2 }} />
              </button>
              <button
                className="control-btn"
                onClick={actions.nextStep}
                title="下一步"
              >
                <img className="btn-icon" src={nextIcon} alt="下一步" style={{ right: -3, top: 2 }} />
              </button>
              <button
                className="control-btn"
                onClick={actions.reset}
                title="重播"
              >
                <img className="btn-icon" src={refreshIcon} alt="重播" style={{ top: 2, right: -2 }} />
              </button>
              <button
                className={`control-btn speed-btn ${state.speed === 0.5 ? 'active' : ''}`}
                onClick={actions.toggleSpeed}
                title="切换倍速"
              >
                <span className="speed-text">{state.speed}x</span>
              </button>
              <button
                className={`control-btn loop-btn ${state.loopCurrentStep ? 'active' : ''}`}
                onClick={actions.toggleLoop}
                title={state.loopCurrentStep ? '单步循环（开）' : '单步循环（关）'}
              >
                <img
                  className="loop-icon"
                  src={state.loopCurrentStep ? stepLoopIconActive : stepLoopIcon}
                  alt="单步循环"
                />
              </button>
            </div>
          </div>

          {/* 进度条 */}          <div className="progress-container">
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={globalProgress}
              onChange={(e) => actions.setGlobalProgress(parseFloat(e.target.value))}
              className="progress-bar"
            />
          </div>

          {/* 颜色选择器 */}
          <div className="color-bar">
            {COLOR_OPTIONS.map((color) => (
              <button
                key={color}
                className={`color-item ${strokeColor === color ? 'active' : ''}`}
                onClick={() => setStrokeColor(color)}
                title={color}
              >
                <span className="color-circle" style={{ backgroundColor: color }} />
              </button>
            ))}
            <label className="color-picker-label" title="选择任意颜色">
              <input
                type="color"
                value={strokeColor}
                onChange={(e) => setStrokeColor(e.target.value)}
                className="color-picker-input"
              />
              <span className="color-circle" style={{ backgroundColor: strokeColor }} />
            </label>
          </div>

          {/* 笔画粗细选择器 */}
          <div className="stroke-width-bar">
            {STROKE_WIDTH_OPTIONS.map((width) => (
              <button
                key={width}
                className={`stroke-width-item ${strokeWidth === width ? 'active' : ''}`}
                onClick={() => setStrokeWidth(width)}
                title={`粗细：${width}`}
              >
                <span className="stroke-circle" style={{ width, height: width }} />
              </button>
            ))}
            {/* 自定义画笔大小滑块 */}
            <div className="stroke-width-slider-wrapper" title="自定义画笔大小">
              <input
                type="range"
                min="1"
                max="20"
                value={strokeWidth}
                onChange={(e) => setStrokeWidth(parseInt(e.target.value))}
                className="stroke-width-slider"
              />
              <span className="stroke-width-value">{strokeWidth}</span>
            </div>
          </div>

          {/* 画笔类型选择器：点击选中画笔进入绘制模式，再点同一支退出 */}
          <div className="stroke-type-bar">
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
                <span className="stroke-type-name">{type.name}</span>
              </button>
            ))}
          </div>

          {/* 绘图工具栏 */}
          <div className="draw-tools-bar">
            <button className="draw-tool-btn" onClick={handleUndo} title="撤销">
              <img className="tool-btn-icon" src={undoIcon} alt="撤销" />
            </button>
            <button className="draw-tool-btn" onClick={handleClear} title="清除">
              <img className="tool-btn-icon" src={clearIcon} alt="清除" />
            </button>
            <button className="draw-tool-btn save-btn" onClick={handleExport} title="保存图片">
              <img className="tool-btn-icon" src={saveIcon} alt="保存" />
            </button>
            <button
              className="draw-tool-btn export-json-btn"
              onClick={handleExportJson}
              title="导出绘制路径 JSON"
            >
              <svg className="tool-btn-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-label="导出 JSON">
                <path d="M12 3v12" />
                <path d="M7 11l5 5 5-5" />
                <path d="M4 20h16" />
              </svg>
            </button>
            <button className="draw-tool-btn share-btn" onClick={handleShare} title="分享">
              <img className="tool-btn-icon" src={shareIcon} alt="分享" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function DrawingDetail() {
  const params = useParams<{ '*': string }>();
  // 路径可能含多级分类，如 "detail/quickdraw/cat/xxx"
  const segments = (params['*'] || '').split('/').filter(Boolean);
  const drawingId = segments.pop() || '';
  const categoryId = segments.join('/');
  const navigate = useNavigate();
  const [drawing, setDrawing] = useState<Drawing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (categoryId && drawingId) {
      loadDrawing(categoryId, drawingId).then(data => {
        setDrawing(data);
        setLoading(false);
      }).catch(err => {
        console.error('加载图案失败:', err);
        setError(true);
        setLoading(false);
      });
    } else {
      navigate('/');
    }
  }, [categoryId, drawingId, navigate]);

  const handleBack = () => {
    navigate(-1);
  };

  // 如果加载中或错误，显示加载状态
  if (loading || error) {
    return (
      <div className="drawing-detail">
        <Navbar showBack onBack={handleBack} />
        <div className="loading-state">
          <div className="loading-spinner"></div>
          <p>{error ? '加载失败，请刷新页面重试' : '加载中...'}</p>
        </div>
      </div>
    );
  }

  if (!drawing) {
    return null;
  }

  // key=drawing.id：切换图案时强制重建画布组件，重置用户绘制栈、撤销增量栈、
  // 视图变换等实例状态，避免上一幅图的残留（撤销栈/画布内容）串到下一幅。
  return <DrawingCanvas key={drawing.id} drawing={drawing} onBack={handleBack} />;
}
