import SwiftUI

// MARK: - 主界面：全屏画布 + 左侧抽屉式图案浏览
//
// 画布默认全屏（矩形，图案按适配变换居中留边距，边距区也能画）。
// 顶栏「图案」图标切换左侧抽屉（分组→分类→图案网格）；
// 点图案载入画布并自动收起抽屉，抽屉内浏览不跳转（保持当前层级）。

struct MainView: View {
    @StateObject private var vm = DrawingViewModel()

    var body: some View {
        DrawingPane(vm: vm)
            .preferredColorScheme(.light)
            .task {
                try? await DataStore.shared.loadMainIndex()
            }
    }
}

// MARK: - 绘制工作台

/// 顶栏/底栏/右侧栏是 safeAreaInset，会收缩安全区；
/// 用 safeAreaInsets 算出真正可用的画布区域，画布填满该区域（矩形）。
/// 图案抽屉叠在画布左侧（顶栏之下），默认藏在屏幕外，点击顶栏图标滑入。
struct DrawingPane: View {
    @ObservedObject var vm: DrawingViewModel

    var body: some View {
        GeometryReader { geo in
            let inset = geo.safeAreaInsets
            let avail = CGRect(
                x: inset.leading,
                y: inset.top,
                width: max(1, geo.size.width - inset.leading - inset.trailing),
                height: max(1, geo.size.height - inset.top - inset.bottom)
            )
            // 抽屉宽度：按比例，窄屏收窄
            let drawerW = min(400, max(300, geo.size.width * 0.4))
            ZStack {
                Color(.systemGroupedBackground).ignoresSafeArea()

                // 画布（填满可用空间，矩形；图案按适配变换居中留边距）
                CanvasContainer(viewModel: vm)
                    .frame(width: avail.width, height: avail.height)
                    .position(x: avail.midX, y: avail.midY)

                // 加载态
                if vm.loadingDrawing {
                    VStack(spacing: 12) {
                        ProgressView().controlSize(.large)
                        Text("图案加载中…").foregroundStyle(.secondary)
                    }
                    .frame(width: avail.width, height: avail.height)
                    .position(x: avail.midX, y: avail.midY)
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
                }

                // 缩放指示（视图偏离 1x 时短暂显示，画布右上角）
                if vm.showScaleIndicator {
                    Text(String(format: "%.1f×", vm.view.scale))
                        .font(.headline.monospacedDigit())
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 8))
                        .position(x: avail.maxX - 44, y: avail.minY + 28)
                        .allowsHitTesting(false)
                        .transition(.opacity)
                }

                // 步骤提示（画布右下角，与 web studio-step-tip 一致）
                if let tip = vm.drawing?.steps[vm.currentStep].tip, !tip.isEmpty {
                    Text(tip)
                        .font(.subheadline)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(Color.black.opacity(0.55), in: Capsule())
                        .padding([.trailing, .bottom], 12)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                        .allowsHitTesting(false)
                        .transition(.opacity)
                }
            }
            .overlay(alignment: .topLeading) {
                // 图案抽屉：默认藏在画布左侧外（offset 移出屏幕），点击顶栏图标滑入
                PatternBrowser(currentDrawingId: vm.drawing?.id) { categoryId, item in
                    vm.showBrowser = false
                    Task { await vm.loadDrawing(categoryId: categoryId, item: item) }
                }
                .frame(width: drawerW, height: avail.height)
                .background(Color(.systemBackground))
                .shadow(color: .black.opacity(0.18), radius: 10, x: 4, y: 0)
                .offset(x: vm.showBrowser ? 0 : -drawerW - 24, y: inset.top)
                .allowsHitTesting(vm.showBrowser)
                .animation(.easeInOut(duration: 0.22), value: vm.showBrowser)
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
        .confirmationDialog(
            "确定要清除所有绘制内容吗？",
            isPresented: $vm.showClearConfirm,
            titleVisibility: .visible
        ) {
            Button("清空画布", role: .destructive) { vm.clearAll() }
            Button("取消", role: .cancel) {}
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
    }
}
