package com.stepdraw.android

import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.widget.SeekBar
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import com.stepdraw.android.data.DataStore
import com.stepdraw.android.data.DrawingItem
import com.stepdraw.android.data.PALETTE
import com.stepdraw.android.data.ViewTransform
import com.stepdraw.android.databinding.ActivityMainBinding
import com.stepdraw.android.util.ImageLoader
import com.stepdraw.android.viewmodel.DrawingViewModel
import com.stepdraw.android.viewmodel.ToastHost
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * 主界面：顶部信息栏 + 中间画布 + 右侧操作栏 + 底部工具栏（与 ipad MainView + Toolbars 同构）。
 */
class MainActivity : AppCompatActivity(), ToastHost, PatternListener {

    private lateinit var binding: ActivityMainBinding
    private lateinit var vm: DrawingViewModel
    private var progressDragged = false
    private val appScope = kotlinx.coroutines.CoroutineScope(SupervisorJob() + kotlinx.coroutines.Dispatchers.Main)
    private val density: Float by lazy { resources.displayMetrics.density }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        DataStore.attach(this)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        vm = DrawingViewModel(this)
        binding.canvas.viewModel = vm
        binding.canvas.onFrame = { syncDynamic() }
        ImageLoader.ensureScope(appScope)
        ToastHost.instance = this

        wireTopBar()
        wireRightBar()
        wireBottomToolbar()
        wireCanvas()

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

    // MARK: - 图案选中回调（来自 PatternBrowserBottomSheet）

    override fun onPatternSelected(categoryId: String, item: DrawingItem) {
        vm.loadDrawing(categoryId, item)
        syncAll()
    }

    // MARK: - 布局：画布正方形居中 + 右侧栏避让

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        layoutCanvas()
    }

    private fun layoutCanvas() {
        val area = binding.mainArea
        val canvas = binding.canvas
        if (area.width <= 0 || area.height <= 0) return
        // 最大正方形（画布由 FrameLayout 的 layout_gravity="center" 居中）
        val sidePx = minOf(area.width, area.height).coerceAtLeast(1)
        canvas.layoutParams = canvas.layoutParams.also {
            it.width = sidePx
            it.height = sidePx
        }
        // 画布居中后的位置（用于缩放指示 / 空白提示跟随）
        val canvasLeft = (area.width - sidePx) / 2f
        val canvasTop = (area.height - sidePx) / 2f
        binding.scaleIndicator.x = (canvasLeft + sidePx - (56 * density)).toFloat()
        binding.scaleIndicator.y = (12 * density).toFloat()
        binding.emptyHint.x = canvasLeft + sidePx / 2f - binding.emptyHint.width / 2f
        binding.emptyHint.y = canvasTop + (40 * density).toFloat()
    }

    // MARK: - 顶栏

    private fun wireTopBar() {
        binding.btnMode.setOnClickListener {
            vm.toggleDrawMode()
            syncAll()
        }
        binding.btnPattern.setOnClickListener { showPatternBrowser() }
        binding.btnReset.setOnClickListener {
            vm.resetView()
            syncAll()
        }
    }

    // MARK: - 右侧栏

    private fun wireRightBar() {
        binding.btnSave.setOnClickListener { vm.saveToPhotos() }
        binding.btnShare.setOnClickListener { vm.shareImage() }
        binding.btnUndo.setOnClickListener { vm.undo(); syncAll() }
        binding.btnClear.setOnClickListener {
            if (!vm.canUndo) return@setOnClickListener
            AlertDialog.Builder(this)
                .setTitle("确定要清除所有绘制内容吗？")
                .setPositiveButton("清空画布") { _, _ -> vm.clearAll(); syncAll() }
                .setNegativeButton("取消", null)
                .show()
        }
    }

    // MARK: - 底部工具栏

    private fun wireBottomToolbar() {
        // 轮廓开关
        binding.btnGuide.setOnClickListener { vm.toggleGuide(); syncAll() }

        // 播放控制
        binding.btnPrev.setOnClickListener { vm.prevStep(); syncAll() }
        binding.btnPlay.setOnClickListener { vm.togglePlay(); syncAll() }
        binding.btnNext.setOnClickListener { vm.nextStep(); syncAll() }
        binding.btnReplay.setOnClickListener { vm.replay(); syncAll() }
        binding.btnSpeed.setOnClickListener { vm.cycleSpeed(); syncAll() }

        // 进度条
        binding.seekProgress.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(sb: SeekBar, progress: Int, fromUser: Boolean) {
                if (fromUser) {
                    vm.setGlobalProgress(progress / 1000f)
                    syncTopBarOnly()
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

        // 色板（6 个固定色 + 自定义色）
        val dots = listOf(
            binding.pal0, binding.pal1, binding.pal2,
            binding.pal3, binding.pal4, binding.pal5,
        )
        dots.forEachIndexed { i, dot ->
            dot.background = colorDotBackground(PALETTE[i], selected = i == 5)
            dot.setOnClickListener {
                vm.brushColor = PALETTE[i]
                syncPalette()
            }
        }
        binding.palCustom.setOnClickListener {
            showColorPicker { c ->
                vm.brushColor = c
                syncPalette()
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

        // 笔种
        binding.brushPen.setOnClickListener { setBrush(0) }
        binding.brushPencil.setOnClickListener { setBrush(1) }
        binding.brushMarker.setOnClickListener { setBrush(2) }
        binding.brushBrush.setOnClickListener { setBrush(3) }
    }

    private fun setBrush(index: Int) {
        val kinds = listOf(
            com.stepdraw.android.data.BrushKind.PEN,
            com.stepdraw.android.data.BrushKind.PENCIL,
            com.stepdraw.android.data.BrushKind.MARKER,
            com.stepdraw.android.data.BrushKind.BRUSH,
        )
        vm.brushKind = kinds[index]
        if (!vm.drawingMode) vm.drawingMode = true
        syncBrushes()
    }

    // MARK: - 画布区域事件

    private fun wireCanvas() {
        binding.emptyHint.setOnClickListener { showPatternBrowser() }
        binding.btnEmptyPick.setOnClickListener { showPatternBrowser() }
    }

    private fun showPatternBrowser() {
        PatternBrowserBottomSheet.newInstance().show(supportFragmentManager, "pattern")
    }

    // MARK: - UI 同步（每帧 / 状态变化后调用）

    private fun syncAll() {
        syncTopBar()
        syncRightBar()
        syncBottom()
        layoutCanvas()
    }

    /**
     * 每帧动态同步：进度条 / 步骤提示 / 缩放指示 / 播放按钮等会随动画变化的 UI。
     * 只在值变化时写，避免每帧无谓地重排。
     */
    private var lastStepInfo = ""
    private var lastProgress = -1
    private var lastPlayIcon = ""
    private var lastScale = ""
    private var lastScaleVisible = false

    private fun syncDynamic() {
        // 步骤提示
        val d = vm.drawing
        val stepText = if (d != null) "${vm.currentStep + 1}/${maxOf(vm.totalSteps, 1)} 步" else "自由绘制"
        if (stepText != lastStepInfo) {
            lastStepInfo = stepText
            binding.tvStepInfo.text = stepText
            if (d != null) {
                val tip = d.steps.getOrNull(vm.currentStep)?.tip
                binding.tvTip.text = if (tip.isNullOrEmpty()) "" else tip
                binding.tvTip.visibility = if (tip.isNullOrEmpty()) View.GONE else View.VISIBLE
            }
        }
        // 进度条（拖动期间不覆盖）
        val progress = if (!vm.sliderEditing && !progressDragged) (vm.progressSliderValue * 1000).toInt() else -1
        if (progress != lastProgress) {
            lastProgress = progress
            if (progress >= 0) binding.seekProgress.progress = progress
        }
        // 播放按钮图标
        val playIcon = if (vm.playing) "❚❚" else "▶︎"
        if (playIcon != lastPlayIcon) {
            lastPlayIcon = playIcon
            binding.btnPlay.text = playIcon
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
    }

    private fun syncTopBar() {
        val d = vm.drawing
        if (d != null) {
            binding.tvPatternName.text = d.displayName
            binding.tvStepInfo.text = "${vm.currentStep + 1}/${maxOf(vm.totalSteps, 1)} 步"
            val tip = d.steps.getOrNull(vm.currentStep)?.tip
            binding.tvTip.text = if (tip.isNullOrEmpty()) "" else tip
            binding.tvTip.visibility = if (tip.isNullOrEmpty()) View.GONE else View.VISIBLE
        } else {
            binding.tvPatternName.text = "一笔一笔"
            binding.tvStepInfo.text = "自由绘制"
            binding.tvTip.text = ""
            binding.tvTip.visibility = View.GONE
        }
        binding.btnMode.text = if (vm.drawingMode) "✎ 绘制" else "✋ 移动"
        binding.btnMode.setTextColor(
            if (vm.drawingMode) Color.parseColor("#1E88E5") else Color.parseColor("#1C1C1E")
        )
        binding.btnMode.background = chipBackground(vm.drawingMode)
        binding.btnReset.alpha = if (vm.view == com.stepdraw.android.data.ViewTransform.IDENTITY) 0.4f else 1f
        binding.emptyHint.visibility =
            if (vm.drawing == null && !vm.canUndo) View.VISIBLE else View.GONE
        binding.loadingOverlay.visibility = if (vm.loadingDrawing) View.VISIBLE else View.GONE
    }

    private fun syncTopBarOnly() {
        syncTopBar()
    }

    private fun syncRightBar() {
        val enabled = if (vm.canUndo) 1f else 0.4f
        binding.btnUndo.alpha = enabled
        binding.btnClear.alpha = enabled
    }

    private fun syncBottom() {
        binding.btnGuide.text = if (vm.showGuide) "◧ 轮廓" else "◨ 轮廓"
        binding.btnGuide.setTextColor(
            if (vm.showGuide) Color.parseColor("#1E88E5") else Color.parseColor("#8E8E93")
        )
        binding.btnGuide.background = chipBackground(vm.showGuide)

        binding.btnPlay.text = if (vm.playing) "❚❚" else "▶︎"
        val noDrawing = vm.drawing == null
        binding.btnPrev.alpha = if (noDrawing || (vm.currentStep == 0 && vm.stepProgress == 0f)) 0.4f else 1f
        binding.btnPlay.alpha = if (noDrawing) 0.4f else 1f
        binding.btnNext.alpha =
            if (noDrawing || (vm.currentStep == vm.totalSteps - 1 && vm.stepProgress >= 1f)) 0.4f else 1f
        binding.btnReplay.alpha = if (noDrawing) 0.4f else 1f
        binding.btnSpeed.text = speedLabel(vm.speed)
        binding.seekProgress.alpha = if (noDrawing) 0.4f else 1f

        // 进度条（拖动期间不被动画覆盖）
        if (!progressDragged && !vm.sliderEditing) {
            binding.seekProgress.progress = (vm.progressSliderValue * 1000).toInt()
        }

        // 粗细
        binding.seekWidth.progress = (vm.brushWidth - 1).toInt().coerceIn(0, 23)
        binding.tvWidth.text = vm.brushWidth.toInt().toString()
        // 画笔区在移动模式下禁用外观
        val drawEnabled = vm.drawingMode
        binding.palette.alpha = if (drawEnabled) 1f else 0.4f
        binding.seekWidth.alpha = if (drawEnabled) 1f else 0.4f
        binding.tvWidth.alpha = if (drawEnabled) 1f else 0.4f

        syncBrushes()
        syncPalette()
        binding.tvGestureHint.text = if (vm.drawingMode) "单指绘制 · 双指缩放/移动" else "单指移动 · 双指缩放 · 点「绘制」开始画"
        binding.scaleIndicator.visibility = if (vm.showScaleIndicator) View.VISIBLE else View.GONE
        if (vm.showScaleIndicator) {
            binding.scaleIndicator.text = String.format("%.1f×", vm.view.scale.toDouble())
        }
    }

    private fun syncBrushes() {
        val brushes = listOf(
            binding.brushPen to com.stepdraw.android.data.BrushKind.PEN,
            binding.brushPencil to com.stepdraw.android.data.BrushKind.PENCIL,
            binding.brushMarker to com.stepdraw.android.data.BrushKind.MARKER,
            binding.brushBrush to com.stepdraw.android.data.BrushKind.BRUSH,
        )
        for ((btn, kind) in brushes) {
            val active = vm.brushKind == kind && vm.drawingMode
            btn.setTextColor(if (active) Color.parseColor("#1E88E5") else Color.parseColor("#1C1C1E"))
            btn.background = chipBackground(active)
        }
    }

    private fun syncPalette() {
        val dots = listOf(
            binding.pal0, binding.pal1, binding.pal2,
            binding.pal3, binding.pal4, binding.pal5,
        )
        dots.forEachIndexed { i, dot ->
            val selected = vm.brushColor == PALETTE[i]
            dot.background = colorDotBackground(PALETTE[i], selected)
        }
    }

    // MARK: - 色板辅助

    private fun chipBackground(active: Boolean) =
        if (active) getDrawable(R.drawable.chip_bg_active) else getDrawable(R.drawable.ripple_chip)

    private fun colorDotBackground(color: Int, selected: Boolean): android.graphics.drawable.Drawable {
        val shape = android.graphics.drawable.GradientDrawable().apply {
            shape = android.graphics.drawable.GradientDrawable.OVAL
            setColor(color)
            if (selected) {
                setStroke((4 * density).toInt(), Color.parseColor("#1E88E5"))
            }
        }
        return shape
    }

    private fun showColorPicker(onPick: (Int) -> Unit) {
        val dialog = AlertDialog.Builder(this)
            .setTitle("选择颜色")
            .setItems(
                arrayOf("红", "蓝", "绿", "橙", "紫", "黑", "深灰", "棕色"),
            ) { _, which ->
                val colors = intArrayOf(
                    0xFFE53935.toInt(), 0xFF1E88E5.toInt(), 0xFF43A047.toInt(),
                    0xFFFB8C00.toInt(), 0xFF8E24AA.toInt(), 0xFF000000.toInt(),
                    0xFF424242.toInt(), 0xFF795548.toInt(),
                )
                onPick(colors[which])
            }
            .setNegativeButton("取消", null)
            .create()
        dialog.show()
    }

    private fun speedLabel(speed: Float): String =
        when {
            speed == 0.5f -> "0.5x"
            speed == 2f -> "2x"
            else -> "1x"
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
