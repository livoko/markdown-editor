[English](README.en.md) | **简体中文**

# Markdown 编辑器

一个简洁的 macOS 桌面 Markdown 编辑器，支持阅读与编辑两种模式。基于 [Tauri 2](https://tauri.app/) + TypeScript 构建，体积小、启动快。

**[⬇️ 下载 macOS 版（Apple Silicon）](https://github.com/livoko/markdown-editor/releases/latest)**

![阅读模式：左侧最近文件、中间大纲导航、右侧渲染预览](docs/screenshot-read.png)

<details>
<summary>编辑模式（语法高亮）</summary>

![编辑模式：CodeMirror 语法高亮](docs/screenshot-edit.png)

</details>

## 功能

- **阅读 / 编辑** 双模式，`⌘E` 一键切换；打开文件默认进入阅读模式
- **GFM 渲染**：标题、列表、任务列表、表格、代码高亮、引用等
- **语法高亮编辑器**（CodeMirror 6），撤销、查找
- **左侧文件区**：新建 / 打开 + 最近打开列表（可逐条移除、可收起 `⌘\`）
- **阅读模式大纲**：点击标题快速定位，滚动自动高亮
- **文件关联**：可设为 `.md` 默认打开程序，Finder 双击直接打开
- 跟随系统的**明暗主题**
- 未保存提醒；保存按钮随未保存状态点亮

## 快捷键

| 快捷键 | 功能 |
| --- | --- |
| `⌘N` | 新建 |
| `⌘O` | 打开 |
| `⌘S` | 保存 |
| `⌘E` | 阅读 / 编辑 切换 |
| `⌘\` | 收起 / 展开侧边栏 |

## 技术栈

- **框架**：Tauri 2（Rust 壳 + 系统 WebView）
- **前端**：TypeScript + Vite（无框架）
- **编辑器**：CodeMirror 6
- **渲染**：markdown-it + highlight.js + markdown-it-task-lists

## 开发

前置：[Node.js](https://nodejs.org/) 与 [Rust](https://www.rust-lang.org/tools/install)。

```bash
npm install        # 安装依赖
npm run tauri dev  # 本地开发（编译 Rust + 起前端）
npm run tauri build -- --bundles app  # 打包 .app
```

打包产物在 `src-tauri/target/release/bundle/macos/`。

## 许可

MIT
