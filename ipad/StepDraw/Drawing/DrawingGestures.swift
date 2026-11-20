import UIKit
import SwiftUI

// MARK: - 手势视图

/// 触摸 + Apple Pencil 手势采集，叠在画布层之上。
///
/// 模式：
/// - 绘制模式：单指/Pencil 落笔绘制；绘制中落下第二指 → 结束当前笔并转捏合
/// - 导航模式：单指/Pencil 拖拽平移，双指捏合缩放
///
/// 回调均传"层坐标"（view.bounds 内的坐标），由 ViewModel 换算成内容坐标。
final class DrawingGestureView: UIView {
    var isDrawingMode: Bool = false

    var onDrawBegan: ((CGPoint) -> Void)?
    var onDrawMoved: ((CGPoint) -> Void)?
    var onDrawEnded: (() -> Void)?
    var onPan: ((CGPoint) -> Void)?                    // 层坐标增量
    var onPinch: ((CGFloat, CGPoint) -> Void)?         // 相对上次的倍率, 锚点(层坐标, 相对画布中心)
    var onPencilHover: ((CGPoint?) -> Void)?           // Pencil 悬停点(层坐标)

    private struct TrackedPointer {
        var location: CGPoint
    }

    private var pointers: [UITouch: TrackedPointer] = [:]
    private var gesture: String = "none"   // none / draw / pan / pinch
    private var drawTouch: UITouch?
    private var lastPanLocation: CGPoint = .zero
    private var lastPinchDist: CGFloat = 0

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        isMultipleTouchEnabled = true
        #if targetEnvironment(ipad)
        let hover = UIHoverGestureRecognizer(target: self, action: #selector(handleHover(_:)))
        hover.minimumPressDuration = 0
        addGestureRecognizer(hover)
        #endif
    }

    required init?(coder: NSCoder) { fatalError() }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        for t in touches {
            pointers[t] = TrackedPointer(location: t.location(in: self))
        }
        classifyAfterChange()
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        for t in touches {
            guard var p = pointers[t] else { continue }
            p.location = t.location(in: self)
            pointers[t] = p
        }
        dispatchMove()
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        for t in touches { pointers[t] = nil }
        dispatchEnd()
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        for t in touches { pointers[t] = nil }
        dispatchEnd()
    }

    // MARK: 手势判定

    private func classifyAfterChange() {
        guard !pointers.isEmpty else {
            if gesture == "draw" { onDrawEnded?() }
            gesture = "none"
            drawTouch = nil
            return
        }

        if pointers.count >= 2 {
            if gesture == "draw" {
                // 绘制中落下第二指：结束当前笔，转捏合
                onDrawEnded?()
                drawTouch = nil
            }
            let locs = pointers.values.map(\.location)
            lastPinchDist = locs[0].distance(to: locs[1])
            gesture = "pinch"
            return
        }

        // 单指
        guard let (touch, p) = pointers.first else { return }
        if gesture == "pinch" {
            // 双指变单指：转平移
            gesture = "pan"
            lastPanLocation = p.location
            return
        }
        if isDrawingMode {
            if gesture != "draw" {
                gesture = "draw"
                drawTouch = touch
                onDrawBegan?(p.location)
            }
        } else {
            if gesture != "pan" {
                gesture = "pan"
                lastPanLocation = p.location
            }
        }
    }

    private func dispatchMove() {
        let active = pointers.values

        if gesture == "pinch" {
            guard active.count >= 2, lastPinchDist > 0 else { return }
            let locs = Array(active.prefix(2)).map(\.location)
            let dist = locs[0].distance(to: locs[1])
            let mid = CGPoint(x: (locs[0].x + locs[1].x) / 2, y: (locs[0].y + locs[1].y) / 2)
            let anchor = CGPoint(x: mid.x - bounds.width / 2, y: mid.y - bounds.height / 2)
            if dist > 0 {
                let factor = dist / lastPinchDist
                lastPinchDist = dist
                onPinch?(factor, anchor)
            }
            return
        }

        if gesture == "pan", let p = active.first {
            let delta = CGPoint(x: p.location.x - lastPanLocation.x, y: p.location.y - lastPanLocation.y)
            lastPanLocation = p.location
            onPan?(delta)
            return
        }

        if gesture == "draw", let dt = drawTouch, let stored = pointers[dt] {
            onDrawMoved?(stored.location)
        }
    }

    private func dispatchEnd() {
        let active = pointers.values

        if gesture == "pinch" {
            if active.count == 1 {
                gesture = "pan"
                lastPanLocation = active.first!.location
            } else {
                gesture = "none"
            }
            return
        }

        if gesture == "draw" {
            // 绘图指抬起（或所有指抬起）→ 结束笔画
            let stillThere = drawTouch.map { pointers[$0] != nil } ?? false
            if !stillThere {
                onDrawEnded?()
                gesture = "none"
                drawTouch = nil
            }
            return
        }

        if gesture == "pan", active.isEmpty {
            gesture = "none"
        }
    }

    // MARK: Pencil 悬停

    @objc private func handleHover(_ gr: UIHoverGestureRecognizer) {
        switch gr.state {
        case .began, .changed:
            onPencilHover?(gr.location(in: self))
        default:
            onPencilHover?(nil)
        }
    }
}

// MARK: - 画布容器

/// 四层 CALayer（outline/history/brush/pencil）+ 手势视图 + CADisplayLink。
/// DisplayLink 每帧调 ViewModel.tick()（先推进动画，再渲染）。
struct CanvasContainer: UIViewRepresentable {
    let viewModel: DrawingViewModel

    func makeUIView(context: Context) -> CanvasHostView {
        CanvasHostView(viewModel: viewModel)
    }

    func updateUIView(_ uiView: CanvasHostView, context: Context) {
        uiView.gestureView.isDrawingMode = viewModel.drawingMode
    }

    final class CanvasHostView: UIView {
        weak var viewModel: DrawingViewModel?

        let outlineLayer = CALayer()
        let historyLayer = CALayer()
        let brushLayer = CALayer()
        let pencilLayer = CALayer()
        let gestureView = DrawingGestureView()
        private var displayLink: CADisplayLink?

        init(viewModel: DrawingViewModel) {
            self.viewModel = viewModel
            super.init(frame: .zero)
            backgroundColor = .clear

            for (i, layer) in [outlineLayer, historyLayer, brushLayer, pencilLayer].enumerated() {
                layer.backgroundColor = UIColor.white.cgColor
                layerStack.insertSublayer(layer, at: i)
            }
            gestureView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            addSubview(gestureView)

            wireEngine()
            wireGestures()

            let link = CADisplayLink(target: self, selector: #selector(tick))
            link.add(to: .main, forMode: .common)
            displayLink = link
        }

        required init?(coder: NSCoder) { fatalError() }

        private func wireEngine() {
            guard let vm = viewModel else { return }
            vm.engine.outlineLayer = outlineLayer
            vm.engine.historyLayer = historyLayer
            vm.engine.brushLayer = brushLayer
            vm.engine.pencilLayer = pencilLayer
        }

        private func wireGestures() {
            gestureView.onDrawBegan = { [weak self] p in self?.viewModel?.beginStroke(layerPoint: p) }
            gestureView.onDrawMoved = { [weak self] p in self?.viewModel?.extendStroke(layerPoint: p) }
            gestureView.onDrawEnded = { [weak self] in self?.viewModel?.endStroke() }
            gestureView.onPan = { [weak self] d in self?.viewModel?.pan(by: d) }
            gestureView.onPinch = { [weak self] f, a in self?.viewModel?.pinch(factor: f, anchor: a) }
            gestureView.onPencilHover = { [weak self] p in self?.viewModel?.updatePencilHover(layerPoint: p) }
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            gestureView.frame = bounds
            for layer in [outlineLayer, historyLayer, brushLayer, pencilLayer] {
                layer.frame = bounds
                layer.contentsScale = UIScreen.main.scale
            }
        }

        /// 视图离屏时停掉 DisplayLink，避免 retain 环导致泄漏
        override func willMove(toWindow newWindow: UIWindow?) {
            super.willMove(toWindow: newWindow)
            if newWindow == nil {
                displayLink?.invalidate()
                displayLink = nil
            }
        }

        @objc private func tick() {
            viewModel?.tick()
        }
    }
}
