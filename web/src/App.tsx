import { Routes, Route } from 'react-router-dom';
import { Home } from './components/Home';
import { CategoryList } from './components/CategoryList';
import { DrawingDetail } from './components/DrawingDetail';
import './App.css';

function App() {
  return (
    <div className="app">
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/category/:categoryId" element={<CategoryList />} />
        <Route path="/detail/:categoryId/:drawingId" element={<DrawingDetail />} />
      </Routes>
    </div>
  );
}

export default App;
