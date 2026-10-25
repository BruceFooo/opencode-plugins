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

The plugin also tracks how much context it has used (an estimate based on message length) and prunes
before each generate request against a **generation budget** (about 22K tokens) — keeping the recent
conversation and dropping stale tool output as needed — and before each compaction request against a
much tighter **compaction budget** (about 10K tokens) so the summary itself fits comfortably in a
32K window. Tool schemas are stripped from the compaction input, and old reasoning fields are dropped.

## How much context is left?

`context-guard` keeps a running estimate (roughly characters ÷ 3.6, with ASCII bonus) of the current
context — messages, system prompt, and tool schemas — and logs before/after token counts on prune and
compaction events, so you can see the guard actually doing its job rather than trusting it blindly.

The numbers above are starting points for a 32K local model; tweak the budgets in the plugin constants to
match your model's window.

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