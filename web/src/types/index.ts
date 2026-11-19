// 一笔一笔 StepDraw - 类型定义

// 画笔图标
import penIcon from '../assets/fountain_pen.png';
import penIconActive from '../assets/fountain_active.png';
import pencilIcon from '../assets/pencil.png';
import pencilIconActive from '../assets/pencil_active.png';
import markerIcon from '../assets/markpen.png';
import markerIconActive from '../assets/mark_pen_active.png';
import brushIcon from '../assets/ink_brush.png';
import brushIconActive from '../assets/ink_brush_active.png';

// 笔画：一组点构成的线条
export interface Stroke {
  width: number;
  points: [number, number][];
}

// 步骤：包含多个笔画和文字提示
export interface Step {
  id: number;
  tip: string;
  strokes: Stroke[];
}

// 图案数据
export interface Drawing {
  id: string;
  name: string;
  tags: string[];
  difficulty: number; // 1=入门，2=简单，3=进阶
  viewBox: [number, number, number, number];
  thumbnail?: string;
  steps: Step[];
}

// 分类标签
export type Category = '动物' | '植物' | '食物' | '人物' | '交通工具' | '日常物品' | '节日';

// 难度等级
export type DifficultyLevel = '入门' | '简单' | '进阶';

// 播放状态
export interface PlayState {
  currentStep: number;
  progress: number; // 当前步骤内的进度 0-1
  playing: boolean;
  speed: number; // 倍速 0.5 | 1 | 2
  loopCurrentStep: boolean; // 单步循环
  showOutline: boolean; // 显示轮廓底图
}

// 演示模式
export type DemoMode = 'discrete' | 'continuous'; // 离散步骤切换 | 连续笔画生长

// 用户笔画（支持手绘功能）
export interface UserStroke {
  points: [number, number][];
  width: number;
  color: string;
  type: StrokeType;
}

// 画笔类型
export type StrokeType = 'pen' | 'pencil' | 'marker' | 'brush';

// 画笔类型定义
export const STROKE_TYPES: { key: StrokeType; name: string; icon: string; iconActive: string }[] = [
  { key: 'pen', name: '钢笔', icon: penIcon, iconActive: penIconActive },
  { key: 'pencil', name: '铅笔', icon: pencilIcon, iconActive: pencilIconActive },
  { key: 'marker', name: '马克笔', icon: markerIcon, iconActive: markerIconActive },
  { key: 'brush', name: '毛笔', icon: brushIcon, iconActive: brushIconActive }
];

// 绘图模式
export type DrawMode = 'demo' | 'draw'; // 演示模式 | 绘图模式
