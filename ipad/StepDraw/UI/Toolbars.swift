import SwiftUI

// MARK: - 顶部工具栏（与 web 端 DrawingStudio 的 studio-top 一致）
//
// logo（最左，点它展开图案抽屉）｜ 绘制/移动 · 笔种图标 · 自定义颜色 · 粗细 · 撤销/清除/复位

struct TopBar: View {
    @ObservedObject var vm: DrawingViewModel

    var body: some View {
        ZStack {
            // 中间工具区（水平居中，不受 logo 影响）
            HStack(spacing: 6) {
                // 笔种图标（web 图标：钢笔/铅笔/马克/毛笔；点已选中的笔 → 退出绘制回到移动模式）
                ForEach(BrushKind.allCases) { kind in
                    let active = vm.brushKind == kind && vm.drawingMode
                    Button {
                        // 与 web handleStrokeTypeSelect 一致：
                        // 点已选中的笔 → 退出绘制（移动/平移）；点其它笔 → 选中并进入绘制
                        if active {
                            vm.drawingMode = false
                        } else {
                            vm.brushKind = kind
                            vm.drawingMode = true
                        }
                    } label: {
                        AppAssets.image(active ? kind.activeIconName : kind.iconName)
                            .resizable()
                            .scaledToFit()
                            .frame(width: 24, height: 24)
                            .frame(width: 38, height: 38)
                            .background(
                                active ? Color(white: 0.94) : .clear,
                                in: RoundedRectangle(cornerRadius: 10)
                            )
                            .overlay(
                                RoundedRectangle(cornerRadius: 10)
                                    .strokeBorder(active ? Color.accentColor : .clear, lineWidth: 1)
                            )
                    }
                    .buttonStyle(.plain)
                    .opacity(vm.drawingMode ? 1 : 0.5)
                    .help(kind.displayName)
                }

                // 自定义颜色（原生取色器圆点，显示当前色）
                ColorPicker("", selection: $vm.brushColor, supportsOpacity: false)
                    .labelsHidden()
                    .frame(width: 28, height: 28)
                    .opacity(vm.drawingMode ? 1 : 0.5)

                // 粗细（滑块 + 数值，无"粗细"文字）
                Slider(value: $vm.brushWidth, in: 1...24)
                    .frame(width: 110)
                Text("\(Int(vm.brushWidth))")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .frame(width: 22, alignment: .trailing)
                .opacity(vm.drawingMode ? 1 : 0.5)

                Divider().frame(height: 22)

                // 撤销 / 清除 / 复位（web 图标）
                TopIconButton(name: "undo", disabled: !vm.canUndo) {
                    vm.undo()
                }
                TopIconButton(name: "clear", disabled: !vm.canUndo) {
                    vm.showClearConfirm = true
                }
                TopIconButton(name: "reset", disabled: vm.view == .identity) {
                    vm.resetView()
                }
            }

            // 最左：logo（点击展开图案抽屉）
            HStack {
                Button {
                    withAnimation(.easeInOut(duration: 0.22)) { vm.showBrowser.toggle() }
                } label: {
                    AppAssets.image("logo")
                        .resizable()
                        .scaledToFit()
                        .frame(width: 36, height: 36)
                        .clipShape(Circle())
                        .overlay(Circle().strokeBorder(Color(.systemGray5), lineWidth: 1))
                }
                .buttonStyle(.plain)
                .help("图案")
                Spacer()
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }
}

/// 顶栏小工具图标（撤销/清除/复位）
private struct TopIconButton: View {
    let name: String
    var disabled: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            AppAssets.image(name)
                .resizable()
                .scaledToFit()
                .frame(width: 20, height: 20)
                .frame(width: 34, height: 34)
                .background(Color(.systemGray6), in: RoundedRectangle(cornerRadius: 9))
                .opacity(disabled ? 0.4 : 1)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
    }
}

// MARK: - 笔种 web 图标名

extension BrushKind {
    /// 普通态图标（web/src/assets）
    var iconName: String {
        switch self {
        case .pen: return "fountain_pen"
        case .pencil: return "pencil"
        case .marker: return "markpen"
        case .brush: return "ink_brush"
        }
    }
    /// 选中态图标（web 的 *_active 高亮版）
    var activeIconName: String {
        switch self {
        case .pen: return "fountain_active"
        case .pencil: return "pencil_active"
        case .marker: return "mark_pen_active"
        case .brush: return "ink_brush_active"
        }
    }
}

// MARK: - 右侧全高操作栏（与 web 的 studio-right 一致：白底 + 左边线，占满高度）

struct RightSidebar: View {
    @ObservedObject var vm: DrawingViewModel

    var body: some View {
        VStack(spacing: 12) {
            SideAction(name: "save", label: "保存") {
                vm.saveToPhotos()
            }
            SideAction(name: "share", label: "分享") {
                Task { await vm.shareImage() }
            }
            Spacer()
        }
        .padding(.vertical, 14)
        .padding(.horizontal, 8)
        .frame(width: 64)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Color(.systemBackground))
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(Color(.systemGray5))
                .frame(width: 1)
        }
    }
}

/// 右侧栏按钮：图标 + 文字（web studio-save-btn 样式）
private struct SideAction: View {
    let name: String
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 5) {
                AppAssets.image(name)
                    .resizable()
                    .scaledToFit()
                    .frame(width: 24, height: 24)
                Text(label)
                    .font(.system(size: 11))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .foregroundStyle(Color(white: 0.2))
            .background(Color(white: 0.98), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color(.systemGray5), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - 底部播放控制（单行，web 图标）

struct BottomToolbar: View {
    @ObservedObject var vm: DrawingViewModel

    private var noDrawing: Bool { vm.drawing == nil }

    var body: some View {
        HStack(spacing: 10) {
            // 轮廓开关（cat_solid / cat_solid_active）
            BottomIconButton(
                name: vm.showGuide ? "cat-solid-active" : "cat-solid",
                size: 40,
                disabled: noDrawing
            ) {
                vm.toggleGuide()
            }

            Divider().frame(height: 24)

            BottomIconButton(
                name: "pre",
                size: 40,
                disabled: noDrawing || (vm.currentStep == 0 && vm.stepProgress == 0)
            ) {
                vm.prevStep()
            }
            // 播放 / 暂停（play.png / stop.png）
            BottomIconButton(
                name: vm.playing ? "stop" : "play",
                size: 44,
                disabled: noDrawing
            ) {
                vm.togglePlay()
            }
            BottomIconButton(
                name: "next",
                size: 40,
                disabled: noDrawing || (vm.currentStep == vm.totalSteps - 1 && vm.stepProgress >= 1)
            ) {
                vm.nextStep()
            }
            // 重播
            BottomIconButton(name: "refresh", size: 40, disabled: noDrawing) {
                vm.replay()
            }

            // 倍速
            Button {
                vm.cycleSpeed()
            } label: {
                Text("\(vm.speed.formatted())x")
                    .font(.subheadline.weight(.semibold).monospacedDigit())
                    .frame(width: 46, height: 40)
                    .background(Color(.systemGray6), in: RoundedRectangle(cornerRadius: 10))
                    .opacity(noDrawing ? 0.4 : 1)
            }
            .buttonStyle(.plain)
            .disabled(noDrawing)

            // 进度条
            ProgressSlider(vm: vm)
                .frame(maxWidth: .infinity)
                .disabled(noDrawing)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(.bar)
    }
}

/// 底部播放图标按钮（圆形，web 图标）
private struct BottomIconButton: View {
    let name: String
    var size: CGFloat = 40
    var disabled: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            AppAssets.image(name)
                .resizable()
                .scaledToFit()
                .frame(width: size * 0.56, height: size * 0.56)
                .frame(width: size, height: size)
                .background(Color(.systemGray6), in: Circle())
                .opacity(disabled ? 0.4 : 1)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
    }
}

/// 自定义进度条（拖动时暂停播放，拖动期间不被动画覆盖）
struct ProgressSlider: View {
    @ObservedObject var vm: DrawingViewModel

    var body: some View {
        Slider(
            value: Binding(
                get: { vm.progressSliderValue },
                set: { vm.setGlobalProgress($0) }
            ),
            in: 0...1
        ) { editing in
            vm.sliderEditing = editing
        }
    }
}
