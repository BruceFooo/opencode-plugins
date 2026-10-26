# opencode-plugins

Small opencode plugins for working with **small local models** (e.g. Ollama with a 32K context window).

> [中文版 README](README.zh-CN.md)

## Plugins

### `context-guard.ts`

A context guard for opencode 2.x running on small local models, where a single whole-file
read can consume most of the context and a compaction request that carries full history plus a
16K output allowance overflows the context window.

It works in four steps:

1. **Force `read` into 300-line pages** and repair a path → `filePath` translation quirk.
2. **Cap large tool outputs** and save the full text to a local cache file.
3. **Add a `file_outline` tool** so the model can inspect file structure before reading.
4. **Prune** old tool output before generation and before compaction, and inject a short
   context-discipline system prompt.

Before every generate request it prunes against a **generation budget** (~22K tokens); before every
compaction it shrinks the input to a tighter **compaction budget** (~15K tokens) via `pruneForCompaction`.
For the summary it drops reasoning, keeps and caps the most recent tool results (4 kept, each capped at
~6K chars), caps assistant text and tool-call arguments (~4K), caps user text (~8K), drops the oldest user
turns only if still over budget, and clears an oversized system prompt as a last resort (the default
compaction template is appended as a user message, not system). Tool schemas are also stripped from the
summary request.

It also logs before/after token estimates on prune and compaction events so you can watch context usage
in real time.

Both plugins ship token-usage estimates (roughly characters ÷ 3.6) for monitoring context pressure.

### `ollama-discovery.ts`

Applies uniform context/output limits to every Ollama model discovered via the gateway
(`/api/tags`), instead of relying on model-specific defaults.

## Usage

Copy the `.ts` files into your opencode plugin directory.

> This repo is a starting point. The guard intentionally does not change
> `limit.context` / `limit.output` or the model variant; it only shrinks the prompt so that
> prompt + output fits inside the window.