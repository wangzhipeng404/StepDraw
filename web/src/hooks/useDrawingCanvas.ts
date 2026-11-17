import { useRef, useCallback } from 'react';
import type { Drawing } from '../types';
import { renderDrawing } from '../utils/canvas';

interface UseDrawingCanvasProps {
  drawing: Drawing;
  currentStep: number;
  stepProgress: number;
  showOutline: boolean;
}

export function useDrawingCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const render = useCallback((props: UseDrawingCanvasProps) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    renderDrawing(ctx, props.drawing, props.currentStep, props.stepProgress, props.showOutline);
  }, []);

  return { canvasRef, render };
}
