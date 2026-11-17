import { useRef, useCallback } from 'react';
import type { Drawing, UserStroke } from '../types';
import { renderDrawing } from '../utils/canvas';

interface UseDrawingCanvasProps {
  drawing: Drawing;
  currentStep: number;
  stepProgress: number;
  showOutline: boolean;
  userStrokes?: UserStroke[];
  currentStroke?: UserStroke;
}

export function useDrawingCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const render = useCallback((props: UseDrawingCanvasProps) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    renderDrawing(
      ctx,
      props.drawing,
      props.currentStep,
      props.stepProgress,
      props.showOutline,
      props.userStrokes,
      props.currentStroke
    );
  }, []);

  return { canvasRef, render };
}
