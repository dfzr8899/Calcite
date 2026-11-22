# Calcite

**v1.0.0 · [MIT](LICENSE) · Windows + Android** · [English](README_EN.md)

Calcite 是一款本地优先的 Markdown 双链知识库应用。笔记以普通 Markdown 文件保存，附件随知识库组织，可以用其他编辑器继续读写。Calcite 无需注册应用账号，也不收取订阅费。电脑和手机可在受信任的局域网内直连，或通过自己的私有 Git 仓库跨网络同步。

## 核心功能

### 1. Windows 与 Android 双轨同步

- **局域网直连**。电脑开启共享，手机扫码或粘贴配对串即可双向同步。默认监听端口为 `27183`，支持自定义端口和手机个人热点，配对时会降低虚拟网卡地址的优先级。Git 对象批量拉取的 JSON 响应限制为 2 MiB（含 Base64 和 JSON 开销），大对象通过单独的二进制通道传输。移动端为网络调用设置 JS 层硬超时，并将网络等待和串行写入分开，传输时仍可阅读本地笔记。
- **自带远程 Git（BYOS）**。通过 HTTPS 连接 GitHub、Gitee 等 Git 服务。先用 `info/refs` 检查分支，无变化时跳过拉取和推送。拉取限定目标分支，首次拉取或缺少已知共同祖先时使用浅拉取。移动端按路径、修改时间和大小识别脏文件。Windows 通过 Electron 的网络栈使用系统代理配置。GitHub 仓库 URL 可自动补全 `.git`，支持向空仓库首推。
- **冲突与版本历史**。双方修改 `.gitignore` 或 `.gitattributes` 时按行去重并集合并。普通笔记优先尝试三方合并，无法无损合并时采用最新修改优先（LWW）。比较本机文件修改时间和远端该笔记最后一次变更的提交时间，同时间保留本机。被覆盖的完整版本进入版本历史，可对比、恢复或另存为新笔记。两端同步时将识别为 UTF-8 文本的文件统一为 LF，二进制文件保留原始字节。

### 2. 双向链接与知识库维护

- 支持 `[[笔记#章节]]`、`[[目标|别名]]` 和 `![[内嵌]]`。可用目录路径区分同名笔记，自动生成的链接使用能消歧的最短路径。内嵌阅读会拦截循环引用。
- 重命名或移动笔记及文件夹时，自动改写当前知识库中的相关引用，并跳过围栏代码块、行内代码和 YAML 属性内容。支持带上下文的反链、桌面悬停和手机长按预览，以及按目录组织的双链图谱。
- 知识库体检可查找孤立笔记、悬空占位链、歧义链接和无效章节。支持多级标签树、今日笔记（Daily Note）、随机笔记（Random Note）和模板，模板可用 `{{date}}`、`{{time}}`、`{{title}}`、`{{weekday}}`、`{{vault}}`。
- 可生成文末标准 Markdown 引用定义块，使用普通 Markdown 链接和相对路径，在 GitHub 等支持 Markdown 的阅读器中也可跳转。

### 3. 编辑器与大库索引

- 提供即时编辑、源码和阅读三种视图，支持 CommonMark、GFM 表格与任务列表、代码高亮、Mermaid 和 KaTeX 数学公式，KaTeX 可配置自定义宏。Android 默认使用源码编辑，即时编辑可在设置中启用。
- 文件树只读取目录和文件元数据。笔记索引根据路径、修改时间和大小增量更新，供全文搜索、反链和图谱复用。索引缓存位于本地 `.calcite/` 目录，排除在 Git 跟踪区之外。
- 支持剪贴板贴图落盘与相对路径引用。附件管家可扫描孤立附件，并把选中的文件移入回收站。YAML Front Matter 与属性面板联动，复杂 YAML 可在源码中编辑。
- 支持明暗切换。Android 适配安全区、可横滑的 Markdown 表格和键盘上方的 Markdown 快捷工具栏。

### 4. 多知识库与导出

- **Windows** 以文件夹为知识库。通过「打开文件夹」纳入现有文件夹或新建空文件夹，也可从最近知识库列表切换。库目录的重命名和删除由系统文件管理器完成。
- **Android** 提供应用内知识库管理，可新建空白库、扫码配对新建、切换、重命名和删除。两端均按知识库保留各自的同步配置。Android 的知识库默认放在应用私有存储。
- **双端导出**支持 PDF、PNG 阅读长图、独立 HTML 和便携 Markdown ZIP。Android PDF 调用系统打印界面，可在其中另存为 PDF。Windows 安装 Pandoc 后还可导出 DOCX 和 EPUB。

## 选型对比

| 维度 | Calcite | 传统桌面 Markdown 编辑器 | 商业云同步笔记 |
| --- | --- | --- | --- |
| 数据形态 | 本地 Markdown 文件与附件 | 通常直接编辑本地文件 | 常由服务管理存储和导出 |
| 知识库能力 | 双链、反链、内嵌、移动改链和体检 | 主要围绕文档编辑，知识库能力视产品而定 | 通常提供库内组织和链接，开放程度视产品而定 |
| Windows ↔ Android 同步 | 受信任局域网直连，或自带 HTTPS Git 仓库 | 常交给外部同步工具 | 通常通过服务账号与托管云空间 |
| 费用与维护 | 应用无订阅，Git 托管的额度和费用由服务商决定 | 编辑器和同步工具各自计费或免费 | 部分套餐按同步容量、设备或功能计费 |

## 快速开始

Windows 使用 `Calcite-Setup.exe`，Android 使用 APK。可在项目的 [Releases](../../releases) 查看已发布资产，也可按下文从源码构建。

### 局域网直连

1. 在 Windows 打开要共享的知识库文件夹，进入「设置中心 → 同步与配对」，选择「局域网直连」，点击「显示配对二维码」开启共享。
2. 将电脑和手机连到同一受信任的 Wi-Fi 或可互访的个人热点。使用个人热点时，关闭「仅通过 Wi-Fi 或有线网络自动同步」。
3. Android 可在「知识库管理 → 配对新建」扫码建立新库，也可在已有库的同步设置中扫码或粘贴配对串。配对后发起同步。

直连采用 HTTP，请在受信任的网络使用，并私下保存配对串。

### GitHub 或 Gitee 私有仓库

1. 为笔记创建空白私有仓库。同步分支可使用 `main`。
2. 使用 GitHub 时，创建 Fine-grained personal access token，将仓库访问范围限定为这一个笔记仓库，仓库权限设置为 `Contents: Read and write`。使用 Gitee 时，按账户设置准备可通过 HTTPS 拉取和推送目标仓库的凭据。[GitHub 令牌说明](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
3. Windows 打开知识库的「同步与配对」，选择「自定义远程 Git」，填写 `https://github.com/<username>/<notes-repo>.git` 或 `https://gitee.com/<username>/<notes-repo>.git`、分支和用户名 `<username>`，将令牌填入 Token 字段。保存后测试连接，再执行「立即手动同步」。
4. Android 可在同步设置的「手动高级设置」中填写同一仓库和分支，也可使用 Windows 生成的一次性配置二维码。配置二维码可领取访问凭据，请勿转发。

## 项目结构与本地开发

| 目录 | 职责 |
| --- | --- |
| [`shared/core/`](shared/core/) | Vault 索引、改链、同步调度、Git 合并与历史快照 |
| [`src/`](src/) | 编辑器、阅读渲染、桌面与移动交互 |
| [`src/platform/`](src/platform/) | Electron、Capacitor 与浏览器的文件、同步和导出适配 |
| [`electron/`](electron/) | 桌面主进程、IPC、文件监听、局域网服务与导出 |
| [`android/`](android/) | Capacitor Android 工程、原生打印、剪贴板和凭据存储 |
| [`tests/core/`](tests/core/) 和 [`scripts/`](scripts/) | 单元测试、双端 smoke、许可证核查和打包 |

使用 Node.js 22.12 或更新版本。从项目根目录安装依赖并启动桌面应用：

```sh
npm ci
npm run build
npm start
```

静态检查与本地验收：

```sh
npm run typecheck
npm run verify:all
```

`verify:all` 依次执行共享核心类型检查、单元测试、smoke、依赖许可检查和生产构建。生产构建需要当前宿主的桌面打包工具，以及 Android SDK Platform 36 和 JDK 21。

单独构建 Windows 安装器：

```powershell
npm run package -- --installer-only
```

单独构建 Android 调试 APK：

```powershell
npm run build
npx cap sync android
Set-Location android
.\gradlew.bat :app:assembleDebug
```

APK 位于 `android/app/build/outputs/apk/debug/app-debug.apk`。Android 环境和签名配置见[手机端构建说明](MOBILE_BUILD.md)，贡献流程见[贡献指南](CONTRIBUTING.md)。

## 开源许可

Calcite 源码采用 [MIT License](LICENSE)。随包分发的第三方依赖和资源适用各自的许可，详见[第三方声明](assets/THIRD-PARTY-NOTICES.txt)。
