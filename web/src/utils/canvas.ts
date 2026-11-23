// 一笔一笔 StepDraw - Canvas 渲染工具

import type { Drawing, Stroke, UserAction, UserStroke } from '../types';

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

/** 播放时"正在绘制"笔画的颜色：介于轮廓底图（#333@15%）与最终线条（#000）之间的深灰 */
export const PLAY_STROKE_COLOR = '#666';

/**
 * 三层渲染的可变状态（缓存），由 hook 持有并逐帧传入。
 * 尺寸/dpr 变化时 renderLayers 会返回全新状态（旧缓存作废）。
 */
export interface LayerState {
  size: { cssW: number; cssH: number; dpr: number };
  /** 引导底图离屏缓存（淡色全图案） */
  outlineCache: CanvasLike | null;
  /** 用户填充离屏缓存（设备像素，画在图案线条之下，涂色本效果） */
  fillCache: CanvasLike | null;
  /** 已完成步骤离屏缓存 */
  doneCache: CanvasLike | null;
  /** 用户手绘笔画离屏缓存（设备像素，画在图案之上） */
  strokeCache: CanvasLike | null;
  outlineKey: string;
  doneKey: string;
  fillKey: string;
  strokeKey: string;
}

export interface RenderLayersArgs {
  drawing: Drawing;
  currentStep: number;
  stepProgress: number;
  showOutline: boolean;
  userActions: UserAction[];
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
export { getTransform };

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

// ============================================================
// 漫水填充（油漆桶）
//
// 图案的封闭区域由抗锯齿、变宽、平滑过的采样点线条围成。手画的圆几乎必然
// 有 ≤4px 的起收笔缺口，严格逐像素 flood fill 会从缺口漏出去、撞到画布边缘
// 而误报"不封闭"。
// 所以这里：
//  1) 用 alpha 通道判定"墙"（墨线），不靠颜色容差对比；
//  2) 对墙做 1 像素二值膨胀，把 ≤2px 的缺口自动弥合（只用于遍历防漏）；
//  3) 墙内做 flood fill，碰到画布边缘 = 真的不封闭；
//  4) 输出时把填充向外扩 1px（只到抗锯齿 halo，不盖线条实体像素），
//     消掉填充与线条之间的白色缝隙。
// 结果是一张与画布同尺寸（设备像素）、区域白色 alpha=255 的区域掩码，存进 UserFill.mask。
// ============================================================

// 墙的 alpha 阈值：≥ 该值算墨线实体。抗锯齿 halo 分两层：
//  - 内层 halo（alpha ≥ 100）算墙实体，视觉上已是线条边缘；
//  - 外层 halo（alpha < 100）近乎透明，不填会透出白底形成"白缝"，输出时补上。
const WALL_ALPHA = 100;
// 墙膨胀半径（设备像素）：手画线条缺口通常 ≤4px（2 设备像素），膨胀 1px
// 即可把两侧墙接上；太大反而会把细区域填死。
const WALL_DILATE = 1;

/** 二值化墙图：alpha ≥ WALL_ALPHA 为 1（墨线实体） */
function binarizeWall(src: ImageData): Uint8Array {
  const n = src.width * src.height;
  const wall = new Uint8Array(n);
  const sd = src.data;
  for (let i = 0; i < n; i++) wall[i] = sd[i * 4 + 3] >= WALL_ALPHA ? 1 : 0;
  return wall;
}

/** 对二值墙图做 box 膨胀（每个 3x3 邻域有墙即成墙），r 次 */
function dilateWall(wall: Uint8Array, w: number, h: number, r: number): Uint8Array {
  let prev: Uint8Array = wall;
  let cur: Uint8Array = new Uint8Array(w * h);
  for (let k = 0; k < r; k++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (prev[i]) { cur[i] = 1; continue; }
        let hit = 0;
        for (let dy = -1; dy <= 1 && !hit; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            if (prev[yy * w + xx]) { hit = 1; break; }
          }
        }
        cur[i] = hit ? 1 : 0;
      }
    }
    // swap
    const tmp = prev; prev = cur; cur = tmp;
  }
  return prev;
}

/** floodFill 结果：成功带位图，失败带原因（'border'=不封闭, 'online'=点在墨线上, 'oob'=落点越界） */
export type FillResult =
  | { ok: true; canvas: HTMLCanvasElement }
  | { ok: false; reason: 'border' | 'online' | 'oob' };

/**
 * 在 underlay（当前墨线合成图，设备像素、透明底）上做漫水填充。
 */
export function floodFill(
  underlay: HTMLCanvasElement,
  seedX: number,
  seedY: number
): FillResult {
  const w = underlay.width;
  const h = underlay.height;
  const src = underlay.getContext('2d');
  if (!src || w === 0 || h === 0) return { ok: false, reason: 'oob' };

  const sx = Math.floor(seedX);
  const sy = Math.floor(seedY);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return { ok: false, reason: 'oob' };

  const img = src.getImageData(0, 0, w, h);
  const baseWall = binarizeWall(img);
  const wall = dilateWall(baseWall, w, h, WALL_DILATE);

  // 种子本身就在墙上（点在了线条上）：无处可填
  if (wall[sy * w + sx]) return { ok: false, reason: 'online' };

  // 只遍历"非墙"像素做连通域，墙即天然边界
  const visited = new Uint8Array(w * h);
  const stack: number[] = [sy * w + sx];
  let touchesBorder = false;

  while (stack.length > 0) {
    const p = stack.pop()!;
    if (visited[p] || wall[p]) continue;
    visited[p] = 1;
    const x = p % w;
    const y = (p - x) / w;
    // 连通域碰到画布边缘 = 填的是"图案外的无限背景"，说明该处不封闭。
    // 图案居中且四周留 10% 边距，正常封闭区域绝不会碰到边缘，可提前终止。
    if (x === 0 || x === w - 1 || y === 0 || y === h - 1) {
      touchesBorder = true;
      break;
    }
    if (x > 0) stack.push(p - 1);
    if (x < w - 1) stack.push(p + 1);
    if (y > 0) stack.push(p - w);
    if (y < h - 1) stack.push(p + w);
  }

  if (touchesBorder) return { ok: false, reason: 'border' };

  // 输出：区域掩码（白色 alpha=255、区域外全透明），与颜色解耦。
  // 连通域 + 1px 外扩，但不覆盖线条实体像素（baseWall）。
  // 外扩盖住线条的抗锯齿 halo（alpha < WALL_ALPHA 的半透明边缘）——
  // 膨胀墙让 visited 离线条多了 1px，不补的话 halo 下透出白底形成白缝。
  // 渲染时按 (mask, color) 上色；再次喷涂同一区域可复用此 mask。
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const outCtx = out.getContext('2d');
  if (!outCtx) return { ok: false, reason: 'oob' };
  const outData = outCtx.createImageData(w, h);
  const od = outData.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (baseWall[p]) continue;
      let hit = visited[p];
      if (!hit) {
        if ((x > 0 && visited[p - 1]) || (x < w - 1 && visited[p + 1]) ||
            (y > 0 && visited[p - w]) || (y < h - 1 && visited[p + w])) {
          hit = 1;
        }
      }
      if (!hit) continue;
      const i = p * 4;
      od[i] = 255; od[i + 1] = 255; od[i + 2] = 255; od[i + 3] = 255;
    }
  }
  outCtx.putImageData(outData, 0, 0);
  return { ok: true, canvas: out };
}

/**
 * 合成"填充用底图"（设备像素、透明底）。
 * 墙 = 整幅图案所有步骤的线条（画浓作墙）+ 用户内容（填充位图 + 笔画），全部不透明。
 * 为什么不复用 outlineCache/doneCache：
 *  - 引导层是 15% 半透明，alpha < WALL_ALPHA 不算墙，会把"点还没播放到的步骤"
 *    的区域判成不封闭；这里把引导线画浓，作为墙用（只用于找墙，不上屏）。
 *  - doneCache 只缓存 < currentStep 的步，缺当前步。
 */
export function buildUnderlay(
  size: { cssW: number; cssH: number; dpr: number },
  drawing: Drawing,
  userActions: UserAction[]
): HTMLCanvasElement | null {
  if (size.cssW === 0 || size.cssH === 0) return null;
  const dpr = size.dpr;
  const w = Math.max(1, Math.round(size.cssW * dpr));
  const h = Math.max(1, Math.round(size.cssH * dpr));
  const under = document.createElement('canvas');
  under.width = w;
  under.height = h;
  const ctx = under.getContext('2d');
  if (!ctx) return null;

  const { scale, offsetX, offsetY } = getTransform(size, drawing);

  // 整幅引导线画浓（作为墙），让"点未播放步骤的区域"也能封闭
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);
  for (const step of drawing.steps) {
    for (const stroke of step.strokes) {
      renderStroke(ctx, stroke, 1, '#000', false);
    }
  }

  // 用户手绘笔画作为墙（自由线条也能围出区域）。
  // 注意：已喷涂的填充是"色块"不是"线"，不作墙——否则已涂区域会被当成
  // 线条挡在新填充前面，导致"已经喷过的地方喷不上"。色块不阻挡新的漫水。
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (const a of userActions) {
    if (a.kind === 'stroke') {
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      renderUserStroke(ctx, a.stroke);
      ctx.restore();
    }
  }
  return under;
}

// 把白色区域掩码按颜色上色（掩码白色处 -> 颜色，其余透明），返回新画布。
// 每次重建填充缓存时调用；颜色与区域解耦，改色只是换颜色、不重算区域。
function tintMask(mask: HTMLCanvasElement, color: string): HTMLCanvasElement {
  const w = mask.width, h = mask.height;
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const outCtx = out.getContext('2d');
  if (!outCtx) return out;
  const srcCtx = mask.getContext('2d');
  if (!srcCtx) return out;
  const src = srcCtx.getImageData(0, 0, w, h).data;
  const outData = outCtx.createImageData(w, h);
  const od = outData.data;
  const fr = parseInt(color.slice(1, 3), 16);
  const fg = parseInt(color.slice(3, 5), 16);
  const fb = parseInt(color.slice(5, 7), 16);
  for (let i = 0; i < w * h; i++) {
    if (src[i * 4 + 3] < 128) continue;
    const j = i * 4;
    od[j] = fr; od[j + 1] = fg; od[j + 2] = fb; od[j + 3] = 255;
  }
  outCtx.putImageData(outData, 0, 0);
  return out;
}

// 判断点 (x,y)（掩码像素坐标）是否落在某区域掩码内。
// 用于"再次喷涂同区域时复用旧掩码"的判定。
export function isPointInMask(mask: HTMLCanvasElement, x: number, y: number): boolean {
  const w = mask.width, h = mask.height;
  const ix = Math.floor(x), iy = Math.floor(y);
  if (ix < 0 || iy < 0 || ix >= w || iy >= h) return false;
  const ctx = mask.getContext('2d');
  if (!ctx) return false;
  const d = ctx.getImageData(ix, iy, 1, 1).data;
  return d[3] >= 128;
}

/**
 * 拾取点 (imageX, imageY)（图像 CSS 像素）下最上层的一条线条，返回"复制换色"后
 * 的 UserStroke（图像坐标、新颜色）；点不到线条返回 null。
 * 拾取顺序：用户笔迹（在上层，后画的优先）→ 图案线条（从顶层往底层）。
 * 用于油漆桶点中线条时改色：复制一份线盖在原线上，撤销时副本消失、原线还原。
 * 仅在点击时调用一次（逐条画到探针画布查像素 alpha），开销可忽略。
 */
export function pickLineForRecolor(
  drawing: Drawing,
  userActions: UserAction[],
  size: { cssW: number; cssH: number; dpr: number },
  imageX: number,
  imageY: number,
  newColor: string
): UserStroke | null {
  if (size.cssW === 0 || size.cssH === 0) return null;
  const dpr = size.dpr;
  const w = Math.max(1, Math.round(size.cssW * dpr));
  const h = Math.max(1, Math.round(size.cssH * dpr));
  const probeX = Math.floor(imageX * dpr);
  const probeY = Math.floor(imageY * dpr);
  if (probeX < 0 || probeY < 0 || probeX >= w || probeY >= h) return null;

  const probe = document.createElement('canvas');
  probe.width = w; probe.height = h;
  const ctx = probe.getContext('2d');
  if (!ctx) return null;

  // 画一条线后采样探针像素：alpha ≥ 60 视为命中（兼容 marker/brush 的半透明核心）
  const probeHit = (draw: () => void): boolean => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    draw();
    return ctx.getImageData(probeX, probeY, 1, 1).data[3] >= 60;
  };

  // 1) 用户笔迹（最上层）：同几何同类型，只换色
  for (let i = userActions.length - 1; i >= 0; i--) {
    const a = userActions[i];
    if (a.kind !== 'stroke') continue;
    const s = a.stroke;
    if (s.points.length < 1) continue;
    const hit = probeHit(() => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      renderUserStroke(ctx, s);
    });
    if (hit) {
      return {
        points: s.points.map(p => [p[0], p[1]] as [number, number]),
        width: s.width,
        color: newColor,
        type: s.type
      };
    }
  }

  // 2) 图案线条（viewBox 坐标 -> 图像坐标，宽度按 scale 换算以对齐原线）
  const { scale, offsetX, offsetY } = getTransform(size, drawing);
  for (let si = drawing.steps.length - 1; si >= 0; si--) {
    const step = drawing.steps[si];
    if (!step) continue;
    for (let li = step.strokes.length - 1; li >= 0; li--) {
      const stroke = step.strokes[li];
      if (!stroke || stroke.points.length < 2) continue;
      const hit = probeHit(() => {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.translate(offsetX, offsetY);
        ctx.scale(scale, scale);
        renderStroke(ctx, stroke, 1, '#000', false);
      });
      if (hit) {
        return {
          points: stroke.points.map(([vx, vy]) => [vx * scale + offsetX, vy * scale + offsetY] as [number, number]),
          width: stroke.width * scale,
          color: newColor,
          type: 'pen'
        };
      }
    }
  }
  return null;
}

// 重建"用户填充"离屏缓存（设备像素空间，渲染在图案线条之下，涂色本效果）。
// 同一区域再次喷涂 = 多一层 (mask, color)，共享同一份 mask；按时间序叠色。
function rebuildFillCache(state: LayerState, userActions: UserAction[]): void {
  const cache = createCacheCanvas(state.size);
  const ctx = cache.getContext('2d');
  if (!ctx) {
    state.fillCache = null;
    return;
  }
  for (const a of userActions) {
    if (a.kind === 'fill') ctx.drawImage(tintMask(a.fill.mask, a.fill.color), 0, 0);
  }
  state.fillCache = cache;
}

// 重建"用户手绘笔画"离屏缓存（设备像素空间，渲染在图案线条之上）
function rebuildStrokeCache(state: LayerState, userActions: UserAction[]): void {
  const cache = createCacheCanvas(state.size);
  const ctx = cache.getContext('2d');
  if (!ctx) {
    state.strokeCache = null;
    return;
  }
  const dpr = state.size.dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const a of userActions) {
    if (a.kind === 'stroke') renderUserStroke(ctx, a.stroke);
  }
  state.strokeCache = cache;
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
        if (current) renderStroke(ctx, current, currentStrokeProgress, PLAY_STROKE_COLOR, true);
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
        if (current) renderStroke(ctx, current, currentStrokeProgress, PLAY_STROKE_COLOR, true);
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
  const { drawing, currentStep, stepProgress, showOutline, userActions, currentStroke } = args;
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
      fillCache: null,
      doneCache: null,
      strokeCache: null,
      outlineKey: '',
      doneKey: '',
      fillKey: '',
      strokeKey: ''
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

  // ---- 用户内容：填充（图案下）与笔画（图案上）分开缓存，各自按 key 重建 ----
  // 增/撤销/清除都改变数组长度，按操作数做 key 即可
  const userCount = String(userActions.length);
  if (state.fillKey !== userCount) {
    rebuildFillCache(state, userActions);
    state.fillKey = userCount;
  }
  if (state.strokeKey !== userCount) {
    rebuildStrokeCache(state, userActions);
    state.strokeKey = userCount;
  }

  const view = args.view || IDENTITY_VIEW;
  const cssW = state.size.cssW;
  const cssH = state.size.cssH;

  // 叠加视图变换（以画布中心为缩放中心），缓存按图像坐标 blit
  applyViewTransform(ctx, dpr, cssW, cssH, view);
  if (state.outlineCache) {
    ctx.drawImage(state.outlineCache, 0, 0, cssW, cssH);
  }
  // 填充在图案线条之下：颜色垫底，黑色轮廓压在上面（涂色本效果）
  if (state.fillCache) {
    ctx.drawImage(state.fillCache, 0, 0, cssW, cssH);
  }
  if (state.doneCache) {
    ctx.drawImage(state.doneCache, 0, 0, cssW, cssH);
  }

  // 当前步骤的动画部分（在视图变换之上再叠加 viewBox 变换）
  renderCurrentStep(ctx, state.size, drawing, currentStep, stepProgress);

  // ---- history 层：用户手绘笔画走离屏缓存，叠加视图变换 ----
  historyCtx.setTransform(1, 0, 0, 1, 0, 0);
  historyCtx.clearRect(0, 0, targetWidth, targetHeight);
  applyViewTransform(historyCtx, dpr, cssW, cssH, view);
  if (state.strokeCache) {
    historyCtx.drawImage(state.strokeCache, 0, 0, cssW, cssH);
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
  // 填充在图案线条之下（设备像素空间，与 out 尺寸一致，直接平铺）
  if (state.fillCache) ctx.drawImage(state.fillCache, 0, 0);
  if (state.doneCache) ctx.drawImage(state.doneCache, 0, 0, out.width, out.height);
  // 用户手绘笔画在图案之上
  if (state.strokeCache) ctx.drawImage(state.strokeCache, 0, 0);

  // 当前步骤动画部分（viewBox 变换，dpr 缩放）
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  renderCurrentStep(ctx, state.size, drawing, currentStep, stepProgress);

  return out.toDataURL('image/png');
}
