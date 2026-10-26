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

每次生成前会按 **生成预算**（约 22K tokens）清理；compaction 前会把输入压缩到更紧的 **压缩预算**（约 15K tokens），通过 `pruneForCompaction` 处理：丢弃 reasoning、仅保留最近几个工具结果（每个最多约 6K chars）、限制 assistant 文本和 tool-call 参数（约 4K）、限制 user 文本（约 8K），只有仍超预算时才丢弃最旧的 user turns，最后才清理超长的 system prompt（默认 compaction 模板会以 user message 追加）。compaction 输入前会先移除工具 schema。

插件同时记录每次 prune / compaction 前的 token 估算，方便实时观察上下文消耗。两个插件均内置 token 用量估算（按字符 ÷ 3.6）。

### `ollama-discovery.ts`

为通过网关（`/api/tags`）发现的所有 Ollama 模型统一设置 context/output 上限，而不是依赖各模型各自的默认值。

## 使用方式

把 `.ts` 文件复制到你的 opencode 插件目录。

> 该守卫刻意**不**修改 `limit.context` / `limit.output` 或模型 variant；它只压缩 prompt，让 prompt + output 能塞进窗口。