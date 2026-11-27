import { Routes, Route } from 'react-router-dom';
import { Home } from './components/Home';
import { Group } from './components/Group';
import { CategoryList } from './components/CategoryList';
import { DrawingDetail } from './components/DrawingDetail';
import { SplitLayout } from './components/SplitLayout';
import { StudioProvider, useStudio } from './context/StudioContext';
import './App.css';

// 内部组件：按是否分栏选择渲染。必须放在 Provider 内才能读 isSplit。
function AppShell() {
  const { isSplit } = useStudio();
  // 横屏/平板/PC：左右分栏（左侧路由导航页 + 右侧绘制组件）
  if (isSplit) {
    return <SplitLayout />;
  }
  // 手机竖屏：保持原逻辑 分类页 -> 图案页 -> 详情页(整页跳转)
  return (
    <div className="app">
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/group/*" element={<Group />} />
        <Route path="/category/*" element={<CategoryList />} />
        <Route path="/detail/*" element={<DrawingDetail />} />
      </Routes>
    </div>
  );
}

function App() {
  return (
    <StudioProvider>
      <AppShell />
    </StudioProvider>
  );
}

export default App;
