// 一笔一笔 StepDraw - 绘画详情页组件

import { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { Drawing } from '../types';
import { loadDrawing } from '../data/drawings';
import { useDrawingPlayer } from '../hooks/useDrawingPlayer';
import { useDrawingCanvas } from '../hooks/useDrawingCanvas';
import { Navbar } from './Navbar';
import preIcon from '../assets/pre.png';
import playIcon from '../assets/play.png';
import stopIcon from '../assets/stop.png';
import nextIcon from '../assets/next.png';
import refreshIcon from '../assets/refresh.png';
import './DrawingDetail.css';

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

  // 持续重绘循环（播放时）
  useEffect(() => {
    let animationId: number;

    const draw = () => {
      renderRef.current({
        drawing,
        currentStep: state.currentStep,
        stepProgress: state.progress,
        showOutline: state.showOutline
      });
      animationId = requestAnimationFrame(draw);
    };

    animationId = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(animationId);
    };
  }, [drawing, state.currentStep, state.progress, state.showOutline]);

  const currentStepData = drawing.steps[state.currentStep];
  const globalProgress = getGlobalProgress();

  return (
    <div className="drawing-detail">
      {/* 导航栏 */}
      <Navbar showBack onBack={onBack} />

      {/* 画布区 */}
      <div className="canvas-container">
        <canvas ref={canvasRef} className="drawing-canvas" />
        {/* 步骤提示固定在右下角 */}
        <div className="step-tip-overlay">
          <span className="tip-text">{currentStepData?.tip || ''}</span>
        </div>
      </div>

      {/* 播放控制栏 */}
      <div className="control-bar">
        <div className="control-btn-row">
          <button
            className={`control-btn outline-btn ${state.showOutline ? 'active' : ''}`}
            onClick={actions.toggleOutline}
            title="轮廓"
          >
            <span className="outline-text">轮廓</span>
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

      {/* 进度条 */}
      <div className="progress-container">
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
