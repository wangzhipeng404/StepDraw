# 小程序 Canvas「轮廓内笔迹保留 / 轮廓外一键清除」完整技术方案

> 适用场景：微信小程序 `canvas type="2d"`，页面有一个由点/路径生成的轮廓，
> 用户可在上层自由涂鸦，需要提供「一键清除轮廓外内容」能力。
> **兼容开放轮廓、手绘草图、多段线条等非理想输入。**

## 1. 需求拆解

| 角色 | 内容 | 是否可变 |
|---|---|---|
| 底层 | 底图 + 轮廓线 | 静态，初始化后不变 |
| 上层 | 用户手绘笔迹 | 高频变化 |
| 遮罩 | 允许保留的区域 | 静态，可预生成 |

核心目标：

- 用户笔迹只渲染在「允许区域内」
- 点「清除轮廓外」后，允许区域外的像素直接消失
- 不破坏轮廓内已有笔迹
- 轮廓未闭合 / 手绘草图缺口大时依然行为正确
- 支持撤销、导出、高性能实时绘制

## 2. 轮廓的两种语义（设计前提）

本方案最大分歧点：**「轮廓」究竟代表什么？** 必须先分清楚，否则 mask 会算出错误区域。

| 类型 | 视觉特征 | 几何含义 | 生成 mask 的方式 |
|---|---|---|---|
| **闭合区域型** | 围成一块面（填充/涂色、上色本、填色游戏） | 有明确的内部 / 外部 | `fill()` |
| **线条围栏型** | 一条轨道、跑道、边界线、书写引导线 | 没有内外，只有"离线的距离" | `stroke()` |

```js
// 通过构造参数在两种语义间切换
const mode = 'fill' | 'stroke'
```

> ⚠️ 开放轮廓下「内部 / 外部」在数学上不成立，`fill()` 会隐式用直线缝合缺口，
> 产生一块"幽灵区域"。**开放轮廓必须走 `stroke` mask。**

## 3. 整体架构：三层分离

```
┌───────────────────────────────────┐
│  base canvas（底图+轮廓+生效区）   │  只读，不接收触摸
├───────────────────────────────────┤
│  draw canvas（用户笔迹）           │  只接收触摸，可被 Mask 裁剪
├───────────────────────────────────┤
│  mask（离屏 canvas）               │  内存中，不显示，仅用于合成
└───────────────────────────────────┘
```

分层原因：`destination-in` 是像素级交集运算，作用于整个画布。
笔迹与底图同层会导致清除时把底图一起裁掉。

## 4. WXML / WXSS

```html
<view class="stage">
  <!-- 底层：轮廓 + 生效区 + 底图 -->
  <canvas
    type="2d"
    id="baseCanvas"
    class="layer"
    disable-scroll="{{true}}"
  ></canvas>

  <!-- 上层：用户笔迹（接收触摸） -->
  <canvas
    type="2d"
    id="drawCanvas"
    class="layer"
    bindtouchstart="onTouchStart"
    bindtouchmove="onTouchMove"
    bindtouchend="onTouchEnd"
  ></canvas>

  <view class="toolbar">
    <button bindtap="clearOutside">清除轮廓外</button>
    <button bindtap="undo">撤销</button>
    <button bindtap="clearAll">清空</button>
    <button bindtap="exportImage">导出</button>
  </view>
</view>
```

```css
.stage {
  position: relative;
  width: 100vw;
  height: 70vh;
}
.layer {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
}
#baseCanvas {
  pointer-events: none;   /* 事件全部落到上层 */
}
```

## 5. 轮廓路径定义

路径抽成纯函数，底图绘制、遮罩生成、可视化校验全部复用同一份。

```js
// outline.js
export function traceOutline(ctx, { close = true } = {}) {
  ctx.beginPath()

  // 示例：一段手绘草图轮廓（可能不闭合）
  ctx.moveTo(100, 80)
  ctx.bezierCurveTo(180, 60, 260, 120, 240, 220)
  ctx.lineTo(160, 320)
  ctx.lineTo(60, 260)
  // 故意不 closePath —— 模拟手绘缺口

  if (close) ctx.closePath()
}

// 拿到点集（用于校验、缝合、bbox）
export function getOutlinePoints() {
  // 与 traceOutline 保持同一份数据源
  return [
    { x: 100, y: 80 },
    { x: 180, y: 60 },
    { x: 260, y: 120 },
    { x: 240, y: 220 },
    { x: 160, y: 320 },
    { x: 60,  y: 260 }
  ]
}
```

## 6. 初始化

```js
const dpr = wx.getWindowInfo().pixelRatio

Page({
  data: { drawing: false },

  strokes: [],           // 笔迹点集：[{ width, color, points[] }]
  currentStroke: null,
  maskCanvas: null,
  maskAvailable: false,  // 标记 mask 是否有效

  // ★ 业务配置：切换 'fill' / 'stroke' 语义
  mode: 'fill',
  strokeMaskWidth: 30,   // stroke 模式下的允许带宽

  async onReady() {
    this.base = await this.initCanvas('#baseCanvas')
    this.draw = await this.initCanvas('#drawCanvas')

    this.renderBase()
    this.buildMask()
  },

  initCanvas(selector) {
    return new Promise(resolve => {
      wx.createSelectorQuery()
        .select(selector)
        .fields({ node: true, size: true })
        .exec(res => {
          const { node, width, height } = res[0]
          node.width = Math.floor(width * dpr)
          node.height = Math.floor(height * dpr)
          const ctx = node.getContext('2d')
          ctx.scale(dpr, dpr)
          resolve({ node, ctx, width, height })
        })
    })
  },
```

## 7. 轮廓合法性校验（关键前置）

开放轮廓 / 点太少 / 共线会算出退化 mask，可能把全部笔迹误清。
生成 mask 前必须先判断。

```js
const CLOSE_TOLERANCE = 8   // px，小于此距离视为可缝合

validateOutline() {
  const pts = getOutlinePoints()

  if (pts.length < 3) {
    return { ok: false, reason: 'POINTS_TOO_FEW' }
  }

  // 鞋带公式算面积
  let area = 0
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    area += pts[j].x * pts[i].y - pts[i].x * pts[j].y
  }
  area = Math.abs(area) / 2

  if (area < 50) {
    return { ok: false, reason: 'AREA_TOO_SMALL' }
  }

  // 首尾缺口
  const first = pts[0]
  const last = pts[pts.length - 1]
  const gap = Math.hypot(first.x - last.x, first.y - last.y)

  return {
    ok: true,
    gap,
    closable: gap <= CLOSE_TOLERANCE
  }
}
```

| 校验结果 | 处理方式 |
|---|---|
| `POINTS_TOO_FEW` | 禁用清除，提示「轮廓点过少」 |
| `AREA_TOO_SMALL` | 禁用清除，避免误删全部笔迹 |
| 面积正常 + 缺口小 | 自动缝合，正常走 `fill` |
| 面积正常 + 缺口大 + 是 `fill` 模式 | 降级为 `stroke` mask 或提示用户 |
| `stroke` 模式 | 跳过面积校验，直接用线宽生成 |

## 8. 遮罩生成（核心，含双分支）

```js
buildMask() {
  const { width, height } = this.draw
  const cvs = wx.createOffscreenCanvas({
    type: '2d',
    width: Math.floor(width * dpr),
    height: Math.floor(height * dpr)
  })
  const ctx = cvs.getContext('2d')
  ctx.scale(dpr, dpr)

  const check = this.validateOutline()

  // ===== 分支 A：闭合区域型 =====
  if (this.mode === 'fill') {
    if (!check.ok) {
      console.warn('[mask]', check.reason, '→ 关闭清除功能')
      this.maskAvailable = false
      this.maskCanvas = cvs
      return
    }

    if (check.gap > CLOSE_TOLERANCE) {
      // 缺口过大：强制改走 stroke 语义，避免幽灵区域
      this.mode = 'stroke'
    } else {
      traceOutline(ctx, { close: true })
      ctx.fillStyle = '#fff'
      ctx.fill('nonzero')
      this.maskAvailable = true
      this.maskCanvas = cvs
      return
    }
  }

  // ===== 分支 B：线条围栏型（含 fill 模式的降级） =====
  traceOutline(ctx, { close: false })   // stroke 不闭合
  ctx.lineWidth = this.strokeMaskWidth
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = '#fff'
  ctx.stroke()
  this.maskAvailable = true
  this.maskCanvas = cvs
},
```

### 两种 mask 的对比

| | `fill` mask | `stroke` mask |
|---|---|---|
| 适用 | 涂色、上色本、面状区域 | 轨道、引导线、开放轮廓 |
| 可画范围 | 轮廓围成的一块面 | 线条两侧各 `width/2` 的带状区 |
| 开放轮廓 | 会产生幽灵缝合边 | ✅ 无此问题 |
| 有孔洞 | `evenodd` 支持 | 不适用 |

## 9. 底层渲染（含"生效区"可视化）

把**实际生效范围**画出来，用户不会困惑于"为什么这条线外能画"。

```js
renderBase() {
  const { ctx, width, height } = this.base
  ctx.clearRect(0, 0, width, height)

  // 1. 底图（如有）
  // ctx.drawImage(bgImg, 0, 0, width, height)

  // 2. 生效区域可视化（淡色填充 = 笔迹会被保留的地方）
  if (this.mode === 'fill' && this.maskAvailable) {
    traceOutline(ctx, { close: true })
    ctx.fillStyle = 'rgba(64,158,255,0.06)'
    ctx.fill('nonzero')
  } else if (this.mode === 'stroke') {
    traceOutline(ctx, { close: false })
    ctx.lineWidth = this.strokeMaskWidth
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = 'rgba(64,158,255,0.06)'
    ctx.stroke()
  }

  // 3. 轮廓描边（深色，永远可见）
  traceOutline(ctx, { close: this.mode === 'fill' })
  ctx.lineWidth = 2
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = '#409EFF'
  ctx.stroke()

  // 4. 缺口提示（开放轮廓）
  if (this.mode === 'fill') {
    const pts = getOutlinePoints()
    const gap = Math.hypot(
      pts[0].x - pts[pts.length - 1].x,
      pts[0].y - pts[pts.length - 1].y
    )
    if (gap > CLOSE_TOLERANCE) {
      this.drawGapHint(ctx, pts[0], pts[pts.length - 1])
    }
  }
},

drawGapHint(ctx, a, b) {
  ctx.save()
  ctx.setLineDash([6, 4])
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  ctx.lineTo(b.x, b.y)
  ctx.lineWidth = 1.5
  ctx.strokeStyle = '#F56C6C'
  ctx.stroke()
  ctx.restore()
}
```

> 缺口处画一条红色虚线，明确告诉用户"这里没连上"，体验上比默默缝合更诚实。

## 10. 用户笔迹绘制

### 10.1 触摸事件

```js
getPos(e) {
  const t = e.touches[0] || e.changedTouches[0]
  return { x: t.x, y: t.y }
},

onTouchStart(e) {
  const p = this.getPos(e)
  this.currentStroke = { width: 4, color: '#222', points: [p] }
  this.data.drawing = true
  this.drawDot(p)
},

onTouchMove(e) {
  if (!this.data.drawing) return
  const now = Date.now()
  if (now - (this._lastMove || 0) < 8) return   // 节流
  this._lastMove = now

  const p = this.getPos(e)
  const last = this.currentStroke.points.at(-1)
  this.currentStroke.points.push(p)
  this.drawLine(last, p)
},

onTouchEnd() {
  if (this.currentStroke) this.strokes.push(this.currentStroke)
  this.currentStroke = null
  this.data.drawing = false
}
```

### 10.2 绘制方法

```js
drawDot(p) {
  const { ctx } = this.draw
  ctx.save()
  ctx.beginPath()
  ctx.arc(p.x, p.y, 2, 0, Math.PI * 2)
  ctx.fillStyle = '#222'
  ctx.fill()
  ctx.restore()
},

drawLine(a, b) {
  const { ctx } = this.draw
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  ctx.lineTo(b.x, b.y)
  ctx.lineWidth = 4
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = '#222'
  ctx.stroke()
  ctx.restore()
}
```

## 11. 一键清除轮廓外（核心功能）

```js
clearOutside() {
  if (!this.maskAvailable) {
    wx.showToast({ title: '轮廓未闭合，暂不支持清除', icon: 'none' })
    return
  }

  // 备份（用于撤销这次清除）
  this.backupCanvas = this.snapshot(this.draw)

  const { ctx, width, height } = this.draw
  ctx.save()
  ctx.globalCompositeOperation = 'destination-in'
  // 用逻辑尺寸：ctx 已 scale(dpr)，mask 也是同样比例
  ctx.drawImage(this.maskCanvas, 0, 0, width, height)
  ctx.restore()
  ctx.globalCompositeOperation = 'source-over'   // 必须还原
},

snapshot(layer) {
  const { width, height } = layer
  const cvs = wx.createOffscreenCanvas({
    type: '2d',
    width: width * dpr,
    height: height * dpr
  })
  const ctx = cvs.getContext('2d')
  ctx.scale(dpr, dpr)
  ctx.drawImage(layer.node, 0, 0, width, height)
  return cvs
},

restoreBackup() {
  if (!this.backupCanvas) return
  const { ctx, width, height } = this.draw
  ctx.clearRect(0, 0, width, height)
  ctx.drawImage(this.backupCanvas, 0, 0, width, height)
  this.backupCanvas = null
}
```

### 原理

```
笔迹层（destination）  ∩  mask（source 不透明区）
        =
   只保留允许区域内的笔迹
```

- `destination-in`：保留已有内容中与 source 重叠的部分，其余变透明
- mask 白色区域 = 保留，透明区域 = 删除
- 操作只作用于 `drawCanvas`，底图完全不受影响

## 12. 撤销 & 清空

### 12.1 撤销（点集重放，最干净）

```js
undo() {
  this.strokes.pop()
  this.rerenderStrokes()
},

rerenderStrokes() {
  const { ctx, width, height } = this.draw
  ctx.clearRect(0, 0, width, height)
  this.strokes.forEach(stroke => {
    if (stroke.points.length === 1) {
      this.drawDot(stroke.points[0])
      return
    }
    for (let i = 1; i < stroke.points.length; i++) {
      this.drawLine(stroke.points[i - 1], stroke.points[i])
    }
  })
}
```

### 12.2 清空

```js
clearAll() {
  const { ctx, width, height } = this.draw
  ctx.clearRect(0, 0, width, height)
  this.strokes = []
}
```

## 13. 导出合成图

两层 canvas 需合并为一张：

```js
exportImage() {
  const { width, height } = this.draw
  const out = wx.createOffscreenCanvas({
    type: '2d',
    width: width * dpr,
    height: height * dpr
  })
  const octx = out.getContext('2d')
  octx.scale(dpr, dpr)

  octx.drawImage(this.base.node, 0, 0, width, height)
  octx.drawImage(this.draw.node, 0, 0, width, height)

  wx.canvasToTempFilePath({
    canvas: out,
    success: res => wx.previewImage({ urls: [res.tempFilePath] })
  })
}
```

## 14. 性能优化清单

| 问题 | 优化手段 |
|---|---|
| touchmove 过密 | 节流 8~16ms，或按距离阈值采样 |
| 遮罩重复创建 | `buildMask()` 只跑一次，缓存离屏实例 |
| 大画布内存爆炸 | 单边物理像素 ≤ 4096，逻辑尺寸 ≤ 1365 |
| 反复 destination-in 边缘衰减 | 清除前先备份笔迹层 / 基于点集重放 |
| 重绘卡顿 | 静态层离屏预渲染，动态层只画增量 |
| 真机延迟黑屏 | `onReady` + `wx.nextTick` 后再绘制 |
| 缺口大的轮廓反复校验 | 结果缓存，轮廓变化时再重算 |

## 15. 边界情况 & 避坑

### 15.1 DPR 对齐

- 物理尺寸：`node.width = cssWidth * dpr`
- 上下文：`ctx.scale(dpr, dpr)`
- drawImage mask 用**逻辑尺寸**，不要再用物理尺寸

### 15.2 离屏 canvas 版本兼容

- `wx.createOffscreenCanvas({ type: '2d' })` 需要基础库 **2.16.1+**
- 低版本降级：用一个隐藏的 `canvas` 节点代替离屏

### 15.3 轮廓带孔洞

- `fill('evenodd')` 自动处理内外环
- 内孔路径方向须与外环相反

### 15.4 合成模式忘记还原

- 用完 `destination-in` 必须设回 `source-over`，否则后续 `stroke()` 异常

### 15.5 开放轮廓强行 fill 的后果

- 隐式用直线缝合缺口 → 产生"幽灵区域"
- 视觉和实际生效范围不一致 → 用户困惑
- **本方案通过校验 + 自动降级为 stroke mask 规避**

### 15.6 跨边界笔画

- `destination-in` 是像素级裁剪，跨边界笔迹会被切齐，无溢出
- 追求矢量精确切割需在线段层做交点裁剪（复杂，一般不必要）

## 16. 测试清单

- [ ] 闭合轮廓：清除后内部笔迹完整、外部消失
- [ ] 首尾小缝隙（<8px）：自动缝合，行为符合预期
- [ ] 首尾大缺口：自动降级为 stroke mask，或明确提示
- [ ] 多段独立开放线：stroke mask 正常覆盖各段
- [ ] 跨边界笔画：边缘干净无残影
- [ ] 连续点 5 次清除：边缘不糊、不闪
- [ ] 点太少 / 共线轮廓：不误删笔迹，给出提示
- [ ] 撤销清除：可恢复到清除前状态
- [ ] iOS & Android 真机 DPR=2/3 均不错位
- [ ] 导出图片：轮廓、生效区、笔迹三者对齐
- [ ] 大屏（iPad）不报 4096 尺寸错误
- [ ] 缺口提示虚线在正常轮廓下不出现

## 17. 方案总结

| 维度 | 本方案 |
|---|---|
| 实现复杂度 | 中（一次离屏遮罩 + 一次合成） |
| 性能 | 高（清除为 O(1) 像素操作，不重放点集） |
| 视觉效果 | 抗锯齿好，边缘柔和 |
| 开放轮廓 | ✅ 自动降级为 stroke mask |
| 缺口可视化 | ✅ 红色虚线提示未闭合处 |
| 退化保护 | ✅ 校验面积，避免误删全部笔迹 |
| 可撤销 | ✅ 点集 + 位图双备份 |
| 兼容性 | 2.16.1+ 完美，低版本可降级 |

> **核心思路**：笔迹单独一层 + 轮廓预生成 mask + `destination-in` 交集合成；
> 通过**轮廓语义识别**（闭合区域 / 线条围栏）+ **合法性校验** + **缺口可视化**，
> 把"开放轮廓"这一最容易出问题的边界情况彻底兜住。