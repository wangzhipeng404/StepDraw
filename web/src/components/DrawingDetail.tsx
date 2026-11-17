// 一笔一笔 StepDraw - 绘画详情页组件

import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { Drawing, UserStroke, StrokeType } from '../types';
import { STROKE_TYPES } from '../types';
import { loadDrawing } from '../data/drawings';
import { useDrawingPlayer } from '../hooks/useDrawingPlayer';
import { useDrawingCanvas } from '../hooks/useDrawingCanvas';
import { Navbar } from './Navbar';
import preIcon from '../assets/pre.png';
import playIcon from '../assets/play.png';
import stopIcon from '../assets/stop.png';
import nextIcon from '../assets/next.png';
import refreshIcon from '../assets/refresh.png';
import outlineIcon from '../assets/cat-solid.png';
import outlineIconActive from '../assets/cat-solid-active.png';
import './DrawingDetail.css';

// 颜色选项
const COLOR_OPTIONS = ['#E53935', '#1E88E5', '#43A047', '#FB8C00', '#8E24AA', '#000000'];
// 笔画粗细选项
const STROKE_WIDTH_OPTIONS = [2, 4, 6, 8, 12];

interface DrawingCanvasProps {
  drawing: Drawing;
  onBack: () => void;
}

function DrawingCanvas({ drawing, onBack }: DrawingCanvasProps) {
  const { state, actions, getGlobalProgress } = useDrawingPlayer({
    drawing,
    mode: 'continuous'
  });

  const { canvasRef, render } = useDrawingCanvas();
  const renderRef = useRef(render);
  renderRef.current = render;

  // 绘图模式相关状态
  const [userStrokes, setUserStrokes] = useState<UserStroke[]>([]);
  const [strokeColor, setStrokeColor] = useState('#000000');
  const [strokeWidth, setStrokeWidth] = useState(4);
  const [strokeType, setStrokeType] = useState<StrokeType>('pen');
  const [isDrawing, setIsDrawing] = useState(false);
  const canvasContainerRef = useRef<HTMLDivElement>(null);

  // 持续重绘循环
  useEffect(() => {
    let animationId: number;

    const draw = () => {
      renderRef.current({
        drawing,
        currentStep: state.currentStep,
        stepProgress: state.progress,
        showOutline: state.showOutline,
        userStrokes: userStrokes,
        currentStroke: currentStrokeRef.current ? currentStrokeRef.current : undefined
      });
      animationId = requestAnimationFrame(draw);
    };

    animationId = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(animationId);
    };
  }, [drawing, state.currentStep, state.progress, state.showOutline, userStrokes]);

  // 获取 Canvas 相对于视口的位置
  const getCanvasOffset = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return { left: 0, top: 0 };
    const rect = canvas.getBoundingClientRect();
    return { left: rect.left, top: rect.top };
  }, [canvasRef]);

  // 将鼠标/触摸坐标转换为 Canvas 坐标
  const getCanvasCoordinates = useCallback((clientX: number, clientY: number) => {
    const { left, top } = getCanvasOffset();
    return {
      x: clientX - left,
      y: clientY - top
    };
  }, [getCanvasOffset]);

  // 使用 ref 存储当前笔画，避免状态更新延迟导致的断线
  const currentStrokeRef = useRef<UserStroke | null>(null);

  // 开始绘制
  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    setIsDrawing(true);

    const { x, y } = getCanvasCoordinates(e.clientX, e.clientY);
    currentStrokeRef.current = {
      points: [[x, y]],
      width: strokeWidth,
      color: strokeColor,
      type: strokeType
    };
  }, [getCanvasCoordinates, strokeWidth, strokeColor, strokeType]);

  // 绘制中
  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !currentStrokeRef.current) return;

    e.preventDefault();
    const { x, y } = getCanvasCoordinates(e.clientX, e.clientY);

    // 直接修改 ref，避免创建新对象导致的性能问题
    currentStrokeRef.current.points.push([x, y]);
  }, [isDrawing, getCanvasCoordinates]);

  // 结束绘制
  const handlePointerUp = useCallback(() => {
    if (!isDrawing || !currentStrokeRef.current) return;

    setIsDrawing(false);

    // 保存笔画（即使只有一个点也保存）
    const newStroke = currentStrokeRef.current;
    setUserStrokes(prev => [...prev, newStroke]);
    currentStrokeRef.current = null;
  }, [isDrawing]);

  // 撤销上一笔
  const handleUndo = useCallback(() => {
    if (userStrokes.length > 0) {
      setUserStrokes(userStrokes.slice(0, -1));
    }
  }, [userStrokes]);

  // 清除所有用户绘制
  const handleClear = useCallback(() => {
    if (window.confirm('确定要清除所有绘制内容吗？')) {
      setUserStrokes([]);
      currentStrokeRef.current = null;
    }
  }, []);

  // 导出为图片
  const handleExport = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    try {
      const dataUrl = canvas.toDataURL('image/png');
      const link = document.createElement('a');
      link.download = `${drawing.name || 'drawing'}-${Date.now()}.png`;
      link.href = dataUrl;
      link.click();
    } catch (err) {
      console.error('导出失败:', err);
      alert('导出失败，请重试');
    }
  }, [canvasRef, drawing.name]);

  const currentStepData = drawing.steps[state.currentStep];
  const globalProgress = getGlobalProgress();

  return (
    <div className="drawing-detail">
      {/* 导航栏 */}
      <Navbar showBack onBack={onBack} />

      {/* 主内容区域 */}
      <div className="main-content">
        {/* 画布区 */}
        <div className="canvas-wrapper">
          <div className="canvas-container" ref={canvasContainerRef}>
            <canvas
              ref={canvasRef}
              className="drawing-canvas"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerLeave={handlePointerUp}
              onPointerCancel={handlePointerUp}
              style={{ touchAction: 'none' }}
            />
            {/* 步骤提示固定在右下角 */}
            <div className="step-tip-overlay">
              <span className="tip-text">{currentStepData?.tip || ''}</span>
            </div>
          </div>
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
          </div>

          {/* 画笔类型选择器 */}
          <div className="stroke-type-bar">
            {STROKE_TYPES.map((type) => (
              <button
                key={type.key}
                className={`stroke-type-item ${strokeType === type.key ? 'active' : ''}`}
                onClick={() => setStrokeType(type.key)}
                title={type.name}
              >
                <span className="stroke-type-icon">{type.icon}</span>
                <span className="stroke-type-name">{type.name}</span>
              </button>
            ))}
          </div>

          {/* 绘图工具栏 */}
          <div className="draw-tools-bar">
            <button className="draw-tool-btn" onClick={handleUndo} title="撤销">
              撤销
            </button>
            <button className="draw-tool-btn" onClick={handleClear} title="清除">
              清除
            </button>
            <button className="draw-tool-btn save-btn" onClick={handleExport} title="保存">
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function DrawingDetail() {
  const { categoryId, drawingId } = useParams<{ categoryId: string; drawingId: string }>();
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

  return <DrawingCanvas drawing={drawing} onBack={handleBack} />;
}
