import UIKit
import CoreGraphics

// MARK: - hex 颜色（定义在渲染侧，Models 保持平台无关）

extension UIColor {
    convenience init(hex: String) {
        var s = hex
        if s.hasPrefix("#") { s.removeFirst() }
        var v: UInt64 = 0
        Scanner(string: s).scanHexInt64(&v)
        self.init(
            red: CGFloat((v & 0xFF0000) >> 16) / 255,
            green: CGFloat((v & 0x00FF00) >> 8) / 255,
            blue: CGFloat(v & 0x0000FF) / 255,
            alpha: 1
        )
    }
}

// MARK: - 画笔渲染（与 web 端 renderUserStroke 同构，内容坐标系）

/// 画一条用户笔画（上下文需已应用「适配+视图」变换）
func renderUserStroke(_ ctx: CGContext, stroke: UserStroke) {
    let pts = stroke.points
    guard !pts.isEmpty else { return }
    let color = UIColor(hex: stroke.color)
    let width = stroke.width
    let kind = stroke.kind

    ctx.setLineCap(.round)
    ctx.setLineJoin(.round)
    ctx.setAlpha(1)

    if pts.count == 1 {
        let p = pts[0]
        let r = width / 2
        switch kind {
        case .pen:
            ctx.setFillColor(color.cgColor)
            ctx.fillEllipse(in: CGRect(x: p.x - r, y: p.y - r, width: r * 2, height: r * 2))
        case .pencil:
            ctx.setFillColor(color.withAlphaComponent(0.8).cgColor)
            ctx.fillEllipse(in: CGRect(x: p.x - r, y: p.y - r, width: r * 2, height: r * 2))
        case .marker:
            ctx.setFillColor(color.withAlphaComponent(0.4).cgColor)
            ctx.fillEllipse(in: CGRect(x: p.x - r * 1.5, y: p.y - r, width: r * 3, height: r * 2))
        case .brush:
            ctx.setFillColor(color.withAlphaComponent(0.6).cgColor)
            ctx.fillEllipse(in: CGRect(x: p.x - r, y: p.y - r, width: r * 2, height: r * 2))
        }
        return
    }

    ctx.setStrokeColor(color.cgColor)
    switch kind {
    case .pen:
        ctx.setLineWidth(width)
        addSmoothPath(ctx, pts)
        ctx.strokePath()
    case .pencil:
        ctx.setLineWidth(width)
        ctx.setAlpha(0.7)
        ctx.setLineDash(phase: 0, lengths: [width, width / 2])
        addPlainPath(ctx, pts)
        ctx.strokePath()
        ctx.setLineDash(phase: 0, lengths: [])
    case .marker:
        ctx.setLineWidth(width * 2)
        ctx.setAlpha(0.4)
        addSmoothPath(ctx, pts)
        ctx.strokePath()
    case .brush:
        ctx.setLineWidth(width * 1.5)
        ctx.setAlpha(0.6)
        addSmoothPath(ctx, pts)
        ctx.strokePath()
    }
    ctx.setAlpha(1)
}

/// 中点法平滑折线（二次贝塞尔）
func addSmoothPath(_ ctx: CGContext, _ pts: [CGPoint]) {
    guard let first = pts.first else { return }
    ctx.move(to: first)
    if pts.count < 3 {
        for p in pts.dropFirst() { ctx.addLine(to: p) }
        return
    }
    for i in 1..<pts.count - 1 {
        let c = pts[i]
        let mid = CGPoint(x: (c.x + pts[i + 1].x) / 2, y: (c.y + pts[i + 1].y) / 2)
        ctx.addQuadCurve(to: mid, control: c)
    }
    ctx.addLine(to: pts[pts.count - 1])
}

/// 普通折线
func addPlainPath(_ ctx: CGContext, _ pts: [CGPoint]) {
    guard let first = pts.first else { return }
    ctx.move(to: first)
    for p in pts.dropFirst() { ctx.addLine(to: p) }
}

/// 画一条图案笔画，progress < 1 时按弧长截断（"笔画生长"动画用）
func addStrokePath(_ ctx: CGContext, points: [CGPoint], progress: CGFloat) {
    let pts = points
    guard pts.count >= 2 else { return }
    if progress >= 1 {
        addSmoothPath(ctx, pts)
        return
    }
    let total = strokeLength(pts)
    guard total > 0 else {
        addSmoothPath(ctx, pts)
        return
    }
    let target = progress * total
    var accumulated: CGFloat = 0
    var cutIndex = pts.count - 1
    var cutFrac: CGFloat = 1
    for i in 1..<pts.count {
        let seg = pts[i].distance(to: pts[i - 1])
        if accumulated + seg >= target {
            cutIndex = i
            cutFrac = seg > 0 ? (target - accumulated) / seg : 0
            break
        }
        accumulated += seg
    }
    let cutPoint = CGPoint(
        x: pts[cutIndex - 1].x + (pts[cutIndex].x - pts[cutIndex - 1].x) * cutFrac,
        y: pts[cutIndex - 1].y + (pts[cutIndex].y - pts[cutIndex - 1].y) * cutFrac
    )
    addSmoothPath(ctx, Array(pts[0...cutIndex - 1]) + [cutPoint])
}

// MARK: - 离屏缓存（层坐标空间，恒为"无视图变换"）

final class LayerCache {
    let size: CGSize
    let scale: CGFloat
    private let context: CGContext
    /// 生成一次后缓存的位图，blit 时复用（避免每帧重复 makeImage 大位图拷贝）
    private(set) var image: CGImage?

    init?(size: CGSize, scale: CGFloat) {
        guard size.width > 0, size.height > 0 else { return nil }
        self.size = size
        self.scale = scale
        guard let ctx = CGContext(
            data: nil,
            width: Int(size.width * scale),
            height: Int(size.height * scale),
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        ctx.scaleBy(x: scale, y: scale)
        self.context = ctx
    }

    var contextAccess: CGContext { context }

    /// 内容画完后调用，把位图固化成 CGImage 供 blit 复用
    func finalizeImage() {
        image = context.makeImage()
    }

    func blit(into ctx: CGContext, view: ViewTransform, size: CGSize) {
        if image == nil { finalizeImage() }
        guard let img = image else { return }
        let c = CGPoint(x: size.width / 2, y: size.height / 2)
        let s = view.scale
        ctx.saveGState()
        // 与 web 端 applyViewTransform 同公式：p' = s*(p-c)+c+t
        ctx.concatenate(CGAffineTransform(
            a: s, b: 0, c: 0, d: s,
            tx: c.x + view.tx - s * c.x,
            ty: c.y + view.ty - s * c.y
        ))
        ctx.draw(img, in: CGRect(origin: .zero, size: size))
        ctx.restoreGState()
    }
}

// MARK: - 绘制引擎

/// 四层渲染：
/// - outline：图案引导（全轮廓淡显）+ 已完成步骤 + 当前动画笔画（仅在加载图案时）
/// - history：用户已完成笔画
/// - brush：正在画的一笔
/// - pencil：Apple Pencil 笔尖预览（层坐标，固定尺寸）
///
/// 支持"无图案自由绘制"：此时 outline 层为空白，用户笔迹用恒等适配（内容坐标=层坐标）。
/// 每帧由 CADisplayLink 调 render()。
final class DrawingEngine {
    weak var outlineLayer: CALayer?
    weak var historyLayer: CALayer?
    weak var brushLayer: CALayer?
    weak var pencilLayer: CALayer?

    private(set) var layerSize: CGSize = .zero
    private(set) var renderScale: CGFloat = 1

    // 图案播放状态（可空 = 自由绘制模式）
    var drawing: Drawing?
    var drawingID: String = ""
    var currentStep: Int = 0
    var stepProgress: CGFloat = 0
    var showGuide: Bool = true
    var view: ViewTransform = .identity

    // 用户绘制
    var userStrokes: [UserStroke] = []
    var liveStroke: UserStroke?
    /// Pencil 悬停点（层坐标，固定屏幕尺寸预览）
    var pencilPoint: CGPoint?
    var pencilVisible: Bool = false

    // 缓存（都在"无视图变换"层空间；尺寸/内容变化才重建，视图变化只改 blit 变换）
    private var guideCache: LayerCache?
    private var guideKey: String = ""
    private var doneCache: LayerCache?
    private var doneKey: String = ""
    private var userCache: LayerCache?
    private var userCacheKey: String = ""
    /// 用户内容变化计数（增/删/清）
    var contentVersion: Int = 0

    // 脏标记：只有输入变化的层才重建位图（避免每帧 4 次全分辨率分配）
    private var outlineDirty = true
    private var historyDirty = true
    private var brushDirty = true
    private var pencilDirty = true
    private var lastView: ViewTransform?
    private var lastBrushFingerprint: String?
    private var lastPencilFingerprint: String?

    // MARK: 内容空间适配（有图案=按 viewBox，无图案=恒等）

    func currentFit(size: CGSize) -> FitTransform {
        if let drawing { return fitTransform(size: size, drawing: drawing) }
        return FitTransform(scale: 1, offsetX: 0, offsetY: 0)
    }

    // MARK: 每帧渲染

    func render() {
        let size = outlineLayer?.bounds.size ?? .zero
        let scale = outlineLayer?.contentsScale ?? UIScreen.main.scale
        guard size != .zero else { return }
        if size != layerSize || scale != renderScale {
            layerSize = size
            renderScale = scale
            invalidateAll()
            markAllDirty()
        }

        let fit = currentFit(size: size)

        // 图案相关缓存（无图案时清空）
        if let drawing, !drawing.steps.isEmpty {
            if refreshGuideCache(size: size, drawing: drawing) { outlineDirty = true }
            if refreshDoneCache(size: size, drawing: drawing) { outlineDirty = true }
        } else {
            if guideCache != nil || doneCache != nil {
                guideCache = nil; guideKey = ""
                doneCache = nil; doneKey = ""
                outlineDirty = true
            }
        }

        // 用户笔迹缓存（始终）
        if refreshUserCache(size: size, fit: fit) { historyDirty = true }

        // 视图变化：四层都需重新 blit
        if lastView != view {
            lastView = view
            markAllDirty()
        }

        if outlineDirty {
            drawOutline(fit: fit)
            outlineDirty = false
        }
        if historyDirty {
            drawHistory()
            historyDirty = false
        }
        if brushDirty {
            let fp = liveStroke.map { "l|\($0.points.count)" } ?? "none"
            if fp != lastBrushFingerprint {
                drawBrush(fit: fit)
                lastBrushFingerprint = fp
                brushDirty = false
            }
        }
        if pencilDirty {
            let fp = "\(pencilPoint?.x ?? 0)|\(pencilPoint?.y ?? 0)|\(pencilVisible ? 1 : 0)"
            if fp != lastPencilFingerprint {
                drawPencil()
                lastPencilFingerprint = fp
                pencilDirty = false
            }
        }
    }

    // MARK: 脏标记入口

    func markPlayingStateDirty() { outlineDirty = true }
    func markContentDirty() { historyDirty = true; brushDirty = true }
    func markPencilDirty() { pencilDirty = true }

    private func markAllDirty() {
        outlineDirty = true
        historyDirty = true
        brushDirty = true
        pencilDirty = true
        lastBrushFingerprint = nil
        lastPencilFingerprint = nil
    }

    private func invalidateAll() {
        guideKey = ""
        doneKey = ""
        userCacheKey = ""
    }

    private func clearLayers() {
        outlineLayer?.contents = nil
        historyLayer?.contents = nil
        brushLayer?.contents = nil
        pencilLayer?.contents = nil
        markAllDirty()
    }

    // MARK: 缓存刷新（key 变化时重建，返回是否重建）

    private func refreshGuideCache(size: CGSize, drawing: Drawing) -> Bool {
        let key = "\(drawingID)|\(size.width)x\(size.height)|\(showGuide ? 1 : 0)"
        guard key != guideKey else { return false }
        guideKey = key
        guard showGuide, let cache = LayerCache(size: size, scale: renderScale) else {
            guideCache = nil
            return true
        }
        let fit = fitTransform(size: size, drawing: drawing)
        cache.contextAccess.saveGState()
        applyContentTransform(cache.contextAccess, size: size, fit: fit, view: .identity)
        cache.contextAccess.setAlpha(0.15)
        for step in drawing.steps {
            for stroke in step.strokes {
                cache.contextAccess.setStrokeColor(UIColor(hex: "#333333").cgColor)
                cache.contextAccess.setLineWidth(stroke.width)
                cache.contextAccess.setLineCap(.round)
                cache.contextAccess.setLineJoin(.round)
                let pts = stroke.cgPoints
                if pts.count >= 2 {
                    addSmoothPath(cache.contextAccess, pts)
                    cache.contextAccess.strokePath()
                }
            }
        }
        cache.contextAccess.restoreGState()
        cache.finalizeImage()
        guideCache = cache
        return true
    }

    private func refreshDoneCache(size: CGSize, drawing: Drawing) -> Bool {
        let key = "\(drawingID)|\(size.width)x\(size.height)|\(currentStep)"
        guard key != doneKey else { return false }
        doneKey = key
        guard let cache = LayerCache(size: size, scale: renderScale) else {
            doneCache = nil
            return true
        }
        let fit = fitTransform(size: size, drawing: drawing)
        cache.contextAccess.saveGState()
        applyContentTransform(cache.contextAccess, size: size, fit: fit, view: .identity)
        for i in 0..<min(currentStep, drawing.steps.count) {
            for stroke in drawing.steps[i].strokes {
                cache.contextAccess.setStrokeColor(UIColor.black.cgColor)
                cache.contextAccess.setLineWidth(stroke.width)
                cache.contextAccess.setLineCap(.round)
                cache.contextAccess.setLineJoin(.round)
                let pts = stroke.cgPoints
                if pts.count >= 2 {
                    addSmoothPath(cache.contextAccess, pts)
                    cache.contextAccess.strokePath()
                }
            }
        }
        cache.contextAccess.restoreGState()
        cache.finalizeImage()
        doneCache = cache
        return true
    }

    private func refreshUserCache(size: CGSize, fit: FitTransform) -> Bool {
        let key = "\(drawingID)|\(size.width)x\(size.height)|\(userStrokes.count)|\(contentVersion)"
        guard key != userCacheKey else { return false }
        userCacheKey = key
        guard !userStrokes.isEmpty, let cache = LayerCache(size: size, scale: renderScale) else {
            userCache = nil
            return true
        }
        cache.contextAccess.saveGState()
        applyContentTransform(cache.contextAccess, size: size, fit: fit, view: .identity)
        for stroke in userStrokes {
            renderUserStroke(cache.contextAccess, stroke: stroke)
        }
        cache.contextAccess.restoreGState()
        cache.finalizeImage()
        userCache = cache
        return true
    }

    // MARK: 各层

    private func newLayerContext() -> CGContext? {
        guard Int(layerSize.width * renderScale) > 0, Int(layerSize.height * renderScale) > 0 else {
            return nil
        }
        guard let ctx = CGContext(
            data: nil,
            width: Int(layerSize.width * renderScale),
            height: Int(layerSize.height * renderScale),
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        ctx.scaleBy(x: renderScale, y: renderScale)
        return ctx
    }

    private func drawOutline(fit: FitTransform) {
        guard let layer = outlineLayer else { return }
        guard let drawing, let ctx = newLayerContext() else {
            layer.contents = nil
            return
        }
        guideCache?.blit(into: ctx, view: view, size: layerSize)
        doneCache?.blit(into: ctx, view: view, size: layerSize)
        // 当前步骤动画部分（内容坐标 + 视图变换直接画）
        ctx.saveGState()
        applyContentTransform(ctx, size: layerSize, fit: fit, view: view)
        renderCurrentStep(ctx, drawing: drawing)
        ctx.restoreGState()
        layer.contents = ctx.makeImage()
    }

    private func drawHistory() {
        guard let layer = historyLayer else { return }
        guard let ctx = newLayerContext() else { return }
        userCache?.blit(into: ctx, view: view, size: layerSize)
        layer.contents = ctx.makeImage()
    }

    private func drawBrush(fit: FitTransform) {
        guard let layer = brushLayer else { return }
        guard let ctx = newLayerContext() else { return }
        if let live = liveStroke {
            ctx.saveGState()
            applyContentTransform(ctx, size: layerSize, fit: fit, view: view)
            renderUserStroke(ctx, stroke: live)
            ctx.restoreGState()
        }
        layer.contents = ctx.makeImage()
    }

    private func drawPencil() {
        guard let layer = pencilLayer else { return }
        guard pencilVisible, let p = pencilPoint, let img = pencilImage else {
            layer.contents = nil
            return
        }
        guard let ctx = newLayerContext() else { return }
        // 笔尖预览固定在层坐标（不随视图缩放），中心对准触点，笔尖朝上
        let w: CGFloat = 22
        let h: CGFloat = 33
        ctx.draw(img, in: CGRect(x: p.x - w / 2, y: p.y - h, width: w, height: h))
        layer.contents = ctx.makeImage()
    }

    /// 笔尖预览小图（懒生成）
    private var pencilImage: CGImage? = {
        guard let cs = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        let w: CGFloat = 48, h: CGFloat = 72
        guard let ctx = CGContext(
            data: nil, width: Int(w), height: Int(h),
            bitsPerComponent: 8, bytesPerRow: 0, space: cs,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        // 笔尖三角
        ctx.setFillColor(UIColor(hex: "#2B2B2B").cgColor)
        ctx.move(to: CGPoint(x: 0, y: h * 0.32))
        ctx.addLine(to: CGPoint(x: w, y: h * 0.32))
        ctx.addLine(to: CGPoint(x: w / 2, y: 0))
        ctx.closePath()
        ctx.fillPath()
        // 金属箍
        ctx.setFillColor(UIColor(hex: "#B0B7C3").cgColor)
        ctx.fill(CGRect(x: 0, y: h * 0.32, width: w, height: h * 0.08))
        // 笔杆
        ctx.setFillColor(UIColor(hex: "#EFE7D8").cgColor)
        ctx.fill(CGRect(x: 0, y: h * 0.4, width: w, height: h * 0.38))
        ctx.setFillColor(UIColor(hex: "#C9B892").cgColor)
        ctx.fill(CGRect(x: 0, y: h * 0.78, width: w, height: h * 0.22))
        return ctx.makeImage()
    }()

    // MARK: 当前步骤动画

    private func renderCurrentStep(_ ctx: CGContext, drawing: Drawing) {
        guard currentStep < drawing.steps.count else { return }
        let strokes = drawing.steps[currentStep].strokes
        guard !strokes.isEmpty else { return }

        if stepProgress >= 1 {
            for stroke in strokes { drawFullStroke(ctx, stroke) }
            return
        }

        let lengths = strokes.map { strokeLength($0.cgPoints) }
        let total = lengths.reduce(0, +)
        let highlight = UIColor(hex: "#E53935")

        if total == 0 {
            let per = stepProgress * CGFloat(strokes.count)
            let done = Int(per)
            for i in 0..<min(done, strokes.count) { drawFullStroke(ctx, strokes[i]) }
            if done < strokes.count {
                ctx.setStrokeColor(highlight.cgColor)
                drawPartialStroke(ctx, strokes[done], progress: per - CGFloat(done))
            }
        } else {
            let target = stepProgress * total
            var acc: CGFloat = 0
            for (i, len) in lengths.enumerated() {
                if acc + len >= target {
                    for j in 0..<i { drawFullStroke(ctx, strokes[j]) }
                    ctx.setStrokeColor(highlight.cgColor)
                    let prog = len > 0 ? (target - acc) / len : 1
                    drawPartialStroke(ctx, strokes[i], progress: prog)
                    return
                }
                acc += len
            }
            for stroke in strokes { drawFullStroke(ctx, stroke) }
        }
    }

    private func drawFullStroke(_ ctx: CGContext, _ stroke: StrokeJSON) {
        ctx.setStrokeColor(UIColor.black.cgColor)
        ctx.setLineWidth(stroke.width)
        ctx.setLineCap(.round)
        ctx.setLineJoin(.round)
        let pts = stroke.cgPoints
        guard pts.count >= 2 else { return }
        addSmoothPath(ctx, pts)
        ctx.strokePath()
    }

    private func drawPartialStroke(_ ctx: CGContext, _ stroke: StrokeJSON, progress: CGFloat) {
        ctx.setLineWidth(stroke.width)
        ctx.setLineCap(.round)
        ctx.setLineJoin(.round)
        let pts = stroke.cgPoints
        guard pts.count >= 2 else { return }
        addStrokePath(ctx, points: pts, progress: progress)
        ctx.strokePath()
    }

    // MARK: 导出（原始视图，不受当前缩放/平移影响）

    /// 合成完整作品：有图案时含全步骤+引导（若开），外加用户笔迹；无图案时仅用户笔迹。
    func exportImage() -> UIImage? {
        let size = layerSize == .zero ? CGSize(width: 800, height: 800) : layerSize
        let scale: CGFloat = 3
        guard let ctx = CGContext(
            data: nil,
            width: Int(size.width * scale),
            height: Int(size.height * scale),
            bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        ctx.scaleBy(x: scale, y: scale)
        ctx.setFillColor(UIColor.white.cgColor)
        ctx.fill(CGRect(origin: .zero, size: size))

        let fit = currentFit(size: size)

        if let drawing {
            // 引导层（导出时若开启则带上）
            if showGuide {
                buildGuide(size: size, scale: scale, drawing: drawing)?.blit(into: ctx, view: .identity, size: size)
            }
            // 全部步骤（合成完整作品，而非当前播放进度）
            let done = buildDone(size: size, scale: scale, drawing: drawing, upTo: drawing.steps.count)
            done?.blit(into: ctx, view: .identity, size: size)
        }

        // 用户笔迹（始终）
        if !userStrokes.isEmpty {
            if let cache = LayerCache(size: size, scale: scale) {
                cache.contextAccess.saveGState()
                applyContentTransform(cache.contextAccess, size: size, fit: fit, view: .identity)
                for stroke in userStrokes {
                    renderUserStroke(cache.contextAccess, stroke: stroke)
                }
                cache.contextAccess.restoreGState()
                cache.blit(into: ctx, view: .identity, size: size)
            }
        }

        guard let img = ctx.makeImage() else { return nil }
        return UIImage(cgImage: img)
    }

    private func buildGuide(size: CGSize, scale: CGFloat, drawing: Drawing) -> LayerCache? {
        guard let cache = LayerCache(size: size, scale: scale) else { return nil }
        let fit = fitTransform(size: size, drawing: drawing)
        cache.contextAccess.saveGState()
        applyContentTransform(cache.contextAccess, size: size, fit: fit, view: .identity)
        cache.contextAccess.setAlpha(0.15)
        for step in drawing.steps {
            for stroke in step.strokes {
                cache.contextAccess.setStrokeColor(UIColor(hex: "#333333").cgColor)
                cache.contextAccess.setLineWidth(stroke.width)
                cache.contextAccess.setLineCap(.round)
                cache.contextAccess.setLineJoin(.round)
                let pts = stroke.cgPoints
                if pts.count >= 2 {
                    addSmoothPath(cache.contextAccess, pts)
                    cache.contextAccess.strokePath()
                }
            }
        }
        cache.contextAccess.restoreGState()
        return cache
    }

    private func buildDone(size: CGSize, scale: CGFloat, drawing: Drawing, upTo: Int) -> LayerCache? {
        guard let cache = LayerCache(size: size, scale: scale) else { return nil }
        let fit = fitTransform(size: size, drawing: drawing)
        cache.contextAccess.saveGState()
        applyContentTransform(cache.contextAccess, size: size, fit: fit, view: .identity)
        for i in 0..<min(upTo, drawing.steps.count) {
            for stroke in drawing.steps[i].strokes {
                cache.contextAccess.setStrokeColor(UIColor.black.cgColor)
                cache.contextAccess.setLineWidth(stroke.width)
                cache.contextAccess.setLineCap(.round)
                cache.contextAccess.setLineJoin(.round)
                let pts = stroke.cgPoints
                if pts.count >= 2 {
                    addSmoothPath(cache.contextAccess, pts)
                    cache.contextAccess.strokePath()
                }
            }
        }
        cache.contextAccess.restoreGState()
        return cache
    }
}
