// 一笔一笔 StepDraw - 分类下的图案列表

import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { loadCategoryIndex, loadDrawing, DATA_BASE_URL } from '../data/drawings';
import { Navbar } from './Navbar';
import { useStudio } from '../context/StudioContext';
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

const LOAD_MORE_COUNT = 20;

export function CategoryList() {
  const params = useParams<{ '*': string }>();
  // categoryId 可能带路径，如 "quickdraw/cat"
  const categoryId = params['*'] || '';
  const navigate = useNavigate();
  const { isSplit, selectDrawing } = useStudio();
  const [category, setCategory] = useState<CategoryData | null>(null);
  const [items, setItems] = useState<DrawingItem[]>([]);
  const [displayCount, setDisplayCount] = useState(LOAD_MORE_COUNT);
  const [selectedDifficulty, setSelectedDifficulty] = useState('全部');
  const [loading, setLoading] = useState(true);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  // 正常流程用 navigate(-1) 弹栈；直达深链（无历史，如分享链接直接打开）
  // 才回所属主分类。若用固定路径跳转，会把上一页重复压栈，导致多返回一层
  const backPath = categoryId.includes('/')
    ? `/group/${categoryId.split('/')[0]}`
    : '/';

  const handleBack = () => {
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate(backPath);
    }
  };

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
        if (isSplit) {
          // 分栏(横屏/平板/PC)模式：不跳转，直接把图案交给右侧绘制组件
          selectDrawing(drawing);
        } else {
          // 手机竖屏：保持原逻辑整页跳转详情页
          navigate(`/detail/${categoryId}/${item.id}`);
        }
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

  const filteredDrawings = useMemo(() => {
    if (selectedDifficulty === '全部') {
      return items;
    }
    const difficultyMap: Record<string, number> = { '入门': 1, '简单': 2, '进阶': 3 };
    return items.filter(drawing => drawing.difficulty === difficultyMap[selectedDifficulty]);
  }, [items, selectedDifficulty]);

  const displayedDrawings = filteredDrawings.slice(0, displayCount);

  useEffect(() => {
    const container = document.querySelector('.drawing-grid');
    if (!container || isLoadingMore) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      if (scrollHeight - scrollTop - clientHeight < 200 && displayCount < filteredDrawings.length) {
        setIsLoadingMore(true);
        setTimeout(() => {
          setDisplayCount(prev => prev + LOAD_MORE_COUNT);
          setIsLoadingMore(false);
        }, 100);
      }
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [displayCount, filteredDrawings.length, isLoadingMore]);

  useEffect(() => {
    setDisplayCount(LOAD_MORE_COUNT);
  }, [selectedDifficulty]);

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
      <Navbar showBack onBack={handleBack} />

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

        <div className="drawing-grid" ref={loadMoreRef}>
          {displayedDrawings.length === 0 ? (
            <div className="empty-state">没有找到匹配的图案</div>
          ) : (
            <>
              {displayedDrawings.map(drawing => (
                <div
                  key={drawing.id}
                  className="drawing-card"
                  onClick={() => handleDrawingClick(drawing)}
                >
                  <div className="drawing-thumbnail">
                    <span className="difficulty-tag">{getDifficultyLabel(drawing.difficulty)}</span>
                    {drawing.thumbnail ? (
                      <img
                        src={`${DATA_BASE_URL}/${drawing.thumbnail}`}
                        alt={drawing.name}
                        className="thumbnail-image"
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
                  </div>
                </div>
              ))}
              {isLoadingMore && (
                <div className="loading-more-container">
                  <div className="loading-spinner-small"></div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
