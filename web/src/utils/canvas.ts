// 一笔一笔 StepDraw - Canvas 渲染工具

import type { Drawing, Stroke, UserAction, UserStroke, UserFill } from '../types';

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
 * 按进度截取笔画的已生长前缀（0 < progress < 1）：返回 [起点..插值点] 的折线，
 * 保留原始路径形状（不是起点到端点的直线弦）；progress >= 1 返回原笔画。
 * 供油漆桶"改色拾取"使用：当前步只让已生长部分可被点中/复制。
 */
function sliceStrokeByProgress(stroke: Stroke, progress: number): Stroke {
  if (progress >= 1) return stroke;
  const { totalLength, segments } = calculateStrokeLengths(stroke.points);
  const prefix: [number, number][] = [stroke.points[0]];
  if (totalLength === 0 || stroke.points.length < 2) return { width: stroke.width, points: prefix };

  const targetLength = progress * totalLength;
  let accumulatedLength = 0;
  for (let i = 0; i < segments.length; i++) {
    if (accumulatedLength + segments[i] >= targetLength) {
      const segmentProgress = (targetLength - accumulatedLength) / segments[i];
      const p0 = stroke.points[i];
      const p1 = stroke.points[i + 1];
      prefix.push([
        p0[0] + (p1[0] - p0[0]) * segmentProgress,
        p0[1] + (p1[1] - p0[1]) * segmentProgress
      ]);
      return { width: stroke.width, points: prefix };
    }
    prefix.push(stroke.points[i + 1]);
    accumulatedLength += segments[i];
  }
  return { width: stroke.width, points: prefix };
}

/**
 * 抽稀：去掉离上一个点 <minDist 的采样点（触摸抖动噪声）。与小程序端 commit 时一致。
 */
export function thinStrokePoints(points: [number, number][], minDist = 2): [number, number][] {
  if (points.length < 2) return points.slice();
  const out: [number, number][] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const [px, py] = out[out.length - 1];
    const [x, y] = points[i];
    const dx = x - px, dy = y - py;
    if (dx * dx + dy * dy >= minDist * minDist) out.push([x, y]);
  }
  return out;
}

/**
 * 直线化：笔画整体几乎沿一条直线（每个采样点离首尾连线距离都 < max(2, 6%总长)）
 * 时返回 [首点, 末点]，否则 null。与小程序端 commit 时一致。
 */
export function snapStrokeToLine(points: [number, number][]): [number, number][] | null {
  if (points.length < 3) return null;
  const [x1, y1] = points[0];
  const [x2, y2] = points[points.length - 1];
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 12) return null; // 太短没有直线化意义
  const tol = Math.max(2, len * 0.06);
  const tol2 = tol * tol;
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i];
    const cross = dx * (y - y1) - dy * (x - x1);
    const d2 = (cross * cross) / (len * len);
    if (d2 > tol2) return null;
  }
  return [[x1, y1], [x2, y2]];
}

/**
 * 把点列按"中点二次贝塞尔"平滑连成一条子路径（不 beginPath、不 stroke，只填轨迹）。
 * 控制点取采样点、曲线过相邻点中点 —— 贴着原轨迹抹平锯齿（与小程序端同算法）。
 */
function tracePath(ctx: CanvasRenderingContext2D, points: [number, number][]): void {
  if (points.length === 0) return;
  ctx.moveTo(points[0][0], points[0][1]);
  if (points.length === 2) {
    ctx.lineTo(points[1][0], points[1][1]);
    return;
  }
  for (let i = 1; i < points.length - 1; i++) {
    const midX = (points[i][0] + points[i + 1][0]) / 2;
    const midY = (points[i][1] + points[i + 1][1]) / 2;
    ctx.quadraticCurveTo(points[i][0], points[i][1], midX, midY);
  }
  const last = points[points.length - 1];
  ctx.lineTo(last[0], last[1]);
}

/**
 * 渲染单个笔画到 Canvas
 */
// 填色笔画（涂色本数据，img2json.py 格式）：type==='fill' 或 width===0 且
// fill 为具体颜色（"none" 是字符串，不是颜色）。points 是封闭多边形（首尾点相同）。
// 播放时按多边形整块填色，不描边。
export function isPatternFillStroke(stroke: Stroke | undefined): boolean {
  if (!stroke) return false;
  if (stroke.type === 'fill') return true;
  return stroke.width === 0
    && typeof stroke.fill === 'string'
    && stroke.fill !== 'none';
}

// 笔画的播放时长长度：填色笔画记 0（到达即整块出现，不占时长、多边形周长
// 不应折算成"生长速度"），普通笔画 = 点列弧长。进度映射/步长计算统一走这里。
export function getStrokePlayLength(stroke: Stroke): number {
  if (isPatternFillStroke(stroke)) return 0;
  return calculateStrokeLengths(stroke.points).totalLength;
}

// 画一个填色笔画：按 points 多边形填充 fill 色（viewBox 坐标系，调用方已 apply viewBox 变换）。
export function renderPatternFillStroke(
  ctx: CanvasRenderingContext2D,
  stroke: Stroke
): void {
  const color = stroke.fill || stroke.color;
  if (!color || color === 'none' || !Array.isArray(stroke.points) || stroke.points.length < 3) return;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(stroke.points[0][0], stroke.points[0][1]);
  for (let i = 1; i < stroke.points.length; i++) {
    ctx.lineTo(stroke.points[i][0], stroke.points[i][1]);
  }
  ctx.closePath();
  ctx.fill();
}

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
    // 已完成笔画，绘制完整（轮廓用直线连接采样点，保持原始直角；
    // 圆滑只用于用户笔画 renderUserStroke，两者不共用 tracePath）
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
  stroke: UserStroke,
  progress: number = 1
): void {
  const color = stroke.color || '#E53935';
  const width = stroke.width || 4;
  const strokeType = stroke.type || 'pen';
  const points = stroke.points;

  if (points.length === 0) return;

  // 回放生长：progress<1 时按弧长截断多点点列（单点无长度，直接画）。
  // 与小程序端 drawUserStroke 的同款长度插值，保证回放/录制画面一致。
  let target: [number, number][] = points;
  if (progress < 1 && points.length >= 2) {
    if (progress <= 0) return;
    const { totalLength, segments } = calculateStrokeLengths(points);
    if (totalLength === 0) return;
    const targetLength = progress * totalLength;
    target = [points[0]];
    let acc = 0;
    for (let i = 1; i < points.length; i++) {
      const seg = segments[i - 1];
      if (acc + seg >= targetLength) {
        const t = seg > 0 ? (targetLength - acc) / seg : 0;
        const p0 = points[i - 1];
        const p1 = points[i];
        target.push([p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t]);
        break;
      }
      target.push(points[i]);
      acc += seg;
    }
    if (target.length < 2) return;
  }

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // 单个点：绘制一个圆形
  if (target.length === 1) {
    const [x, y] = target[0];
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
    // 多个点：平滑路径（中点二次贝塞尔，与小程序端 drawUserStroke 一致）
    ctx.beginPath();
    tracePath(ctx, target);

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
      // 毛笔：沿笔迹方向由淡入浓（起笔淡、收笔浓），与小程序端同逻辑。
      // 旧实现首末两个 stop 是同一个颜色（渐变根本没生效），且单一首->末渐变在
      // 折返笔画上浓淡错位；现按段绘制，透明度随笔迹位置插值，淡浓跟着手走。
      ctx.strokeStyle = color;
      ctx.lineWidth = width * 1.5;
      const n = target.length;
      const mid = (i: number, j: number): [number, number] =>
        [(target[i][0] + target[j][0]) / 2, (target[i][1] + target[j][1]) / 2];
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
  /** 已 bake 进 strokeCache 的笔画对象引用（按序）。增量判定的基准：
   *  当前笔画序列若以它为"引用前缀"（尾部追加）则增量补画，否则整层重建。
   *  撤销/擦除/撤销擦除都会破坏前缀 -> 自动回退到重建，不会画错。 */
  bakedStrokes: UserStroke[];
  /** 已 bake 进 fillCache 的填充对象引用（按序），同 bakedStrokes 的增量判定。 */
  bakedFills: UserFill[];
  /** fill.key -> 上色结果（tintMask 开销大：整幅逐像素。fill 对象不可变、key 唯一，
   *  缓存上色位图，重建/增量补画只需 drawImage。尺寸变化时 state 重置会随之失效。 */
  fillTintCache: Map<string, CanvasLike>;
}

export interface RenderLayersArgs {
  drawing: Drawing;
  currentStep: number;
  stepProgress: number;
  showOutline: boolean;
  userActions: UserAction[];
  currentStroke: UserStroke | null;
  /** 当前笔画的生长进度 0~1（回放时 <1 按弧长截断生长；默认 1 = 完整一笔） */
  currentStrokeProgress?: number;
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
        if (isPatternFillStroke(stroke)) renderPatternFillStroke(ctx, stroke);
        else renderStroke(ctx, stroke, 1, '#000', false);
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
      if (isPatternFillStroke(stroke)) renderPatternFillStroke(ctx, stroke);
      else renderStroke(ctx, stroke, 1, '#333', false);
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

// ============================================================
// 套索填充（lasso fill）
//
// 与油漆桶（漫水，靠线条自然围合）不同：用户圈一个套索，把"套索内且被线条
// 完全封闭"的区域填上颜色。套索只是选区，不是墙——套索本身不封闭也合法，
// 封闭性由线条决定：
//   掩码 = 套索内 且 与画布边缘不连通的 非墙区域
// 所以：线条围合的封闭块 -> 填充；线条断口/开放区域（连通到套索边缘外）-> 不填。
// 与油漆桶共用 buildUnderlay 的"墙"（屏幕上实际可见的线条）。
// ============================================================

export type LassoFillResult =
  | { ok: true; canvas: HTMLCanvasElement }
  | { ok: false; reason: 'empty' | 'nothing' | 'oob' };

/**
 * 套索填充：套索点列 points（图像 CSS 像素）+ underlay（可见线条，设备像素、透明底）
 * -> 区域掩码（设备像素、白色 alpha=255）。
 * 步骤：
 *  1) 把套索画成实心多边形（fill 抗锯齿天然覆盖套索内所有像素，无需逐点 raycast），
 *     采样 alpha 得"套索内"位图；
 *  2) 在 underlay 上二值化墙 + 1px 膨胀（弥合 ≤2px 线条缺口，与 floodFill 同参数）；
 *  3) 从画布边缘 flood"外部"：非墙且与边缘连通的像素 = 外部（背景/开放区域）；
 *  4) 掩码 = 套索内 && 非墙 && 非外部（再补 1px halo，与 floodFill 一致消白缝）。
 */
export function lassoFill(
  underlay: HTMLCanvasElement,
  points: [number, number][],
  dpr: number
): LassoFillResult {
  const w = underlay.width;
  const h = underlay.height;
  const src = underlay.getContext('2d');
  if (!src || w === 0 || h === 0) return { ok: false, reason: 'oob' };
  if (points.length < 3) return { ok: false, reason: 'empty' };

  // 1) 套索内位图：在 underlay 同尺寸的画布上实心填充套索多边形，采样 alpha
  const lasso = document.createElement('canvas');
  lasso.width = w;
  lasso.height = h;
  const lctx = lasso.getContext('2d');
  if (!lctx) return { ok: false, reason: 'oob' };
  lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  lctx.beginPath();
  lctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) lctx.lineTo(points[i][0], points[i][1]);
  lctx.closePath();
  lctx.fillStyle = '#fff';
  lctx.fill();
  const lassoData = lctx.getImageData(0, 0, w, h).data;
  const inLasso = new Uint8Array(w * h);
  let lassoPx = 0;
  for (let i = 0; i < w * h; i++) {
    inLasso[i] = lassoData[i * 4 + 3] > 0 ? 1 : 0;
    if (inLasso[i]) lassoPx++;
  }
  if (lassoPx === 0) return { ok: false, reason: 'empty' };

  // 2) 墙（与 floodFill 同参数：alpha 二值化 + 1px 膨胀弥合缺口）
  const baseWall = binarizeWall(src.getImageData(0, 0, w, h));
  const wall = dilateWall(baseWall, w, h, WALL_DILATE);

  // 3) 从画布边缘 flood 出"外部"：非墙且与边缘连通的像素（背景/开放区域）
  const outside = new Uint8Array(w * h);
  const extStack: number[] = [];
  for (let x = 0; x < w; x++) {
    for (const y of [0, h - 1]) {
      const p = y * w + x;
      if (!wall[p] && !outside[p]) { outside[p] = 1; extStack.push(p); }
    }
  }
  for (let y = 0; y < h; y++) {
    for (const x of [0, w - 1]) {
      const p = y * w + x;
      if (!wall[p] && !outside[p]) { outside[p] = 1; extStack.push(p); }
    }
  }
  while (extStack.length > 0) {
    const p = extStack.pop()!;
    const x = p % w;
    const y = (p - x) / w;
    if (x > 0) { const q = p - 1; if (!wall[q] && !outside[q]) { outside[q] = 1; extStack.push(q); } }
    if (x < w - 1) { const q = p + 1; if (!wall[q] && !outside[q]) { outside[q] = 1; extStack.push(q); } }
    if (y > 0) { const q = p - w; if (!wall[q] && !outside[q]) { outside[q] = 1; extStack.push(q); } }
    if (y < h - 1) { const q = p + w; if (!wall[q] && !outside[q]) { outside[q] = 1; extStack.push(q); } }
  }

  // 4) 掩码 = 套索内 && 非墙 && 非外部（再补 1px halo，不盖线条实体像素）
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const outCtx = out.getContext('2d');
  if (!outCtx) return { ok: false, reason: 'oob' };
  const od = outCtx.createImageData(w, h).data;
  let maskPx = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (baseWall[p] || !inLasso[p] || outside[p]) continue;
      const i = p * 4;
      od[i] = 255; od[i + 1] = 255; od[i + 2] = 255; od[i + 3] = 255;
      maskPx++;
    }
  }
  // halo 外扩 1px（同 floodFill：visited 离墙 1px，不补的话抗锯齿 halo 下透白缝）
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (baseWall[p] || od[p * 4 + 3] >= 128) continue;
      if ((x > 0 && od[(p - 1) * 4 + 3] >= 128) || (x < w - 1 && od[(p + 1) * 4 + 3] >= 128) ||
          (y > 0 && od[(p - w) * 4 + 3] >= 128) || (y < h - 1 && od[(p + w) * 4 + 3] >= 128)) {
        const i = p * 4;
        od[i] = 255; od[i + 1] = 255; od[i + 2] = 255; od[i + 3] = 255;
        maskPx++;
      }
    }
  }
  if (maskPx === 0) return { ok: false, reason: 'nothing' };
  outCtx.putImageData(new ImageData(od, w, h), 0, 0);
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
// 当前步骤在进度 stepProgress 下每条笔画的可见进度（0~1）。
// 与 renderCurrentStep 的进度映射一致：按笔画弧长分配，总长为 0 时退化为按笔数均分。
// buildUnderlay（油漆桶的墙）用它保证"墙 = 屏幕上实际可见的线条"：
// 未播放的步骤、当前步骤未生长到的部分都不算墙。
export function getStepStrokesProgress(
  strokes: Stroke[],
  stepProgress: number
): number[] {
  const n = strokes.length;
  if (stepProgress >= 1) return strokes.map(() => 1);
  if (stepProgress <= 0) return strokes.map(() => 0);

  const lengths = strokes.map(s => getStrokePlayLength(s));
  const totalLength = lengths.reduce((a, b) => a + b, 0);
  if (totalLength === 0) {
    // 零长度笔画：按数量均分
    const sp = stepProgress * n;
    return strokes.map((_, i) => Math.max(0, Math.min(1, sp - i)));
  }
  const target = stepProgress * totalLength;
  const progresses = new Array<number>(n).fill(0);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    if (acc + lengths[i] >= target) {
      progresses[i] = lengths[i] > 0 ? (target - acc) / lengths[i] : 1;
      break;
    }
    progresses[i] = 1;
    acc += lengths[i];
  }
  return progresses;
}

// 合成"填充用底图"（设备像素、透明底），墙 = 屏幕上实际可见的线条。
// 已播放的部分（前序步骤全量 + 当前步骤已生长部分）+ 用户手绘笔画。
// 不把未播放步骤画进墙：油漆桶的封闭区域应和用户在画布上看到的一致，
// 未画出来的线条不该围出"隐形区域"。
export function buildUnderlay(
  size: { cssW: number; cssH: number; dpr: number },
  drawing: Drawing,
  userActions: UserAction[],
  currentStep: number,
  stepProgress: number
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

  // 前序步骤：完整画浓（作为墙）
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);
  for (let i = 0; i < currentStep; i++) {
    const step = drawing.steps[i];
    if (!step) continue;
    for (const stroke of step.strokes) {
      if (isPatternFillStroke(stroke)) continue; // 填色块不是墙（同下方用户填充的注释）
      renderStroke(ctx, stroke, 1, '#000', false);
    }
  }

  // 当前步骤：只画已生长的部分（与 renderCurrentStep 的进度映射一致）
  const currentStepData = drawing.steps[currentStep];
  if (currentStepData && currentStepData.strokes.length > 0 && stepProgress > 0) {
    const progresses = getStepStrokesProgress(currentStepData.strokes, stepProgress);
    currentStepData.strokes.forEach((stroke, i) => {
      const p = progresses[i];
      if (isPatternFillStroke(stroke)) return; // 填色块不是墙（同下方用户填充的注释）
      if (p > 0) renderStroke(ctx, stroke, p, '#000', p < 1);
    });
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
 * 拾取点 (imageX, imageY)（图像 CSS 像素）处最上层的一个用户操作，返回其在
 * userActions 中的下标（后画的优先），点不到返回 -1。
 * 与 pickLineForRecolor 同一套探针法（逐条画到探针画布查像素 alpha），
 * 但只查用户内容（笔画 + 填充），供橡皮擦使用。仅在点击/拖动时调用，开销可忽略。
 */
export function pickUserActionIndex(
  userActions: UserAction[],
  size: { cssW: number; cssH: number; dpr: number },
  imageX: number,
  imageY: number
): number {
  if (size.cssW === 0 || size.cssH === 0) return -1;
  const dpr = size.dpr;
  const w = Math.max(1, Math.round(size.cssW * dpr));
  const h = Math.max(1, Math.round(size.cssH * dpr));
  const probeX = Math.floor(imageX * dpr);
  const probeY = Math.floor(imageY * dpr);
  if (probeX < 0 || probeY < 0 || probeX >= w || probeY >= h) return -1;

  const probe = document.createElement('canvas');
  probe.width = w; probe.height = h;
  const ctx = probe.getContext('2d');
  if (!ctx) return -1;

  // 画一个用户操作后采样探针像素：alpha ≥ 30 视为命中
  // （比改色拾取更宽松：铅笔/马克笔/毛笔是半透明笔触，边缘 alpha 低，擦得掉才算好用）
  const probeHit = (draw: () => void): boolean => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    draw();
    return ctx.getImageData(probeX, probeY, 1, 1).data[3] >= 30;
  };

  // 从后往前（最上层优先）：先查笔画，再查填充
  for (let i = userActions.length - 1; i >= 0; i--) {
    const a = userActions[i];
    if (a.kind === 'stroke') {
      if (!a.stroke.points || a.stroke.points.length < 1) continue;
      if (probeHit(() => {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        renderUserStroke(ctx, a.stroke);
      })) return i;
    } else if (a.kind === 'fill') {
      if (probeHit(() => {
        ctx.drawImage(tintMask(a.fill.mask, a.fill.color), 0, 0);
      })) return i;
    }
  }
  return -1;
}

/**
 * 拾取点 (imageX, imageY)（图像 CSS 像素）下最上层的一条线条，返回"复制换色"后
 * 的 UserStroke（图像坐标、新颜色）；点不到线条返回 null。
 * 拾取顺序：用户笔迹（在上层，后画的优先）→ 图案线条（只取已播放的步骤，从顶层往底层）。
 * 用于油漆桶点中线条时改色：复制一份线盖在原线上，撤销时副本消失、原线还原。
 * currentStep/stepProgress 限定图案线条的"可点范围"：前序步骤整条、当前步只到已生长
 * 部分，未播放步骤不参与——否则点在淡色引导轮廓上，会把一根看不见的线复制成彩线冒出来。
 * 仅在点击时调用一次（逐条画到探针画布查像素 alpha），开销可忽略。
 */
export function pickLineForRecolor(
  drawing: Drawing,
  userActions: UserAction[],
  size: { cssW: number; cssH: number; dpr: number },
  imageX: number,
  imageY: number,
  newColor: string,
  currentStep: number,
  stepProgress: number
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

  // 2) 图案线条（viewBox 坐标 -> 图像坐标，宽度按 scale 换算以对齐原线）。
  // 只拾取已播放的线条：前序步骤整条，当前步按 stepProgress 截取已生长部分，
  // 未播放步骤不参与（与 buildUnderlay 的墙范围一致）。
  const { scale, offsetX, offsetY } = getTransform(size, drawing);
  for (let si = Math.min(currentStep, drawing.steps.length - 1); si >= 0; si--) {
    const step = drawing.steps[si];
    if (!step) continue;
    const progresses = si === currentStep ? getStepStrokesProgress(step.strokes, stepProgress) : null;
    for (let li = step.strokes.length - 1; li >= 0; li--) {
      const stroke = step.strokes[li];
      if (!stroke || stroke.points.length < 2) continue;
      if (isPatternFillStroke(stroke)) continue; // 填色块不是线条，不参与改色拾取
      const p = progresses ? progresses[li] : 1;
      if (!p || p <= 0) continue; // 当前步未生长到的笔画不拾取
      const visible = p >= 1 ? stroke : sliceStrokeByProgress(stroke, p);
      const hit = probeHit(() => {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.translate(offsetX, offsetY);
        ctx.scale(scale, scale);
        renderStroke(ctx, visible, 1, '#000', false);
      });
      if (hit) {
        return {
          points: visible.points.map(([vx, vy]) => [vx * scale + offsetX, vy * scale + offsetY] as [number, number]),
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
  const fillsNow = collectFillRefs(userActions);
  if (!ctx) {
    state.fillCache = null;
    state.bakedFills = [];
    return;
  }
  for (const f of fillsNow) {
    const tinted = tintMaskCached(state, f);
    if (tinted) ctx.drawImage(tinted, 0, 0);
  }
  state.fillCache = cache;
  state.bakedFills = fillsNow;
}

// 给填充区域上色，按 fill.key 缓存结果。
// tintMask 开销大（整幅 getImageData 逐像素上色），而 fill 对象不可变、key 唯一，
// 每个填充只算一次，重建/增量补画都只 drawImage（与小程序端 _fillTintCache 同思路）。
function tintMaskCached(state: LayerState, fill: UserFill): CanvasLike | null {
  let tinted = state.fillTintCache.get(fill.key);
  if (!tinted) {
    tinted = tintMask(fill.mask, fill.color);
    state.fillTintCache.set(fill.key, tinted);
  }
  return tinted;
}

// 按序收集当前 userActions 里的填充对象引用（增量缓存的前缀比对基准）
function collectFillRefs(userActions: UserAction[]): UserFill[] {
  const out: UserFill[] = [];
  for (const a of userActions) {
    if (a.kind === 'fill') out.push(a.fill);
  }
  return out;
}

// 重建"用户手绘笔画"离屏缓存（设备像素空间，渲染在图案线条之上）
function rebuildStrokeCache(state: LayerState, userActions: UserAction[]): void {
  const cache = createCacheCanvas(state.size);
  const ctx = cache.getContext('2d');
  const strokesNow = collectStrokeRefs(userActions);
  if (!ctx) {
    state.strokeCache = null;
    state.bakedStrokes = [];
    return;
  }
  const dpr = state.size.dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const s of strokesNow) renderUserStroke(ctx, s);
  state.strokeCache = cache;
  state.bakedStrokes = strokesNow;
}

// 按序收集当前 userActions 里的笔画对象引用（增量缓存的前缀比对基准）
function collectStrokeRefs(userActions: UserAction[]): UserStroke[] {
  const out: UserStroke[] = [];
  for (const a of userActions) {
    if (a.kind === 'stroke') out.push(a.stroke);
  }
  return out;
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
      if (isPatternFillStroke(stroke)) renderPatternFillStroke(ctx, stroke);
      else renderStroke(ctx, stroke, 1, '#000', false);
    }
  } else {
    // 基于笔画总长度做进度映射
    const strokeLengths: number[] = [];
    let totalLength = 0;
    for (const stroke of strokes) {
      const len = getStrokePlayLength(stroke);
      strokeLengths.push(len);
      totalLength += len;
    }

    if (totalLength === 0) {
      // 总长度为 0，按笔画数量分配进度
      const strokesProgress = stepProgress * strokes.length;
      const completedStrokes = Math.floor(strokesProgress);
      const currentStrokeProgress = strokesProgress - completedStrokes;

      for (let i = 0; i < completedStrokes; i++) {
        const s = strokes[i];
        if (isPatternFillStroke(s)) renderPatternFillStroke(ctx, s);
        else renderStroke(ctx, s, 1, '#000', false);
      }
      if (completedStrokes < strokes.length) {
        const current = strokes[completedStrokes];
        if (isPatternFillStroke(current)) renderPatternFillStroke(ctx, current);
        else renderStroke(ctx, current, currentStrokeProgress, PLAY_STROKE_COLOR, true);
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
        const s = strokes[i];
        if (isPatternFillStroke(s)) renderPatternFillStroke(ctx, s);
        else renderStroke(ctx, s, 1, '#000', false);
      }
      if (completedStrokes < strokes.length) {
        const current = strokes[completedStrokes];
        if (isPatternFillStroke(current)) {
          // 零长度笔画位于弧长位置 accumulatedLength：进度位置到达/越过它才出现
          // （避免"后面的线还没长到，填充却先冒出来"）
          if (targetLength >= accumulatedLength) renderPatternFillStroke(ctx, current);
        } else {
          renderStroke(ctx, current, currentStrokeProgress, PLAY_STROKE_COLOR, true);
        }
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
  const { drawing, currentStep, stepProgress, showOutline, userActions, currentStroke, currentStrokeProgress } = args;
  if (!outlineCanvas || !historyCanvas || !brushCanvas) return state;

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
      strokeKey: '',
      bakedStrokes: [],
      bakedFills: [],
      fillTintCache: new Map()
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

  // ---- 用户内容：填充（图案下）与笔画（图案上）分开缓存，各自按"引用前缀"增量 ----
  // 增量优化：提交一笔（append）时只把这一笔画进现有离屏缓存，不重画全部
  // （画 50 笔后每笔提交都 O(n) 全量重绘，低端机会卡）。
  // 判定：当前笔画对象序列是否以"已 bake 序列"为引用前缀（尾部追加）——
  // 是则增量补画；撤销/擦除/撤销擦除都会破坏前缀，自动整层重建。
  const userCount = String(userActions.length);
  const strokesNow = collectStrokeRefs(userActions);
  if (state.strokeKey !== userCount) {
    const baked = state.bakedStrokes;
    const canAppend = state.strokeCache != null
      && baked.length <= strokesNow.length
      && baked.every((s, i) => strokesNow[i] === s);
    if (canAppend) {
      // 增量：补画新追加的笔画（ctx 带 dpr 变换，与 rebuildStrokeCache 一致）
      const ctx = state.strokeCache!.getContext('2d');
      if (ctx) {
        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        for (let i = baked.length; i < strokesNow.length; i++) {
          renderUserStroke(ctx, strokesNow[i]);
        }
        ctx.restore();
        state.bakedStrokes = strokesNow;
      } else {
        rebuildStrokeCache(state, userActions);
      }
    } else {
      rebuildStrokeCache(state, userActions);
    }
    state.strokeKey = userCount;
  }

  const fillsNow = collectFillRefs(userActions);
  if (state.fillKey !== userCount) {
    const bakedFills = state.bakedFills;
    const canAppend = state.fillCache != null
      && bakedFills.length <= fillsNow.length
      && bakedFills.every((f, i) => fillsNow[i] === f);
    if (canAppend) {
      const ctx = state.fillCache!.getContext('2d');
      if (ctx) {
        // 增量：补画新追加的填充（上色结果走 fill.key 缓存，不重算全部）
        for (let i = bakedFills.length; i < fillsNow.length; i++) {
          const tinted = tintMaskCached(state, fillsNow[i]);
          if (tinted) ctx.drawImage(tinted, 0, 0);
        }
        state.bakedFills = fillsNow;
      } else {
        rebuildFillCache(state, userActions);
      }
    } else {
      rebuildFillCache(state, userActions);
    }
    state.fillKey = userCount;
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
    renderUserStroke(brushCtx, currentStroke, currentStrokeProgress ?? 1);
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

// ============================================================
// 视频录制（浏览器版，对应小程序 show 页的 wx.createMediaRecorder + 存相册）。
//
// 小程序靠 WebGL 离屏画布 + 手动 requestFrame 逐帧喂给录制器，因为 <canvas> 拿不到
// webgl 上下文、且录制要存相册。web 里这些都反过来：可见 canvas 有 2d 上下文，
// canvas.captureStream() 能直接把渲染帧喂给 MediaRecorder，录完直接触发浏览器下载
// （web 没有"存相册"概念）。所以这里不复刻小程序那套 WebGL/增量层渲染——
// 让画布照常实时渲染，captureStream 跟帧录制即可（与用户当前所见一致）。
// ============================================================

export interface CanvasRecorder {
  stop: () => Promise<Blob | null>;
  supported: boolean;
  reason?: string;
}

// 选一个浏览器都支持的视频编码；都不支持就回退到"任意可用"。
function pickMimeType(): string {
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4'
  ];
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  return candidates.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

/**
 * 开始录制一个 canvas（实时帧）。返回 { stop, supported, reason }：
 *   supported=false 时 reason 说明原因（调用方如实提示，不要笼统说"不支持"）。
 *   调 stop() 得到 Blob（webm/mp4），由调用方负责触发下载。
 */
export function startCanvasRecording(canvas: HTMLCanvasElement, fps = 30): CanvasRecorder {
  if (typeof MediaRecorder === 'undefined') {
    return { stop: async () => null, supported: false, reason: '当前浏览器不支持 MediaRecorder' };
  }
  if (typeof canvas.captureStream !== 'function') {
    return { stop: async () => null, supported: false, reason: '当前浏览器不支持 canvas.captureStream' };
  }

  const mime = pickMimeType();
  let stream: MediaStream;
  try {
    stream = canvas.captureStream(fps);
  } catch (e) {
    return { stop: async () => null, supported: false, reason: '创建视频流失败：' + (e as Error).message };
  }

  let recorder: MediaRecorder;
  try {
    recorder = mime
      ? new MediaRecorder(stream, { mimeType: mime })
      : new MediaRecorder(stream);
  } catch (e) {
    stream.getTracks().forEach(t => t.stop());
    return { stop: async () => null, supported: false, reason: '创建录制器失败：' + (e as Error).message };
  }

  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size > 0) chunks.push(ev.data); };
  recorder.onerror = () => { /* stop 时统一处理 */ };
  recorder.start(); // 默认按 1000ms 分片

  const stop = (): Promise<Blob | null> =>
    new Promise((resolve) => {
      if (recorder.state === 'inactive') {
        stream.getTracks().forEach(t => t.stop());
        resolve(null);
        return;
      }
      recorder.onstop = () => {
        const type = recorder.mimeType || mime || 'video/webm';
        try {
          resolve(new Blob(chunks, { type }));
        } catch {
          resolve(null);
        }
        stream.getTracks().forEach(t => t.stop());
      };
      try {
        recorder.stop();
      } catch {
        stream.getTracks().forEach(t => t.stop());
        resolve(null);
      }
    });

  return { stop, supported: true };
}

// 触发浏览器下载一个 Blob（视频/JSON 通用）
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
