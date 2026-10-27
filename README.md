# opencode-plugins

Small opencode plugins for working with **small local models** (e.g. Ollama with a 32K context window).

> [中文版 README](README.zh-CN.md)

## Plugins

### `context-guard.ts`

A context guard for opencode 2.x running on small local models, where a single whole-file
read can consume most of the context and a compaction request that carries full history plus a
16K output allowance overflows the context window.

It works in five steps:

1. **Force `read` into 300-line pages** and repair a path → `filePath` translation quirk.
2. **Cap large tool outputs** and save the full text to a local cache file.
3. **Add a `file_outline` tool** so the model can inspect file structure before reading.
4. **Prune** old tool output before compaction.
5. **Inject a short context-discipline system prompt** for Ollama models, including a post-compaction
   Next Move rule.

Before compaction it shrinks the input to a tighter **compaction budget** (~15K tokens) via
`pruneForCompaction`. For the summary it drops reasoning, keeps and caps the most recent tool
results (4 kept, each capped at ~4K chars), caps assistant text and tool-call arguments (~4K), caps
user text (~8K), drops the oldest user turns only if still over budget, and clears an oversized
system prompt as a last resort (the default compaction template is appended as a user message, not
system). Tool schemas are also stripped from the summary request.

The guard deliberately does **not** prune before every generation; the compaction trigger and the
bounded compaction input are enough.

After a compaction it pushes the agent to execute the summary's first incomplete **Next Move** item
via a nudge, instead of letting it re-read the same files:

- The compaction summary becomes the task state. The nudge points the model at "Execute the first
  incomplete item in the LAST Next Move section now", tells it not to commit until the preceding
  items are complete, and to use only the line ranges named in the summary.
- The nudge is time-boxed: it expires after **30 minutes** (`NEXT_MOVE_TTL_MS`) and is injected at most
  **4 times per session** (`NEXT_MOVE_MAX_INJECTIONS`). Pending state is persisted per session under
  `~/.cache/opencode/context-guard/pending-next-move-<sessionID>.json`, because the context and
  generate hooks can run in different plugin instances.
- A new user request or a successful edit (`edit` / `write` / `patch`) cancels the pending state, so
  the nudge never fires outside a real task. The exploration read budget is carried across
  compactions.

If the agent has read enough pages since the last edit, the **read gate** blocks further `read` calls
for that session (serialized via a lock, and carried across compactions): the read tool is removed
from the request and a nudge tells the model to stop exploring and apply the first incomplete Next
Move edit now.

The guard also drops rarely-used tools for the local model (batch, websearch, execute, skill, todo,
todowrite and their sub-tools) and injects the context-discipline prompt once per request.

It logs before/after token estimates on prune and compaction events and writes nudge status to the
cache dir, so you can watch context usage in real time.

Both plugins ship token-usage estimates (roughly characters ÷ 3.6) for monitoring context pressure.

### `ollama-discovery.ts`

Applies uniform context/output limits to every Ollama model discovered via the gateway
(`/api/tags`), instead of relying on model-specific defaults.

## Usage

Copy the `.ts` files into your opencode plugin directory.

> This repo is a starting point. The guard intentionally does **not** change
> `limit.context` / `limit.output` or the model variant; it only shrinks the prompt so that
> prompt + output fits inside the window.