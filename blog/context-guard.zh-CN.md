# 让 Ollama Agent 留在上下文窗口内

*2026-10-25 · [BruceFooo](https://github.com/BruceFooo) · opencode 插件*

[English](context-guard.md) | [中文](context-guard.zh-CN.md)

当你在 Ollama 这类小型本地模型上运行 AI 编码助手时，一些常见的故障模式会和托管服务不一样：

- 一次整文件读取可能悄悄吃掉 **大部分上下文**；
- compaction 请求携带完整对话历史加上 16K 输出额度时会 **溢出**；
- 长工具输出堆积起来，模型开始忘记自己正在看的代码。

这篇博客介绍一个小小的 opencode 插件 [`context-guard`](https://github.com/BruceFooo/opencode-plugins)，让这些情况变得可控。

## 守卫做了什么

插件把 `read` 工具拆成 **300 行分页**（带 offset/limit 分页前进），增加 `file_outline` 工具让模型先看结构再读内容，并限制大工具输出——完整文本保存到本地缓存文件。

在每次生成和 compaction 前，它都会 **清理** 旧的工具输出，并注入一段简短的上下文纪律提示词。

## 为什么不只是调大上限？

守卫刻意**不**修改 `limit.context`、`limit.output` 或模型 variant；compaction 保留正常的 16K 输出额度，只压缩 prompt，让 prompt + output 能塞进窗口。

## 试用

源码在 [`BruceFooo/opencode-plugins`](https://github.com/BruceFooo/opencode-plugins)：

- [`context-guard.ts`](https://github.com/BruceFooo/opencode-plugins/blob/main/context-guard.ts) — 主守卫
- [`ollama-discovery.ts`](https://github.com/BruceFooo/opencode-plugins/blob/main/ollama-discovery.ts) — Ollama 模型统一限制

把 `.ts` 文件复制到你的 opencode 插件目录并重启 opencode。

---

*English version: [Keeping an Ollama Agent Within Its Context Window](/g/code/opencode-plugins/blog/context-guard.md)

[English](context-guard.md) | [中文](context-guard.zh-CN.md)*