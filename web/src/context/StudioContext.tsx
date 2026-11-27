// 一笔一笔 StepDraw - 分栏(横屏/平板/PC)绘制工作台的全局状态
//
// 响应式策略：
//   - 小屏(手机竖屏)：保持原逻辑 分类页 -> 图案页 -> 详情页(整页跳转)
//   - 横屏 / 平板 / PC(判定：orientation:landscape 或 宽>=768px)：
//     左侧固定宽度放原来的路由导航页，右侧常驻 DrawingStudio 绘制组件。
//     此时图案页点图案不再跳转，而是把图案设为右侧绘制组件的当前图案。
//
// 这个 Context 承载两个状态：是否处于分栏模式、当前右侧在画的图案。
import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import type { ReactNode } from 'react';
import type { Drawing } from '../types';

// 横屏 或 宽>=768px 视为分栏。手机竖屏(多数 <768 且 portrait)保持整页详情。
const SPLIT_QUERY = '(orientation: landscape), (min-width: 768px)';

interface StudioState {
  isSplit: boolean;
  currentDrawing: Drawing | null;
  // 选中(或清空)右侧绘制组件的当前图案
  selectDrawing: (drawing: Drawing | null) => void;
}

const StudioContext = createContext<StudioState | null>(null);

export function StudioProvider({ children }: { children: ReactNode }) {
  const [isSplit, setIsSplit] = useState<boolean>(() =>
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia(SPLIT_QUERY).matches
      : false
  );
  const [currentDrawing, setCurrentDrawing] = useState<Drawing | null>(null);

  // 监听视口变化(旋转屏幕 / 缩放浏览器)实时切换分栏与否
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(SPLIT_QUERY);
    const handler = (e: MediaQueryListEvent) => setIsSplit(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  const selectDrawing = useCallback((drawing: Drawing | null) => {
    // 切换图案时，若当前已加载一个图案且要换成另一个，弹窗确认是否替换
    // （空白画布 currentDrawing=null 不算"图案"，不弹；同图案重复设置也不弹）
    if (drawing && currentDrawing && drawing.id !== currentDrawing.id) {
      const ok = window.confirm(
        `当前正在画「${currentDrawing.name}」，要替换为「${drawing.name}」吗？`
      );
      if (!ok) return;
    }
    setCurrentDrawing(drawing);
  }, [currentDrawing]);

  return (
    <StudioContext.Provider value={{ isSplit, currentDrawing, selectDrawing }}>
      {children}
    </StudioContext.Provider>
  );
}

export function useStudio(): StudioState {
  const ctx = useContext(StudioContext);
  if (!ctx) throw new Error('useStudio 必须在 <StudioProvider> 内使用');
  return ctx;
}
