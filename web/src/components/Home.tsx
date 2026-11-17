// 一笔一笔 StepDraw - 首页组件（分类卡片列表）

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { loadMainIndex } from '../data/drawings';
import { Navbar } from './Navbar';
import './Home.css';

interface Category {
  id: string;
  name: string;
  count: number;
  dir: string;
}

export function Home() {
  const navigate = useNavigate();
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadInitialData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const index = await loadMainIndex();
      setCategories(index.categories);
    } catch (err) {
      setError('加载数据失败，请刷新页面重试');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadInitialData();
  }, [loadInitialData]);

  const handleCategoryClick = (category: Category) => {
    navigate(`/category/${category.id}`);
  };

  if (loading) {
    return (
      <div className="home">
        <div className="loading-state">
          <div className="loading-spinner"></div>
          <p>加载中...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="home">
        <div className="error-state">
          <p>{error}</p>
          <button onClick={loadInitialData}>重试</button>
        </div>
      </div>
    );
  }

  return (
    <div className="home">
      {/* 导航栏 */}
      <Navbar />

      {/* 内容区域 */}
      <div className="home-content">
        <div className="page-header">
          <h1>选择你想画的图案</h1>
          <p>从以下分类中选择一个开始绘画</p>
        </div>

        <div className="category-grid">
          {categories.map(category => (
            <div
              key={category.id}
              className="category-card"
              onClick={() => handleCategoryClick(category)}
            >
              <div className="category-icon">
                <span>{category.name.charAt(0)}</span>
              </div>
              <h3 className="category-name">{category.name}</h3>
              <p className="category-count">{category.count} 个图案</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
