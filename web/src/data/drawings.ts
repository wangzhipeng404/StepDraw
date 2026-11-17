// 一笔一笔 StepDraw - 数据加载（使用 fetch 加载）

import type { Drawing } from '../types';

// 基础路径配置，与 vite.config.ts 保持一致
export const DATA_BASE_URL = import.meta.env.VITE_DATA_BASE_URL || '/data';

// 缓存已加载的数据
const categoryCache = new Map<string, CategoryData>();
const drawingCache = new Map<string, Drawing>();

interface CategoryData {
  category: string;
  name: string;
  viewBox: [number, number, number, number];
  items: Array<{
    id: string;
    name: string;
    difficulty: number;
    stepCount: number;
    thumbnail?: string;
  }>;
}

// 主索引缓存
let mainIndexCache: MainIndex | null = null;

interface MainIndex {
  viewBox: [number, number, number, number];
  categories: Array<{ id: string; name: string; emoji: string; count: number; dir: string }>;
}

/**
 * 加载主索引
 */
export async function loadMainIndex(): Promise<MainIndex> {
  if (mainIndexCache) {
    return mainIndexCache;
  }

  const response = await fetch(`${DATA_BASE_URL}/index.json?t=${Date.now()}`);
  const data = await response.json();
  mainIndexCache = data;
  return data;
}

/**
 * 加载分类索引
 */
export async function loadCategoryIndex(categoryId: string): Promise<CategoryData> {
  // 检查缓存
  if (categoryCache.has(categoryId)) {
    return categoryCache.get(categoryId)!;
  }

  const response = await fetch(`${DATA_BASE_URL}/${categoryId}/index.json?t=${Date.now()}`);
  const data = await response.json();

  const categoryData: CategoryData = {
    category: categoryId,
    name: data.name,
    viewBox: data.viewBox,
    items: data.items
  };

  // 缓存数据
  categoryCache.set(categoryId, categoryData);

  return categoryData;
}

/**
 * 加载单个图案数据
 */
export async function loadDrawing(categoryId: string, drawingId: string): Promise<Drawing | null> {
  const cacheKey = `${categoryId}/${drawingId}`;

  // 检查缓存
  if (drawingCache.has(cacheKey)) {
    return drawingCache.get(cacheKey)!;
  }

  try {
    const response = await fetch(`${DATA_BASE_URL}/${categoryId}/${drawingId}.json`);
    if (!response.ok) return null;

    const drawing: Drawing = await response.json();

    // 缓存数据
    drawingCache.set(cacheKey, drawing);

    return drawing;
  } catch (err) {
    console.error(`Failed to load drawing ${categoryId}/${drawingId}:`, err);
    return null;
  }
}

/**
 * 获取所有分类的图案列表
 */
export async function getAllDrawings(): Promise<Array<{
  id: string;
  name: string;
  difficulty: number;
  stepCount: number;
  categoryId: string;
  categoryName: string;
  thumbnail?: string;
}>> {
  const index = await loadMainIndex();
  const allItems: Array<{
    id: string;
    name: string;
    difficulty: number;
    stepCount: number;
    categoryId: string;
    categoryName: string;
    thumbnail?: string;
  }> = [];

  for (const category of index.categories) {
    const categoryData = await loadCategoryIndex(category.id);
    for (const item of categoryData.items) {
      allItems.push({
        ...item,
        categoryId: category.id,
        categoryName: category.name
      });
    }
  }

  return allItems;
}

/**
 * 获取分类列表
 */
export async function getCategories(): Promise<Array<{ id: string; name: string; count: number }>> {
  const index = await loadMainIndex();
  return index.categories.map(c => ({ id: c.id, name: c.name, count: c.count }));
}

/**
 * 获取分类下的图案列表
 */
export async function getCategoryItems(categoryId: string): Promise<Array<{
  id: string;
  name: string;
  difficulty: number;
  stepCount: number;
  thumbnail?: string;
}>> {
  const category = await loadCategoryIndex(categoryId);
  return category.items;
}

/**
 * 预加载分类索引
 */
export async function preloadCategory(categoryId: string): Promise<void> {
  await loadCategoryIndex(categoryId);
}

/**
 * 清空缓存
 */
export function clearCache(): void {
  categoryCache.clear();
  drawingCache.clear();
}

/**
 * 清空图案缓存（保留分类索引）
 */
export function clearDrawingCache(): void {
  drawingCache.clear();
}
