# pi-web

![截图](screenshot.png)

## 安装与运行

### 前置要求

- Node.js >= 18

### 克隆并安装

```bash
git clone https://github.com/abc123-70/pi-web.git
cd pi-web
npm install
```

### 配置 API Key

```bash
# 环境变量方式（推荐）
# Windows:
set DEEPSEEK_API_KEY=sk-xxx
# macOS / Linux:
export DEEPSEEK_API_KEY=sk-xxx
```

也可以启动后在网页端「模型与配置 -> 自定义配置」填写。

### 启动

```bash
npm start
```

打开浏览器访问 http://127.0.0.1:8765

### 自定义端口

```bash
node server.mjs 9000
```

## 内置技能

项目内置 6 个来自 [Anthropic 官方技能库](https://github.com/anthropics/skills)（Apache-2.0）的办公技能，开箱即用：

| 技能 | 用途 |
|------|------|
| docx | Word 文档创建/编辑 |
| pdf | PDF 读取/合并/拆分 |
| pptx | PPT 制作 |
| xlsx | 电子表格读写分析 |
| webapp-testing | 网页自动化测试 |
| skill-creator | 创建新技能 |

## License

[MIT](LICENSE)
