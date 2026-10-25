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

在每次生成和 compaction 前，它都会 **清理** 旧的工具输出，并注入一段简短的上下文纪律提示词。它还会跟踪当前上下文消耗量（基于消息长度估算），并在每次生成前对照 **生成预算**（约 22K tokens）清理，compaction 前则压缩到 **压缩预算**（约 10K tokens），让摘要本身也能装进 32K 窗口。compaction 输入还会去掉工具 schema，并丢弃旧的 reasoning 字段。

## 上下文还能撑多久？

`context-guard` 会持续估算当前上下文用量（按字符 ÷ 3.6 估算，ASCII 字符有加成），并在 prune / compaction 事件中记录 before/after 的 token 数，让你可以看到守卫到底在干什么，而不是盲目相信它。

上面的数字是针对 32K 本地模型的起始点；你可以按模型窗口调插件里的常量。

## 为什么不只是调大上限？

守卫刻意**不**修改 `limit.context`、`limit.output` 或模型 variant；compaction 保留正常的 16K 输出额度，只压缩 prompt，让 prompt + output 能塞进窗口。

## 试用

源码在 [`BruceFooo/opencode-plugins`](https://github.com/BruceFooo/opencode-plugins)：

- [`context-guard.ts`](https://github.com/BruceFooo/opencode-plugins/blob/main/context-guard.ts) — 主守卫
- [`ollama-discovery.ts`](https://github.com/BruceFooo/opencode-plugins/blob/main/ollama-discovery.ts) — Ollama 模型统一限制

把 `.ts` 文件复制到你的 opencode 插件目录并重启 opencode。

---

*English version: [Keeping an Ollama Agent Within Its Context Window](context-guard.md)*