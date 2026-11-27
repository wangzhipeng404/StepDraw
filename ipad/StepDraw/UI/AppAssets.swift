import SwiftUI

/// 打包图标加载（web 端同款 PNG/JPG）。
///
/// 资源统一放在 target 内 `Assets/`（21 个 web 图标 + logo）。
/// - ipeddle / SwiftPM 构建：资源进 `Bundle.module`（自动，无需改 pbxproj）。
/// - Xcode 构建：资源进 `Bundle.main`（需把 `Assets/` 加入 target 的 Resources）。
/// 两种构建用同一份代码，下面按文件名 + 扩展名在候选 bundle / 子目录里找，
/// 兼容"打包到 bundle 顶层"或"打包进 Assets/ 子目录"两种布局。
enum AppAssets {

    /// 取一个打包图标（返回未缩放的 Image，调用方自行 .resizable()）。
    /// 找不到时回退一个占位符，避免运行期空白。
    static func image(_ name: String) -> Image {
        if let url = url(for: name), let ui = UIImage(contentsOfFile: url.path) {
            return Image(uiImage: ui)
        }
        return Image(systemName: "questionmark.circle")
    }

    static func url(for name: String) -> URL? {
        #if SWIFT_PACKAGE
        let bundles: [Bundle] = [.module, .main]
        #else
        let bundles: [Bundle] = [.main]
        #endif
        let subdirs = ["", "Assets"]
        let exts = ["png", "jpg", "jpeg", "webp"]
        for b in bundles {
            for sub in subdirs {
                for ext in exts {
                    if let u = b.url(forResource: name, withExtension: ext, subdirectory: sub) {
                        return u
                    }
                }
            }
        }
        return nil
    }
}
