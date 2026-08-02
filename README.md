# pi-web

本地多会话 AI 网页助手 —— 深色极简 UI，开箱即用。

基于 [@earendil-works/pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) 构建，在浏览器里提供完整的 AI 对话体验：多会话管理、项目工作区、技能管理、文件/图片附件、语音输入、优雅重启。

![深色极简界面](https://img.shields.io/badge/style-dark--minimal-%23101318)

## ✨ 功能

- **多会话并行**：多个 AI 会话可同时存活、独立上下文，关网页不丢对话（jsonl 持久化 + 懒恢复）
- **项目工作区**：左侧栏管理多个项目，不同项目的对话严格隔离
- **技能管理**：网页端查看/启用/禁用/搜索/安装技能（内置 docx、pdf、pptx、xlsx 等 6 个官方技能）
- **文件附件**：输入框「＋」选择图片（缩略图预览）或文本/代码文件，随消息发送给 AI
- **语音输入**：浏览器麦克风录音，自动转文字发送
- **模型切换**：顶部状态栏一键切换模型、配置 API Key
- **代码块复制**：AI 回复中的代码块 hover 出现复制按钮
- **优雅重启**：`POST /api/restart` 安全重启服务，页面自动刷新、上下文不丢（详见 [防自杀机制.md](防自杀机制.md)）
- **无想法气泡**：AI 思考过程完全不展示（无气泡、无残留），正文出现才显示，界面干净
- **朴素回复样式**：对话回复无加粗、无表情符号、无深底彩字，全部统一为普通正文（详见 [防自杀机制.md](防自杀机制.md)）
- **热更新**：修改 `page.html` 后已打开页面自动刷新，无需手动

## 🚀 快速开始

### 前置要求

- Node.js ≥ 18
- 一个兼容的模型 API Key（默认 DeepSeek，可配置其他渠道）

### 安装与运行

```bash
# 1. 克隆项目
git clone https://github.com/<your-name>/pi-web.git
cd pi-web

# 2. 安装依赖
npm install

# 3. 配置 API Key（二选一）
# 方式 A：环境变量
set DEEPSEEK_API_KEY=sk-xxx        # Windows
export DEEPSEEK_API_KEY=sk-xxx      # macOS / Linux
# 方式 B：网页端「模型与配置 → 自定义配置」填写

# 4. 启动
npm start
```

打开浏览器访问 http://127.0.0.1:8765

### 端口

默认 8765，可用环境变量或参数修改：

```bash
PI_WEB_PORT=9000 npm start   # 环境变量
node server.mjs 9000         # 参数
```

## ⚙️ 配置说明

| 环境变量 | 作用 | 默认 |
|---------|------|------|
| `DEEPSEEK_API_KEY` | DeepSeek API Key（余额显示用） | 空 |
| `PI_SKILLS_CLI` | ai-agent-skills 的 cli.js 路径（技能搜索/安装） | 自动探测 |
| `PI_WEB_PORT` | 服务端口 | `8765` |
| `PI_WEB_CWD` | 默认工作目录 | 用户主目录 |

> API Key 只在本地使用，不会上传。网页端「自定义配置」保存到 `~/.pi/agent/auth.json`，已加入 `.gitignore`。

## 📦 内置技能

`.pi/skills/` 目录内置 6 个来自 [Anthropic 官方技能库](https://github.com/anthropics/skills)（Apache-2.0）的办公技能，项目克隆后 pi 自动识别：

| 技能 | 用途 |
|------|------|
| docx | Word 文档创建/编辑 |
| pdf | PDF 读取/合并/拆分 |
| pptx | PPT 制作 |
| xlsx | 电子表格读写分析 |
| webapp-testing | 网页自动化测试 |
| skill-creator | 创建新技能 |

## 🛡️ 防自杀机制

网页版 AI 会话运行在服务进程内部。为防止 AI 修改代码后"杀掉自己导致回复截断、页面回不去"，项目内置了优雅重启接口与规范：

- 重启服务请用 `POST /api/restart`（禁止 taskkill 服务进程）
- 详见 [防自杀机制.md](防自杀机制.md)

## 🗂 项目结构

```
pi-web/
├── server.mjs          # 服务端（HTTP + SSE + 会话管理）
├── page.html           # 前端单页（深色极简 UI）
├── package.json        # 依赖与启动脚本
├── .pi/skills/         # 内置技能（随项目发布）
├── 防自杀机制.md        # 优雅重启规范
└── start-web.cmd       # Windows 一键启动
```

## 📄 License

[MIT](LICENSE)
