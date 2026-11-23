package com.stepdraw.android.viewmodel

import android.app.Activity
import android.graphics.Color
import android.graphics.PointF
import android.os.Handler
import android.os.Looper
import com.stepdraw.android.data.BrushKind
import com.stepdraw.android.data.DataStore
import com.stepdraw.android.data.Drawing
import com.stepdraw.android.data.DrawingItem
import com.stepdraw.android.data.Size
import com.stepdraw.android.data.UserStroke
import com.stepdraw.android.data.ViewTransform
import com.stepdraw.android.data.clampScale
import com.stepdraw.android.data.toImagePoint
import com.stepdraw.android.data.strokeLength
import com.stepdraw.android.drawing.DrawingEngine
import java.io.File
import java.io.FileOutputStream
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlin.math.abs

/**
 * 主界面状态：播放 + 绘制 + 视图 + 数据，全部集中在这里（与 ipad/DrawingViewModel.swift 同构）。
 * CanvasHostView 每帧调 tick()：推进动画 → 引擎渲染。
 */
class DrawingViewModel(private val activity: Activity) {

    // MARK: 引擎

    val engine = DrawingEngine()

    // MARK: 数据

    @Volatile var drawing: Drawing? = null
    @Volatile var categoryId: String = ""
    @Volatile var loadingDrawing: Boolean = false
    @Volatile var loadError: String? = null

    // MARK: 播放状态

    var currentStep: Int = 0
    var stepProgress: Float = 0f
    var playing: Boolean = false
    var speed: Float = 1f          // 0.5 / 1 / 2
    var showGuide: Boolean = true

    // MARK: 绘制状态

    var drawingMode: Boolean = true      // 默认进入绘制模式
    var brushKind: BrushKind = BrushKind.PEN
    var brushColor: Int = Color.BLACK
    var brushWidth: Float = 4f          // 内容坐标系线宽
    @Volatile var canUndo: Boolean = false

    // MARK: 视图变换

    var view: ViewTransform = ViewTransform.IDENTITY
    @Volatile var showScaleIndicator: Boolean = false
    private val mainHandler = Handler(Looper.getMainLooper())
    private var scaleIndicatorRunnable: Runnable? = null

    // MARK: 播放进度（进度条按需读取）

    @Volatile var progressSliderValue: Float = 0f
    @Volatile var sliderEditing: Boolean = false

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    init {
        engine.showGuide = showGuide
    }

    // MARK: - 初始化与加载

    fun loadDrawing(categoryId: String, item: DrawingItem) {
        this.categoryId = categoryId
        loadingDrawing = true
        loadError = null
        resetCanvasState()
        scope.launch {
            try {
                val d = DataStore.getInstance().loadDrawing(categoryId, item.id)
                this@DrawingViewModel.drawing = d
                engine.drawing = d
                lastSyncedPlayingState = null
            } catch (e: Exception) {
                loadError = "图案加载失败，请重试"
            }
            loadingDrawing = false
        }
    }

    /** 换一个图案时重置画布内容（不重置视图） */
    private fun resetCanvasState() {
        currentStep = 0
        stepProgress = 0f
        playing = false
        progressSliderValue = 0f
        engine.userStrokes.clear()
        engine.liveStroke = null
        engine.contentVersion += 1
        canUndo = false
        view = ViewTransform.IDENTITY
    }

    // MARK: - 每帧推进

    /// 播放状态快照（用于按需置脏 outline 层）
    private class Snap(val id: String, val step: Int, val progress: Float, val guide: Boolean)

    private var lastSyncedPlayingState: Snap? = null

    fun tick() {
        // 视图变换始终同步（自由绘制下平移/缩放也依赖它）
        engine.view = view

        val d = drawing
        if (d == null) {
            // 自由绘制模式：无图案，outline 层留空
            engine.drawing = null
            engine.drawingID = ""
            engine.render()
            return
        }
        // 同步播放状态到引擎
        engine.drawing = d
        engine.drawingID = d.id
        engine.currentStep = currentStep
        engine.stepProgress = stepProgress
        engine.showGuide = showGuide

        val snap = Snap(d.id, currentStep, stepProgress, showGuide)
        val last = lastSyncedPlayingState
        if (last == null || last.id != snap.id || last.step != snap.step ||
            last.progress != snap.progress || last.guide != snap.guide
        ) {
            engine.markPlayingStateDirty()
            lastSyncedPlayingState = snap
        }

        if (playing) {
            advanceAnimation()
            engine.markPlayingStateDirty()
        }

        engine.render()
        if (!sliderEditing) {
            progressSliderValue = globalProgress()
        }
    }

    val totalSteps: Int
        get() = drawing?.steps?.size ?: 0

    /** 全局进度（0~1，按步数均分，与 web 端 getGlobalProgress 一致） */
    fun globalProgress(): Float {
        val n = totalSteps
        if (n == 0) return 0f
        return (currentStep + stepProgress) / n
    }

    // 动画：基础速度每秒 100 内容像素（按当前步长度换算为进度增量）
    private fun advanceAnimation() {
        val d = drawing
        if (d == null || currentStep >= d.steps.size) {
            playing = false
            return
        }
        val step = d.steps[currentStep]
        var stepLength = 0f
        for (s in step.strokes) stepLength += strokeLength(s.cgPoints)
        if (stepLength <= 0f) {
            // 零长度步骤：直接跳到下一步
            if (currentStep < totalSteps - 1) {
                currentStep += 1
                stepProgress = 0f
            } else {
                playing = false
            }
            return
        }

        // 每帧约 16.6ms；用固定 dt 近似（Choreographer 频率稳定）
        val dt = 1.0 / 60.0
        val pixels = 100.0 * dt * speed
        stepProgress += (pixels / stepLength).toFloat()

        if (stepProgress >= 1f) {
            if (currentStep < totalSteps - 1) {
                currentStep += 1
                stepProgress = 0f
            } else {
                stepProgress = 1f
                playing = false
            }
        }
    }

    // MARK: - 播放控制

    fun togglePlay() {
        if (playing) {
            playing = false
            return
        }
        // 已播完则从头开始
        if (currentStep == totalSteps - 1 && stepProgress >= 1f) {
            currentStep = 0
            stepProgress = 0f
        }
        playing = true
    }

    fun prevStep() {
        if (stepProgress > 0.02f) {
            stepProgress = 0f
        } else if (currentStep > 0) {
            currentStep -= 1
            stepProgress = 0f
        }
    }

    fun nextStep() {
        if (stepProgress < 1f) {
            stepProgress = 1f
        } else if (currentStep < totalSteps - 1) {
            currentStep += 1
            stepProgress = 0f
        }
    }

    fun replay() {
        currentStep = 0
        stepProgress = 0f
        playing = true
    }

    fun cycleSpeed() {
        val speeds = floatArrayOf(0.5f, 1f, 2f)
        var i = -1
        for (k in speeds.indices) {
            if (speeds[k] == speed) { i = k; break }
        }
        if (i < 0) i = 1
        speed = speeds[(i + 1) % speeds.size]
    }

    fun toggleGuide() {
        showGuide = !showGuide
    }

    /** 切换 绘制/移动 模式。从绘制切走时先收尾当前笔画，避免残留半笔。 */
    fun toggleDrawMode() {
        if (drawingMode) {
            endStroke()          // 此时仍是绘制模式，能正常收尾
        }
        drawingMode = !drawingMode
    }

    /** 拖动进度条（暂停播放） */
    fun setGlobalProgress(value: Float) {
        playing = false
        val n = totalSteps
        if (n == 0) return
        val f = value * n
        val step = minOf(f.toInt(), n - 1)
        currentStep = step
        stepProgress = (f - step).toFloat()
        progressSliderValue = value
    }

    /**
     * 清除图案，回到空白画布。
     * 用户笔迹存的是图案内容坐标，与空白画布的坐标空间不同，必须一并清除。
     */
    fun removePattern() {
        drawing = null
        categoryId = ""
        lastSyncedPlayingState = null
        resetCanvasState()
        showToast("已回到空白画布")
    }

    // MARK: - 视图（平移 / 缩放 / 复位）

    fun pan(deltaX: Float, deltaY: Float) {
        view = ViewTransform(view.scale, view.tx + deltaX, view.ty + deltaY)
        flashScale()
    }

    /** 以锚点（相对画布中心，层坐标）缩放 */
    fun pinch(factor: Float, anchorX: Float, anchorY: Float) {
        val newScale = clampScale(view.scale * factor)
        val applied = newScale / view.scale
        if (abs(applied - 1f) < 0.0001f) return
        view = ViewTransform(
            scale = newScale,
            tx = anchorX - applied * (anchorX - view.tx),
            ty = anchorY - applied * (anchorY - view.ty),
        )
        flashScale()
    }

    fun resetView() {
        view = ViewTransform.IDENTITY
        flashScale()
    }

    private fun flashScale() {
        showScaleIndicator = true
        scaleIndicatorRunnable?.let { mainHandler.removeCallbacks(it) }
        val r = Runnable {
            showScaleIndicator = false
        }
        scaleIndicatorRunnable = r
        mainHandler.postDelayed(r, 800)
    }

    // MARK: - 用户绘制

    private val livePoints = mutableListOf<PointF>()
    private var liveActive = false

    /** 层坐标 -> 内容坐标（有图案按 viewBox 适配，无图案恒等=层坐标） */
    private fun contentPoint(layerX: Float, layerY: Float): PointF {
        val w = if (engine.layerWidth == 0) 800 else engine.layerWidth
        val h = if (engine.layerHeight == 0) 800 else engine.layerHeight
        val fit = engine.currentFit(w.toFloat(), h.toFloat())
        return toImagePoint(
            PointF(layerX, layerY),
            Size(w, h),
            fit,
            view,
        )
    }

    fun beginStroke(layerX: Float, layerY: Float) {
        if (!drawingMode) return
        liveActive = true
        livePoints.clear()
        livePoints.add(contentPoint(layerX, layerY))
        engine.liveStroke = UserStroke(
            points = livePoints,
            width = brushWidth,
            color = brushColor,
            kind = brushKind,
        )
        engine.markContentDirty()
    }

    fun extendStroke(layerX: Float, layerY: Float) {
        if (!drawingMode || !liveActive) return
        val p = contentPoint(layerX, layerY)
        // 距离过近的点丢弃，减少数据量
        val last = livePoints.lastOrNull()
        if (last != null) {
            val dx = p.x - last.x
            val dy = p.y - last.y
            if (kotlin.math.sqrt((dx * dx + dy * dy).toDouble()) < 0.5) return
        }
        livePoints.add(p)
        engine.markContentDirty()
    }

    fun endStroke() {
        if (!drawingMode || !liveActive) return
        liveActive = false
        val stroke = engine.liveStroke
        engine.liveStroke = null
        if (stroke != null && stroke.points.isNotEmpty()) {
            engine.userStrokes.add(stroke)
            canUndo = true
        }
        engine.contentVersion += 1
        engine.markContentDirty()
    }

    fun undo() {
        val last = engine.userStrokes.removeLastOrNull()
        if (last != null) {
            engine.contentVersion += 1
            engine.markContentDirty()
            canUndo = engine.userStrokes.isNotEmpty()
        }
    }

    fun clearAll() {
        engine.userStrokes.clear()
        engine.liveStroke = null
        liveActive = false
        livePoints.clear()
        engine.contentVersion += 1
        engine.markContentDirty()
        canUndo = false
        showToast("已清空画布")
    }

    // MARK: - 保存 / 分享

    fun saveToPhotos() {
        if (engine.userStrokes.isEmpty() && engine.liveStroke == null) {
            showToast("画布上还没有内容")
            return
        }
        val img = engine.exportBitmap() ?: run {
            showToast("保存失败")
            return
        }
        val file = File(
            activity.getExternalFilesDir(null),
            "StepDraw_" + System.currentTimeMillis() + ".png"
        )
        try {
            FileOutputStream(file).use { img.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
            // 通知媒体库
            try {
                android.media.MediaScannerConnection.scanFile(
                    activity, arrayOf(file.absolutePath), arrayOf("image/png"), null
                )
            } catch (_: Exception) {}
            showToast("已保存：${file.name}")
        } catch (e: Exception) {
            showToast("保存失败：${e.message}")
        }
    }

    fun shareImage() {
        val img = engine.exportBitmap() ?: return
        val file = File(activity.cacheDir, "StepDraw_share.png")
        try {
            FileOutputStream(file).use { img.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
        } catch (e: Exception) {
            showToast("分享失败")
            return
        }
        val uri = androidx.core.content.FileProvider.getUriForFile(
            activity,
            activity.packageName + ".fileprovider",
            file,
        )
        val intent = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
            type = "image/png"
            putExtra(android.content.Intent.EXTRA_STREAM, uri)
            addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        try {
            activity.startActivity(
                android.content.Intent.createChooser(intent, "分享作品")
            )
        } catch (e: Exception) {
            showToast("分享失败")
        }
    }

    // MARK: - Toast

    private var toastRunnable: Runnable? = null

    fun showToast(message: String) {
        ToastHost.instance?.show(message)
        toastRunnable?.let { mainHandler.removeCallbacks(it) }
        val r = Runnable { ToastHost.instance?.hide() }
        toastRunnable = r
        mainHandler.postDelayed(r, 2000)
    }

    fun destroy() {
        scope.cancel()
        mainHandler.removeCallbacksAndMessages(null)
    }
}

/** Toast 宿主（MainActivity 实现，避免 ViewModel 直接持有 View） */
interface ToastHost {
    fun show(message: String)
    fun hide()

    companion object {
        @Volatile
        var instance: ToastHost? = null
    }
}
