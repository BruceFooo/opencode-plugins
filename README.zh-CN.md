# opencode-plugins

用于 **小型本地模型**（如 Ollama，32K context）的 opencode 插件集合。

[English](README.md)

## 插件

### `context-guard.ts`

针对运行在小上下文本地模型上的 opencode 2.x 上下文守卫。当模型由 Ollama 以 32K context 加载时，一次整文件读取可能消耗大部分上下文，compaction 请求携带完整历史加上 16K 输出额度时会溢出 context 窗口。该插件：

1. 强制 `read` 为 300 行分页，并修复 path → filePath 的转换问题；
2. 限制大工具输出大小，并把完整文本保存到本地缓存文件；
3. 增加 `file_outline` 工具，让模型先看结构再读内容；
4. 在生成和 compaction 前清理旧的工具输出，并注入简短的上下文纪律提示词。

### `ollama-discovery.ts`

为通过网关（`/api/tags`）发现的所有 Ollama 模型统一设置 context/output 上限，而不是依赖各模型各自的默认值。

## 使用方式

把 `.ts` 文件复制到你的 opencode 插件目录。

> 该守卫刻意**不**修改 `limit.context` / `limit.output` 或模型 variant；它只压缩 prompt，让 prompt + output 能塞进窗口。