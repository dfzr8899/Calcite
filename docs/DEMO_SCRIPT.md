# Calcite 实操演示

观众先看到一份用链接串起的银河观测计划。随后在文件树改名，打开源文件确认引用已经改写，再点回同一节。演示的结果是原笔记里的自定义链接文字和章节目标依然可用。

| 时间 | 实操画面 | 字幕 |
| --- | --- | --- |
| 00–04 秒 | 打开「周末银河观测计划」，停留在出发前的清单 | 笔记一改名，旧链接会断吗？ |
| 04–11 秒 | 悬停「月落后的观测窗口」，预览「出发条件」，再点击跳转 | 从计划跳到观测条件 |
| 11–19 秒 | 在左侧文件树右击「月相窗口」，改名为「无月观测窗口」，确认并等引用更新提示 | 在文件树中重命名笔记 |
| 19–25 秒 | 回到原文件并切换源码，展示已更新的 Markdown 目标和原别名 | 原 Markdown 文件里的引用已改写 |
| 25–31 秒 | 切回阅读视图，点击原别名，确认仍打开「出发条件」 | 原来的链接依然直达同一节 |
| 31–38 秒 | 展示真实示例库的双链图谱 | 本地 Markdown，双链知识库 |

视频配中英双语画内字幕。README 的 GIF 节选同一段录制。

## 一键重录

准备 Node.js 22.12+、已安装的项目依赖以及带 `libx264` 的 FFmpeg。在 Windows 上可用 `winget install "FFmpeg (Essentials Build)"` 安装独立编码工具。FFmpeg 可从 PATH 获取，也可以通过环境变量 `CALCITE_FFMPEG` 指定可执行文件。录制依赖 Playwright 自带的 FFmpeg，可用下面的命令准备。

```powershell
npm ci
npm run build
npx playwright install ffmpeg
```

以后在仓库根目录运行一条命令即可重录。

```powershell
node scripts/demo/record.cjs
```

脚本启动实际的 Electron 窗口，在 1280×720 下用 Playwright 录制。它将[示例知识库](demo-vault/)与[演示专用笔记](../scripts/demo/notes/)复制到 `.test-data/`，用独立配置运行。重命名落盘后，脚本会检查原 Markdown 的真实引用及再次点击的跳转目标。

输出为 [MP4](media/demo.mp4) 和 [GIF](media/demo.gif)。原始 WebM 保存在本次运行的临时目录，可通过 `node scripts/demo/encode.cjs <capture.webm>` 单独转码。
