# 贡献指南

欢迎提交 Issue 或 Pull Request。可使用中文或英文。

## 本地验证

使用 Node.js 22.12 或更新版本。Git 同步测试还需要系统 Git。Android 工程使用 Android SDK 36 和 JDK 21。移动工程的构建方式见[手机端构建说明](MOBILE_BUILD.md)。

```sh
npm ci
npx playwright install chromium
npm run verify:all
```

`verify:all` 依次执行类型检查、核心单测、全量冒烟、依赖许可核查和桌面与 Android 生产构建。Windows 预检安装包默认写入 `.test-data/verify-release/`，Android APK 写入 Gradle 的 `android/app/build/outputs/apk/release/`。普通 push 和 PR 使用同一[质量门禁](.github/workflows/ci.yml)。

核心逻辑位于 `shared/core/`，通过参数接收文件系统、路径和传输实现。可用 `npm run typecheck` 和 `npm run test:unit` 在纯 Node 环境快速验证。验证单项编辑、同步或移动交互时，可以运行 `scripts/` 下对应的 `*-smoke.cjs`。

## 提交改动

在 PR 中写清改动原因、覆盖平台和验证结果。涉及界面时，可使用匿名示例附图。新增及升级的 npm 依赖须提供 MIT 或 Apache-2.0 许可。依赖改动请更新锁文件并运行 `npm run verify:licenses`，既有许可例外由锁文件指纹核对。保持首次发布版本号 `1.0.0`，避免提交个人 Vault、密钥、调试产物和安装包。

[缺陷模板](.github/ISSUE_TEMPLATE/bug_report.md) · [功能建议模板](.github/ISSUE_TEMPLATE/feature_request.md) · [安全报告](SECURITY.md)

## 重新生成宣传截图

截图脚本会复制[示例 Vault](docs/demo-vault)到独立的临时工作区，通过 Electron 和 Chromium 驱动实际界面。移动图使用 390×844 CSS 视口与原生桥接模拟，触发软键盘快捷条的视口变化。五张 PNG 以 2 倍像素密度写入 `docs/screenshots/`。

```sh
npm run build
npx playwright install chromium
node scripts/capture-screenshots.cjs
```

[Windows 专项验证](.github/workflows/windows-ci.yml)可手动验证安装包。主流水线支持手动构建四个目标并下载预检产物，版本标签推送负责发布。[发布流水线](.github/workflows/ci-release.yml)
