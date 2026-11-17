# 一笔一笔 StepDraw

> 纯观看型简笔画分步参考工具

## 项目结构

```
StepDraw/
├── web/                          # Web 版 (React + TypeScript)
│   ├── public/
│   │   └── data/                 # 图案数据
│   │       ├── index.json        # 索引文件
│   │       ├── bear.json         # 熊的分类数据
│   │       ├── bird.json         # 鸟的分类数据
│   │       ├── cat.json          # 猫的分类数据
│   │       ├── cow.json          # 牛的分类数据
│   │       ├── dog.json          # 狗的分类数据
│   │       ├── elephant.json     # 大象的分类数据
│   │       ├── fish.json         # 鱼的分类数据
│   │       ├── horse.json        # 马的分类数据
│   │       ├── pig.json          # 猪的分类数据
│   │       └── rabbit.json       # 兔子的分类数据
│   ├── src/
│   │   ├── components/           # React 组件
│   │   │   ├── Home.tsx          # 首页
│   │   │   ├── DrawingDetail.tsx # 绘画详情页
│   │   │   ├── Home.css
│   │   │   └── DrawingDetail.css
│   │   ├── hooks/                # 自定义 Hooks
│   │   │   ├── useDrawingCanvas.ts   # Canvas 渲染 Hook
│   │   │   └── useDrawingPlayer.ts   # 播放控制 Hook
│   │   ├── types/                # TypeScript 类型定义
│   │   │   └── index.ts
│   │   ├── data/                 # 数据加载
│   │   │   └── drawings.ts       # fetch 数据加载工具
│   │   ├── utils/                # 工具函数
│   │   │   └── canvas.ts         # Canvas 渲染工具
│   │   ├── platform/             # 平台适配层
│   │   │   ├── web/              # Web 平台实现
│   │   │   └── mini-program/     # 小程序平台实现 (预留)
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   └── index.css
│   └── package.json
│
└── miniprogram/                  # 小程序版 (预留)
    ├── pages/
    │   ├── home/                 # 首页
    │   ├── detail/               # 详情页
    │   ├── favorite/             # 收藏页
    │   └── settings/             # 设置页
    ├── components/               # 小程序组件 (预留)
    ├── utils/                    # 工具函数 (预留)
    ├── data/                     # 数据 (预留)
    ├── images/                   # 图片资源 (预留)
    ├── app.json
    ├── app.ts
    └── app.wxss
```

## 数据格式

### index.json (索引文件)
```json
{
  "viewBox": [0, 0, 256, 256],
  "categories": [
    { "id": "cat", "name": "猫", "count": 123198, "file": "cat.json" }
  ],
  "items": [
    { "id": "123", "name": "猫", "category": "cat", "difficulty": 2, "stepCount": 6 }
  ]
}
```

### 分类数据文件 (如 cat.json)
```json
[
  {
    "id": "123",
    "name": "猫",
    "tags": ["动物", "cat"],
    "difficulty": 2,
    "viewBox": [0, 0, 256, 256],
    "steps": [
      {
        "id": 1,
        "tip": "",
        "strokes": [
          { "width": 3, "points": [[16,89],[10,74],[9,52]] }
        ]
      }
    ]
  }
]
```

## Web 版开发

### 启动开发服务器

```bash
cd web
npm run dev
```

访问 http://localhost:5174/

### 构建

```bash
cd web
npm run build
```

### 技术栈

- React 19
- TypeScript
- Vite
- Canvas 2D API

## 数据加载

数据通过 fetch 从 `/public/data/` 目录加载：

- `loadIndex()` - 加载索引文件
- `loadCategoryData(categoryId)` - 加载指定分类的所有图案
- `loadDrawing(categoryId, drawingId)` - 获取单个图案
- 数据会自动缓存，避免重复加载

## 小程序版 (预留)

小程序版代码将放在 `miniprogram/` 目录，使用微信开发者工具进行开发。

## 核心功能

根据 PRD 实现的功能：

- [x] 图案浏览、分类、搜索
- [x] 分步演示（离散步骤切换 + 连续笔画生长两种模式）
- [x] 播放控制：播放/暂停/上一步/下一步/重播/变速
- [x] 步骤文字提示、步骤条跳转
- [x] 当前笔画高亮、整体轮廓底图开关
- [x] 从 JSON 数据加载图案
- [ ] 收藏 (Web 版已实现 localStorage 存储)
- [ ] 进度条拖动

## 后续扩展

1. 添加更多分类数据加载
2. 实现图案描点工具（用于生成图案数据）
3. 小程序版开发
4. 离线缓存功能
