# 云上构建 + 本地自签安装指南

目标：GitHub Actions 在云上编译出 **未签名 IPA** → 你下载到 Windows → 用 **Sideloadly**
（有 Windows 版，免 Mac）拿免费 Apple ID 重签名 → 装到 iPad。

全程**不需要付费开发者账号**，也**不需要把任何签名私钥传到 GitHub**。

---

## 第 0 步：了解为什么是"未签名"

CI 上没有你的签名私钥/描述文件，所以只能产出未签名的 IPA。
未签名 IPA 不能直接双击安装，需要本地工具**用你的 Apple ID 重新签名**（叫 sideload / 侧载）。
这是 iOS 侧载的通用做法，Sideloadly / AltStore 都是干这个的。

> 签好之后：
> - 免费 Apple ID：**7 天**有效期，到期后用同一工具重签一次即可（Sideloadly 支持续期）。
> - 付费开发者账号（$99/年）：可以签 1 年，但没必要为这个 app 专门开。

---

## 第 1 步：触发云上构建

代码推上去后（或在 Actions 页手动跑）：

1. 打开仓库 → 右侧 **Actions** → 选 **"Build iPad IPA (unsigned)"**
2. 点 **Run workflow**（手动）或等 `push` 到 `main` 且只改了 `ipad/**` 时自动跑
3. 等 ~5–10 分钟，跑完后在该次运行的 **Artifacts** 区下载：
   - `StepDraw_unsigned_ipa` → 得到 `StepDraw_unsigned.ipa`（你要的就是这个）
   - `StepDraw_xcarchive`（备用，一般用不到）

> 如果编译失败，日志里会看到 `xcodebuild archive 失败`，把报错贴出来我来修。

---

## 第 2 步：安装 Sideloadly（Windows）

1. 下载：https://sideloadly.io/download （选 Windows）
2. 安装并打开
3. 登录你的 **Apple ID**（普通免费账号即可，就是 App Store 那个）

---

## 第 3 步：侧载安装

1. 打开 Sideloadly，把 `StepDraw_unsigned.ipa` **拖进窗口**
2. **App ID** 一栏：留默认即可。
   - 如果想固定 bundle id（续期不冲突），可手动填 `com.stepdraw.ipad`
3. 勾选 **Sign Only**（只签名，不注入 App 扩展）——本 app 没有扩展，选这个更干净
4. **iPad 用数据线连电脑**（首次连会提示"信任此电脑"，在 iPad 上点信任）
5. 点 **Start**
6. Sideloadly 会自动重签名并推送到 iPad，全程几分钟
7. 完成后，**解锁 iPad，在桌面点一下 app 图标**（首次要手动点一下"信任"未受信任开发者）

> 关于"点一下图标"：iOS 要求你首次启动侧载 app 时手动点一下图标，让系统完成本地代码签名验证，之后才会在桌面常驻。

---

## 第 4 步：7 天后续期

免费签名 7 天后会失效（图标变灰/打不开）。两种办法：

- **最快**：在 Sideloadly 里对**同一个 ipa** 再点一次 Start，它会重新签名，覆盖旧的。
- **省事**：Sideloadly 的 **Library** 里会记住你的 app，下次直接选它续期。

> 注意：续期用的是**同一个 ipa 文件**。如果你之后改了代码，记得重新跑第 1 步拿新 ipa。

---

## 常见问题

| 现象 | 原因 / 解决 |
|---|---|
| Sideloadly 提示连不上 iPad | 换数据线（有些线只能充电不能传数据）；iPad 上"信任此电脑" |
| 安装成功但图标点了没反应 | 在 iPad「设置 → 通用 → VPN 与设备管理」里信任对应开发者，或回到桌面手动点一下图标 |
| 7 天后打不开 | 按第 4 步续期 |
| 想用一年期签名 | 需要 $99 付费开发者账号 + 建 ad-hoc 描述文件，把私钥/描述文件放进 GitHub Secrets 让 CI 直接签。本仓库默认走免费路线 |
| 想 CI 直接产出**已签名** IPA | 见下方"进阶：CI 直接签名" |

---

## 进阶：让 CI 直接产出已签名 IPA（需付费开发者账号）

如果之后你开了 Apple 开发者账号，想让 CI 一步到位出可分发 IPA：

1. 在 Apple Developer 建一个 **App ID**（如 `com.stepdraw.ipad`）
2. 建 **Distribution 描述文件**（App Store / Ad Hoc）
3. 把 **私钥（.p12，导出时设密码）+ 描述文件（.mobileprovision）** 上传到
   GitHub 仓库 **Settings → Secrets and variables → Actions**
4. 把本 workflow 的 `CODE_SIGNING_ALLOWED=NO` 等去掉，改成
   `CODE_SIGN_IDENTITY`、`PROVISIONING_PROFILE`、`FASTLANE_*`（用 fastlane match/sigh 管理证书）

> 这条路线涉及私钥管理，安全性要求高，且要付费账号，所以默认没启用。需要的话我再帮你接 fastlane。
