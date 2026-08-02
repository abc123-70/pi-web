# pi-web

![截图](screenshot.png)

## 安装与运行（新手教程）

### 第 1 步：下载安装 Node.js

先下载 Node.js（这是一个运行环境，装一次就行）：

- 国内镜像（速度快）：[https://npmmirror.com/mirrors/node/](https://npmmirror.com/mirrors/node/) —— 点进去找最新的 `node-vXX.X.X-x64.msi` 下载
- 或者官网中文页：[https://nodejs.cn/download/](https://nodejs.cn/download/) —— 点绿色"下载 LTS 版本"

下载后双击安装，一路点"下一步"直到完成，不用改任何设置。

### 第 2 步：打开终端

按键盘上的 **Win + R**，弹出"运行"窗口，输入：

```
cmd
```

按回车，会打开一个黑色窗口（这就是终端）。

### 第 3 步：验证 Node.js 装好了

在黑色窗口里输入下面这行，按回车：

```
node -v
```

如果显示类似 `v22.19.0` 这样的版本号，说明装好了，继续下一步。

### 第 4 步：下载本项目

在黑色窗口里输入下面两行，每行输完按一次回车：

```
cd Desktop
git clone https://github.com/abc123-70/pi-web.git
```

等待下载完成，然后进入项目文件夹：

```
cd pi-web
```

### 第 5 步：安装依赖

在黑色窗口里输入，按回车，等待完成（可能需要几分钟）：

```
npm install
```

### 第 6 步：配置 API Key

在黑色窗口里输入（把 `sk-xxx` 换成你自己的密钥）：

```
set DEEPSEEK_API_KEY=sk-xxx
```

（macOS / Linux 用户用：`export DEEPSEEK_API_KEY=sk-xxx`）

### 第 7 步：启动

输入：

```
npm start
```

看到 `pi-web 已启动` 就成功了。打开浏览器，访问：

**http://127.0.0.1:8765**

大功告成！

---

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
