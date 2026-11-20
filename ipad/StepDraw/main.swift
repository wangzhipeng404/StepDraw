import SwiftUI

// 应用入口。用 main.swift 顶层代码启动（而非 @main），
// 这样 Xcode 工程与 SwiftPM/ipeddle 都认它是唯一入口，两边不冲突。
struct StepDrawApp: App {
    var body: some Scene {
        WindowGroup {
            MainView()
        }
    }
}

StepDrawApp.main()
