// 一笔一笔 StepDraw - 分类下的图案列表

import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { loadCategoryIndex, loadDrawing, DATA_BASE_URL } from '../data/drawings';
import { Navbar } from './Navbar';
import './CategoryList.css';

interface DrawingItem {
  id: string;
  name: string;
  difficulty: number;
  stepCount: number;
  thumbnail?: string;
}

interface CategoryData {
  category: string;
  name: string;
  viewBox: [number, number, number, number];
  items: DrawingItem[];
}

export function CategoryList() {
  const { categoryId } = useParams<{ categoryId: string }>();
  const navigate = useNavigate();
  const [category, setCategory] = useState<CategoryData | null>(null);
  const [items, setItems] = useState<DrawingItem[]>([]);
  const [selectedDifficulty, setSelectedDifficulty] = useState('全部');
  const [loading, setLoading] = useState(true);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  useEffect(() => {
    if (categoryId) {
      loadCategoryData(categoryId);
    }
  }, [categoryId]);

  const loadCategoryData = async (id: string) => {
    try {
      setLoading(true);
      const data = await loadCategoryIndex(id);
      setCategory(data);
      setItems(data.items);
    } catch (err) {
      console.error('Failed to load category:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleDrawingClick = async (item: DrawingItem) => {
    if (loadingId) return;

    setLoadingId(item.id);
    try {
      const drawing = await loadDrawing(categoryId!, item.id);
      if (drawing) {
        // 跳转到详情页，传递 categoryId 和 drawingId
        navigate(`/detail/${categoryId}/${item.id}`);
      }
    } catch (err) {
      console.error('加载图案失败:', err);
    } finally {
      setLoadingId(null);
    }
  };

  const getDifficultyLabel = (diff: number): string => {
    return diff === 1 ? '入门' : diff === 2 ? '简单' : '进阶';
  };

  const difficulties = ['全部', '入门', '简单', '进阶'];

  const filteredDrawings = selectedDifficulty === '全部'
    ? items
    : items.filter(drawing => {
        const difficultyMap: Record<string, number> = { '入门': 1, '简单': 2, '进阶': 3 };
        return drawing.difficulty === difficultyMap[selectedDifficulty];
      });

  if (loading) {
    return (
      <div className="category-list">
        <div className="loading-state">
          <div className="loading-spinner"></div>
          <p>加载中...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="category-list">
      {/* 导航栏 */}
      <Navbar showBack onBack={() => navigate('/')} />

      {/* 内容区域 */}
      <div className="category-list-content">
        <div className="category-header">
          <h2 className="category-title">{category?.name || '分类'}</h2>
          <div className="difficulty-filter">
            {difficulties.map(diff => (
              <button
                key={diff}
                className={`difficulty-btn ${selectedDifficulty === diff ? 'active' : ''}`}
                onClick={() => setSelectedDifficulty(diff)}
              >
                {diff}
              </button>
            ))}
          </div>
        </div>

        <div className="drawing-grid">
          {filteredDrawings.length === 0 ? (
            <div className="empty-state">没有找到匹配的图案</div>
          ) : (
            filteredDrawings.map(drawing => (
              <div
                key={drawing.id}
                className="drawing-card"
                onClick={() => handleDrawingClick(drawing)}
              >
                <div className="drawing-thumbnail">
                  {drawing.thumbnail ? (
                    <img
                      src={`${DATA_BASE_URL}/${drawing.thumbnail}`}
                      alt={drawing.name}
                      className="thumbnail-image"
                      loading="lazy"
                      onError={(e) => {
                        e.currentTarget.style.display = 'none';
                        e.currentTarget.nextElementSibling?.classList.remove('hidden');
                      }}
                    />
                  ) : null}
                  <div className="thumbnail-placeholder hidden" style={{ display: drawing.thumbnail ? 'none' : 'flex' }}>
                    <span>{drawing.name.charAt(0)}</span>
                  </div>
                </div>
                <div className="drawing-info">
                  <h3 className="drawing-name">{drawing.name}</h3>
                  <div className="drawing-tags">
                    <span className="tag tag-difficulty">{getDifficultyLabel(drawing.difficulty)}</span>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
