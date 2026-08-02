# 内置技能

pi-web 开箱自带的 6 个基础技能，来自 [Anthropic 官方技能库](https://github.com/anthropics/skills)（Apache-2.0 协议），全部本地运行、无需额外 API key。

| 技能 | 用途 |
|------|------|
| **docx** | 创建 / 编辑 / 提取 Word 文档 |
| **pdf** | 读取 / 合并 / 拆分 / 生成 PDF |
| **pptx** | 制作 PowerPoint 演示文稿 |
| **xlsx** | 电子表格读写与数据分析 |
| **webapp-testing** | 网页自动化测试、回归检查 |
| **skill-creator** | 创建新的技能（SKILL.md 规范） |

## 使用方法

1. 在 pi 的任意对话中描述需求（如"帮我把这段文字生成一个 Word 文档"），pi 会自动调用对应技能
2. 也可手动强制加载：`/skill:docx`、`/skill:pdf` 等

## 目录结构

每个技能目录包含 `SKILL.md`（指令）和所需脚本/资源，符合 [Agent Skills 规范](https://agentskills.io/specification)。
