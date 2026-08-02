# pi-web

![截图](screenshot.png)

## 安装与运行

### 第 1 步：下载安装 Node.js

- 国内镜像（速度快）：[https://npmmirror.com/mirrors/node/](https://npmmirror.com/mirrors/node/) —— 找最新的 `node-vXX.X.X-x64.msi` 下载
- 或者官网中文页：[https://nodejs.cn/download/](https://nodejs.cn/download/) —— 点绿色"下载 LTS 版本"

下载后双击安装，一路点"下一步"直到完成。

### 第 2 步：打开终端

按 **Win + R**，输入：

```
cmd
```

按回车。

### 第 3 步：下载本项目

```
cd Desktop
git clone https://github.com/abc123-70/pi-web.git
cd pi-web
```

### 第 4 步：安装依赖

```
npm install
```

### 第 5 步：启动

```
npm start
```

启动后打开浏览器访问 http://127.0.0.1:8765 ，在对话框正上方的模型名处点击，进入「模型与配置」填入你的 API Key 即可使用。

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
