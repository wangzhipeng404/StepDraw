import SwiftUI

/// 图案选择 sheet：分组 → 分类 → 图案网格（搜索/难度筛选/分页）。
/// 用 NavigationStack path 管理三级导航。
struct PatternBrowserSheet: View {
    @Environment(\.dismiss) private var dismiss
    var onSelect: (String, DrawingItem) -> Void

    @StateObject private var model = PatternBrowserModel()
    @State private var path: [Route] = []

    enum Route: Hashable {
        case group(MainGroup)
        case category(MainCategory)
    }

    var body: some View {
        NavigationStack(path: $path) {
            GroupListView(model: model) { group in
                path.append(.group(group))
            }
            .navigationTitle("选择图案")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("完成") { dismiss() }
                }
            }
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .group(let group):
                    CategoryListView(model: model, group: group) { cat in
                        path.append(.category(cat))
                    }
                case .category(let cat):
                    DrawingGridView(categoryId: cat.id, categoryName: cat.displayName) { item in
                        dismiss()
                        onSelect(cat.id, item)
                    }
                }
            }
        }
        .frame(minWidth: 760, minHeight: 580)
        .task {
            await model.loadIfNeeded()
        }
    }
}

// MARK: - 第一级：分组

private struct GroupListView: View {
    @ObservedObject var model: PatternBrowserModel
    var onSelect: (MainGroup) -> Void

    var body: some View {
        if model.isLoading {
            ProgressView("加载分类…").frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let msg = model.loadError {
            ContentUnavailableView(msg, systemImage: "wifi.exclamationmark") {
                Button("重试") { Task { await model.loadIfNeeded(force: true) } }
            }
        } else {
            ScrollView {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 14)], spacing: 14) {
                    ForEach(model.groups) { group in
                        Button {
                            onSelect(group)
                        } label: {
                            VStack(spacing: 8) {
                                Text(group.emoji ?? "📦")
                                    .font(.system(size: 40))
                                Text(group.name)
                                    .font(.headline)
                                Text("\(model.categoryCount(of: group)) 个分类 · \(model.totalCount(of: group)) 个图案")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 20)
                            .background(Color(.systemGray6), in: RoundedRectangle(cornerRadius: 14))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(16)
            }
        }
    }
}

// MARK: - 第二级：分类

private struct CategoryListView: View {
    @ObservedObject var model: PatternBrowserModel
    let group: MainGroup
    var onSelect: (MainCategory) -> Void

    var body: some View {
        ScrollView {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 130), spacing: 12)], spacing: 12) {
                ForEach(model.categories(of: group)) { cat in
                    Button {
                        onSelect(cat)
                    } label: {
                        VStack(spacing: 6) {
                            Text(cat.emoji ?? "📦")
                                .font(.system(size: 30))
                            Text(cat.displayName)
                                .font(.subheadline.weight(.medium))
                                .lineLimit(1)
                            Text("\(cat.count ?? 0)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(Color(.systemGray6), in: RoundedRectangle(cornerRadius: 12))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(14)
        }
        .navigationTitle(group.name)
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - 第三级：图案网格

/// 分类图案网格（搜索 / 难度筛选 / 分页加载）
private struct DrawingGridView: View {
    let categoryId: String
    let categoryName: String
    var onSelect: (DrawingItem) -> Void

    @StateObject private var model: DrawingGridModel
    @State private var searchText = ""
    @State private var difficulty: Int = 0   // 0=全部

    init(categoryId: String, categoryName: String, onSelect: @escaping (DrawingItem) -> Void) {
        self.categoryId = categoryId
        self.categoryName = categoryName
        self.onSelect = onSelect
        _model = StateObject(wrappedValue: DrawingGridModel(categoryId: categoryId))
    }

    var body: some View {
        ScrollView {
            // 难度筛选
            HStack(spacing: 8) {
                ForEach(0...3, id: \.self) { d in
                    let label = d == 0 ? "全部" : (d == 1 ? "入门" : d == 2 ? "简单" : "进阶")
                    Button {
                        withAnimation(.snappy) { difficulty = d }
                    } label: {
                        Text(label)
                            .font(.subheadline.weight(.medium))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .background(
                                difficulty == d ? Color.accentColor : Color(.systemGray6),
                                in: Capsule()
                            )
                            .foregroundColor(difficulty == d ? .white : .primary)
                    }
                    .buttonStyle(.plain)
                }
                Spacer()
                Text("\(model.items.count) 个图案")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)

            if let msg = model.error {
                ContentUnavailableView(msg, systemImage: "wifi.exclamationmark") {
                    Button("重试") { Task { await model.load() } }
                }
                .padding(.top, 40)
            } else if model.items.isEmpty {
                ProgressView().padding(.top, 80)
            } else {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 108), spacing: 10)], spacing: 10) {
                    ForEach(visibleItems) { item in
                        ThumbnailCard(
                            item: item,
                            categoryId: categoryId,
                            onSelect: { onSelect(item) }
                        )
                    }
                }
                .padding(14)

                if model.loadedCount < model.items.count {
                    HStack {
                        Spacer()
                        ProgressView()
                        Spacer()
                    }
                    .padding()
                    .onAppear {
                        model.loadMore()
                    }
                }
            }
        }
        .navigationTitle(categoryName)
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $searchText, prompt: "搜索图案名称")
        .task {
            await model.load()
        }
    }

    private var visibleItems: [DrawingItem] {
        let base = model.visiblePrefix()
        let s = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        let searched = s.isEmpty ? base : base.filter { $0.name.localizedCaseInsensitiveContains(s) }
        guard difficulty != 0 else { return searched }
        return searched.filter { ($0.difficulty ?? 3) == difficulty }
    }
}

// MARK: - 缩略图卡片

struct ThumbnailCard: View {
    let item: DrawingItem
    let categoryId: String
    var onSelect: () -> Void

    var body: some View {
        Button(action: onSelect) {
            VStack(spacing: 6) {
                ZStack {
                    Rectangle().fill(Color(.systemGray6))
                    if let url = DataStore.shared.thumbnailURL(categoryId: categoryId, item: item) {
                        AsyncImage(url: url) { phase in
                            if let img = phase.image {
                                img.resizable().scaledToFit().padding(6)
                            } else if case .failure = phase {
                                Image(systemName: "photo")
                                    .foregroundStyle(.tertiary)
                            }
                        }
                    }
                }
                .aspectRatio(1, contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .stroke(Color(.systemSeparator), lineWidth: 0.5)
                )

                HStack(spacing: 4) {
                    Text(item.name)
                        .font(.caption)
                        .lineLimit(1)
                    Spacer()
                    if let d = item.difficulty {
                        Text(d == 1 ? "入门" : d == 2 ? "简单" : "进阶")
                            .font(.system(size: 9))
                            .padding(.horizontal, 5)
                            .padding(.vertical, 2)
                            .background(
                                (d == 1 ? Color.green : d == 2 ? .orange : .red).opacity(0.15),
                                in: Capsule()
                            )
                            .foregroundColor(d == 1 ? .green : d == 2 ? .orange : .red)
                    }
                }
                .padding(.horizontal, 2)
            }
        }
        .buttonStyle(.plain)
    }
}

// MARK: - 模型

@MainActor
final class PatternBrowserModel: ObservableObject {
    @Published var groups: [MainGroup] = []
    @Published var isLoading = false
    @Published var loadError: String?

    private(set) var index: MainIndex?

    func loadIfNeeded(force: Bool = false) async {
        if index != nil && !force { return }
        isLoading = true
        loadError = nil
        defer { isLoading = false }
        do {
            let idx = try await DataStore.shared.loadMainIndex(force: force)
            self.index = idx
            self.groups = idx.groups ?? []
        } catch {
            self.loadError = "加载分类失败，请检查网络后重试"
        }
    }

    func categories(of group: MainGroup) -> [MainCategory] {
        guard let cats = index?.categories else { return [] }
        return cats.filter { $0.id == group.id || ($0.dir ?? "").hasPrefix(group.id + "/") }
    }

    func categoryCount(of group: MainGroup) -> Int {
        categories(of: group).count
    }

    func totalCount(of group: MainGroup) -> Int {
        categories(of: group).reduce(0) { $0 + ($1.count ?? 0) }
    }
}

@MainActor
final class DrawingGridModel: ObservableObject {
    @Published var items: [DrawingItem] = []
    @Published var error: String?
    private(set) var loadedCount = 24
    private let page = 24
    private let categoryId: String

    init(categoryId: String) {
        self.categoryId = categoryId
    }

    func load() async {
        error = nil
        loadedCount = 24
        do {
            let cat = try await DataStore.shared.loadCategoryIndex(categoryId: categoryId)
            items = cat.items
        } catch {
            error = "加载图案列表失败，请检查网络后重试"
        }
    }

    func loadMore() {
        loadedCount += page
    }

    func visiblePrefix() -> [DrawingItem] {
        Array(items.prefix(loadedCount))
    }
}
