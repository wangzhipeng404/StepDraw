// 一笔一笔 StepDraw - 主分类下的子分类页

import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { loadMainIndex } from '../data/drawings';
import { Navbar } from './Navbar';
import './Group.css';

interface Category {
  id: string;
  name: string;
  emoji: string;
  count: number;
  dir: string;
  iconBg?: string;
  iconColor?: string;
}

const BG_COLORS = ['#FFE5E5', '#E5F3FF', '#FFF5E5', '#F0F5E5', '#FFE5FF', '#E5FFE5', '#E5F5FF', '#FFF5F5', '#F5E5FF', '#FFE5F5'];
const TEXT_COLORS = ['#FF6B6B', '#4A90D9', '#FFA500', '#8BC34A', '#9C27B0', '#4CAF50', '#00BCD4', '#E91E63', '#673AB7', '#FF4081'];

export function Group() {
  const { '*': groupId } = useParams<{ '*': string }>();
  const navigate = useNavigate();
  const [categories, setCategories] = useState<Category[]>([]);
  const [groupName, setGroupName] = useState('');
  const [groupEmoji, setGroupEmoji] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadGroup = useCallback(async () => {
    if (!groupId) return;
    try {
      setLoading(true);
      setError(null);
      const index = await loadMainIndex();
      // 分组与分类都按 dir 精确等于或前缀匹配归入（目录结构保证唯一）
      const group = (index.groups || []).find(g => g.id === groupId)
        || { id: groupId, name: groupId, emoji: '' };
      const cats = index.categories.filter(
        cat => cat.id === groupId || cat.dir.startsWith(groupId + '/')
      ).map((cat) => ({
        ...cat,
        iconBg: BG_COLORS[cat.id.length % BG_COLORS.length],
        iconColor: TEXT_COLORS[cat.id.length % TEXT_COLORS.length]
      }));
      setGroupEmoji(group.emoji || group.name.charAt(0));
      setCategories(cats);
      document.title = `${group.name} - 一笔一笔 StepDraw`;
      setGroupName(group.name);
    } catch (err) {
      setError('加载数据失败，请刷新页面重试');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  useEffect(() => {
    loadGroup();
  }, [loadGroup]);

  const handleCategoryClick = (category: Category) => {
    navigate(`/category/${category.id}`);
  };

  if (loading) {
    return (
      <div className="group-page">
        <Navbar showBack onBack={() => navigate(-1)} />
        <div className="loading-state">
          <div className="loading-spinner"></div>
          <p>加载中...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="group-page">
        <Navbar showBack onBack={() => navigate(-1)} />
        <div className="error-state">
          <p>{error}</p>
          <button onClick={loadGroup}>重试</button>
        </div>
      </div>
    );
  }

  return (
    <div className="group-page">
      <Navbar showBack onBack={() => navigate(-1)} />

      <div className="group-page-content">
        <div className="group-page-header">
          <div className="group-page-icon">
            <span>{groupEmoji}</span>
          </div>
          <div className="group-page-text">
            <h1>{groupName}</h1>
            <p>{categories.length} 个子分类</p>
          </div>
        </div>

        {categories.length === 0 ? (
          <div className="empty-state">暂无子分类</div>
        ) : (
          <div className="category-grid">
            {categories.map(category => (
              <div
                key={category.id}
                className="category-card"
                onClick={() => handleCategoryClick(category)}
              >
                <div
                  className="category-icon"
                  style={{ background: category.iconBg, color: category.iconColor }}
                >
                  <span>{category.emoji || category.name.charAt(0)}</span>
                </div>
                <h3 className="category-name">{category.name}</h3>
                <p className="category-count">{category.count} 个图案</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
