import Foundation

/// 数据加载 + 缓存。
/// 远程数据来自 GitHub Pages（与 web 端同源），磁盘缓存在 Caches 目录。
/// 缓存 key 与 URL 一致；index.json 强制刷新，保证拿到最新索引。
final class DataStore: ObservableObject {
    static let shared = DataStore()

    /// 远程数据根地址。打包发布后如需换 CDN，只改这里。
    static var remoteBaseURL = URL(string: "https://wangzhipeng404.github.io/StepDraw/data")!

    private let baseURL = DataStore.remoteBaseURL
    private let cacheURL: URL = {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("StepDrawData", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    private let session: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.urlCache = URLCache(memoryCapacity: 64 * 1024 * 1024, diskCapacity: 256 * 1024 * 1024)
        cfg.requestCachePolicy = .returnCacheDataElseLoad
        cfg.timeoutIntervalForRequest = 20
        return URLSession(configuration: cfg)
    }()

    private let ioQueue = DispatchQueue(label: "stepdraw.io", qos: .userInitiated)
    private let lock = NSLock()
    private var inFlight: [String: Task<Data, Error>] = [:]
    private var diskCache: [String: Data] = [:]

    // MARK: - 主索引

    @Published var mainIndex: MainIndex?

    func loadMainIndex(force: Bool = false) async throws -> MainIndex {
        if !force, let cached = mainIndex { return cached }
        let data = try await fetch("index.json", force: force)
        let index = try JSONDecoder().decode(MainIndex.self, from: data)
        await MainActor.run {
            self.mainIndex = index
        }
        return index
    }

    // MARK: - 分类索引

    func loadCategoryIndex(categoryId: String) async throws -> CategoryIndex {
        let data = try await fetch("\(categoryId)/index.json")
        return try JSONDecoder().decode(CategoryIndex.self, from: data)
    }

    // MARK: - 单个图案

    func loadDrawing(categoryId: String, drawingId: String) async throws -> Drawing {
        let data = try await fetch("\(categoryId)/\(drawingId).json")
        return try JSONDecoder().decode(Drawing.self, from: data)
    }

    /// 缩略图 URL（直接走远程，由 Image 层缓存）
    func thumbnailURL(categoryId: String, item: DrawingItem) -> URL? {
        // 优先用 item.thumbnail（相对路径，如 "quickdraw/cat/123.png"）
        var path: String? = item.thumbnail
        if let path, !path.isEmpty {
            // 去掉可能存在的开头斜杠
            while path.hasPrefix("/") { path = String(path.dropFirst()) }
            return baseURL.appendingPathComponent(path)
        }
        return baseURL.appendingPathComponent("\(categoryId)/\(item.id).png")
    }

    // MARK: - 下载（磁盘缓存 + 去重）

    /// 拉取并缓存一个资源。`force` 时跳过内存/磁盘缓存强制走网络。
    private func fetch(_ path: String, force: Bool = false) async throws -> Data {
        let key = path
        let url = baseURL.appending(path: path)

        // 内存缓存
        lock.lock()
        if !force, let cached = diskCache[key] {
            lock.unlock()
            return cached
        }
        // 进行中的同 key 请求去重
        let existing = inFlight[key]
        lock.unlock()

        if let existing {
            return try await existing.value
        }

        let task = Task {
            try await performFetch(path: key, url: url, force: force)
        }
        lock.lock()
        inFlight[key] = task
        lock.unlock()

        do {
            let data = try await task.value
            lock.lock()
            inFlight[key] = nil
            diskCache[key] = data
            lock.unlock()
            return data
        } catch {
            lock.lock()
            inFlight[key] = nil
            lock.unlock()
            throw error
        }
    }

    private func performFetch(path: String, url: URL, force: Bool) async throws -> Data {
        // 磁盘缓存
        let fileURL = cacheURL.appendingPathComponent(path)
        if !force {
            let fm = FileManager.default
            if let data = try? Data(contentsOf: fileURL), !data.isEmpty {
                return data
            }
        }

        var request = URLRequest(url: url)
        // index 文件强制刷新（内容会随素材库更新）
        if path.hasSuffix("index.json") {
            request.cachePolicy = .reloadIgnoringLocalCacheData
            request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        }

        let (data, response) = try await session.data(for: request)
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw URLError(.badServerResponse)
        }
        guard !data.isEmpty else { throw URLError(.notConnectedToInternet) }

        // 写入磁盘缓存（路径含 "/"，逐级建目录）
        ioQueue.async {
            try? FileManager.default.createDirectory(
                at: fileURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try? data.write(to: fileURL)
        }
        return data
    }

    // MARK: - 磁盘缓存大小

    var cacheSizeBytes: Int64 {
        let fm = FileManager.default
        guard let en = try? fm.enumerator(at: cacheURL, includingPropertiesForKeys: [.fileSizeKey]) else {
            return 0
        }
        var total: Int64 = 0
        for case let fileURL as URL in en {
            let size = (try? fileURL.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
            total += Int64(size)
        }
        return total
    }

    func clearCache() {
        try? FileManager.default.removeItem(at: cacheURL)
        lock.lock()
        diskCache.removeAll()
        lock.unlock()
    }
}
