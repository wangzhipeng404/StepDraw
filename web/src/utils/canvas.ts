// 一笔一笔 StepDraw - Canvas 渲染工具

import type { Drawing, Stroke, UserStroke } from '../types';

/**
 * 将采样点转换为平滑的二次贝塞尔曲线路径
 * 使用中点法：相邻两点的中点作为控制点
 */
export function createSmoothPath(points: [number, number][]): string {
  if (points.length < 2) return '';
  if (points.length === 2) {
    return `M ${points[0][0]} ${points[0][1]} L ${points[1][0]} ${points[1][1]}`;
  }

  let path = `M ${points[0][0]} ${points[0][1]}`;

  for (let i = 1; i < points.length - 1; i++) {
    const midX = (points[i][0] + points[i + 1][0]) / 2;
    const midY = (points[i][1] + points[i + 1][1]) / 2;
    path += ` Q ${points[i][0]} ${points[i][1]}, ${midX} ${midY}`;
  }

  // 连接到最后一个点
  const last = points[points.length - 1];
  path += ` L ${last[0]} ${last[1]}`;

  return path;
}

/**
 * 计算笔画的累积弧长，用于进度插值
 */
export function calculateStrokeLengths(points: [number, number][]): {
  totalLength: number;
  segments: number[];
} {
  if (points.length < 2) {
    return { totalLength: 0, segments: [] };
  }

  const segments: number[] = [];
  let totalLength = 0;

  for (let i = 1; i < points.length; i++) {
    const dx = points[i][0] - points[i - 1][0];
    const dy = points[i][1] - points[i - 1][1];
    const length = Math.sqrt(dx * dx + dy * dy);
    segments.push(length);
    totalLength += length;
  }

  return { totalLength, segments };
}

/**
 * 根据进度获取笔画上某一点的位置
 */
export function getPositionAtProgress(
  points: [number, number][],
  progress: number
): [number, number] {
  if (points.length < 2) return points[0] || [0, 0];

  const { totalLength, segments } = calculateStrokeLengths(points);
  if (totalLength === 0) return points[0];

  const targetLength = progress * totalLength;
  let accumulatedLength = 0;

  for (let i = 0; i < segments.length; i++) {
    if (accumulatedLength + segments[i] >= targetLength) {
      const segmentProgress = (targetLength - accumulatedLength) / segments[i];
      const p0 = points[i];
      const p1 = points[i + 1];
      return [
        p0[0] + (p1[0] - p0[0]) * segmentProgress,
        p0[1] + (p1[1] - p0[1]) * segmentProgress
      ];
    }
    accumulatedLength += segments[i];
  }

  return points[points.length - 1];
}

/**
 * 渲染单个笔画到 Canvas
 */
export function renderStroke(
  ctx: CanvasRenderingContext2D,
  stroke: Stroke,
  progress: number = 1,
  color: string = '#333',
  isCurrentStroke: boolean = false
): void {
  const { totalLength, segments } = calculateStrokeLengths(stroke.points);
  if (totalLength === 0) return;

  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = stroke.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (isCurrentStroke && progress < 1) {
    // 当前笔画，按进度绘制
    const targetLength = progress * totalLength;
    let accumulatedLength = 0;

    ctx.moveTo(stroke.points[0][0], stroke.points[0][1]);

    for (let i = 1; i < stroke.points.length; i++) {
      if (accumulatedLength + segments[i - 1] >= targetLength) {
        const remaining = targetLength - accumulatedLength;
        const segmentProgress = remaining / segments[i - 1];
        const p0 = stroke.points[i - 1];
        const p1 = stroke.points[i];
        ctx.lineTo(
          p0[0] + (p1[0] - p0[0]) * segmentProgress,
          p0[1] + (p1[1] - p0[1]) * segmentProgress
        );
        break;
      }
      ctx.lineTo(stroke.points[i][0], stroke.points[i][1]);
      accumulatedLength += segments[i - 1];
    }
  } else {
    // 已完成笔画，绘制完整
    ctx.moveTo(stroke.points[0][0], stroke.points[0][1]);
    for (let i = 1; i < stroke.points.length; i++) {
      ctx.lineTo(stroke.points[i][0], stroke.points[i][1]);
    }
  }

  ctx.stroke();
}

/**
 * 渲染用户笔画到 Canvas（完全参考小程序逻辑）
 * 用户绘制的坐标是 CSS 像素，直接使用 CSS 像素坐标绘制
 */
export function renderUserStroke(
  ctx: CanvasRenderingContext2D,
  stroke: UserStroke
): void {
  const color = stroke.color || '#E53935';
  const width = stroke.width || 4;
  const strokeType = stroke.type || 'pen';
  const points = stroke.points;

  if (points.length === 0) return;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // 单个点：绘制一个圆形
  if (points.length === 1) {
    const [x, y] = points[0];
    const radius = width / 2;

    if (strokeType === 'pencil') {
      // 铅笔：绘制不规则的小点
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
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
      ctx.beginPath();
      ctx.ellipse(x, y, radius * 1.5, radius, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    } else if (strokeType === 'brush') {
      // 毛笔：绘制有渐变效果的圆
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.6;
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
      gradient.addColorStop(0, color);
      gradient.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    } else {
      // 钢笔：实心圆
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    // 多个点：绘制路径
    ctx.beginPath();
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
      gradient.addColorStop(0, color);
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
  ctx.restore();
}

// ============================================================
// 视图变换（缩放 / 平移）
//
// 图像坐标系：view.scale=1、tx=0、ty=0 时与画布 CSS 像素坐标一致。
// 视图变换叠加在画布之上：以画布中心为缩放中心，单指/拖拽平移整图。
// 用户笔画以图像坐标存储，缩放/平移只是显示层变换，导出与复位不受影响。
// ============================================================

export interface ViewTransform {
  scale: number; // 缩放倍率（1 = 原始大小）
  tx: number;    // 平移量（CSS 像素）
  ty: number;
}

export const IDENTITY_VIEW: ViewTransform = { scale: 1, tx: 0, ty: 0 };

/** 把视图变换叠加到 ctx 上（内部已合成 dpr），之后按 CSS 像素坐标绘制即可。 */
export function applyViewTransform(
  ctx: CanvasRenderingContext2D,
  dpr: number,
  cssW: number,
  cssH: number,
  view: ViewTransform
): void {
  const s = view.scale;
  const cx = cssW / 2;
  const cy = cssH / 2;
  // 图像点 p -> 屏幕点 p' = s*(p - c) + c + (tx, ty)，其中 c = (cssW/2, cssH/2)
  ctx.setTransform(
    dpr * s, 0, 0, dpr * s,
    dpr * (cx + view.tx - s * cx),
    dpr * (cy + view.ty - s * cy)
  );
}

/** 视口坐标（clientX/Y）-> 图像坐标（CSS 像素），绘制时把指针落点还原到未缩放/未平移的图。 */
export function toImagePoint(
  clientX: number,
  clientY: number,
  rectLeft: number,
  rectTop: number,
  cssW: number,
  cssH: number,
  view: ViewTransform
): [number, number] {
  const cx = clientX - rectLeft - cssW / 2;
  const cy = clientY - rectTop - cssH / 2;
  return [
    (cx - view.tx) / view.scale + cssW / 2,
    (cy - view.ty) / view.scale + cssH / 2
  ];
}

// 以画布中心为缩放中心：给定锚点前的 scale 与平移，返回缩放后使锚点保持不动的平移。
export function zoomAnchored(
  view: ViewTransform,
  newScale: number,
  anchorCssX: number, // 相对画布中心（CSS 像素）
  anchorCssY: number
): ViewTransform {
  const factor = newScale / view.scale;
  return {
    scale: newScale,
    tx: anchorCssX - factor * (anchorCssX - view.tx),
    ty: anchorCssY - factor * (anchorCssY - view.ty)
  };
}

// ============================================================
// 三层画布渲染（与小程序端同构）
//
// outline（底层）：JSON 图案数据 —— 轮廓底图 / 已完成步骤 / 当前动画笔画
// history（中层）：用户已完成的笔画，增量绘制（只追加，撤销/清除才重建）
// brush（顶层）：当前正在绘制的一笔，每帧只重画这一笔
//
// 三层各自独立承载，只有导出时合并。
// ============================================================

type CanvasLike = HTMLCanvasElement;

/**
 * 三层渲染的可变状态（缓存），由 hook 持有并逐帧传入。
 * 尺寸/dpr 变化时 renderLayers 会返回全新状态（旧缓存作废）。
 */
export interface LayerState {
  size: { cssW: number; cssH: number; dpr: number };
  /** 轮廓底图离屏缓存 */
  outlineCache: CanvasLike | null;
  /** 已完成步骤离屏缓存 */
  doneCache: CanvasLike | null;
  /** 用户笔画离屏缓存（仅笔画增删时重建，缩放/平移时直接 drawImage） */
  userCache: CanvasLike | null;
  outlineKey: string;
  doneKey: string;
  /** 历史层已绘制的笔画数（用于增量/重建判断） */
  historyCount: number;
}

export interface RenderLayersArgs {
  drawing: Drawing;
  currentStep: number;
  stepProgress: number;
  showOutline: boolean;
  userStrokes: UserStroke[];
  currentStroke: UserStroke | null;
  /** 视图变换（缩放/平移），默认无变换 */
  view?: ViewTransform;
}

// 创建与主画布同尺寸的离屏画布（用于静态内容缓存）
function createCacheCanvas(size: { cssW: number; cssH: number; dpr: number }): CanvasLike {
  const off = document.createElement('canvas');
  off.width = Math.max(1, Math.round(size.cssW * size.dpr));
  off.height = Math.max(1, Math.round(size.cssH * size.dpr));
  return off;
}

function getTransform(size: { cssW: number; cssH: number }, drawing: Drawing): { scale: number; offsetX: number; offsetY: number } {
  const { viewBox } = drawing;
  const { cssW: width, cssH: height } = size;
  const patternWidth = viewBox[2] - viewBox[0];
  const patternHeight = viewBox[3] - viewBox[1];
  const scale = Math.min(width / patternWidth, height / patternHeight) * 0.8; // 留 10% 边距
  const offsetX = (width - patternWidth * scale) / 2 - viewBox[0] * scale;
  const offsetY = (height - patternHeight * scale) / 2 - viewBox[1] * scale;
  return { scale, offsetX, offsetY };
}

// 重建"已完成步骤"离屏缓存（步骤切换/尺寸变化时调用）
function rebuildDoneCache(
  state: LayerState,
  drawing: Drawing,
  currentStep: number
): void {
  const { scale, offsetX, offsetY } = getTransform(state.size, drawing);
  const cache = createCacheCanvas(state.size);
  const ctx = cache.getContext('2d');
  if (!ctx) {
    state.doneCache = null;
    return;
  }
  const dpr = state.size.dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);
  for (let i = 0; i < currentStep; i++) {
    const step = drawing.steps[i];
    if (step) {
      for (const stroke of step.strokes) {
        renderStroke(ctx, stroke, 1, '#000', false);
      }
    }
  }
  state.doneCache = cache;
}

// 重建"轮廓底图"离屏缓存（显隐/尺寸变化时调用）
function rebuildOutlineCache(
  state: LayerState,
  drawing: Drawing,
  showOutline: boolean
): void {
  if (!showOutline) {
    state.outlineCache = null;
    return;
  }
  const { scale, offsetX, offsetY } = getTransform(state.size, drawing);
  const cache = createCacheCanvas(state.size);
  const ctx = cache.getContext('2d');
  if (!ctx) {
    state.outlineCache = null;
    return;
  }
  const dpr = state.size.dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);
  ctx.globalAlpha = 0.15;
  for (const step of drawing.steps) {
    for (const stroke of step.strokes) {
      renderStroke(ctx, stroke, 1, '#333', false);
    }
  }
  state.outlineCache = cache;
}

// 重建"用户笔画"离屏缓存（新增/撤销/清除时调用，缩放/平移时复用）
function rebuildUserCache(state: LayerState, userStrokes: UserStroke[]): void {
  const cache = createCacheCanvas(state.size);
  const ctx = cache.getContext('2d');
  if (!ctx) {
    state.userCache = null;
    return;
  }
  const dpr = state.size.dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const stroke of userStrokes) {
    renderUserStroke(ctx, stroke);
  }
  state.userCache = cache;
}

// 绘制当前步骤的动画部分（viewBox 变换 + 进度映射）。
// ctx 需已处于目标坐标系；内部 save/translate/scale/restore，不影响外部变换（如视图变换）。
function renderCurrentStep(
  ctx: CanvasRenderingContext2D,
  size: { cssW: number; cssH: number },
  drawing: Drawing,
  currentStep: number,
  stepProgress: number
): void {
  const currentStepData = drawing.steps[currentStep];
  if (!currentStepData || currentStepData.strokes.length === 0) return;
  const strokes = currentStepData.strokes;
  const { scale, offsetX, offsetY } = getTransform(size, drawing);

  ctx.save();
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);

  if (stepProgress >= 1) {
    for (const stroke of strokes) {
      renderStroke(ctx, stroke, 1, '#000', false);
    }
  } else {
    // 基于笔画总长度做进度映射
    const strokeLengths: number[] = [];
    let totalLength = 0;
    for (const stroke of strokes) {
      const { totalLength: len } = calculateStrokeLengths(stroke.points);
      strokeLengths.push(len);
      totalLength += len;
    }

    if (totalLength === 0) {
      // 总长度为 0，按笔画数量分配进度
      const strokesProgress = stepProgress * strokes.length;
      const completedStrokes = Math.floor(strokesProgress);
      const currentStrokeProgress = strokesProgress - completedStrokes;

      for (let i = 0; i < completedStrokes; i++) {
        renderStroke(ctx, strokes[i], 1, '#000', false);
      }
      if (completedStrokes < strokes.length) {
        const current = strokes[completedStrokes];
        if (current) renderStroke(ctx, current, currentStrokeProgress, '#E53935', true);
      }
    } else {
      const targetLength = stepProgress * totalLength;
      let accumulatedLength = 0;
      let completedStrokes = 0;
      let currentStrokeProgress = 1;

      for (let i = 0; i < strokes.length; i++) {
        if (accumulatedLength + strokeLengths[i] >= targetLength) {
          completedStrokes = i;
          currentStrokeProgress = strokeLengths[i] > 0
            ? (targetLength - accumulatedLength) / strokeLengths[i]
            : 1;
          break;
        }
        accumulatedLength += strokeLengths[i];
        completedStrokes = i + 1;
      }

      for (let i = 0; i < completedStrokes; i++) {
        renderStroke(ctx, strokes[i], 1, '#000', false);
      }
      if (completedStrokes < strokes.length) {
        const current = strokes[completedStrokes];
        if (current) renderStroke(ctx, current, currentStrokeProgress, '#E53935', true);
      }
    }
  }
  ctx.restore();
}

/**
 * 每帧入口：检查缓存有效性后分三层绘制，返回更新后的状态。
 * - outline 层：静态内容（轮廓底图、已完成步骤）走离屏缓存，每帧仅
 *   2 次全屏 drawImage + 当前动画部分
 * - history 层：增量追加新笔画；笔画数减少（撤销/清除）时整体重建
 * - brush 层：只重画当前这一笔
 */
export function renderLayers(
  outlineCanvas: HTMLCanvasElement | null,
  historyCanvas: HTMLCanvasElement | null,
  brushCanvas: HTMLCanvasElement | null,
  state: LayerState | null,
  args: RenderLayersArgs
): LayerState | null {
  const { drawing, currentStep, stepProgress, showOutline, userStrokes, currentStroke } = args;
  if (!outlineCanvas || !historyCanvas || !brushCanvas || drawing.steps.length === 0) return state;

  const dpr = window.devicePixelRatio || 1;
  const displayWidth = outlineCanvas.clientWidth;
  const displayHeight = outlineCanvas.clientHeight;
  if (displayWidth === 0 || displayHeight === 0) return state;

  // 尺寸/像素比变化：全部缓存作废
  if (!state || state.size.cssW !== displayWidth || state.size.cssH !== displayHeight || state.size.dpr !== dpr) {
    state = {
      size: { cssW: displayWidth, cssH: displayHeight, dpr },
      outlineCache: null,
      doneCache: null,
      userCache: null,
      outlineKey: '',
      doneKey: '',
      historyCount: 0
    };
  }

  const ctx = outlineCanvas.getContext('2d');
  const historyCtx = historyCanvas.getContext('2d');
  const brushCtx = brushCanvas.getContext('2d');
  if (!ctx || !historyCtx || !brushCtx) return state;

  // 设置三层画布 backing store 尺寸（变化时会清空对应层）
  const targetWidth = displayWidth * dpr;
  const targetHeight = displayHeight * dpr;
  for (const cv of [outlineCanvas, historyCanvas, brushCanvas]) {
    if (cv.width !== targetWidth || cv.height !== targetHeight) {
      cv.width = targetWidth;
      cv.height = targetHeight;
    }
  }

  // ---- outline 层：静态内容走离屏缓存，整体叠加视图变换 ----
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, targetWidth, targetHeight);

  const sizeKey = `${displayWidth}x${displayHeight}@${dpr}`;
  const outlineKey = `${sizeKey}|${showOutline ? 1 : 0}`;
  const doneKey = `${sizeKey}|${currentStep}`;

  if (state.outlineKey !== outlineKey) {
    rebuildOutlineCache(state, drawing, showOutline);
    state.outlineKey = outlineKey;
  }
  if (state.doneKey !== doneKey) {
    rebuildDoneCache(state, drawing, currentStep);
    state.doneKey = doneKey;
  }

  const view = args.view || IDENTITY_VIEW;
  const cssW = state.size.cssW;
  const cssH = state.size.cssH;

  // 叠加视图变换（以画布中心为缩放中心），缓存按图像坐标 blit
  applyViewTransform(ctx, dpr, cssW, cssH, view);
  if (state.outlineCache) {
    ctx.drawImage(state.outlineCache, 0, 0, cssW, cssH);
  }
  if (state.doneCache) {
    ctx.drawImage(state.doneCache, 0, 0, cssW, cssH);
  }

  // 当前步骤的动画部分（在视图变换之上再叠加 viewBox 变换）
  renderCurrentStep(ctx, state.size, drawing, currentStep, stepProgress);

  // ---- history 层：用户笔画走离屏缓存，叠加视图变换 ----
  // 笔画数变化（新增/撤销/清除）时重建缓存，缩放/平移时仅 drawImage 一次
  if (userStrokes.length !== state.historyCount) {
    rebuildUserCache(state, userStrokes);
    state.historyCount = userStrokes.length;
  }
  historyCtx.setTransform(1, 0, 0, 1, 0, 0);
  historyCtx.clearRect(0, 0, targetWidth, targetHeight);
  applyViewTransform(historyCtx, dpr, cssW, cssH, view);
  if (state.userCache) {
    historyCtx.drawImage(state.userCache, 0, 0, cssW, cssH);
  }

  // ---- brush 层（仅当前一笔），叠加视图变换 ----
  brushCtx.setTransform(1, 0, 0, 1, 0, 0);
  brushCtx.clearRect(0, 0, targetWidth, targetHeight);
  applyViewTransform(brushCtx, dpr, cssW, cssH, view);
  if (currentStroke && currentStroke.points.length >= 1) {
    renderUserStroke(brushCtx, currentStroke);
  }

  return state;
}

/**
 * 合并三层画布导出为 PNG dataURL。
 * 使用离屏缓存按"原始视图"合成，导出不受当前缩放/平移影响，始终为完整原图比例。
 * state 需为最近一次 renderLayers 返回的状态（缓存已就绪）。
 */
export function exportLayersToDataURL(
  state: LayerState | null,
  drawing: Drawing,
  currentStep: number,
  stepProgress: number
): string | null {
  if (!state) return null;
  const { cssW, cssH, dpr } = state.size;
  if (cssW === 0 || cssH === 0) return null;

  const out = document.createElement('canvas');
  out.width = Math.round(cssW * dpr);
  out.height = Math.round(cssH * dpr);
  const ctx = out.getContext('2d');
  if (!ctx) return null;

  // 白色背景（与小程序端导出一致），按原始视图（无缩放/平移）合成
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, out.width, out.height);

  if (state.outlineCache) ctx.drawImage(state.outlineCache, 0, 0, out.width, out.height);
  if (state.doneCache) ctx.drawImage(state.doneCache, 0, 0, out.width, out.height);
  if (state.userCache) ctx.drawImage(state.userCache, 0, 0, out.width, out.height);

  // 当前步骤动画部分（viewBox 变换，dpr 缩放）
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  renderCurrentStep(ctx, state.size, drawing, currentStep, stepProgress);

  return out.toDataURL('image/png');
}
