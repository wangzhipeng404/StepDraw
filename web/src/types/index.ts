// 一笔一笔 StepDraw - 类型定义

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
