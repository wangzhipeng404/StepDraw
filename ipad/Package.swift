// swift-tools-version:5.9
//
// StepDraw iPad — SwiftPM 包描述（ipeddle 构建入口）
//
// 源码不移动、不复制：target 直接指向现有的 StepDraw/ 目录，
// Xcode 工程（ipad/StepDraw.xcodeproj）与 ipeddle 共用同一份代码。
// 命名对齐 ipeddle 官方示例：包名 = 产品名 = target 名 = StepDraw，
// 入口 struct 叫 StepDrawApp（放 main.swift，顶层代码 = 可执行 target 的 main，
// Xcode 与 SwiftPM 都认；避免 struct 名与模块名相同带来的歧义）。
import PackageDescription

let package = Package(
    name: "StepDraw",
    platforms: [
        .iOS(.v17)
    ],
    products: [
        .executable(name: "StepDraw", targets: ["StepDraw"])
    ],
    targets: [
        .executableTarget(
            name: "StepDraw",
            path: "StepDraw",
            // Info.plist 不进 app bundle 资源：
            // ipeddle 侧由 ipeddle.toml 的 info-plist 指向（与 Xcode 共用），
            // 这里排除以免 SwiftPM 的 "unhandled file" 警告。
            // 图标源文件在 ipad/Icon.png（不在 target 目录内）。
            exclude: ["Info.plist"]
        )
    ]
)
