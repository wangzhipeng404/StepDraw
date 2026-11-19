import { Routes, Route } from 'react-router-dom';
import { Home } from './components/Home';
import { Group } from './components/Group';
import { CategoryList } from './components/CategoryList';
import { DrawingDetail } from './components/DrawingDetail';
import './App.css';

function App() {
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

export default App;
