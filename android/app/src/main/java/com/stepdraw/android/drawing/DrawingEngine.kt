package com.stepdraw.android.drawing

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PointF
import android.graphics.RectF
import com.stepdraw.android.data.BrushKind
import com.stepdraw.android.data.Drawing
import com.stepdraw.android.data.StrokeJSON
import com.stepdraw.android.data.UserStroke
import com.stepdraw.android.data.Size
import com.stepdraw.android.data.ViewTransform
import com.stepdraw.android.data.FitTransform
import com.stepdraw.android.data.fitTransform
import com.stepdraw.android.data.strokeLength
import kotlin.math.min

// ============================================================
// 路径构建（与 ipad/DrawingEngine.swift 的 addSmoothPath / addStrokePath 同构）
// ============================================================

/** 中点法平滑折线（二次贝塞尔） */
private fun Path.appendSmooth(pts: List<PointF>) {
    if (pts.isEmpty()) return
    moveTo(pts[0].x, pts[0].y)
    if (pts.size < 3) {
        for (i in 1 until pts.size) lineTo(pts[i].x, pts[i].y)
        return
    }
    for (i in 1 until pts.size - 1) {
        val c = pts[i]
        val n = pts[i + 1]
        val midX = (c.x + n.x) / 2f
        val midY = (c.y + n.y) / 2f
        quadTo(c.x, c.y, midX, midY)
    }
    val last = pts[pts.size - 1]
    lineTo(last.x, last.y)
}

/** 普通折线 */
private fun Path.appendPlain(pts: List<PointF>) {
    if (pts.isEmpty()) return
    moveTo(pts[0].x, pts[0].y)
    for (i in 1 until pts.size) lineTo(pts[i].x, pts[i].y)
}

/** 画一条图案笔画，progress < 1 时按弧长截断（"笔画生长"动画用） */
private fun Path.appendStrokeWithProgress(pts: List<PointF>, progress: Float) {
    if (pts.size < 2) return
    if (progress >= 1f) {
        appendSmooth(pts)
        return
    }
    val total = strokeLength(pts)
    if (total <= 0f) {
        appendSmooth(pts)
        return
    }
    val target = progress * total
    var accumulated = 0f
    var cutIndex = pts.size - 1
    var cutFrac = 1f
    for (i in 1 until pts.size) {
        val seg = hypotF(pts[i], pts[i - 1])
        if (accumulated + seg >= target) {
            cutIndex = i
            cutFrac = if (seg > 0f) (target - accumulated) / seg else 0f
            break
        }
        accumulated += seg
    }
    val a = pts[cutIndex - 1]
    val b = pts[cutIndex]
    val cutPoint = PointF(a.x + (b.x - a.x) * cutFrac, a.y + (b.y - a.y) * cutFrac)
    appendSmooth(pts.subList(0, cutIndex) + cutPoint)
}

private fun hypotF(a: PointF, b: PointF): Float =
    kotlin.math.hypot((a.x - b.x).toDouble(), (a.y - b.y).toDouble()).toFloat()

// ============================================================
// 画笔渲染（与 web 端 renderUserStroke 同构，内容坐标系）
// ============================================================

/** 画一条用户笔画（上下文需已应用「适配+视图」变换） */
fun renderUserStroke(canvas: Canvas, stroke: UserStroke, paint: Paint) {
    val pts = stroke.points
    if (pts.isEmpty()) return
    paint.color = stroke.color
    paint.strokeCap = Paint.Cap.ROUND
    paint.strokeJoin = Paint.Join.ROUND
    paint.alpha = 255

    if (pts.size == 1) {
        val p = pts[0]
        val r = stroke.width / 2f
        when (stroke.kind) {
            BrushKind.PEN -> canvas.drawCircle(p.x, p.y, r, paint)
            BrushKind.PENCIL -> {
                paint.alpha = 204
                canvas.drawCircle(p.x, p.y, r, paint)
            }
            BrushKind.MARKER -> {
                paint.alpha = 102
                canvas.drawOval(RectF(p.x - r * 1.5f, p.y - r, p.x + r * 1.5f, p.y + r), paint)
            }
            BrushKind.BRUSH -> {
                paint.alpha = 153
                canvas.drawCircle(p.x, p.y, r, paint)
            }
        }
        paint.alpha = 255
        return
    }

    val path = Path()
    when (stroke.kind) {
        BrushKind.PEN -> {
            paint.style = Paint.Style.STROKE
            paint.strokeWidth = stroke.width
            path.appendSmooth(pts)
            canvas.drawPath(path, paint)
        }
        BrushKind.PENCIL -> {
            paint.style = Paint.Style.STROKE
            paint.strokeWidth = stroke.width
            paint.alpha = 178   // 0.7
            paint.pathEffect = DashPathEffectCompat(stroke.width, stroke.width / 2f)
            path.appendPlain(pts)
            canvas.drawPath(path, paint)
            paint.pathEffect = null
        }
        BrushKind.MARKER -> {
            paint.style = Paint.Style.STROKE
            paint.strokeWidth = stroke.width * 2f
            paint.alpha = 102   // 0.4
            path.appendSmooth(pts)
            canvas.drawPath(path, paint)
        }
        BrushKind.BRUSH -> {
            paint.style = Paint.Style.STROKE
            paint.strokeWidth = stroke.width * 1.5f
            paint.alpha = 153   // 0.6
            path.appendSmooth(pts)
            canvas.drawPath(path, paint)
        }
    }
    paint.alpha = 255
}

/**
 * 铅笔虚线效果。iPad 端用 [width, width/2]（on, off）。
 * 注意：width 是 on 长度，interval 是周期 = on + off，所以 off = interval - on。
 */
private fun DashPathEffectCompat(on: Float, off: Float) =
    android.graphics.DashPathEffect(floatArrayOf(on, off), 0f)

// ============================================================
// 离屏缓存（层坐标空间，恒为"无视图变换"）
// ============================================================

/**
 * 一张离屏位图 + 其 Canvas。
 * 生成一次后固化 bitmap，blit 时复用（避免每帧重复分配大位图）。
 */
class LayerCache(val width: Int, val height: Int, scale: Float) {
    val bitmap: Bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    val canvas: Canvas = Canvas(bitmap).apply { scale(scale, scale) }

    /** 把位图按视图变换画到目标画布（与 web 端 applyViewTransform 同公式：p' = s*(p-c)+c+t） */
    fun blit(into: Canvas, view: ViewTransform, sizeW: Float, sizeH: Float) {
        val cx = sizeW / 2f
        val cy = sizeH / 2f
        val s = view.scale
        into.save()
        into.translate(cx + view.tx, cy + view.ty)
        into.scale(s, s)
        into.translate(-cx, -cy)
        into.drawBitmap(bitmap, 0f, 0f, null)
        into.restore()
    }
}

// ============================================================
// 绘制引擎
// ============================================================

/**
 * 四层渲染（与 ipad/DrawingEngine.swift 同构）：
 * - outline：图案引导（全轮廓淡显）+ 已完成步骤 + 当前动画笔画（仅在加载图案时）
 * - history：用户已完成笔画
 * - brush：正在画的一笔
 * - pencil：笔尖预览（层坐标，固定尺寸）
 *
 * 支持"无图案自由绘制"：此时 outline 层为空白，用户笔迹用恒等适配（内容坐标=层坐标）。
 * 每帧由 CanvasHostView 调 render()。
 *
 * 缓存（都在"无视图变换"层空间；尺寸/内容变化才重建，视图变化只改 blit 变换）。
 */
class DrawingEngine {

    var layerWidth = 0
    var layerHeight = 0
    var renderScale = 1f

    // 图案播放状态（可空 = 自由绘制模式）
    var drawing: Drawing? = null
    var drawingID: String = ""
    var currentStep: Int = 0
    var stepProgress: Float = 0f
    var showGuide: Boolean = true
    var view: ViewTransform = ViewTransform.IDENTITY

    // 用户绘制
    var userStrokes: MutableList<UserStroke> = mutableListOf()
    var liveStroke: UserStroke? = null

    // 缓存
    private var guideCache: LayerCache? = null
    private var guideKey: String = ""
    private var doneCache: LayerCache? = null
    private var doneKey: String = ""
    private var userCache: LayerCache? = null
    private var userCacheKey: String = ""
    /** 用户内容变化计数（增/删/清） */
    var contentVersion: Int = 0

    // 脏标记：只有输入变化的层才重建位图（避免每帧 4 次全分辨率分配）
    private var outlineDirty = true
    private var historyDirty = true
    private var brushDirty = true
    private var lastView: ViewTransform? = null
    private var lastBrushFingerprint: String? = null

    private val outlinePaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val patternPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val userPaint = Paint(Paint.ANTI_ALIAS_FLAG)

    private val guideStroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
        color = Color.parseColor("#333333")
        alpha = 38  // 0.15 * 255
    }
    private val doneStroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
        color = Color.BLACK
    }
    private val highlightStroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
        color = Color.parseColor("#E53935")
    }

    // MARK: 内容空间适配（有图案=按 viewBox，无图案=恒等）

    fun currentFit(sizeW: Float, sizeH: Float): FitTransform {
        val d = drawing ?: return FitTransform(1f, 0f, 0f)
        return fitTransform(Size(sizeW.toInt(), sizeH.toInt()), d)
    }

    // MARK: 每帧渲染

    /**
     * 渲染四层。[drawOutline] / [drawHistory] / [drawBrush] 分别把内容画进给定画布
     * （宿主 View 的四层各自传入自己的 Canvas），pencil 画在 brush 之上（同一画布）。
     */
    fun render() {
        val w = layerWidth
        val h = layerHeight
        if (w <= 0 || h <= 0) return

        val fit = currentFit(w.toFloat(), h.toFloat())

        // 图案相关缓存（无图案时清空）
        val d = drawing
        if (d != null && d.steps.isNotEmpty()) {
            if (refreshGuideCache(d)) outlineDirty = true
            if (refreshDoneCache(d)) outlineDirty = true
        } else {
            if (guideCache != null || doneCache != null) {
                guideCache = null; guideKey = ""
                doneCache = null; doneKey = ""
                outlineDirty = true
            }
        }

        // 用户笔迹缓存（始终）
        if (refreshUserCache(fit)) historyDirty = true

        // 视图变化：四层都需重新 blit
        if (lastView != view) {
            lastView = view
            outlineDirty = true
            historyDirty = true
            brushDirty = true
            lastBrushFingerprint = null
        }
    }

    // MARK: 脏标记入口

    fun markPlayingStateDirty() { outlineDirty = true }
    fun markContentDirty() { historyDirty = true; brushDirty = true }
    fun markAllDirty() {
        outlineDirty = true
        historyDirty = true
        brushDirty = true
        lastBrushFingerprint = null
    }
    fun invalidateAll() {
        guideKey = ""
        doneKey = ""
        userCacheKey = ""
    }

    // MARK: 缓存刷新（key 变化时重建，返回是否重建）

    private fun refreshGuideCache(drawing: Drawing): Boolean {
        val key = "$drawingID|${layerWidth}x${layerHeight}|${if (showGuide) 1 else 0}"
        if (key == guideKey) return false
        guideKey = key
        if (!showGuide) {
            guideCache = null
            return true
        }
        val fit = fitTransform(Size(layerWidth, layerHeight), drawing)
        val cache = newCache() ?: return true
        cache.canvas.save()
        applyContentTransform(cache.canvas, fit, ViewTransform.IDENTITY)
        for (step in drawing.steps) {
            for (stroke in step.strokes) {
                guideStroke.strokeWidth = stroke.width.toFloat()
                val pts = stroke.cgPoints
                if (pts.size >= 2) {
                    val p = Path().apply { appendSmooth(pts) }
                    cache.canvas.drawPath(p, guideStroke)
                }
            }
        }
        cache.canvas.restore()
        guideCache = cache
        return true
    }

    private fun refreshDoneCache(drawing: Drawing): Boolean {
        val key = "$drawingID|${layerWidth}x${layerHeight}|$currentStep"
        if (key == doneKey) return false
        doneKey = key
        val fit = fitTransform(Size(layerWidth, layerHeight), drawing)
        val cache = newCache() ?: return true
        cache.canvas.save()
        applyContentTransform(cache.canvas, fit, ViewTransform.IDENTITY)
        val upTo = min(currentStep, drawing.steps.size)
        for (i in 0 until upTo) {
            for (stroke in drawing.steps[i].strokes) {
                doneStroke.strokeWidth = stroke.width.toFloat()
                val pts = stroke.cgPoints
                if (pts.size >= 2) {
                    val p = Path().apply { appendSmooth(pts) }
                    cache.canvas.drawPath(p, doneStroke)
                }
            }
        }
        cache.canvas.restore()
        doneCache = cache
        return true
    }

    private fun refreshUserCache(fit: FitTransform): Boolean {
        val key = "$drawingID|${layerWidth}x${layerHeight}|${userStrokes.size}|$contentVersion"
        if (key == userCacheKey) return false
        userCacheKey = key
        if (userStrokes.isEmpty()) {
            userCache = null
            return true
        }
        val cache = newCache() ?: return true
        cache.canvas.save()
        applyContentTransform(cache.canvas, fit, ViewTransform.IDENTITY)
        for (stroke in userStrokes) {
            renderUserStroke(cache.canvas, stroke, userPaint)
        }
        cache.canvas.restore()
        userCache = cache
        return true
    }

    private fun newCache(): LayerCache? {
        val bw = (layerWidth * renderScale).toInt()
        val bh = (layerHeight * renderScale).toInt()
        if (bw <= 0 || bh <= 0) return null
        return LayerCache(bw, bh, renderScale)
    }

    // MARK: 各层绘制（画布需已按 renderScale 缩放）

    /** 内容坐标 -> 层坐标 的变换应用到画布上（适配 + 视图） */
    private fun applyContentTransform(canvas: Canvas, fit: FitTransform, view: ViewTransform) {
        val cx = layerWidth / 2f
        val cy = layerHeight / 2f
        val s = view.scale
        val tx = s * fit.offsetX + view.tx + cx * (1f - s)
        val ty = s * fit.offsetY + view.ty + cy * (1f - s)
        canvas.concat(
            android.graphics.Matrix().apply {
                setScale(s * fit.scale, s * fit.scale)
                postTranslate(tx, ty)
            }
        )
    }

    /** 画 outline 层：引导 + 已完成 + 当前动画笔画 */
    fun drawOutline(canvas: Canvas) {
        val d = drawing
        outlinePaint.color = Color.WHITE
        canvas.drawRect(0f, 0f, layerWidth.toFloat(), layerHeight.toFloat(), outlinePaint)
        if (d == null) return

        val fit = currentFit(layerWidth.toFloat(), layerHeight.toFloat())
        val v = view
        guideCache?.blit(canvas, v, layerWidth.toFloat(), layerHeight.toFloat())
        doneCache?.blit(canvas, v, layerWidth.toFloat(), layerHeight.toFloat())
        // 当前步骤动画部分（内容坐标 + 视图变换直接画）
        canvas.save()
        applyContentTransform(canvas, fit, v)
        renderCurrentStep(canvas, d)
        canvas.restore()
    }

    /** 画 history 层：用户已完成笔画 */
    fun drawHistory(canvas: Canvas) {
        canvas.drawColor(Color.TRANSPARENT, android.graphics.PorterDuff.Mode.CLEAR)
        userCache?.blit(canvas, view, layerWidth.toFloat(), layerHeight.toFloat())
    }

    /** 画 brush 层：正在画的一笔 + pencil 笔尖预览 */
    fun drawBrush(canvas: Canvas) {
        canvas.drawColor(Color.TRANSPARENT, android.graphics.PorterDuff.Mode.CLEAR)
        val live = liveStroke ?: return
        val fit = currentFit(layerWidth.toFloat(), layerHeight.toFloat())
        canvas.save()
        applyContentTransform(canvas, fit, view)
        renderUserStroke(canvas, live, userPaint)
        canvas.restore()
    }

    // MARK: 当前步骤动画

    private fun renderCurrentStep(canvas: Canvas, drawing: Drawing) {
        if (currentStep >= drawing.steps.size) return
        val strokes = drawing.steps[currentStep].strokes
        if (strokes.isEmpty()) return

        if (stepProgress >= 1f) {
            for (stroke in strokes) drawFullStroke(canvas, stroke)
            return
        }

        val lengths = strokes.map { strokeLength(it.cgPoints) }
        val total = lengths.sum()
        val highlight = highlightStroke

        if (total == 0f) {
            val per = stepProgress * strokes.size
            val done = per.toInt()
            for (i in 0 until min(done, strokes.size)) drawFullStroke(canvas, strokes[i])
            if (done < strokes.size) {
                highlightStroke.strokeWidth = strokes[done].width.toFloat()
                drawPartialStroke(canvas, strokes[done], (per - done).toFloat(), highlight)
            }
        } else {
            val target = stepProgress * total
            var acc = 0f
            for (i in lengths.indices) {
                val len = lengths[i]
                if (acc + len >= target) {
                    for (j in 0 until i) drawFullStroke(canvas, strokes[j])
                    val prog = if (len > 0f) (target - acc) / len else 1f
                    highlightStroke.strokeWidth = strokes[i].width.toFloat()
                    drawPartialStroke(canvas, strokes[i], prog, highlight)
                    return
                }
                acc += len
            }
            for (stroke in strokes) drawFullStroke(canvas, stroke)
        }
    }

    private fun drawFullStroke(canvas: Canvas, stroke: StrokeJSON) {
        doneStroke.strokeWidth = stroke.width.toFloat()
        val pts = stroke.cgPoints
        if (pts.size < 2) return
        val p = Path().apply { appendSmooth(pts) }
        canvas.drawPath(p, doneStroke)
    }

    private fun drawPartialStroke(canvas: Canvas, stroke: StrokeJSON, progress: Float, paint: Paint) {
        paint.strokeWidth = stroke.width.toFloat()
        val pts = stroke.cgPoints
        if (pts.size < 2) return
        val p = Path().apply { appendStrokeWithProgress(pts, progress) }
        canvas.drawPath(p, paint)
    }

    // MARK: 导出（原始视图，不受当前缩放/平移影响）

    /**
     * 合成完整作品：有图案时含全步骤+引导（若开），外加用户笔迹；无图案时仅用户笔迹。
     * 返回 3x 分辨率 Bitmap。
     */
    fun exportBitmap(): Bitmap? {
        val sizeW = if (layerWidth == 0) 800 else layerWidth
        val sizeH = if (layerHeight == 0) 800 else layerHeight
        val scale = 3f
        val w = (sizeW * scale).toInt()
        val h = (sizeH * scale).toInt()
        if (w <= 0 || h <= 0) return null
        val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap).apply { scale(scale, scale) }
        outlinePaint.color = Color.WHITE
        canvas.drawRect(0f, 0f, sizeW.toFloat(), sizeH.toFloat(), outlinePaint)

        // 临时切到导出尺寸计算 fit
        val savedW = layerWidth; val savedH = layerHeight
        layerWidth = sizeW.toInt(); layerHeight = sizeH.toInt()
        val fit = currentFit(sizeW.toFloat(), sizeH.toFloat())

        val d = drawing
        if (d != null) {
            // 引导层（导出时若开启则带上）
            if (showGuide) {
                val gPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                    style = Paint.Style.STROKE
                    strokeCap = Paint.Cap.ROUND
                    strokeJoin = Paint.Join.ROUND
                    color = Color.parseColor("#333333")
                    alpha = 38
                }
                canvas.save()
                applyContentTransform(canvas, fit, ViewTransform.IDENTITY)
                for (step in d.steps) {
                    for (stroke in step.strokes) {
                        gPaint.strokeWidth = stroke.width.toFloat()
                        val pts = stroke.cgPoints
                        if (pts.size >= 2) {
                            val p = Path().apply { appendSmooth(pts) }
                            canvas.drawPath(p, gPaint)
                        }
                    }
                }
                canvas.restore()
            }
            // 全部步骤（合成完整作品，而非当前播放进度）
            canvas.save()
            applyContentTransform(canvas, fit, ViewTransform.IDENTITY)
            for (i in d.steps.indices) {
                for (stroke in d.steps[i].strokes) {
                    doneStroke.strokeWidth = stroke.width.toFloat()
                    val pts = stroke.cgPoints
                    if (pts.size >= 2) {
                        val p = Path().apply { appendSmooth(pts) }
                        canvas.drawPath(p, doneStroke)
                    }
                }
            }
            canvas.restore()
        }

        // 用户笔迹（始终）
        if (userStrokes.isNotEmpty()) {
            canvas.save()
            applyContentTransform(canvas, fit, ViewTransform.IDENTITY)
            for (stroke in userStrokes) {
                renderUserStroke(canvas, stroke, userPaint)
            }
            canvas.restore()
        }

        layerWidth = savedW
        layerHeight = savedH
        return bitmap
    }
}
