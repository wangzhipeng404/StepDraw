import SwiftUI

// MARK: - 顶部信息栏

/// 左侧：返回空白 / 图案名 + 步骤提示；右侧：模式切换 + 选图案 + 视图复位
struct TopBar: View {
    @ObservedObject var vm: DrawingViewModel

    var body: some View {
        HStack(spacing: 14) {
            // 左：当前图案
            HStack(spacing: 10) {
                if let d = vm.drawing {
                    Text(d.displayName)
                        .font(.headline)
                        .lineLimit(1)
                    Text("\(vm.currentStep + 1)/\(max(vm.totalSteps, 1)) 步")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Button {
                        vm.showRemovePatternConfirm = true
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.body)
                            .foregroundStyle(.tertiary)
                    }
                    .buttonStyle(.plain)
                    if let tip = d.steps[vm.currentStep].tip, !tip.isEmpty {
                        Text(tip)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                } else {
                    Text("一笔一笔")
                        .font(.headline)
                    Text("自由绘制")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            // 右：操作
            HStack(spacing: 8) {
                // 模式切换：绘制 / 导航
                Button {
                    withAnimation(.snappy) { vm.toggleDrawMode() }
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: vm.drawingMode ? "hand.draw" : "hand.point.up")
                        Text(vm.drawingMode ? "绘制" : "移动")
                            .font(.subheadline.weight(.medium))
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .background(
                        vm.drawingMode ? Color.accentColor.opacity(0.15) : Color(.systemGray6),
                        in: RoundedRectangle(cornerRadius: 9)
                    )
                    .foregroundColor(vm.drawingMode ? Color.accentColor : .primary)
                }

                // 选图案
                Button {
                    vm.showPatternSheet = true
                } label: {
                    Label("图案", systemImage: "square.grid.2x2")
                        .font(.subheadline.weight(.medium))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .background(Color(.systemGray6), in: RoundedRectangle(cornerRadius: 9))
                }

                // 视图复位
                Button {
                    vm.resetView()
                } label: {
                    Image(systemName: "arrow.counterclockwise")
                        .font(.body.weight(.semibold))
                        .frame(width: 36, height: 36)
                        .background(Color(.systemGray6), in: RoundedRectangle(cornerRadius: 9))
                }
                .disabled(vm.view == .identity)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
    }
}

// MARK: - 右侧操作栏

/// 保存 / 分享 / 撤销 / 清空
struct RightSidebar: View {
    @ObservedObject var vm: DrawingViewModel

    var body: some View {
        VStack(spacing: 14) {
            SideButton(icon: "square.and.arrow.down", label: "保存") {
                vm.saveToPhotos()
            }
            SideButton(icon: "square.and.arrow.up", label: "分享") {
                Task { await vm.shareImage() }
            }
            Divider().frame(width: 22)
            SideButton(icon: "arrow.uturn.backward", label: "撤销", disabled: !vm.canUndo) {
                vm.undo()
            }
            SideButton(icon: "trash", label: "清空", disabled: !vm.canUndo) {
                vm.showClearConfirm = true
            }
        }
        .padding(.vertical, 14)
        .padding(.trailing, 14)
        .frame(width: 64)
        .background(
            RoundedRectangle(cornerRadius: 14)
                .fill(.regularMaterial)
        )
        .padding(.trailing, 10)
    }
}

private struct SideButton: View {
    let icon: String
    let label: String
    var disabled: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 3) {
                Image(systemName: icon)
                    .font(.system(size: 18, weight: .medium))
                Text(label)
                    .font(.system(size: 10))
            }
            .frame(width: 44, height: 46)
            .foregroundColor(disabled ? Color(.systemGray3) : Color.accentColor)
            .contentShape(Rectangle())
        }
        .disabled(disabled)
        .buttonStyle(.plain)
    }
}

// MARK: - 底部工具栏

/// 播放控制 + 进度条 + 画笔选择（颜色/粗细/笔种）
struct BottomToolbar: View {
    @ObservedObject var vm: DrawingViewModel

    var body: some View {
        VStack(spacing: 10) {
            // 上排：播放控制 + 进度
            HStack(spacing: 10) {
                // 引导轮廓开关
                toggleButton(
                    icon: vm.showGuide ? "square.dashed.inset.filled" : "square.dashed",
                    label: "轮廓",
                    active: vm.showGuide
                ) { vm.toggleGuide() }

                Divider().frame(height: 24)

                // 上一步
                playButton(icon: "chevron.left", disabled: vm.currentStep == 0 && vm.stepProgress == 0) {
                    vm.prevStep()
                }
                // 播放/暂停
                Button {
                    vm.togglePlay()
                } label: {
                    Image(systemName: vm.playing ? "pause.fill" : "play.fill")
                        .font(.title2)
                        .foregroundColor(.white)
                        .frame(width: 44, height: 44)
                        .background(Color.accentColor, in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(vm.drawing == nil)
                // 下一步
                playButton(icon: "chevron.right", disabled: vm.currentStep == vm.totalSteps - 1 && vm.stepProgress >= 1) {
                    vm.nextStep()
                }
                // 重播
                playButton(icon: "arrow.counterclockwise") {
                    vm.replay()
                }
                // 倍速
                Button {
                    vm.cycleSpeed()
                } label: {
                    Text("\(vm.speed.formatted())x")
                        .font(.subheadline.weight(.semibold).monospacedDigit())
                        .frame(width: 44, height: 44)
                        .background(Color(.systemGray6), in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(vm.drawing == nil)

                // 进度条
                ProgressSlider(vm: vm)
                    .frame(maxWidth: .infinity)
                    .disabled(vm.drawing == nil)
            }

            // 下排：画笔
            HStack(spacing: 12) {
                // 颜色
                HStack(spacing: 6) {
                    ForEach(paletteColors, id: \.self) { c in
                        Circle()
                            .fill(c)
                            .frame(width: 24, height: 24)
                            .overlay(
                                Circle()
                                    .stroke(vm.brushColor == c ? Color.accentColor : .clear, lineWidth: 2.5)
                                    .padding(-3)
                            )
                            .onTapGesture { vm.brushColor = c }
                    }
                    // 自定义色
                    ColorPicker("", selection: $vm.brushColor)
                        .labelsHidden()
                        .frame(width: 24, height: 24)
                }
                .disabled(!vm.drawingMode)

                Divider().frame(height: 24)

                // 粗细
                HStack(spacing: 4) {
                    Image(systemName: "pencil.tip.crop.circle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Slider(value: $vm.brushWidth, in: 1...24)
                        .frame(maxWidth: 180)
                    Text("\(Int(vm.brushWidth))")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .frame(width: 22, alignment: .trailing)
                }
                .disabled(!vm.drawingMode)

                Divider().frame(height: 24)

                // 笔种
                HStack(spacing: 4) {
                    ForEach(BrushKind.allCases) { kind in
                        Button {
                            vm.brushKind = kind
                            if !vm.drawingMode { vm.drawingMode = true }
                        } label: {
                            Image(systemName: kind.symbol)
                                .font(.body)
                                .frame(width: 38, height: 38)
                                .background(
                                    vm.brushKind == kind && vm.drawingMode
                                        ? Color.accentColor.opacity(0.18)
                                        : Color(.systemGray6),
                                    in: RoundedRectangle(cornerRadius: 9)
                                )
                                .foregroundColor(vm.brushKind == kind && vm.drawingMode ? Color.accentColor : .primary)
                        }
                        .buttonStyle(.plain)
                        .help(kind.displayName)
                    }
                }
                .disabled(!vm.drawingMode)

                Spacer(minLength: 0)

                // 提示：当前手势说明
                Text(vm.drawingMode
                     ? "单指绘制 · 双指缩放/移动"
                     : "单指移动 · 双指缩放 · 点「绘制」开始画")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private func playButton(icon: String, disabled: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.body.weight(.semibold))
                .frame(width: 40, height: 40)
                .background(disabled ? Color(.systemGray5) : Color(.systemGray6), in: Circle())
                .foregroundColor(disabled ? Color(.systemGray3) : .primary)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
    }

    private func toggleButton(icon: String, label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 2) {
                Image(systemName: icon)
                    .font(.body.weight(.medium))
                Text(label)
                    .font(.system(size: 10))
            }
            .frame(width: 46, height: 44)
            .foregroundColor(active ? Color.accentColor : Color(.systemGray))
            .background(
                active ? Color.accentColor.opacity(0.15) : Color(.systemGray6),
                in: RoundedRectangle(cornerRadius: 9)
            )
        }
        .buttonStyle(.plain)
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
