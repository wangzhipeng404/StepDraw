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

/**
 * 渲染整个图案到 Canvas
 *
 * 逻辑：
 * 1. 已完成步骤 (0 到 currentStep-1)：全部绘制为灰色
 * 2. 当前步骤 (currentStep)：
 *    - progress 0-1 映射到当前步骤的所有笔画
 *    - 已完成的笔画绘制为灰色
 *    - 当前正在绘制的笔画用强调色
 * 3. 未开始步骤：不绘制
 *
 * @param userStrokes - 用户绘制的笔画（可选）
 * @param currentStroke - 当前正在绘制的笔画（可选）
 */
export function renderDrawing(
  ctx: CanvasRenderingContext2D,
  drawing: Drawing,
  currentStep: number,
  stepProgress: number,
  showOutline: boolean = false,
  userStrokes?: UserStroke[],
  currentStroke?: UserStroke
): void {
  const { viewBox } = drawing;
  const canvas = ctx.canvas;

  // 设置画布尺寸，适配设备像素比
  const dpr = window.devicePixelRatio || 1;
  const displayWidth = canvas.clientWidth;
  const displayHeight = canvas.clientHeight;

  // 如果 Canvas 没有实际尺寸，不渲染
  if (displayWidth === 0 || displayHeight === 0) return;

  if (canvas.width !== displayWidth * dpr || canvas.height !== displayHeight * dpr) {
    canvas.width = displayWidth * dpr;
    canvas.height = displayHeight * dpr;
  }

  // 重置变换矩阵，确保从干净的状态开始
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);

  // 清空画布
  ctx.clearRect(0, 0, displayWidth, displayHeight);

  // 计算缩放比例，使图案居中显示
  const patternWidth = viewBox[2] - viewBox[0];
  const patternHeight = viewBox[3] - viewBox[1];
  const scale = Math.min(
    displayWidth / patternWidth,
    displayHeight / patternHeight
  ) * 0.8; // 留 10% 边距

  const offsetX = (displayWidth - patternWidth * scale) / 2 - viewBox[0] * scale;
  const offsetY = (displayHeight - patternHeight * scale) / 2 - viewBox[1] * scale;

  ctx.save();
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);

  // 如果显示轮廓底图，先绘制完整图案（淡色）
  if (showOutline) {
    ctx.globalAlpha = 0.15;
    for (const step of drawing.steps) {
      for (const stroke of step.strokes) {
        renderStroke(ctx, stroke, 1, '#333', false);
      }
    }
    ctx.globalAlpha = 1;
  }

  // 绘制已完成步骤（黑色）
  for (let i = 0; i < currentStep; i++) {
    if (drawing.steps[i]) {
      for (const stroke of drawing.steps[i].strokes) {
        renderStroke(ctx, stroke, 1, '#000', false);
      }
    }
  }

  // 绘制当前步骤
  if (drawing.steps[currentStep]) {
    const currentStepData = drawing.steps[currentStep];
    const strokes = currentStepData.strokes;

    if (strokes.length > 0) {
      // 处理边界情况：progress = 1 时，绘制所有笔画（黑色）
      if (stepProgress >= 1) {
        for (let i = 0; i < strokes.length; i++) {
          renderStroke(ctx, strokes[i], 1, '#000', false);
        }
      } else {
        // 计算每个笔画的长度，用于基于长度的进度映射
        const strokeLengths: number[] = [];
        let totalLength = 0;
        for (const stroke of strokes) {
          const { totalLength: len } = calculateStrokeLengths(stroke.points);
          strokeLengths.push(len);
          totalLength += len;
        }

        if (totalLength === 0) {
          // 如果总长度为 0，按笔画数量分配进度
          const totalStrokes = strokes.length;
          const strokesProgress = stepProgress * totalStrokes;
          const completedStrokes = Math.floor(strokesProgress);
          const currentStrokeProgress = strokesProgress - completedStrokes;

          for (let i = 0; i < completedStrokes; i++) {
            renderStroke(ctx, strokes[i], 1, '#000', false);
          }

          if (completedStrokes < totalStrokes) {
            const currentStroke = strokes[completedStrokes];
            if (currentStroke) {
              renderStroke(ctx, currentStroke, currentStrokeProgress, '#E53935', true);
            }
          }
        } else {
          // 基于长度计算当前进度应该显示到哪个笔画
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

          // 绘制已完成的笔画（黑色）
          for (let i = 0; i < completedStrokes; i++) {
            renderStroke(ctx, strokes[i], 1, '#000', false);
          }

          // 绘制当前正在绘制的笔画（红色）
          if (completedStrokes < strokes.length) {
            const currentStroke = strokes[completedStrokes];
            if (currentStroke) {
              renderStroke(ctx, currentStroke, currentStrokeProgress, '#E53935', true);
            }
          }
        }
      }
    }
  }

  // 恢复坐标系，然后绘制用户笔画（不使用 viewBox 变换，直接使用 CSS 像素坐标）
  ctx.restore();

  // 绘制用户笔画（完全参考小程序逻辑：直接使用 CSS 像素坐标）
  if (userStrokes) {
    for (const stroke of userStrokes) {
      renderUserStroke(ctx, stroke);
    }
  }

  // 绘制当前正在绘制的笔画
  if (currentStroke && currentStroke.points.length >= 1) {
    renderUserStroke(ctx, currentStroke);
  }
}
