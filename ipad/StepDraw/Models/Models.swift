import SwiftUI
import Foundation

// MARK: - 图案数据（结构与 web/public/data 一致）

/// 一条笔画：一组采样点 + 线宽（cocomaterial 数据额外带 color 字段，这里保留）
struct StrokeJSON: Decodable {
    let width: Double
    let color: String?
    let points: [[Double]]

    var cgPoints: [CGPoint] {
        points.compactMap { $0.count >= 2 ? CGPoint(x: $0[0], y: $0[1]) : nil }
    }
}

/// 一个步骤：多条笔画 + 文字提示
struct StepJSON: Decodable {
    let id: Int?
    let tip: String?
    let strokes: [StrokeJSON]
}

/// 一幅图案
struct Drawing: Decodable, Identifiable {
    let id: String
    let name: String?
    let tags: [String]?
    let difficulty: Int?
    let viewBox: [Double]?
    let thumbnail: String?
    let steps: [StepJSON]

    var displayName: String {
        if let name, !name.isEmpty { return name }
        return id
    }

    /// 图案内容区域（内容坐标系）
    var contentRect: CGRect {
        guard let vb = viewBox, vb.count >= 4, vb[2] > vb[0], vb[3] > vb[1] else {
            return CGRect(x: 0, y: 0, width: 256, height: 256)
        }
        return CGRect(x: vb[0], y: vb[1], width: vb[2] - vb[0], height: vb[3] - vb[1])
    }
}

// MARK: - 索引数据

struct MainGroup: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let emoji: String?
}

struct MainCategory: Decodable, Identifiable, Hashable {
    let id: String
    let name: String?
    let emoji: String?
    let count: Int?
    let dir: String?

    var displayName: String {
        if let name, !name.isEmpty { return name }
        return id
    }
}

struct MainIndex: Decodable {
    let viewBox: [Double]?
    let groups: [MainGroup]?
    let categories: [MainCategory]
}

struct DrawingItem: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let difficulty: Int?
    let stepCount: Int?
    let thumbnail: String?
}

struct CategoryIndex: Decodable {
    let category: String?
    let name: String?
    let viewBox: [Double]?
    let items: [DrawingItem]
}

// MARK: - 用户笔画

enum BrushKind: String, CaseIterable, Identifiable {
    case pen, pencil, marker, brush
    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .pen: return "钢笔"
        case .pencil: return "铅笔"
        case .marker: return "马克笔"
        case .brush: return "毛笔"
        }
    }

    var symbol: String {
        switch self {
        case .pen: return "pencil.tip"
        case .pencil: return "pencil"
        case .marker: return "highlighter"
        case .brush: return "paintbrush.pointed"
        }
    }
}

/// 用户的一笔（以内容坐标存储，缩放/平移只是显示层变换，不影响数据）。
/// color 存 hex 字符串（平台无关，ipeddle 在 Linux 上构建时没有 UIKit）。
struct UserStroke: Equatable {
    var points: [CGPoint]
    var width: Double
    var color: String
    var kind: BrushKind
}

// MARK: - 颜色工具

extension Color {
    init(hex: String) {
        var s = hex
        if s.hasPrefix("#") { s.removeFirst() }
        var v: UInt64 = 0
        Scanner(string: s).scanHexInt64(&v)
        self.init(
            red: Double((v & 0xFF0000) >> 16) / 255,
            green: Double((v & 0x00FF00) >> 8) / 255,
            blue: Double(v & 0x0000FF) / 255
        )
    }
}

/// 常用色板（与 web 端一致）
let paletteColors: [Color] = [
    Color(hex: "#E53935"),
    Color(hex: "#1E88E5"),
    Color(hex: "#43A047"),
    Color(hex: "#FB8C00"),
    Color(hex: "#8E24AA"),
    Color(hex: "#000000")
]
