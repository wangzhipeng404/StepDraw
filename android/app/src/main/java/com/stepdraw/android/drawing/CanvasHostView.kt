package com.stepdraw.android.drawing

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.PorterDuff
import android.util.AttributeSet
import android.view.Choreographer
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import com.stepdraw.android.viewmodel.DrawingViewModel
import kotlin.math.hypot

/**
 * 触摸手势采集 + 离屏渲染宿主（与 ipad/DrawingGestures.swift 的 CanvasHostView 同构）。
 *
 * 三层离屏位图（iPad 版四层的 pencil 层省略：Android 无 Pencil 悬停 API）：
 * - outline：图案引导 + 已完成步骤 + 当前动画笔画
 * - history：用户已完成笔画
 * - brush：正在画的一笔
 *
 * 模式：
 * - 绘制模式：单指落笔绘制；绘制中落下第二指 → 结束当前笔并转捏合
 * - 导航模式：单指拖拽平移，双指捏合缩放
 *
 * Choreographer 每帧调 ViewModel.tick()（先推进动画），再按指纹增量重建脏层位图并 blit。
 */
class CanvasHostView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0,
) : View(context, attrs, defStyleAttr) {

    var viewModel: DrawingViewModel? = null

    /** 每帧渲染后回调，供宿主同步播放进度/步骤等动态 UI */
    var onFrame: (() -> Unit)? = null

    // 三层离屏位图（层坐标空间，恒为"无视图变换"；视图变化只改 blit 变换）
    private var outlineBmp: Bitmap? = null
    private var historyBmp: Bitmap? = null
    private var brushBmp: Bitmap? = null
    private var bmpW = 0
    private var bmpH = 0

    // 各层位图内容指纹（内容/视图未变化则复用位图，避免每帧分配）
    private var outlineFp = ""
    private var historyFp = ""
    private var brushFp = ""

    // 手势状态机（判定逻辑与 ipad 的 DrawingGestureView 一致）
    private enum class Gesture { NONE, DRAW, PAN, PINCH }
    private var gesture = Gesture.NONE
    private val pointers = HashMap<Int, android.graphics.PointF>()   // pointerId -> 层坐标
    private var drawPointerId = -1
    private var lastPanX = 0f
    private var lastPanY = 0f
    private var lastPinchDist = 0f

    private val scaleDetector = ScaleGestureDetector(
        context,
        object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScale(detector: ScaleGestureDetector): Boolean {
                if (gesture != Gesture.PINCH) {
                    gesture = Gesture.PINCH
                    lastPinchDist = detector.currentSpan
                    return false
                }
                val anchorX = detector.focusX - width / 2f
                val anchorY = detector.focusY - height / 2f
                if (lastPinchDist > 0f) {
                    val factor = (detector.currentSpan / lastPinchDist).toFloat()
                    lastPinchDist = detector.currentSpan
                    viewModel?.pinch(factor, anchorX, anchorY)
                }
                return true
            }

            override fun onScaleBegin(detector: ScaleGestureDetector): Boolean = true
        }
    )

    private var frameCallback: Choreographer.FrameCallback? = null
    private var attached = false

    init {
        isFocusable = false
        // 不绘制背景：onDraw 里按透明色清屏，画布本身非不透明
        setWillNotDraw(false)
    }

    // MARK: 生命周期（视图离屏时停掉 Choreographer，避免泄漏）

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        attached = true
        if (frameCallback == null) {
            val cb = object : Choreographer.FrameCallback {
                override fun doFrame(frameTimeNanos: Long) {
                    viewModel?.tick()
                    rebuildLayers()
                    onFrame?.invoke()
                    if (attached) {
                        Choreographer.getInstance().postFrameCallback(this)
                    }
                }
            }
            frameCallback = cb
            Choreographer.getInstance().postFrameCallback(cb)
        }
    }

    override fun onDetachedFromWindow() {
        attached = false
        frameCallback?.let { Choreographer.getInstance().removeFrameCallback(it) }
        frameCallback = null
        recycleBitmaps()
        super.onDetachedFromWindow()
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        val engine = viewModel?.engine ?: return
        engine.layerWidth = w
        engine.layerHeight = h
        // Android View 的宽高本就是屏幕像素（不像 iOS 的 point），按原生分辨率渲染即可
        engine.renderScale = 1f
        engine.invalidateAll()
        engine.markAllDirty()
        bmpW = 0   // 尺寸变了 → 下帧重建位图
    }

    // MARK: 触摸处理（手势判定与 ipad classifyAfterChange / dispatchMove / dispatchEnd 同构）

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                pointers[event.getPointerId(0)] = android.graphics.PointF(event.x, event.y)
                scaleDetector.onTouchEvent(event)
                classifyAfterChange()
            }

            MotionEvent.ACTION_POINTER_DOWN -> {
                val idx = event.actionIndex
                pointers[event.getPointerId(idx)] =
                    android.graphics.PointF(event.getX(idx), event.getY(idx))
                scaleDetector.onTouchEvent(event)
                classifyAfterChange()
            }

            MotionEvent.ACTION_MOVE -> {
                for (i in 0 until event.pointerCount) {
                    val p = pointers[event.getPointerId(i)]
                    if (p != null) {
                        p.x = event.getX(i)
                        p.y = event.getY(i)
                    }
                }
                scaleDetector.onTouchEvent(event)
                dispatchMove()
            }

            MotionEvent.ACTION_POINTER_UP -> {
                pointers.remove(event.getPointerId(event.actionIndex))
                scaleDetector.onTouchEvent(event)
                dispatchEnd()
            }

            MotionEvent.ACTION_UP -> {
                pointers.remove(event.getPointerId(0))
                scaleDetector.onTouchEvent(event)
                dispatchEnd()
            }

            MotionEvent.ACTION_CANCEL -> {
                pointers.clear()
                dispatchEnd()
            }
        }
        return true
    }

    private fun classifyAfterChange() {
        if (pointers.isEmpty()) {
            if (gesture == Gesture.DRAW) viewModel?.endStroke()
            gesture = Gesture.NONE
            drawPointerId = -1
            return
        }

        if (pointers.size >= 2) {
            if (gesture == Gesture.DRAW) {
                // 绘制中落下第二指：结束当前笔，转捏合
                viewModel?.endStroke()
                drawPointerId = -1
            }
            if (lastPinchDist <= 0f) {
                val it = pointers.values.iterator()
                val a = it.next()
                val b = it.next()
                lastPinchDist = hypot((a.x - b.x).toDouble(), (a.y - b.y).toDouble()).toFloat()
            }
            gesture = Gesture.PINCH
            return
        }

        // 单指
        val entry = pointers.entries.first()
        if (gesture == Gesture.PINCH) {
            // 双指变单指：转平移
            gesture = Gesture.PAN
            lastPanX = entry.value.x
            lastPanY = entry.value.y
            return
        }
        if (viewModel?.drawingMode == true) {
            if (gesture != Gesture.DRAW) {
                gesture = Gesture.DRAW
                drawPointerId = entry.key
                viewModel?.beginStroke(entry.value.x, entry.value.y)
            }
        } else {
            if (gesture != Gesture.PAN) {
                gesture = Gesture.PAN
                lastPanX = entry.value.x
                lastPanY = entry.value.y
            }
        }
    }

    private fun dispatchMove() {
        if (gesture == Gesture.PINCH) return   // 缩放由 ScaleGestureDetector 处理
        val entry = pointers.entries.firstOrNull() ?: return
        when (gesture) {
            Gesture.PAN -> {
                val p = entry.value
                val dx = p.x - lastPanX
                val dy = p.y - lastPanY
                lastPanX = p.x
                lastPanY = p.y
                if (dx != 0f || dy != 0f) viewModel?.pan(dx, dy)
            }

            Gesture.DRAW -> {
                if (entry.key == drawPointerId) {
                    viewModel?.extendStroke(entry.value.x, entry.value.y)
                }
            }

            Gesture.NONE -> {}
            Gesture.PINCH -> {}
        }
    }

    private fun dispatchEnd() {
        if (gesture == Gesture.PINCH) {
            if (pointers.size == 1) {
                gesture = Gesture.PAN
                lastPinchDist = 0f
                val p = pointers.values.first()
                lastPanX = p.x
                lastPanY = p.y
            } else {
                gesture = Gesture.NONE
                lastPinchDist = 0f
            }
            return
        }

        if (gesture == Gesture.DRAW) {
            val stillThere = pointers.containsKey(drawPointerId)
            if (!stillThere) {
                viewModel?.endStroke()
                gesture = Gesture.NONE
                drawPointerId = -1
            }
            return
        }

        if (gesture == Gesture.PAN && pointers.isEmpty()) {
            gesture = Gesture.NONE
        }
    }

    // MARK: 渲染（每帧：先 tick 推进状态，再按指纹重建脏层位图；onDraw 里 blit 三层）

    private fun rebuildLayers() {
        val engine = viewModel?.engine ?: return
        if (width <= 0 || height <= 0) return
        if (bmpW != width || bmpH != height) {
            // 尺寸变化 → 重建三层位图
            recycleBitmaps()
            val w = width
            val h = height
            bmpW = w
            bmpH = h
            outlineBmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            historyBmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            brushBmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            outlineFp = ""
            historyFp = ""
            brushFp = ""
        }

        // outline 层（视图变化只影响 blit，这里指纹不含 view，避免每次缩放都重绘全层）
        val fpOutline = "o|${engine.drawingID}|${engine.currentStep}|${engine.stepProgress}|${if (engine.showGuide) 1 else 0}"
        if (fpOutline != outlineFp) {
            val cv = Canvas(outlineBmp!!)
            engine.drawOutline(cv)
            outlineFp = fpOutline
        }

        // history 层
        val fpHistory = "h|${engine.drawingID}|${engine.userStrokes.size}|${engine.contentVersion}"
        if (fpHistory != historyFp) {
            val cv = Canvas(historyBmp!!)
            engine.drawHistory(cv)
            historyFp = fpHistory
        }

        // brush 层
        val live = engine.liveStroke
        val fpBrush = "b|${if (live == null) 0 else live.points.size}"
        if (fpBrush != brushFp) {
            val cv = Canvas(brushBmp!!)
            engine.drawBrush(cv)
            brushFp = fpBrush
        }

        // 位图就绪，请求重绘（blit 在 onDraw 里做）
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val engine = viewModel?.engine ?: return
        val v = engine.view
        canvas.drawColor(Color.TRANSPARENT, PorterDuff.Mode.CLEAR)
        blitLayer(canvas, outlineBmp, v)
        blitLayer(canvas, historyBmp, v)
        blitLayer(canvas, brushBmp, v)
    }

    /** 与 ipad LayerCache.blit 同公式：p' = s*(p-c)+c+t（以画布中心为缩放中心） */
    private fun blitLayer(cv: Canvas, bmp: Bitmap?, v: com.stepdraw.android.data.ViewTransform) {
        if (bmp == null) return
        val cx = width / 2f
        val cy = height / 2f
        cv.save()
        cv.translate(cx + v.tx, cy + v.ty)
        cv.scale(v.scale, v.scale)
        cv.translate(-cx, -cy)
        cv.drawBitmap(bmp, 0f, 0f, null)
        cv.restore()
    }

    private fun recycleBitmaps() {
        outlineBmp?.recycle(); outlineBmp = null
        historyBmp?.recycle(); historyBmp = null
        brushBmp?.recycle(); brushBmp = null
        bmpW = 0
        bmpH = 0
    }
}
