import { useRef, useCallback } from 'react';
import { renderLayers, exportLayersToDataURL, IDENTITY_VIEW } from '../utils/canvas';
import type { LayerState, RenderLayersArgs, ViewTransform } from '../utils/canvas';
import type { Drawing } from '../types';

/**
 * 三层画布 hook（与小程序端同构）：
 * - outlineRef（底层）：JSON 图案数据
 * - historyRef（中层）：用户已完成的笔画（离屏缓存）
 * - brushRef（顶层）：当前正在绘制的一笔（指针事件挂这层）
 * 三层只在导出时合并（exportToDataURL），导出不受当前缩放/平移影响。
 */
export function useDrawingCanvas() {
  const outlineRef = useRef<HTMLCanvasElement>(null);
  const historyRef = useRef<HTMLCanvasElement>(null);
  const brushRef = useRef<HTMLCanvasElement>(null);

  // 三层渲染的可变状态（离屏缓存、历史笔画计数等）
  const layerStateRef = useRef<LayerState | null>(null);

  const render = useCallback((args: Omit<RenderLayersArgs, 'view'> & { view?: ViewTransform }) => {
    const next = renderLayers(
      outlineRef.current,
      historyRef.current,
      brushRef.current,
      layerStateRef.current,
      { ...args, view: args.view || IDENTITY_VIEW }
    );
    if (next) layerStateRef.current = next;
  }, []);

  // 导出：按原始视图合并三层为单张图片（不受当前缩放/平移影响）
  const exportToDataURL = useCallback((
    drawing: Drawing,
    currentStep: number,
    stepProgress: number
  ) => {
    return exportLayersToDataURL(layerStateRef.current, drawing, currentStep, stepProgress);
  }, []);

  return { outlineRef, historyRef, brushRef, render, exportToDataURL };
}
