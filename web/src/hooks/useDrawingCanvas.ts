import { useRef, useCallback } from 'react';
import { renderLayers, exportLayersToDataURL } from '../utils/canvas';
import type { LayerState, RenderLayersArgs } from '../utils/canvas';

/**
 * 三层画布 hook（与小程序端同构）：
 * - outlineRef（底层）：JSON 图案数据
 * - historyRef（中层）：用户已完成的笔画（增量绘制）
 * - brushRef（顶层）：当前正在绘制的一笔（触摸事件挂这层）
 * 三层只在导出时合并（exportToDataURL）。
 */
export function useDrawingCanvas() {
  const outlineRef = useRef<HTMLCanvasElement>(null);
  const historyRef = useRef<HTMLCanvasElement>(null);
  const brushRef = useRef<HTMLCanvasElement>(null);

  // 三层渲染的可变状态（离屏缓存、历史笔画计数等）
  const layerStateRef = useRef<LayerState | null>(null);

  const render = useCallback((args: RenderLayersArgs) => {
    const next = renderLayers(
      outlineRef.current,
      historyRef.current,
      brushRef.current,
      layerStateRef.current,
      args
    );
    if (next) layerStateRef.current = next;
  }, []);

  // 导出：合并三层为单张图片
  const exportToDataURL = useCallback(() => {
    return exportLayersToDataURL(outlineRef.current, historyRef.current, brushRef.current);
  }, []);

  return { outlineRef, historyRef, brushRef, render, exportToDataURL };
}
