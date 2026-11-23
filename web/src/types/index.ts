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
import bucketIcon from '../assets/bucket.png';
import bucketIconActive from '../assets/bucket_active.png';

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
export type StrokeType = 'pen' | 'pencil' | 'marker' | 'brush' | 'fill';

// 画笔类型定义
export const STROKE_TYPES: { key: StrokeType; name: string; icon: string; iconActive: string }[] = [
  { key: 'pen', name: '钢笔', icon: penIcon, iconActive: penIconActive },
  { key: 'pencil', name: '铅笔', icon: pencilIcon, iconActive: pencilIconActive },
  { key: 'marker', name: '马克笔', icon: markerIcon, iconActive: markerIconActive },
  { key: 'brush', name: '毛笔', icon: brushIcon, iconActive: brushIconActive },
  { key: 'fill', name: '填充', icon: bucketIcon, iconActive: bucketIconActive }
];

// 绘图模式
export type DrawMode = 'demo' | 'draw'; // 演示模式 | 绘图模式

// 颜色填充（油漆桶）：点选封闭区域，区域按当前颜色填满。
// mask 是区域掩码位图（设备像素、区域白色 alpha=255、区域外透明），与颜色解耦：
// 在同一区域再次喷涂 = 叠一层新颜色、共享同一份 mask（不复制位图），
// 撤销时逐层退回上一个颜色。渲染时按 (mask, color) 上色。
// strokeCount 记录喷涂时刻的手绘笔画数：墙（线条）没变过时才能复用旧掩码，
// 用户画了新线/撤销了线（区域可能被分割）则必须重新 flood。
export interface UserFill {
  key: string;
  seed: [number, number]; // 点击落点（图像坐标，CSS 像素）
  color: string;
  mask: HTMLCanvasElement;
  strokeCount: number; // 喷涂时的手绘笔画数（墙版本标记）
}

// 用户操作栈：笔画与填充按时间序统一入栈，撤销/清除按序弹出
export type UserAction =
  | { kind: 'stroke'; stroke: UserStroke }
  | { kind: 'fill'; fill: UserFill };
