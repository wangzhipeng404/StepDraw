import SwiftUI

/// 主界面：顶部信息栏 + 中间画布 + 右侧操作栏 + 底部工具栏
struct MainView: View {
    @StateObject private var vm = DrawingViewModel()

    var body: some View {
        GeometryReader { geo in
            // 顶栏/底栏/右侧栏是 safeAreaInset，会收缩安全区；
            // 用 safeAreaInsets 算出真正可用的画布区域，避免被顶栏/底栏遮住。
            let inset = geo.safeAreaInsets
            let avail = CGRect(
                x: inset.left,
                y: inset.top,
                width: max(1, geo.size.width - inset.left - inset.right),
                height: max(1, geo.size.height - inset.top - inset.bottom)
            )
            let canvasRect = canvasRect(in: avail)
            ZStack {
                Color(.systemGroupedBackground).ignoresSafeArea()

                // 画布（正方形，居中于可用空间）
                CanvasContainer(viewModel: vm)
                    .frame(width: canvasRect.width, height: canvasRect.height)
                    .position(x: canvasRect.midX, y: canvasRect.midY)
                    .clipShape(RoundedRectangle(cornerRadius: 16))
                    .overlay(
                        RoundedRectangle(cornerRadius: 16)
                            .stroke(Color(.systemSeparator), lineWidth: 1)
                    )

                // 加载态
                if vm.loadingDrawing {
                    VStack(spacing: 12) {
                        ProgressView().controlSize(.large)
                        Text("图案加载中…").foregroundStyle(.secondary)
                    }
                    .frame(width: canvasRect.width, height: canvasRect.height)
                    .position(x: canvasRect.midX, y: canvasRect.midY)
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
                } else if vm.drawing == nil && !vm.canUndo {
                    // 顶部小提示（不覆盖画布，不挡绘制）
                    HStack(spacing: 10) {
                        Image(systemName: "pencil.and.outline")
                            .foregroundStyle(.secondary)
                        Text("空白画布，直接开画")
                            .font(.subheadline.weight(.medium))
                        Button {
                            vm.showPatternSheet = true
                        } label: {
                            Label("或选择图案临摹", systemImage: "square.grid.2x2")
                                .font(.subheadline.weight(.medium))
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
                    .position(x: canvasRect.midX, y: canvasRect.minY + 44)
                }

                // 缩放指示（视图偏离 1x 时短暂显示，画布右上角）
                if vm.showScaleIndicator {
                    Text("\(vm.view.scale.formatted(.number.precision(.fractionLength(1))))×")
                        .font(.headline.monospacedDigit())
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 8))
                        .position(x: canvasRect.maxX - 44, y: canvasRect.minY + 28)
                        .allowsHitTesting(false)
                        .transition(.opacity)
                }
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            TopBar(vm: vm)
        }
        .safeAreaInset(edge: .trailing, spacing: 0) {
            RightSidebar(vm: vm)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            BottomToolbar(vm: vm)
        }
        .ignoresSafeArea(.keyboard)
        .sheet(isPresented: $vm.showPatternSheet) {
            PatternBrowserSheet { categoryId, item in
                Task { await vm.loadDrawing(categoryId: categoryId, item: item) }
            }
        }
        .confirmationDialog(
            "确定要清除所有绘制内容吗？",
            isPresented: $vm.showClearConfirm,
            titleVisibility: .visible
        ) {
            Button("清空画布", role: .destructive) { vm.clearAll() }
            Button("取消", role: .cancel) {}
        }
        .alert(
            "清除图案并回到空白画布？",
            isPresented: $vm.showRemovePatternConfirm
        ) {
            Button("回到空白画布", role: .destructive) { vm.removePattern() }
            Button("取消", role: .cancel) {}
        } message: {
            Text("图案与你的笔迹会一并清除。")
        }
        .overlay(alignment: .bottom) {
            if let toast = vm.toast {
                HStack(spacing: 8) {
                    Image(systemName: toast.icon).foregroundColor(.white)
                    Text(toast.message).foregroundColor(.white)
                }
                .font(.subheadline.weight(.medium))
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(.black.opacity(0.75), in: Capsule())
                .padding(.bottom, 96)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.spring(duration: 0.3), value: vm.toast)
        .preferredColorScheme(.light)
        .task {
            try? await DataStore.shared.loadMainIndex()
        }
    }

    /// 在可用区域内取最大正方形并居中
    private func canvasRect(in area: CGRect) -> CGRect {
        let side = max(1, min(area.width, area.height))
        return CGRect(
            x: area.midX - side / 2,
            y: area.midY - side / 2,
            width: side,
            height: side
        )
    }
}

#Preview {
    MainView()
}
