# Calcite 手机端构建

共用前端从项目根目录构建。应用 ID 为 `io.calcite.notes`，Web 资源目录为 `dist/`。Android 最低 API 24，使用 API 36 编译。iOS 最低版本为 15，使用 Swift Package Manager。

    npm ci
    npm run mobile:sync

`mobile:sync` 同时更新两套原生工程。单独同步时，先运行 `npm run build`，再运行 `npx cap sync android` 或 `npx cap sync ios`。

## Android APK

安装 Android SDK Platform 36 和 JDK 21。将 `ANDROID_HOME` 指向 SDK 安装目录，或让 Android Studio 写入 `android/local.properties`。从项目根目录运行下列 Windows 命令。

    npm run build
    npx cap sync android
    cd android
    .\gradlew.bat :app:assembleDebug

APK 输出到 `android/app/build/outputs/apk/debug/app-debug.apk`。可运行 `npm run mobile:android` 打开 Android Studio，或用 `adb install -r` 安装到已授权的设备或模拟器。正式分发使用 Android Studio 的签名构建配置生成 release APK 或 AAB。

配对二维码由系统文件或拍照选择器提供，选中的图片在应用内解码。Calcite 无需 Android `CAMERA` 权限。

## iOS Xcode

在 macOS 安装 Xcode 26 或更新版本及 Command Line Tools。运行 `npm run mobile:ios`，等待 Swift Package Manager 解析依赖，选择 `App` scheme，在 Signing & Capabilities 中配置 Team，然后选择设备或模拟器运行。分发使用 Product → Archive。

`ios/App/App/Info.plist` 配置了拍照与局域网用途说明，并在 ATS 下仅启用 `NSAllowsLocalNetworking`。iOS 17 及以上系统可能拦截数字 IP 的 HTTP 连接。若遇到 ATS 拦截，可使用可解析的 `.local` 地址或 HTTPS 远程 Git。文件时间戳和 UserDefaults 的隐私声明位于 `PrivacyInfo.xcprivacy`。[Apple 局域网 ATS 配置](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking)

## 本地数据与网络

Android 默认使用应用私有的 `Directory.Data/CalciteVaults/`，iOS 继续使用 `Directory.Documents/CalciteVaults/`。Android 升级后会尝试复制仍可读取的旧 Vault（包括本地 Git 历史），并保留原目录。无法读取的旧目录会在同步日志提示。首次启动建立默认 Vault。导出副本保存在 `CalciteExports/`，分享通过系统分享面板完成。附件清理把文件移入 Vault 内 `.trash/`。

同步使用原生 `CapacitorHttp`。Android 7.x 的 Git 二进制 POST 通过应用内 HTTPS 桥接兼容。Android 的网络安全 XML 不支持 CIDR，因此允许应用发起 HTTP，Calcite 的同步客户端逐次校验目的地址。明文直连仅允许 RFC1918、CGNAT、IPv6 私有或链路本地地址、回环以及 `.local`。公网 Git 使用 HTTPS，认证请求拒绝自动重定向。手机凭据由 Android Keystore 或 iOS Keychain 保存。若系统提示局域网访问，请在系统设置为 Calcite 授权。

## 验收

    npm run build
    npx cap sync
    node scripts/notices.cjs
    node scripts/mobile-smoke.cjs
    node scripts/offline-auto-sync-smoke.cjs

移动专项使用 Chromium 的 390×844 触屏视口与 Capacitor 桥接 Mock。Git 部分使用真实 isomorphic-git 验证二进制文件和三方合并。可用 `--git-only` 单独运行。若未安装 Playwright 浏览器，运行 `npx playwright install chromium` 或用 `CALCITE_CHROMIUM` 指定 Chrome。

[Capacitor 8 环境要求](https://capacitorjs.com/docs/getting-started/environment-setup) · [Capacitor iOS 构建](https://capacitorjs.com/docs/ios)
