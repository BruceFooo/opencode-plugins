# AGENTS.md

## What this repo is

Small opencode plugins that make AI coding agents usable on small local models (e.g. Ollama with a 32K context window).

- `context-guard.ts` — the main plugin. Default-exports `{ id, setup }` in the opencode 2.x plugin format.
- `ollama-discovery.ts` — applies uniform context/output limits to models discovered via the Ollama gateway (`/api/tags`).

Usage: copy the `.ts` files into the opencode plugin directory.

**Working setup:** the live plugins actually run from `C:\Users\fqq13\.config\opencode\plugins`. When updating plugins from this repo, copy the local `.ts` files into that directory, then push the repo changes to the remote. Don't edit or verify solely against the copy in `.config` — treat this repo as the source of truth.

## Commands

- No `package.json`, build, lint, typecheck, test, or CI config exists in this repo. Do not add or expect any.
- Changes are runtime-loaded plain TypeScript consumed by the opencode host — nothing to compile here.
- No test suite exists. Verification is manual: reload the plugin in a running opencode instance and check the guard logs (`~/.cache/opencode/context-guard/status.json`, RPC app log) and behavior.

## Key invariants and quirks

These come from the code and are easy to get wrong if guessed:

- The guard **intentionally does NOT** change `limit.context`, `limit.output`, or the model variant. Its job is to shrink the prompt so prompt + output fits the window. Keep this invariant; do not "fix" small-model failures by raising limits.
- Compaction keeps its normal 16K output allowance; the prompt is shrunk to a tighter budget instead (`COMPACTION_INPUT_BUDGET = 15000`).
- `read` is forced into pages of at most `MAX_READ_LINES = 300` lines; the tool accepts a `path` alias for the required `filePath` (local models often emit `path`).
- Never invent an `offset` that was not supplied — only clamp explicit offset/limit; default offset is correct.
- Binary files are excluded from `read`.
- Large tool outputs are capped and the full text is saved to `~/.cache/opencode/context-guard`.
- Pruning happens before every generate (`GENERATE_BUDGET ≈ 22K` tokens) and compaction (`COMPACTION_INPUT_BUDGET ≈ 15K`), via `pruneForCompaction` (drops reasoning, keeps ~4 recent tool results each capped ~6K chars, caps assistant text ~4K / user text ~8K, drops oldest user turns only if over budget, clears oversized system prompt last).
- Context token estimates are a rough heuristic (chars ÷ 3.6) used for before/after prune/compaction logging.

## Conventions

- Plain TypeScript, default-exported plugin object; hook/registration APIs are loosely typed (`ctx: any`) and defensive (try/catch around optional ctx APIs).
- Keep plugins minimal — the design goal is small, targeted behavior rather than feature breadth.

## Sources of truth

- `README.md` / `README.zh-CN.md` (bilingual) and `blog/` (English + Chinese posts) are user-facing docs; the code is authoritative. If docs and code disagree, trust the code.