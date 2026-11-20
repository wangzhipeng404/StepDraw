import CoreGraphics
import QuartzCore

// ============================================================
// 视图变换（缩放 / 平移）
//
// 内容坐标系：图案 viewBox 坐标。
// 适配变换（fit）：把 contentRect 等比缩放到画布（留 15% 边距）居中。
// 视图变换（view）：叠加在适配之上，以画布中心为缩放中心，用户手势产生。
//
// 层坐标 p' = C + t + s * (fit(p) - C)，C = 画布中心。
// 用户笔画以内容坐标存储，缩放/平移只是显示层变换，导出与复位不受影响。
// ============================================================

struct ViewTransform: Equatable {
    var scale: CGFloat   // 1 = 原始大小
    var tx: CGFloat      // 平移（层坐标）
    var ty: CGFloat

    static let identity = ViewTransform(scale: 1, tx: 0, ty: 0)
}

let minViewScale: CGFloat = 0.3
let maxViewScale: CGFloat = 5
func clampScale(_ s: CGFloat) -> CGFloat { min(maxViewScale, max(minViewScale, s)) }

/// 以画布中心为锚点缩放：给定锚点前的 scale 与平移，返回缩放后使锚点保持不动的平移。
func zoomAnchored(_ view: ViewTransform, newScale: CGFloat, anchorX: CGFloat, anchorY: CGFloat) -> ViewTransform {
    let factor = newScale / view.scale
    return ViewTransform(
        scale: newScale,
        tx: anchorX - factor * (anchorX - view.tx),
        ty: anchorY - factor * (anchorY - view.ty)
    )
}

/// 把内容坐标点换算成层坐标点
func toLayerPoint(_ p: CGPoint, size: CGSize, fit: FitTransform, view: ViewTransform) -> CGPoint {
    let c = CGPoint(x: size.width / 2, y: size.height / 2)
    let fitP = CGPoint(x: p.x * fit.scale + fit.offsetX, y: p.y * fit.scale + fit.offsetY)
    return CGPoint(
        x: c.x + view.tx + view.scale * (fitP.x - c.x),
        y: c.y + view.ty + view.scale * (fitP.y - c.y)
    )
}

/// 把层坐标点（触点在 layer.bounds 内的坐标）换算回内容坐标
func toImagePoint(_ p: CGPoint, size: CGSize, fit: FitTransform, view: ViewTransform) -> CGPoint {
    let c = CGPoint(x: size.width / 2, y: size.height / 2)
    let x = (p.x - c.x - view.tx) / view.scale + c.x
    let y = (p.y - c.y - view.ty) / view.scale + c.y
    return CGPoint(x: (x - fit.offsetX) / fit.scale, y: (y - fit.offsetY) / fit.scale)
}

/// 图案内容在画布上的适配变换
struct FitTransform: Equatable {
    var scale: CGFloat
    var offsetX: CGFloat
    var offsetY: CGFloat
}

func fitTransform(size: CGSize, drawing: Drawing) -> FitTransform {
    let r = drawing.contentRect
    guard r.width > 0, r.height > 0 else {
        return FitTransform(scale: 1, offsetX: 0, offsetY: 0)
    }
    let margin: CGFloat = 0.85
    let scale = min(size.width * margin / r.width, size.height * margin / r.height)
    let offsetX = (size.width - r.width * scale) / 2 - r.minX * scale
    let offsetY = (size.height - r.height * scale) / 2 - r.minY * scale
    return FitTransform(scale: scale, offsetX: offsetX, offsetY: offsetY)
}

/// 把「适配 + 视图」合成后的变换设置到上下文上，之后按内容坐标绘制即可。
func applyContentTransform(_ ctx: CGContext, size: CGSize, fit: FitTransform, view: ViewTransform) {
    let c = CGPoint(x: size.width / 2, y: size.height / 2)
    let s = view.scale
    // 层 = content * (s*fit.scale) + (s*offset + t + c*(1-s))
    let tx = s * fit.offsetX + view.tx + c.x * (1 - s)
    let ty = s * fit.offsetY + view.ty + c.y * (1 - s)
    ctx.concatenate(CGAffineTransform(a: s * fit.scale, b: 0, c: 0, d: s * fit.scale, tx: tx, ty: ty))
}

// ============================================================
// 笔画几何
// ============================================================

/// 笔画总长度（采样折线长度，用于进度插值）
func strokeLength(_ points: [CGPoint]) -> CGFloat {
    guard points.count > 1 else { return 0 }
    var total: CGFloat = 0
    for i in 1..<points.count {
        total += points[i].distance(to: points[i - 1])
    }
    return total
}

extension CGPoint {
    func distance(to p: CGPoint) -> CGFloat {
        hypot(p.x - x, p.y - y)
    }
}
