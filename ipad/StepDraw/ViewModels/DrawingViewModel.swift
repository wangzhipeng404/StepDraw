import SwiftUI
import UIKit

/// 主界面状态：播放 + 绘制 + 视图 + 数据，全部集中在这里。
/// DisplayLink 每帧调 tick()：推进动画 → 引擎渲染。
@MainActor
final class DrawingViewModel: ObservableObject {

    // MARK: 引擎与画布

    let engine = DrawingEngine()

    // MARK: 图案数据

    @Published var drawing: Drawing?
    @Published var categoryId: String = ""
    @Published var loadingDrawing: Bool = false
    @Published var loadError: String?

    // MARK: 播放状态

    @Published var currentStep: Int = 0
    @Published var stepProgress: CGFloat = 0
    @Published var playing: Bool = false
    @Published var speed: CGFloat = 1            // 0.5 / 1 / 2
    @Published var showGuide: Bool = true

    // MARK: 绘制状态

    @Published var drawingMode: Bool = true      // 默认进入绘制模式
    @Published var brushKind: BrushKind = .pen
    @Published var brushColor: Color = Color(hex: "#000000")
    @Published var brushWidth: Double = 4        // 内容坐标系线宽
    @Published var canUndo: Bool = false

    // MARK: 视图变换

    @Published var view: ViewTransform = .identity
    @Published var showScaleIndicator: Bool = false
    private var scaleIndicatorTask: Task<Void, Never>?

    // MARK: 面板

    @Published var showBrowser: Bool = false   // 左侧图案抽屉是否展开
    @Published var showClearConfirm: Bool = false
    @Published var showRemovePatternConfirm: Bool = false
    @Published var toast: Toast?

    // MARK: 播放进度（内部，非 Published 避免每帧刷 UI；进度条按需读取）

    @Published var progressSliderValue: Double = 0
    /// 进度条是否正在被拖动（拖动期间动画不覆盖该值，避免"打架"）
    @Published var sliderEditing: Bool = false

    // MARK: - 初始化与加载

    init() {
        engine.showGuide = showGuide
    }

    func loadDrawing(categoryId: String, item: DrawingItem) async {
        self.categoryId = categoryId
        loadingDrawing = true
        loadError = nil
        resetCanvasState()
        do {
            let d = try await DataStore.shared.loadDrawing(categoryId: categoryId, drawingId: item.id)
            self.drawing = d
            engine.drawing = d
            lastSyncedPlayingState = nil
        } catch {
            self.loadError = "图案加载失败，请重试"
        }
        loadingDrawing = false
    }

    /// 换一个图案时重置画布内容（不重置视图）
    private func resetCanvasState() {
        currentStep = 0
        stepProgress = 0
        playing = false
        progressSliderValue = 0
        engine.userStrokes = []
        engine.liveStroke = nil
        engine.contentVersion += 1
        canUndo = false
        view = .identity
    }

    // MARK: - 每帧推进

    /// 播放状态快照（用于按需置脏 outline 层）
    private var lastSyncedPlayingState: (id: String, step: Int, progress: CGFloat, guide: Bool)?

    func tick() {
        // 视图变换始终同步（自由绘制下平移/缩放也依赖它）
        engine.view = view

        guard let drawing else {
            // 自由绘制模式：无图案，outline 层留空
            engine.drawing = nil
            engine.drawingID = ""
            engine.render()
            return
        }
        // 同步播放状态到引擎
        engine.drawing = drawing
        engine.drawingID = drawing.id
        engine.currentStep = currentStep
        engine.stepProgress = stepProgress
        engine.showGuide = showGuide

        // 播放相关状态变化 → outline 层置脏
        let snap = (id: drawing.id, step: currentStep, progress: stepProgress, guide: showGuide)
        if let last = lastSyncedPlayingState, last != snap {
            engine.markPlayingStateDirty()
            lastSyncedPlayingState = snap
        }

        if playing {
            advanceAnimation()
            engine.markPlayingStateDirty()
        }

        engine.render()
        if !sliderEditing {
            progressSliderValue = Double(globalProgress)
        }
    }

    var totalSteps: Int { drawing?.steps.count ?? 0 }

    /// 全局进度（0~1，按步数均分，与 web 端 getGlobalProgress 一致）
    var globalProgress: Double {
        let n = totalSteps
        guard n > 0 else { return 0 }
        return (Double(currentStep) + Double(stepProgress)) / Double(n)
    }

    // 动画：基础速度每秒 100 内容像素（按当前步长度换算为进度增量）
    private func advanceAnimation() {
        guard let drawing, currentStep < drawing.steps.count else {
            playing = false
            return
        }
        let step = drawing.steps[currentStep]
        let stepLength = step.strokes.reduce(0) { $0 + strokeLength($1.cgPoints) }
        guard stepLength > 0 else {
            // 零长度步骤：直接跳到下一步
            if currentStep < totalSteps - 1 {
                currentStep += 1
                stepProgress = 0
            } else {
                playing = false
            }
            return
        }

        // 每帧约 16.6ms；用固定 dt 近似（DisplayLink 频率稳定）
        let dt: CGFloat = 1.0 / 60.0
        let pixels = 100.0 * dt * speed
        stepProgress += pixels / stepLength

        if stepProgress >= 1 {
            if currentStep < totalSteps - 1 {
                currentStep += 1
                stepProgress = 0
            } else {
                stepProgress = 1
                playing = false
            }
        }
    }

    // MARK: - 播放控制

    func togglePlay() {
        if playing {
            playing = false
            return
        }
        // 已播完则从头开始
        if currentStep == totalSteps - 1 && stepProgress >= 1 {
            currentStep = 0
            stepProgress = 0
        }
        playing = true
    }

    func prevStep() {
        if stepProgress > 0.02 {
            stepProgress = 0
        } else if currentStep > 0 {
            currentStep -= 1
            stepProgress = 0
        }
    }

    func nextStep() {
        if stepProgress < 1 {
            stepProgress = 1
        } else if currentStep < totalSteps - 1 {
            currentStep += 1
            stepProgress = 0
        }
    }

    func replay() {
        currentStep = 0
        stepProgress = 0
        playing = true
    }

    func cycleSpeed() {
        let speeds: [CGFloat] = [0.5, 1, 2]
        let i = speeds.firstIndex(of: speed) ?? 1
        speed = speeds[(i + 1) % speeds.count]
    }

    func toggleGuide() {
        showGuide.toggle()
    }

    /// 切换 绘制/移动 模式。从绘制切走时先收尾当前笔画，避免残留半笔。
    func toggleDrawMode() {
        if drawingMode {
            endStroke()          // 此时仍是绘制模式，能正常收尾
        }
        drawingMode.toggle()
    }

    /// 拖动进度条（暂停播放）
    func setGlobalProgress(_ value: Double) {
        playing = false
        let n = totalSteps
        guard n > 0 else { return }
        let f = value * Double(n)
        let step = min(Int(f), n - 1)
        currentStep = step
        stepProgress = CGFloat(f - Double(step))
        progressSliderValue = value
    }

    /// 清除图案，回到空白画布。
    /// 用户笔迹存的是图案内容坐标，与空白画布的坐标空间不同，必须一并清除。
    func removePattern() {
        drawing = nil
        categoryId = ""
        lastSyncedPlayingState = nil
        resetCanvasState()
        showRemovePatternConfirm = false
        showToast("已回到空白画布", icon: "checkmark.circle.fill")
    }

    // MARK: - 视图（平移 / 缩放 / 复位）

    func pan(by delta: CGPoint) {
        view.tx += delta.x
        view.ty += delta.y
        flashScale()
    }

    /// 以锚点（相对画布中心，层坐标）缩放
    func pinch(factor: CGFloat, anchor: CGPoint) {
        let newScale = clampScale(view.scale * factor)
        let applied = newScale / view.scale
        if abs(applied - 1) < 0.0001 { return }
        view = ViewTransform(
            scale: newScale,
            tx: anchor.x - applied * (anchor.x - view.tx),
            ty: anchor.y - applied * (anchor.y - view.ty)
        )
        flashScale()
    }

    func resetView() {
        view = .identity
        flashScale()
    }

    private func flashScale() {
        showScaleIndicator = true
        scaleIndicatorTask?.cancel()
        scaleIndicatorTask = Task {
            try? await Task.sleep(nanoseconds: 800_000_000)
            if !Task.isCancelled { showScaleIndicator = false }
        }
    }

    // MARK: - 用户绘制

    private var livePoints: [CGPoint] = []
    private var liveActive: Bool = false

    /// 层坐标 -> 内容坐标（有图案按 viewBox 适配，无图案恒等=层坐标）
    private func contentPoint(fromLayer p: CGPoint) -> CGPoint {
        let size = engine.layerSize == .zero
            ? CGSize(width: 800, height: 800)
            : engine.layerSize
        let fit = engine.currentFit(size: size)
        return toImagePoint(p, size: size, fit: fit, view: view)
    }

    func beginStroke(layerPoint: CGPoint) {
        guard drawingMode else { return }
        liveActive = true
        livePoints = [contentPoint(fromLayer: layerPoint)]
        engine.liveStroke = UserStroke(
            points: livePoints,
            width: CGFloat(brushWidth),
            color: brushColorHex,
            kind: brushKind
        )
        engine.markContentDirty()
    }

    /// 当前画笔色的 hex（UserStroke 平台无关地存 hex 字符串）
    private var brushColorHex: String {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        if UIColor(brushColor).getRed(&r, green: &g, blue: &b, alpha: &a) {
            return String(format: "#%02X%02X%02X", Int(r * 255), Int(g * 255), Int(b * 255))
        }
        return "#000000"
    }

    func extendStroke(layerPoint: CGPoint) {
        guard drawingMode, liveActive else { return }
        let p = contentPoint(fromLayer: layerPoint)
        // 距离过近的点丢弃，减少数据量
        if let last = livePoints.last, p.distance(to: last) < 0.5 { return }
        livePoints.append(p)
        engine.liveStroke?.points = livePoints
        engine.markContentDirty()
    }

    func endStroke() {
        guard drawingMode, liveActive else { return }
        liveActive = false
        let stroke = engine.liveStroke
        engine.liveStroke = nil
        if let stroke, !stroke.points.isEmpty {
            engine.userStrokes.append(stroke)
            canUndo = true
        }
        engine.contentVersion += 1
        engine.markContentDirty()
    }

    func undo() {
        if let last = engine.userStrokes.popLast() {
            _ = last
            engine.contentVersion += 1
            engine.markContentDirty()
            canUndo = !engine.userStrokes.isEmpty
        }
    }

    func clearAll() {
        engine.userStrokes = []
        engine.liveStroke = nil
        liveActive = false
        livePoints = []
        engine.contentVersion += 1
        engine.markContentDirty()
        canUndo = false
        showClearConfirm = false
        toast = Toast(message: "已清空画布", icon: "checkmark.circle.fill")
        scheduleToast()
    }

    // MARK: - Pencil 悬停预览

    func updatePencilHover(layerPoint: CGPoint?) {
        // 笔尖预览用层坐标（固定屏幕尺寸，不随视图缩放）
        engine.pencilPoint = drawingMode ? layerPoint : nil
        engine.pencilVisible = drawingMode && layerPoint != nil
        engine.markPencilDirty()
    }

    // MARK: - 保存 / 分享

    func saveToPhotos() {
        guard !engine.userStrokes.isEmpty || engine.liveStroke != nil else {
            toast = Toast(message: "画布上还没有内容", icon: "exclamationmark.circle")
            scheduleToast(); return
        }
        let img = engine.exportImage()
        guard let img else {
            toast = Toast(message: "保存失败", icon: "xmark.circle")
            scheduleToast(); return
        }
        UIImageWriteToSavedPhotosAlbum(img, nil, nil, nil)
        toast = Toast(message: "已保存到相册", icon: "photo.badge.checkmark")
        scheduleToast()
    }

    func shareImage() async {
        let img = engine.exportImage()
        guard let img else { return }
        let vc = findViewController()
        guard let vc else { return }
        let av = UIActivityViewController(activityItems: [img], applicationActivities: nil)
        av.popoverPresentationController?.sourceView = vc.view
        av.popoverPresentationController?.sourceRect = CGRect(x: 0.5, y: 0.5, width: 1, height: 1)
        av.popoverPresentationController?.permittedArrowDirections = []
        av.modalPresentationStyle = .popover
        vc.present(av, animated: true)
    }

    private func findViewController() -> UIViewController? {
        guard let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
              let root = scene.keyWindow?.rootViewController else { return nil }
        return topViewController(from: root)
    }

    private func topViewController(from root: UIViewController) -> UIViewController {
        if let nav = root as? UINavigationController {
            return topViewController(from: nav.topViewController ?? root)
        }
        if let tab = root as? UITabBarController, let sel = tab.selectedViewController {
            return topViewController(from: sel)
        }
        if let presented = root.presentedViewController {
            return topViewController(from: presented)
        }
        return root
    }

    // MARK: - Toast

    func showToast(_ message: String, icon: String) {
        toast = Toast(message: message, icon: icon)
        scheduleToast()
    }

    private func scheduleToast() {
        Task {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            if toast != nil { toast = nil }
        }
    }
}

struct Toast: Equatable {
    let message: String
    let icon: String
}

extension UIWindowScene {
    var keyWindow: UIWindow? {
        windows.first(where: { $0.isKeyWindow }) ?? windows.first
    }
}
