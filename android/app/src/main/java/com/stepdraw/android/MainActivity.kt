package com.stepdraw.android

import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.View
import android.widget.LinearLayout
import android.widget.SeekBar
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import com.stepdraw.android.data.BrushKind
import com.stepdraw.android.data.DataStore
import com.stepdraw.android.data.DrawingItem
import com.stepdraw.android.data.ViewTransform
import com.stepdraw.android.databinding.ActivityMainBinding
import com.stepdraw.android.util.ImageLoader
import com.stepdraw.android.viewmodel.DrawingViewModel
import com.stepdraw.android.viewmodel.ToastHost
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * 主界面：全屏画布 + 左侧抽屉式图案浏览（布局与 web 端 DrawingStudio 一致）。
 * 顶栏：logo（点它展开图案抽屉）+ 绘制/移动 + 笔种图标 + 自定义颜色 + 粗细 + 撤销/清除/复位
 * 右侧：全高操作栏（保存/分享）；底部：播放控制（轮廓/上一步/播放/下一步/重播/倍速/进度）
 */
class MainActivity : AppCompatActivity(), ToastHost, PatternListener {

    private lateinit var binding: ActivityMainBinding
    private lateinit var vm: DrawingViewModel
    private var progressDragged = false
    private val appScope = kotlinx.coroutines.CoroutineScope(SupervisorJob() + kotlinx.coroutines.Dispatchers.Main)
    private val density: Float by lazy { resources.displayMetrics.density }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 崩溃捕获：把异常堆栈弹到屏上（便于真机定位"选图案崩溃"），避免直接闪退看不到原因。
        Thread.setDefaultUncaughtExceptionHandler(::showCrashDialog)
        DataStore.attach(this)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        vm = DrawingViewModel(this)
        binding.canvas.viewModel = vm
        binding.canvas.onFrame = { syncDynamic() }
        ImageLoader.ensureScope(appScope)
        ToastHost.instance = this

        // 图案抽屉：宽度按画布区比例，窄屏收窄（与 iPad 端一致），避免挤占绘制区。
        // 等首帧布局拿到真实宽度后再设。
        binding.mainArea.post {
            val w = binding.mainArea.width
            if (w > 0) {
                binding.leftPane.layoutParams =
                    (binding.leftPane.layoutParams as android.widget.FrameLayout.LayoutParams).also {
                        it.width = (w * 0.4f).toInt().coerceIn((300 * density).toInt(), (400 * density).toInt())
                    }
            }
        }
        // 顶栏 logo 切换抽屉；点图案 → 载入画布并收起抽屉
        binding.ivLogo.setOnClickListener { toggleBrowser() }
        binding.leftPane.onSelect = { categoryId, item -> onPatternSelected(categoryId, item) }

        wireTopBar()
        wireRightBar()
        wireBottomToolbar()

        // 启动即加载主索引（与 iPad 的 .task { loadMainIndex() } 一致）
        appScope.launch {
            try {
                DataStore.getInstance().loadMainIndex()
            } catch (_: Exception) { }
        }
    }

    override fun onResume() {
        super.onResume()
        syncAll()
    }

    override fun onDestroy() {
        ToastHost.instance = null
        vm.destroy()
        appScope.cancel()
        super.onDestroy()
    }

    // MARK: - 图案抽屉（左侧，默认收起，点 logo 展开）

    private var browserOpen = false

    /** 切换抽屉展开/收起，带横向滑入/滑出动画 */
    private fun toggleBrowser() {
        val open = !browserOpen
        browserOpen = open
        val pane = binding.leftPane
        // GONE 时 width=0，滑移距离取 layoutParams.width（布局里已设好）
        val w = pane.layoutParams.width.takeIf { it > 0 } ?: return
        if (open) {
            pane.visibility = View.VISIBLE
            pane.translationX = -w.toFloat()
            pane.animate().translationX(0f).setDuration(220).start()
        } else {
            pane.animate().translationX(-w.toFloat()).setDuration(220)
                .withEndAction { pane.visibility = View.GONE }
                .start()
        }
    }

    private fun closeBrowser() {
        if (!browserOpen) return
        browserOpen = false
        val pane = binding.leftPane
        val w = pane.layoutParams.width.takeIf { it > 0 } ?: return
        pane.animate().translationX(-w.toFloat()).setDuration(220)
            .withEndAction { pane.visibility = View.GONE }
            .start()
    }

    // MARK: - 图案选中回调（来自左栏 PatternBrowserPane）

    override fun onPatternSelected(categoryId: String, item: DrawingItem) {
        vm.loadDrawing(categoryId, item)
        binding.leftPane.currentDrawingId = item.id
        closeBrowser()   // 载入画布后自动收起抽屉
        syncAll()
    }

    // MARK: - 顶栏

    private fun wireTopBar() {
        // 笔种（图标按钮，与 web 的 STROKE_TYPES 一致：点已选中的笔 → 退出绘制回到移动模式）
        binding.ivBrushPen.setOnClickListener { toggleBrush(BrushKind.PEN) }
        binding.ivBrushPencil.setOnClickListener { toggleBrush(BrushKind.PENCIL) }
        binding.ivBrushMarker.setOnClickListener { toggleBrush(BrushKind.MARKER) }
        binding.ivBrushBrush.setOnClickListener { toggleBrush(BrushKind.BRUSH) }
        // 自定义颜色（圆点显示当前色）
        binding.colorDot.setOnClickListener {
            showColorPicker(vm.brushColor) { c ->
                vm.brushColor = c
                syncAll()
            }
        }
        // 粗细
        binding.seekWidth.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(sb: SeekBar, progress: Int, fromUser: Boolean) {
                if (fromUser) {
                    vm.brushWidth = (progress + 1).toFloat()
                    binding.tvWidth.text = vm.brushWidth.toInt().toString()
                }
            }
            override fun onStartTrackingTouch(sb: SeekBar) {}
            override fun onStopTrackingTouch(sb: SeekBar) {}
        })
        // 撤销 / 清除 / 复位
        binding.ivUndo.setOnClickListener {
            vm.undo()
            syncAll()
        }
        binding.ivClear.setOnClickListener {
            if (!vm.canUndo) return@setOnClickListener
            AlertDialog.Builder(this)
                .setTitle("确定要清除所有绘制内容吗？")
                .setPositiveButton("清空画布") { _, _ -> vm.clearAll(); syncAll() }
                .setNegativeButton("取消", null)
                .show()
        }
        binding.ivReset.setOnClickListener {
            vm.resetView()
            syncAll()
        }
    }

    // MARK: - 右侧全高栏（保存/分享）

    private fun wireRightBar() {
        binding.btnSave.setOnClickListener { vm.saveToPhotos() }
        binding.btnShare.setOnClickListener { vm.shareImage() }
    }

    // MARK: - 底部播放控制

    private fun wireBottomToolbar() {
        binding.btnGuide.setOnClickListener { vm.toggleGuide(); syncAll() }
        binding.btnPrev.setOnClickListener { vm.prevStep(); syncAll() }
        binding.btnPlay.setOnClickListener { vm.togglePlay(); syncAll() }
        binding.btnNext.setOnClickListener { vm.nextStep(); syncAll() }
        binding.btnReplay.setOnClickListener { vm.replay(); syncAll() }
        binding.btnSpeed.setOnClickListener { vm.cycleSpeed(); syncAll() }

        binding.seekProgress.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(sb: SeekBar, progress: Int, fromUser: Boolean) {
                if (fromUser) {
                    vm.setGlobalProgress(progress / 1000f)
                    syncTopBar()
                }
            }
            override fun onStartTrackingTouch(sb: SeekBar) {
                progressDragged = true
                vm.sliderEditing = true
            }
            override fun onStopTrackingTouch(sb: SeekBar) {
                progressDragged = false
                vm.sliderEditing = false
            }
        })
    }

    /**
     * 笔种切换（与 web handleStrokeTypeSelect 一致）：
     * 点已选中的笔 → 退出绘制模式（回到移动/平移）；点其它笔 → 选中并进入绘制模式。
     */
    private fun toggleBrush(kind: BrushKind) {
        if (vm.drawingMode && vm.brushKind == kind) {
            vm.drawingMode = false
        } else {
            vm.brushKind = kind
            vm.drawingMode = true
        }
        syncTopBar()
    }

    // MARK: - UI 同步（每帧 / 状态变化后调用）

    private fun syncAll() {
        syncTopBar()
        syncBottom()
    }

    /**
     * 每帧动态同步：步骤提示 / 进度条 / 播放图标 / 缩放指示等会随动画变化的 UI。
     * 只在值变化时写，避免每帧无谓地重排。
     */
    private var lastTip = ""
    private var lastProgress = -1
    private var lastPlayIcon = -1
    private var lastScale = ""
    private var lastScaleVisible = false
    private var lastLoading = false

    private fun syncDynamic() {
        // 步骤提示（画布右下角，与 web studio-step-tip 一致）
        val d = vm.drawing
        val tip = d?.steps?.getOrNull(vm.currentStep)?.tip.orEmpty()
        if (tip != lastTip) {
            lastTip = tip
            binding.tvTip.text = tip
            binding.tvTip.visibility = if (tip.isEmpty()) View.GONE else View.VISIBLE
        }
        // 进度条（拖动期间不覆盖）
        val progress = if (!vm.sliderEditing && !progressDragged) (vm.progressSliderValue * 1000).toInt() else -1
        if (progress != lastProgress) {
            lastProgress = progress
            if (progress >= 0) binding.seekProgress.progress = progress
        }
        // 播放按钮图标（play.png / stop.png）
        val playIcon = if (vm.playing) R.drawable.stop else R.drawable.play
        if (playIcon != lastPlayIcon) {
            lastPlayIcon = playIcon
            binding.btnPlay.setImageResource(playIcon)
        }
        // 缩放指示
        val scaleVisible = vm.showScaleIndicator
        val scaleText = if (scaleVisible) String.format("%.1f×", vm.view.scale.toDouble()) else ""
        if (scaleVisible != lastScaleVisible || scaleText != lastScale) {
            lastScaleVisible = scaleVisible
            lastScale = scaleText
            binding.scaleIndicator.visibility = if (scaleVisible) View.VISIBLE else View.GONE
            if (scaleVisible) binding.scaleIndicator.text = scaleText
        }
        // 加载遮罩：异步加载完成后 loadingDrawing 会变 false，必须每帧同步，
        // 否则遮罩会一直停在"图案加载中…"（只在离散事件里同步会漏掉完成时刻）。
        if (vm.loadingDrawing != lastLoading) {
            lastLoading = vm.loadingDrawing
            binding.loadingOverlay.visibility = if (vm.loadingDrawing) View.VISIBLE else View.GONE
        }
    }

    private fun syncTopBar() {
        // 笔种图标（选中换 *_active 图，与 web stroke-type-item.active 一致）
        syncBrushes()

        // 自定义颜色圆点（当前色 + 细边框）
        binding.colorDot.background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(vm.brushColor)
            setStroke((1.5f * density).toInt().coerceAtLeast(1), Color.parseColor("#26000000"))
        }

        // 粗细（滑块 + 数值，无"粗细"文字）
        binding.seekWidth.progress = (vm.brushWidth - 1).toInt().coerceIn(0, 23)
        binding.tvWidth.text = vm.brushWidth.toInt().toString()

        // 移动模式下画笔区降低强调（与 web 一致：非绘制模式笔种不高亮）
        val drawEnabled = vm.drawingMode
        binding.colorDot.alpha = if (drawEnabled) 1f else 0.4f
        binding.seekWidth.alpha = if (drawEnabled) 1f else 0.4f
        binding.tvWidth.alpha = if (drawEnabled) 1f else 0.4f

        // 撤销/清除 可用性；复位在视图已归位时降透明
        val undoEnabled = if (vm.canUndo) 1f else 0.4f
        binding.ivUndo.alpha = undoEnabled
        binding.ivClear.alpha = undoEnabled
        binding.ivReset.alpha = if (vm.view == ViewTransform.IDENTITY) 0.4f else 1f

        // 步骤提示（画布右下角）
        val tip = vm.drawing?.steps?.getOrNull(vm.currentStep)?.tip.orEmpty()
        lastTip = tip
        binding.tvTip.text = tip
        binding.tvTip.visibility = if (tip.isEmpty()) View.GONE else View.VISIBLE

        binding.loadingOverlay.visibility = if (vm.loadingDrawing) View.VISIBLE else View.GONE
    }

    /** 笔种图标按钮：选中用 *_active 图标 */
    private fun syncBrushes() {
        val pairs = listOf(
            binding.ivBrushPen to BrushKind.PEN,
            binding.ivBrushPencil to BrushKind.PENCIL,
            binding.ivBrushMarker to BrushKind.MARKER,
            binding.ivBrushBrush to BrushKind.BRUSH,
        )
        val icons = mapOf(
            BrushKind.PEN to (R.drawable.fountain_pen to R.drawable.fountain_active),
            BrushKind.PENCIL to (R.drawable.pencil to R.drawable.pencil_active),
            BrushKind.MARKER to (R.drawable.markpen to R.drawable.mark_pen_active),
            BrushKind.BRUSH to (R.drawable.ink_brush to R.drawable.ink_brush_active),
        )
        for ((btn, kind) in pairs) {
            val active = vm.brushKind == kind && vm.drawingMode
            val (normal, activeIcon) = icons[kind] ?: continue
            if (active) btn.setImageResource(activeIcon) else btn.setImageResource(normal)
        }
    }

    private fun syncBottom() {
        // 轮廓开关（web 图标 cat_solid / cat_solid_active）
        binding.btnGuide.setImageResource(if (vm.showGuide) R.drawable.cat_solid_active else R.drawable.cat_solid)

        // 播放图标（play.png / stop.png）
        val playIcon = if (vm.playing) R.drawable.stop else R.drawable.play
        lastPlayIcon = playIcon
        binding.btnPlay.setImageResource(playIcon)

        val noDrawing = vm.drawing == null
        binding.btnPrev.alpha = if (noDrawing || (vm.currentStep == 0 && vm.stepProgress == 0f)) 0.4f else 1f
        binding.btnPlay.alpha = if (noDrawing) 0.4f else 1f
        binding.btnNext.alpha =
            if (noDrawing || (vm.currentStep == vm.totalSteps - 1 && vm.stepProgress >= 1f)) 0.4f else 1f
        binding.btnReplay.alpha = if (noDrawing) 0.4f else 1f
        binding.btnGuide.alpha = if (noDrawing) 0.4f else 1f
        binding.btnSpeed.text = speedLabel(vm.speed)
        binding.seekProgress.alpha = if (noDrawing) 0.4f else 1f

        // 进度条（拖动期间不被动画覆盖）
        if (!progressDragged && !vm.sliderEditing) {
            binding.seekProgress.progress = (vm.progressSliderValue * 1000).toInt()
        }
    }

    // MARK: - 取色器（HSV 三滑块，自定义颜色）

    private fun showColorPicker(initial: Int, onPick: (Int) -> Unit) {
        val hsv = FloatArray(3)
        Color.colorToHSV(initial, hsv)

        val dp = { v: Int -> (v * density).toInt() }
        val preview = View(this).apply {
            layoutParams = LinearLayout.LayoutParams(dp(44), dp(44)).also { it.marginEnd = dp(14) }
        }
        fun refreshPreview() {
            val c = Color.HSVToColor(hsv)
            preview.background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(c)
                setStroke((1.5f * density).toInt().coerceAtLeast(1), Color.parseColor("#26000000"))
            }
        }
        refreshPreview()

        val rows = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        fun addSlider(max: Int, label: String, index: Int) {
            val col = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                )
            }
            val t = TextView(this).apply {
                text = label
                textSize = 12f
                setTextColor(Color.parseColor("#8E8E93"))
            }
            val sb = SeekBar(this).apply {
                this.max = max
                progress = hsv[index].toInt()
                setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                    override fun onProgressChanged(sb: SeekBar, progress: Int, fromUser: Boolean) {
                        if (fromUser) {
                            hsv[index] = progress.toFloat()
                            refreshPreview()
                        }
                    }
                    override fun onStartTrackingTouch(sb: SeekBar) {}
                    override fun onStopTrackingTouch(sb: SeekBar) {}
                })
            }
            col.addView(t)
            col.addView(sb)
            rows.addView(col)
        }
        addSlider(359, "色相", 0)
        addSlider(255, "饱和", 1)
        addSlider(255, "亮度", 2)

        val content = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
            setPadding(dp(20), dp(16), dp(20), dp(4))
        }
        content.addView(preview)
        content.addView(rows)

        val dialog = AlertDialog.Builder(this)
            .setTitle("自定义颜色")
            .setView(content)
            .setPositiveButton("确定", null)
            .setNegativeButton("取消", null)
            .create()
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                onPick(Color.HSVToColor(hsv))
                dialog.dismiss()
            }
        }
        dialog.show()
    }

    private fun speedLabel(speed: Float): String =
        when {
            speed == 0.5f -> "0.5x"
            speed == 2f -> "2x"
            else -> "1x"
        }

    // MARK: - 崩溃捕获（真机定位用：弹屏显示异常 + 堆栈，点"知道了"退出）

    private fun showCrashDialog(thread: Thread, throwable: Throwable) {
        val sb = StringBuilder()
        sb.append(throwable.stackTraceToString())
        for (e in throwable.suppressed) {
            sb.append("\n--- suppressed ---\n").append(e.stackTraceToString())
        }
        var cause = throwable.cause
        while (cause != null) {
            sb.append("\n--- caused by ---\n").append(cause.stackTraceToString())
            cause = cause.cause
        }
        try {
            val dialog = AlertDialog.Builder(this)
                .setTitle("程序崩溃（请截图发我）")
                .setMessage("线程：${thread.name}\n\n$sb")
                .setCancelable(false)
                .setPositiveButton("知道了", null)
                .show()
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                android.os.Process.killProcess(android.os.Process.myPid())
                kotlin.system.exitProcess(9)
            }
        } catch (_: Exception) {
            // 连弹框都失败就直接退出
            android.os.Process.killProcess(android.os.Process.myPid())
            kotlin.system.exitProcess(9)
        }
    }

    // MARK: - Toast

    override fun show(message: String) {
        binding.toastView.text = message
        binding.toastView.visibility = View.VISIBLE
    }

    override fun hide() {
        binding.toastView.visibility = View.GONE
    }
}
