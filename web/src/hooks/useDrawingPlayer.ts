import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { Drawing, PlayState, DemoMode } from '../types';

interface UseDrawingPlayerProps {
  drawing: Drawing;
  mode: DemoMode;
  initialState?: Partial<PlayState>;
}

// 计算两点之间的距离
function distance(p1: [number, number], p2: [number, number]): number {
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  return Math.sqrt(dx * dx + dy * dy);
}

// 计算一个笔画的总长度
function getStrokeLength(stroke: { points: [number, number][] }): number {
  const points = stroke.points;
  if (points.length < 2) return 0;

  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += distance(points[i - 1], points[i]);
  }
  return length;
}

// 计算一个步骤的总长度（所有笔画长度之和）
function getStepLength(step: { strokes: { points: [number, number][] }[] }): number {
  return step.strokes.reduce((sum, stroke) => sum + getStrokeLength(stroke), 0);
}

export function useDrawingPlayer({ drawing, initialState }: UseDrawingPlayerProps) {
  const totalSteps = drawing.steps.length;

  // 预计算每个步骤的长度和总长度
  const stepLengths = useMemo(() => {
    return drawing.steps.map(step => getStepLength(step));
  }, [drawing.steps]);

  const totalLength = useMemo(() => {
    return stepLengths.reduce((sum, len) => sum + len, 0);
  }, [stepLengths]);

  const [state, setState] = useState<PlayState>({
    currentStep: 0,
    progress: 0,
    playing: false,
    speed: 1,
    loopCurrentStep: false,
    showOutline: true,
    ...initialState
  });

  const animationRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);

  // 重置播放
  const reset = useCallback(() => {
    setState(prev => ({ ...prev, currentStep: 0, progress: 0, playing: false }));
  }, []);

  // 上一步
  const prevStep = useCallback(() => {
    setState(prev => {
      if (prev.progress > 0) {
        return { ...prev, progress: 0 };
      }
      if (prev.currentStep > 0) {
        return { ...prev, currentStep: prev.currentStep - 1, progress: 0 };
      }
      return prev;
    });
  }, []);

  // 下一步
  const nextStep = useCallback(() => {
    setState(prev => {
      // 单步模式：播放当前步骤
      if (prev.loopCurrentStep) {
        // 如果当前步骤已完成，跳到下一步
        if (prev.progress >= 1 && prev.currentStep < totalSteps - 1) {
          return {
            ...prev,
            currentStep: prev.currentStep + 1,
            progress: 0,
            playing: true
          };
        }
        // 否则播放当前步骤
        return { ...prev, playing: true };
      }
      // 连续模式：如果当前步骤未完成，先完成当前步骤
      if (prev.progress < 1) {
        return { ...prev, progress: 1 };
      }
      // 当前步骤已完成，切换到下一步
      if (prev.currentStep < totalSteps - 1) {
        return {
          ...prev,
          currentStep: prev.currentStep + 1,
          progress: 0
        };
      }
      return prev;
    });
  }, [totalSteps]);

  // 跳到指定步骤
  const jumpToStep = useCallback((step: number) => {
    setState(prev => ({
      ...prev,
      currentStep: Math.max(0, Math.min(step, totalSteps - 1)),
      progress: 0
    }));
  }, [totalSteps]);

  // 切换播放/暂停
  const togglePlay = useCallback(() => {
    setState(prev => {
      // 如果已全部绘制完成，点击播放则重新开始
      if (prev.currentStep === totalSteps - 1 && prev.progress >= 1) {
        return { ...prev, currentStep: 0, progress: 0, playing: true };
      }
      return { ...prev, playing: !prev.playing };
    });
  }, [totalSteps]);

  // 切换倍速（循环切换：0.5 → 1 → 2 → 0.5）
  const toggleSpeed = useCallback(() => {
    setState(prev => {
      const speeds = [0.5, 1, 2];
      const currentIndex = speeds.indexOf(prev.speed);
      const nextIndex = (currentIndex + 1) % speeds.length;
      return { ...prev, speed: speeds[nextIndex] };
    });
  }, []);

  // 切换单步循环
  const toggleLoop = useCallback(() => {
    setState(prev => ({ ...prev, loopCurrentStep: !prev.loopCurrentStep }));
  }, []);

  // 切换轮廓底图
  const toggleOutline = useCallback(() => {
    setState(prev => ({ ...prev, showOutline: !prev.showOutline }));
  }, []);

  // 动画循环
  useEffect(() => {
    if (!state.playing) {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
      return;
    }

    lastTimeRef.current = performance.now();

    const animate = (currentTime: number) => {
      const deltaTime = currentTime - lastTimeRef.current;
      lastTimeRef.current = currentTime;

      // 基础速度：每秒绘制 100 像素
      const basePixelsPerSecond = 100;
      const pixelsPerMs = basePixelsPerSecond / 1000;
      const pixelsPerFrame = pixelsPerMs * deltaTime * state.speed;

      setState(prev => {
        // 获取当前步骤的总长度
        const currentStepLength = stepLengths[prev.currentStep] || 1;

        // 根据当前步骤长度计算进度增量
        const progressIncrement = pixelsPerFrame / currentStepLength;

        let newProgress = prev.progress + progressIncrement;
        let newCurrentStep = prev.currentStep;
        let newPlaying = prev.playing;

        if (newProgress >= 1) {
          newProgress = 1;

          if (!prev.loopCurrentStep && prev.currentStep < totalSteps - 1) {
            newCurrentStep = prev.currentStep + 1;
            newProgress = 0;
          } else {
            newPlaying = false;
          }
        }

        return {
          ...prev,
          currentStep: newCurrentStep,
          progress: newProgress,
          playing: newPlaying
        };
      });

      animationRef.current = requestAnimationFrame(animate);
    };

    animationRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [state.playing, state.speed, totalSteps, state.loopCurrentStep, stepLengths]);

  // 计算全局进度
  const getGlobalProgress = useCallback((): number => {
    const completedStepsLength = state.currentStep;
    const currentStepProgress = state.progress;
    return (completedStepsLength + currentStepProgress) / totalSteps;
  }, [state.currentStep, state.progress, totalSteps]);

  // 设置全局进度
  const setGlobalProgress = useCallback((globalProgress: number) => {
    setState(prev => {
      const step = Math.min(
        Math.floor(globalProgress * totalSteps),
        totalSteps - 1
      );
      const stepProgress = globalProgress * totalSteps - step;
      return {
        ...prev,
        currentStep: step,
        progress: stepProgress,
        playing: false
      };
    });
  }, [totalSteps]);

  return {
    state,
    actions: {
      reset,
      prevStep,
      nextStep,
      jumpToStep,
      togglePlay,
      toggleSpeed,
      toggleLoop,
      toggleOutline,
      setGlobalProgress
    },
    getGlobalProgress
  };
}
