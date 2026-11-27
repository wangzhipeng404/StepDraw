// 一笔一笔 StepDraw - 分栏(横屏/平板/PC)布局
//
// 左：抽屉式侧栏（默认收起），渲染原来的路由导航页(首页/分组/图案列表)，可继续往下钻。
//     由右侧顶部工具栏的按钮切换展开/收起（展开时盖在绘制区之上，slide-in 动画）。
// 右：常驻绘制组件 DrawingStudio，占满全部空间。
//   - 图案页点图案 → useStudio().selectDrawing(图案) → 右侧切换，左侧不跳转。
//   - 深链(直接打开分享链接 #/detail/cat/xxx) → 自动载入右侧，左侧显示提示。
//
// 手机竖屏(非分栏)不经过这里，保持原 分类页->图案页->详情页 整页跳转逻辑。
import { useEffect, useMemo, useState } from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
import { Home } from './Home';
import { Group } from './Group';
import { CategoryList } from './CategoryList';
import { DrawingStudio } from './DrawingStudio';
import { useStudio } from '../context/StudioContext';
import { loadDrawing } from '../data/drawings';
import type { Drawing } from '../types';

// 尚未选图案时的空白画布：steps 为空（无参考图案），viewBox 只是一个占位，
// 用户仍可在空白画布上自由绘画（renderLayers 对空 steps 也能渲染用户笔画）。
const BLANK_DRAWING: Drawing = {
  id: 'blank',
  name: '空白画布',
  tags: [],
  difficulty: 1,
  viewBox: [0, 0, 100, 100],
  steps: []
};

// 分栏模式下左侧若落在 /detail/*（多为深链直接打开）：图案在右侧，左侧给个提示
function SplitDetailNote() {
  return (
    <div className="studio-placeholder">
      <p>该图案已在右侧打开</p>
    </div>
  );
}

// 右侧绘制面板：由 useStudio().currentDrawing 驱动，负责把深链载入进来。
// 没有图案时也展示绘制组件（空白画布），随时可画；选了图案则带图案。
// onToggleNav：顶部工具栏的"图案导航"按钮，切换左侧抽屉的展开/收起。
function SplitRight({ onToggleNav }: { onToggleNav: () => void }) {
  const { currentDrawing, selectDrawing } = useStudio();
  const location = useLocation();

  // 深链：/detail/cat/xxx 直接打开时，把该图案载入右侧（categoryId 可能含多级路径）
  useEffect(() => {
    const m = location.pathname.match(/^\/detail\/(.+)$/);
    if (!m) return;
    const rest = decodeURIComponent(m[1]);
    const lastSlash = rest.lastIndexOf('/');
    const drawingId = rest.slice(lastSlash + 1);
    const categoryId = rest.slice(0, lastSlash);
    let active = true;
    loadDrawing(categoryId, drawingId).then(d => { if (active && d) selectDrawing(d); });
    return () => { active = false; };
  }, [location.pathname, selectDrawing]);

  // 未选图案用空白画布；key 区分"空白"与真实图案，切换时重置绘制栈/播放进度
  const drawing = useMemo<Drawing>(
    () => (currentDrawing ? currentDrawing : BLANK_DRAWING),
    [currentDrawing]
  );
  const key = currentDrawing ? currentDrawing.id : 'blank';

  return <DrawingStudio key={key} drawing={drawing} onToggleNav={onToggleNav} />;
}

export function SplitLayout() {
  // 左侧抽屉：默认收起（平板/PC 以绘制区为主），顶部按钮切换
  const [navOpen, setNavOpen] = useState(false);

  return (
    <div className="split-layout">
      {navOpen && <div className="split-nav-mask" onClick={() => setNavOpen(false)} />}
      <div className={`split-left ${navOpen ? 'open' : ''}`}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/group/*" element={<Group />} />
          <Route path="/category/*" element={<CategoryList />} />
          <Route path="/detail/*" element={<SplitDetailNote />} />
          <Route path="*" element={<Home />} />
        </Routes>
      </div>
      <div className="split-right">
        <SplitRight onToggleNav={() => setNavOpen(o => !o)} />
      </div>
    </div>
  );
}
