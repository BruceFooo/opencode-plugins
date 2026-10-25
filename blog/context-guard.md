# Keeping an Ollama Agent Within Its Context Window

*Published on 2026-10-25 · [BruceFooo](https://github.com/BruceFooo) · opencode plugins*

When you run an AI coding agent on a small local model — say, an Ollama server with a 32K context window — the usual failure modes look a bit different from what you might expect in a hosted setup:

- A single whole-file read can quietly eat **most of your context**.
- A compaction request that carries the full conversation history plus a 16K output allowance **overflows**.
- Long tool outputs pile up until the model starts forgetting the code it's looking at.

This post is about a small opencode plugin, [`context-guard`](https://github.com/BruceFooo/opencode-plugins), that makes these situations survivable.

## What the guard does

The plugin wraps the `read` tool into **300-line pages** (with offset/limit so you can page forward),
adds a `file_outline` tool so the model can inspect structure before reading, and caps large tool
outputs — saving the full text to a cache file for later.

Before every generation and before every compaction it **prunes** old tool output, and it injects a
short context-discipline system prompt for the model.

## Why "just raise the limit"?

The guard deliberately does **not** touch `limit.context`, `limit.output`, or the model variant.
Compaction keeps its normal 16K output allowance; the guard only shrinks the prompt so that
prompt + output fits inside the window.

## Try it

The source is in [`BruceFooo/opencode-plugins`](https://github.com/BruceFooo/opencode-plugins):

- [`context-guard.ts`](https://github.com/BruceFooo/opencode-plugins/blob/main/context-guard.ts) — the main context guard
- [`ollama-discovery.ts`](https://github.com/BruceFooo/opencode-plugins/blob/main/ollama-discovery.ts) — uniform context/output limits for discovered Ollama models

Copy the `.ts` files into your opencode plugin directory and restart opencode.

---

*中文版：[让 Ollama Agent 留在上下文窗口内](context-guard.zh-CN.md)*