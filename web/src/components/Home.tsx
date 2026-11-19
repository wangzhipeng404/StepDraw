// 一笔一笔 StepDraw - 首页组件（分类卡片列表）

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { loadMainIndex } from '../data/drawings';
import { Navbar } from './Navbar';
import './Home.css';

interface Category {
  id: string;
  name: string;
  emoji: string;
  count: number;
  dir: string;
}

interface Group {
  id: string;
  name: string;
  emoji: string;
  categories: Category[];
}

// 按一级分组归类（id 精确等于或前缀匹配，目录结构保证唯一）
function groupCategories(index: { groups?: Array<{ id: string; name: string; emoji: string }>; categories: Category[] }): Group[] {
  const groupsRaw = index.groups && index.groups.length > 0
    ? index.groups
    : [{ id: 'all', name: '全部', emoji: '' }];

  return groupsRaw
    .map(group => ({
      id: group.id,
      name: group.name,
      emoji: group.emoji || group.name.charAt(0),
      categories: index.categories.filter(
        cat => cat.id === group.id || cat.dir.startsWith(group.id + '/')
      )
    }))
    .filter(group => group.categories.length > 0);
}

export function Home() {
  const navigate = useNavigate();
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadInitialData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const index = await loadMainIndex();
      setGroups(groupCategories(index));
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

  const handleGroupClick = (group: Group) => {
    // 只有一个分类且就是组本身（如 linedrawer）：直接进入图案列表，少一次点击
    if (group.categories.length === 1 && group.categories[0].id === group.id) {
      navigate(`/category/${group.categories[0].id}`);
      return;
    }
    navigate(`/group/${group.id}`);
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
          <p>先选主分类，再选具体图案</p>
        </div>

        <div className="group-grid">
          {groups.map(group => (
            <div
              key={group.id}
              className="group-card"
              onClick={() => handleGroupClick(group)}
            >
              <div className="group-icon">
                <span>{group.emoji}</span>
              </div>
              <h3 className="group-name">{group.name}</h3>
              <p className="group-meta">
                {group.categories.length} 个子分类 · {group.categories.reduce((sum, c) => sum + c.count, 0)} 个图案
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
