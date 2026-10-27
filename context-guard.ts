// opencode 2.x context guard for small local-model windows.
//
// The model is loaded by Ollama with a 32K context. A single whole-file read
// can consume most of it, and a compaction request that carries the full
// history plus a 16K output allowance overflows. This plugin:
//   1. forces `read` into 300-line pages and repairs path -> filePath
//   2. caps large tool outputs and saves the full text to a cache file
//   3. adds file_outline so the model can inspect structure before reading
//   4. prunes old tool output before compaction
//   5. injects a short context-discipline system prompt for Ollama models
//
// It intentionally does NOT change limit.output, limit.context, or the model
// variant. Compaction keeps its normal 16K output allowance; we only shrink
// the prompt so prompt + output fits.

import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

const CONTEXT_LIMIT = 32768
const OUTPUT_LIMIT = 16184
const MAX_READ_LINES = 300
const MAX_TOOL_CHARS = 16000
const COMPACTION_INPUT_BUDGET = 15000
const COMPACTION_KEEP_TOOL_RESULTS = 4
const COMPACTION_TOOL_RESULT_MAX = 4000
const COMPACTION_ASSISTANT_TEXT_MAX = 4000
const LARGE_FILE_BYTES = 50 * 1024
const READ_PAGE_WARN_AT = 3
const CACHE_DIR = path.join(os.homedir(), ".cache", "opencode", "context-guard")
const NEXT_MOVE_TTL_MS = 30 * 60 * 1000
const NEXT_MOVE_MAX_INJECTIONS = 4
const NEXT_MOVE_MARKER = "Execute the first incomplete item in the LAST Next Move section now"
const NEXT_MOVE_NUDGE = `The compaction summary above is your task state. ${NEXT_MOVE_MARKER}. Do not commit until the preceding items are complete. Use only the line ranges named in the summary; if a range is missing, read only the smallest range you need, then make the edit.`
const READ_BUDGET = 3
const READ_GATE_MARKER = "Read budget exhausted since the last edit"
const READ_GATE_NUDGE = `${READ_GATE_MARKER}. Do not call read again. Stop exploring and apply the first incomplete Next Move edit now. Use grep only for an exact missing symbol, or delegate to the reader subagent. Do not commit until the preceding items are complete.`

type PendingNextMove = {
  at: number
  injected: number
  lastInjectedAt: number
  reads: number
}

// Sessions that just compacted, with injection state. The nudge is anchored to
// the checkpoint and cancelled by a new user request or a successful edit.
const pendingNextMove = new Map<string, PendingNextMove>()

// Per-session, per-file read counters for automatic reminders.
const readStats = new Map<
  string,
  { path: string; reads: number; sizeWarned: boolean; pagesWarned: boolean; updated: number }
>()

const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|bmp|ico|pdf|zip|gz|tgz|7z|rar|exe|dll|so|dylib|mp4|mp3|wav|webm|woff2?|ttf|otf|bin|dat)$/i

const READ_DESCRIPTION = `Read one bounded page of a text file. Always pass filePath, offset (line number), and limit (lines).

This deployment clamps limit to ${MAX_READ_LINES} lines. The result is JSON:
{ type: "text-page", content, mime, offset, truncated, next?, hint? }

If truncated is true, call read again with the same filePath, offset=next, limit=${MAX_READ_LINES}. Never request an entire large file in one call. For files over ${MAX_READ_LINES} lines, call file_outline first and read only the relevant ranges. For images/PDFs, offset and limit are ignored.`

const DISCIPLINE = `<context-discipline>
Context window is 32K tokens. Never read a whole large file in one call.
1) Call file_outline first for any file you have not seen.
2) Read at most ${MAX_READ_LINES} lines per read call; if the result says truncated, continue with offset=next.
3) For files over ${MAX_READ_LINES} lines, multi-file analysis, or a 65KB+ page/schema, delegate to the \`reader\` subagent.
4) If a tool output is truncated, use grep/sed on the saved path instead of re-running the same tool.
5) Summarize findings in your own words before moving on; do not keep raw file contents in context.
6) For multi-file or multi-step work, delegate independent parts to the \`reader\`/\`general\` subagents and keep only their summaries here.
7) If you must read many chunks yourself, maintain a notes file under .opencode/notes/ (gitignored) and rely on the notes instead of remembering raw chunks.
8) If .opencode/notes/handoff.md exists, read it first. After major progress on a long task, update it with the write tool.
9) After a compaction summary, execute its first incomplete Next Move item immediately. Do not re-read entire files; read only the line ranges named in the summary. If a range is missing, read only the smallest range you need, then edit. Do not commit until the preceding Next Move items are complete.
Prefer tool calls over prose; keep explanations short unless asked.
</context-discipline>`

type ToolEditor = {
  get(name: string): any
  update(name: string, fn: (tool: any) => void): void
  add(tool: any): void
}

export default {
  id: "context-guard",
  setup: async (ctx: any) => {
    let outlineRegistered = false
    let toolRegistrationError: string | undefined

    // 1) Rewrite the read tool description and add file_outline.
    try {
      if (ctx.tool?.transform) {
        await ctx.tool.transform((editor: ToolEditor) => {
          if (editor.get("read")) {
            editor.update("read", (tool) => {
              tool.description = READ_DESCRIPTION
            })
          }

          editor.add({
            name: "file_outline",
            description:
              "Return a bounded structural outline of a text file: headings, functions, classes, top-level JSON keys, and line numbers. Use this before reading a large file. Never returns the full file.",
            input: {
              type: "object",
              additionalProperties: false,
              required: ["filePath"],
              properties: {
                filePath: { type: "string", description: "Path to the file to outline" },
                maxItems: {
                  type: "integer",
                  minimum: 10,
                  maximum: 200,
                  description: "Maximum number of structural hits to return (default 120)",
                },
              },
            },
            output: {
              type: "object",
              additionalProperties: false,
              required: ["type", "content"],
              properties: {
                type: { const: "text" },
                content: { type: "string" },
              },
            },
            options: { codemode: false },
            execute: async (args: any, toolCtx: any) => {
              const text = await outlineFile(
                String(args?.filePath ?? ""),
                Math.min(200, Math.max(10, Number(args?.maxItems) || 120)),
                toolCtx?.directory,
              )
              return {
                output: { type: "text", content: text },
                content: text,
                metadata: { filePath: String(args?.filePath ?? "") },
              }
            },
          })
          outlineRegistered = Boolean(editor.get("file_outline"))
        })
      }
    } catch (error) {
      toolRegistrationError = error instanceof Error ? (error.stack ?? error.message) : String(error)
      warn("failed to register file_outline / read description", error)
    }

    // 2) Tool argument and result hooks.
    try {
      if (ctx.tool?.hook) {
        await ctx.tool.hook("execute.before", onExecuteBefore)
        await ctx.tool.hook("execute.after", async (result: any) => onExecuteAfter(ctx, result))
      }
    } catch (error) {
      warn("failed to register tool hooks", error)
    }

    // 3) Session hooks for generation and compaction.
    try {
      if (ctx.session?.hook) {
        // "context" is where the tool list and system prompt are assembled;
        // "generate" is the final pre-call pass. Both need the same trimming.
        await ctx.session.hook("context", async (draft: any) => onGenerate(ctx, draft, "context"))
        await ctx.session.hook("generate", async (draft: any) => onGenerate(ctx, draft, "generate"))
        await ctx.session.hook("compaction", async (draft: any) => onCompaction(ctx, draft))
      }
    } catch (error) {
      warn("failed to register session hooks", error)
    }

    // Note: aisdk language hooks do not fire for the built-in Ollama
    // openai-compatible provider in 2.1.4, so compaction output is controlled
    // by the #none model variant instead of an aisdk maxOutputTokens wrapper.

    let toolNames: string[] = []
    try {
      const tools = await ctx.tool?.list?.()
      toolNames = (tools ?? []).map((tool: any) => String(tool?.name ?? tool?.id ?? ""))
    } catch {}

    try {
      await fs.mkdir(CACHE_DIR, { recursive: true })
      await fs.writeFile(
        path.join(CACHE_DIR, "status.json"),
        JSON.stringify(
          {
            at: new Date().toISOString(),
            outlineRegistered,
            toolRegistrationError,
            hasToolTransform: Boolean(ctx.tool?.transform),
            hasToolHook: Boolean(ctx.tool?.hook),
            hasSessionHook: Boolean(ctx.session?.hook),
            toolNames,
          },
          null,
          2,
        ),
        "utf8",
      )
    } catch {}

    log(ctx, "info", "context-guard ready", {
      contextLimit: CONTEXT_LIMIT,
      outputLimit: OUTPUT_LIMIT,
      maxReadLines: MAX_READ_LINES,
    })
  },
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(ctx: any, level: string, message: string, extra?: any) {
  try {
    const result = ctx?.rpc?.app?.log?.({
      body: { service: "context-guard", level, message, extra },
    })
    if (result && typeof result.catch === "function") result.catch(() => {})
  } catch {}
}

function warn(message: string, error?: unknown) {
  console.error(`[context-guard] ${message}`, error instanceof Error ? error.message : (error ?? ""))
}

// ---------------------------------------------------------------------------
// Tool hooks
// ---------------------------------------------------------------------------

async function onExecuteBefore(input: any) {
  if (!input) return

  // The custom outline tool uses filePath too; let local models that emit
  // `path` pass validation by renaming before the schema check.
  if (input.tool === "file_outline") {
    const outlineArgs = input.input
    if (outlineArgs && typeof outlineArgs === "object") {
      if (!outlineArgs.filePath && typeof outlineArgs.path === "string") outlineArgs.filePath = outlineArgs.path
      input.input = outlineArgs
    }
    return
  }

  if (input.tool !== "read") return
  const args = input.input
  if (!args || typeof args !== "object") return

  // Some local models emit `path` instead of the required `filePath`.
  if (!args.filePath && typeof args.path === "string") args.filePath = args.path
  if (typeof args.filePath !== "string" || args.filePath.length === 0) return
  if (BINARY_EXT.test(args.filePath)) return

  // Do not invent an offset: the read tool's default is correct regardless of
  // whether it is 0-based or 1-based. Only clamp an explicit offset and limit.
  const offset = Number(args.offset)
  if (Number.isFinite(offset) && offset >= 0) args.offset = Math.floor(offset)
  else delete args.offset

  const limit = Number(args.limit)
  args.limit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), MAX_READ_LINES) : MAX_READ_LINES

  input.input = args
}

async function onExecuteAfter(ctx: any, result: any) {
  try {
    if (!result || result.status !== "completed") return
    const tool = String(result.tool ?? "")

    if (["edit", "write", "patch"].includes(tool)) {
      const sessionID = String(result.sessionID ?? "")
      if (sessionID && (await clearPendingNextMove(sessionID))) {
        await writeNudgeStatus({ sessionID, event: "cleared", reason: `tool:${tool}` })
      }
      return
    }

    if (tool === "read") {
      if ((await applyReadGate(ctx, result)) === "blocked") return
      addReadPageHint(result)
      await addReadReminder(ctx, result)
      return
    }

    if (!["webfetch", "grep", "glob", "list", "shell", "bash"].includes(tool)) return
    await capToolOutput(result, tool)
  } catch (error) {
    warn("execute.after failed", error)
  }
}

// ---------------------------------------------------------------------------
// Read pagination hint
// ---------------------------------------------------------------------------

type PageLocation = {
  page: any
  write: (page: any) => void
  contentHint: (hint: string) => void
}

function locatePage(result: any): PageLocation | undefined {
  const res = result?.result
  if (!res) return

  const out = res.output
  if (out && typeof out === "object" && out.type === "text-page") {
    return {
      page: out,
      write: (page) => {
        res.output = page
      },
      contentHint: (hint) => addHintToContent(res, hint),
    }
  }
  if (typeof out === "string") {
    const page = safeParse(out)
    if (page?.type === "text-page") {
      return {
        page,
        write: (p) => {
          res.output = JSON.stringify(p)
        },
        contentHint: (hint) => addHintToContent(res, hint),
      }
    }
  }

  const content = res.content
  if (typeof content === "string") {
    const page = safeParse(content)
    if (page?.type === "text-page") {
      return {
        page,
        write: (p) => {
          res.content = JSON.stringify(p)
        },
        contentHint: (hint) => {
          try {
            const parsed = JSON.parse(res.content)
            parsed.hint = hint
            res.content = JSON.stringify(parsed)
          } catch {
            res.content += `\n\n[${hint}]`
          }
        },
      }
    }
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part?.type !== "text" || typeof part.text !== "string") continue
      const page = safeParse(part.text)
      if (page?.type !== "text-page") continue
      return {
        page,
        write: (p) => {
          part.text = JSON.stringify(p)
        },
        contentHint: (hint) => {
          try {
            const parsed = JSON.parse(part.text)
            parsed.hint = hint
            part.text = JSON.stringify(parsed)
          } catch {
            part.text += `\n\n[${hint}]`
          }
        },
      }
    }
  }
  return
}

function addReadPageHint(result: any) {
  const located = locatePage(result)
  if (!located) return
  const { page } = located
  if (page?.truncated !== true) return

  const filePath = String(result?.input?.filePath ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')
  const content = typeof page.content === "string" ? page.content : ""
  const lineCount = content ? content.split(/\r?\n/).length : MAX_READ_LINES
  const base = Number.isFinite(Number(page.offset)) ? Number(page.offset) : 0
  const next = Number.isFinite(Number(page.next)) ? Number(page.next) : base + lineCount
  const suggestedLimit = Math.min(MAX_READ_LINES, Math.max(1, lineCount))
  const hint = `Page truncated. Next page: call read with filePath="${filePath}" offset=${next} limit=${suggestedLimit}. Do not request the rest at once.`

  page.hint = hint
  located.write(page)
  located.contentHint(hint)
}

function addHintToContent(res: any, hint: string) {
  const content = res?.content
  if (typeof content === "string") {
    try {
      const page = JSON.parse(content)
      page.hint = hint
      res.content = JSON.stringify(page)
    } catch {
      res.content = `${content}\n\n[${hint}]`
    }
    return
  }
  if (Array.isArray(content)) {
    const part = content.find((p: any) => p?.type === "text" && typeof p.text === "string")
    if (part) {
      try {
        const page = JSON.parse(part.text)
        page.hint = hint
        part.text = JSON.stringify(page)
      } catch {
        part.text += `\n\n[${hint}]`
      }
    } else {
      content.push({ type: "text", text: `[${hint}]` })
    }
  }
}

// ---------------------------------------------------------------------------
// Automatic large-file / repeated-read reminders (Phase 2)
// ---------------------------------------------------------------------------

async function addReadReminder(ctx: any, result: any) {
  if (result?.agent === "reader") return

  const filePath = result?.input?.filePath
  if (typeof filePath !== "string" || filePath.length === 0) return
  const sessionID = String(result?.sessionID ?? "unknown")

  let directory: string | undefined
  try {
    const session = await ctx?.session?.get?.({ sessionID })
    directory = typeof session?.directory === "string" ? session.directory : undefined
  } catch {}

  const absolute = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(directory ?? process.cwd(), filePath)
  const stat = await fs.stat(absolute).catch(() => undefined)
  const size = stat?.size ?? 0

  const key = `${sessionID}::${absolute}`
  const entry = readStats.get(key) ?? {
    path: absolute,
    reads: 0,
    sizeWarned: false,
    pagesWarned: false,
    updated: Date.now(),
  }
  entry.reads += 1
  entry.updated = Date.now()
  readStats.set(key, entry)
  pruneReadStats()

  const notes: string[] = []
  if (size > LARGE_FILE_BYTES && !entry.sizeWarned) {
    entry.sizeWarned = true
    notes.push(
      `This file is ${formatBytes(size)}. Do not read it page by page in the main context; use file_outline to target line ranges, or delegate to the reader subagent (subagent tool, agent=reader).`,
    )
  }
  if (entry.reads >= READ_PAGE_WARN_AT && !entry.pagesWarned) {
    entry.pagesWarned = true
    notes.push(
      `You have read ${entry.reads} pages of this file. Stop paging in the main context: use file_outline to target ranges, or delegate the rest to the reader subagent (subagent tool, agent=reader).`,
    )
  }
  if (notes.length > 0) appendToolNote(result, notes.join(" "))
}

function appendToolNote(result: any, note: string) {
  const res = result?.result
  if (!res) return

  const text = `[context-guard] ${note}`
  const content = res.content

  if (content === undefined || content === null) {
    res.content = text
    return
  }

  if (typeof content === "string") {
    try {
      const page = JSON.parse(content)
      page.reminder = text
      res.content = JSON.stringify(page)
    } catch {
      res.content = `${content}\n\n${text}`
    }
    return
  }

  if (Array.isArray(content)) {
    for (const part of content) {
      if (part?.type !== "text" || typeof part.text !== "string") continue
      try {
        const page = JSON.parse(part.text)
        page.reminder = text
        part.text = JSON.stringify(page)
      } catch {
        part.text += `\n\n${text}`
      }
      return
    }
    content.push({ type: "text", text })
    return
  }

  if (res.output && typeof res.output === "object") res.output.reminder = text
}

async function applyReadGate(ctx: any, result: any): Promise<"allowed" | "blocked"> {
  // The reader subagent is the isolated reading context; do not count its
  // pages against the main agent's budget.
  if (result?.agent === "reader") return "allowed"

  const sessionID = String(result?.sessionID ?? "")
  if (!sessionID) return "allowed"

  return withReadGateLock(async () => {
    const pending = await getPendingNextMove(sessionID)
    if (!pending) return "allowed"

    if (Date.now() - pending.at > NEXT_MOVE_TTL_MS) {
      await clearPendingNextMove(sessionID)
      return "allowed"
    }

    pending.reads += 1
    if (pending.reads > READ_BUDGET) {
      await setPendingNextMove(sessionID, pending)
      const text = `${READ_GATE_MARKER} (${READ_BUDGET} pages already read since the last edit). This read was blocked. Do not call read again. Apply the first incomplete Next Move edit now using the code already in context and the summary's line ranges. Use grep only for an exact missing symbol, or delegate to the reader subagent.`
      blockReadResult(result, text)
      await writeNudgeStatus({ sessionID, event: "read-gate-blocked", reads: pending.reads })
      log(ctx, "info", "read gate blocked", { sessionID, reads: pending.reads })
      return "blocked"
    }

    await setPendingNextMove(sessionID, pending)
    if (pending.reads === READ_BUDGET) {
      appendToolNote(
        result,
        "This is the last read before the edit gate. The next read will be blocked; make the Next Move edit now.",
      )
    }
    return "allowed"
  })
}

// Multiple tool results from one assistant step can run concurrently. Serialize
// the read count so three parallel reads count as three, not one.
let readGateQueue: Promise<void> = Promise.resolve()

async function withReadGateLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = readGateQueue
  let release!: () => void
  readGateQueue = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous
  try {
    return await fn()
  } finally {
    release()
  }
}

function blockReadResult(result: any, text: string) {
  const located = locatePage(result)
  if (located) {
    located.page.content = text
    located.page.truncated = false
    delete located.page.next
    located.page.hint = text
    located.write(located.page)
    located.contentHint(text)
    return
  }

  const res = result?.result
  if (!res) return
  res.content = [{ type: "text", text }]
  res.output = { type: "text", content: text }
}

function pruneReadStats() {
  if (readStats.size <= 500) return
  const entries = [...readStats.entries()].sort((a, b) => a[1].updated - b[1].updated)
  for (let index = 0; index < entries.length - 400; index++) readStats.delete(entries[index][0])
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

// ---------------------------------------------------------------------------
// Generic tool output cap
// ---------------------------------------------------------------------------

async function capToolOutput(result: any, tool: string) {
  const res = result?.result
  if (!res) return
  const id = String(result.id ?? result.callID ?? "unknown")
  const targets: { holder: any; key: string; value: string }[] = []

  if (typeof res.content === "string") {
    targets.push({ holder: res, key: "content", value: res.content })
  } else if (Array.isArray(res.content)) {
    for (const part of res.content) {
      if (part?.type === "text" && typeof part.text === "string") {
        targets.push({ holder: part, key: "text", value: part.text })
      }
    }
  }

  for (const target of targets) {
    if (target.value.length <= MAX_TOOL_CHARS) continue

    const saved = await saveFullOutput(tool, id, target.value).catch(() => "<save failed>")
    const head = target.value.slice(0, 8000)
    const tail = target.value.slice(-4000)
    const notice = `\n\n... [truncated ${target.value.length} chars; full output: ${saved}] ...\n\n`
    const extra =
      tool === "webfetch"
        ? "\n[Use grep/sed on the saved file or fetch a more specific URL instead of re-fetching.]"
        : ""
    target.holder[target.key] = head + notice + tail + extra
  }
}

async function saveFullOutput(tool: string, id: string, text: string): Promise<string> {
  await fs.mkdir(CACHE_DIR, { recursive: true })
  const safeTool = tool.replace(/[^A-Za-z0-9_-]/g, "_")
  const safeId = id.replace(/[^A-Za-z0-9_-]/g, "_")
  const file = path.join(CACHE_DIR, `${safeTool}-${safeId}.txt`)
  await fs.writeFile(file, text, "utf8")
  return file
}

// ---------------------------------------------------------------------------
// Session hooks
// ---------------------------------------------------------------------------

async function writeNudgeStatus(data: Record<string, unknown>) {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true })
    await fs.writeFile(
      path.join(CACHE_DIR, "last-nudge.json"),
      JSON.stringify({ at: new Date().toISOString(), ...data }, null, 2),
      "utf8",
    )
  } catch {}
}

function pendingNextMoveFile(sessionID: string): string {
  const safe = sessionID.replace(/[^A-Za-z0-9_-]/g, "_")
  return path.join(CACHE_DIR, `pending-next-move-${safe}.json`)
}

// The compaction and generate hooks can run in different plugin instances.
// Keep the pending state on disk so the nudge does not depend on a shared
// in-memory Map.
async function getPendingNextMove(sessionID: string): Promise<PendingNextMove | undefined> {
  try {
    const text = await fs.readFile(pendingNextMoveFile(sessionID), "utf8")
    const value = JSON.parse(text)
    if (!value || typeof value.at !== "number") return undefined
    const state: PendingNextMove = {
      at: value.at,
      injected: Number(value.injected) || 0,
      lastInjectedAt: Number(value.lastInjectedAt) || 0,
      reads: Number(value.reads) || 0,
    }
    pendingNextMove.set(sessionID, state)
    return state
  } catch {
    pendingNextMove.delete(sessionID)
    return undefined
  }
}

async function setPendingNextMove(sessionID: string, state: PendingNextMove): Promise<void> {
  pendingNextMove.set(sessionID, state)
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true })
    await fs.writeFile(pendingNextMoveFile(sessionID), JSON.stringify(state), "utf8")
  } catch {}
}

async function clearPendingNextMove(sessionID: string): Promise<boolean> {
  const existed = pendingNextMove.delete(sessionID)
  try {
    await fs.unlink(pendingNextMoveFile(sessionID))
    return true
  } catch {
    return existed
  }
}

function messageText(message: any): string {
  if (!message || typeof message !== "object") return ""
  const content = message.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part: any) => (part && typeof part.text === "string" ? part.text : ""))
    .join("\n")
}

function isCheckpointText(text: string): boolean {
  return (
    text.includes("<conversation-checkpoint>") ||
    (text.includes("## Objective") && text.includes("## Next Move"))
  )
}

function isCheckpointMessage(message: any): boolean {
  return isCheckpointText(messageText(message))
}

function lastCheckpointIndex(messages: any[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (isCheckpointMessage(messages[index])) return index
  }
  return -1
}

function isNudgeMessage(message: any): boolean {
  return message?.role === "user" && messageText(message).includes(NEXT_MOVE_MARKER)
}

function isReadGateMessage(message: any): boolean {
  return message?.role === "user" && messageText(message).includes(READ_GATE_MARKER)
}

function isInjectedGuidanceMessage(message: any): boolean {
  return isNudgeMessage(message) || isReadGateMessage(message)
}

function lastUserIndex(messages: any[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "user" && !isInjectedGuidanceMessage(messages[index])) return index
  }
  return -1
}

async function onGenerate(ctx: any, draft: any, phase: "context" | "generate") {
  try {
    if (draft?.model?.providerID !== "ollama") return
    if (draft?.agent === "compaction" || draft?.agent === "title" || draft?.agent === "summary") return
    if (!Array.isArray(draft?.messages)) return

    // Drop tools the local model rarely uses. Keep the core coding toolset:
    // read, file_outline, edit, write, glob, grep, shell, subagent, question,
    // webfetch. Removing `execute` also removes the codemode tools namespace,
    // which is a major source of confusion for a small model.
    for (const name of ["batch", "websearch", "execute", "skill", "todo", "todoread", "todowrite"]) {
      if (draft.tools && Object.prototype.hasOwnProperty.call(draft.tools, name)) delete draft.tools[name]
    }

    // Inject the context-discipline block once per request.
    if (Array.isArray(draft.system)) {
      const marker = "<context-discipline>"
      const already = draft.system.some(
        (message: any) => typeof message?.text === "string" && message.text.includes(marker),
      )
      if (!already) {
        const first = draft.system[0]
        if (first && typeof first.text === "string") first.text += `\n\n${DISCIPLINE}`
        else draft.system.push({ type: "text", text: DISCIPLINE })
      }
    }

    // Do not prune history before generation. The previous 22K safety net
    // removed recently-read code from the request just before compaction,
    // which made the agent re-read the same files again and again. The
    // compaction trigger and the bounded compaction input are enough.

    // After compaction, push the agent to execute the summary's Next Move
    // instead of re-reading the same files. Only inject while the checkpoint is
    // still the latest user turn; a new user request cancels the nudge. The
    // pending state is persisted because the context and generate hooks can run
    // in different plugin instances; hasNudge prevents duplicates within a draft.
    const sessionID = String(draft.sessionID ?? "")
    const pending = sessionID ? await getPendingNextMove(sessionID) : undefined
    if (pending) {
      const expired = Date.now() - pending.at > NEXT_MOVE_TTL_MS
      const checkpointIndex = lastCheckpointIndex(draft.messages)
      const lastUser = lastUserIndex(draft.messages)
      const anchored = checkpointIndex >= 0 && (lastUser < 0 || checkpointIndex >= lastUser)
      if (expired || (phase === "generate" && !anchored)) {
        await clearPendingNextMove(sessionID)
        await writeNudgeStatus({
          sessionID,
          phase,
          event: "cleared",
          reason: expired ? "expired" : "new-user-or-no-checkpoint",
        })
        return
      }
      // The context pass can run before the checkpoint is in the final message
      // list; leave the decision to the generate pass.
      if (!anchored) return

      if (pending.reads >= READ_BUDGET) {
        // Hard gate: the model has read enough pages since the last edit.
        // Remove the read tool for this request and tell it to edit now.
        if (draft.tools && typeof draft.tools === "object") delete draft.tools.read
        const hasGate = draft.messages.some(isReadGateMessage)
        if (!hasGate) {
          draft.messages.push({
            role: "user",
            content: [{ type: "text", text: READ_GATE_NUDGE }],
          })
          await writeNudgeStatus({
            sessionID,
            phase,
            event: "read-gate",
            reads: pending.reads,
          })
        }
      } else {
        const exhausted = pending.injected >= NEXT_MOVE_MAX_INJECTIONS
        if (!exhausted) {
          const hasNudge = draft.messages.some(isNudgeMessage)
          if (!hasNudge) {
            draft.messages.push({
              role: "user",
              content: [{ type: "text", text: NEXT_MOVE_NUDGE }],
            })
            pending.injected += 1
            pending.lastInjectedAt = Date.now()
            await setPendingNextMove(sessionID, pending)
            await writeNudgeStatus({
              sessionID,
              phase,
              event: "injected",
              injected: pending.injected,
              checkpointIndex,
              lastUserIndex: lastUser,
            })
          }
        }
      }
    }
  } catch (error) {
    warn("generate hook failed", error)
  }
}

async function onCompaction(ctx: any, draft: any) {
  try {
    if (draft?.model?.providerID !== "ollama") return

    // The summary request must not carry tool schemas.
    if (draft.tools && typeof draft.tools === "object") {
      for (const name of Object.keys(draft.tools)) delete draft.tools[name]
    }

    // Bound the prompt to the model's real 32K window. The compaction service
    // can hand us a 36K-48K prompt, which Ollama then truncates; the summary
    // model loses the template and either fails validation or fills the
    // remaining context with output. Keep the most useful parts:
    //   - drop reasoning
    //   - keep the last few tool results, replace older ones
    //   - cap assistant text, keep user text
    //   - drop oldest user turns only if still over budget
    //   - clear an oversized system prompt as a last resort (the default
    //     compaction template is appended as a user message, not system)
    const result = pruneForCompaction(draft)

    try {
      await fs.mkdir(CACHE_DIR, { recursive: true })
      await fs.writeFile(
        path.join(CACHE_DIR, "last-compaction.json"),
        JSON.stringify(
          {
            at: new Date().toISOString(),
            sessionID: draft.sessionID,
            messages: Array.isArray(draft.messages) ? draft.messages.length : -1,
            tools: Object.keys(draft.tools ?? {}).length,
            before: result.before,
            after: result.after,
            systemTokens: result.systemTokens,
            systemTokensBefore: result.systemTokensBefore,
            messageTokens: result.messageTokens,
            actions: result.actions,
            roles: Array.isArray(draft.messages) ? draft.messages.map((m: any) => m?.role) : [],
          },
          null,
          2,
        ),
        "utf8",
      )
    } catch {}

    log(ctx, "info", "compaction input bounded", {
      sessionID: draft.sessionID,
      messages: draft.messages?.length,
      before: result.before,
      after: result.after,
      actions: result.actions,
    })

    if (draft?.sessionID) {
      const sessionID = String(draft.sessionID)
      const previous = await getPendingNextMove(sessionID)
      const previousActive = Boolean(previous && Date.now() - previous.at <= NEXT_MOVE_TTL_MS)
      const checkpointIndex = lastCheckpointIndex(draft.messages)
      const lastUser = lastUserIndex(draft.messages)
      const newUserRequest = checkpointIndex >= 0 && lastUser > checkpointIndex
      // Carry the exploration budget across compactions. Reading until the
      // context fills, compacting, and reading again is exactly the loop this
      // gate exists to break; only an edit or a new user request resets it.
      const carriedReads = previousActive && !newUserRequest ? previous.reads : 0
      await setPendingNextMove(sessionID, {
        at: Date.now(),
        injected: 0,
        lastInjectedAt: 0,
        reads: carriedReads,
      })
      await writeNudgeStatus({
        sessionID,
        phase: "compaction",
        event: "pending-reset",
        reads: carriedReads,
        previousReads: previous?.reads ?? 0,
        newUserRequest,
      })
    }
  } catch (error) {
    warn("compaction hook failed", error)
  }
}

// ---------------------------------------------------------------------------
// Compaction input budget
// ---------------------------------------------------------------------------

function pruneForCompaction(draft: any): {
  before: number
  after: number
  systemTokens: number
  systemTokensBefore: number
  messageTokens: number
  actions: string[]
} {
  const actions: string[] = []
  const messages = Array.isArray(draft?.messages) ? draft.messages : []
  const beforeSystem = estimateTokens(draft?.system)
  const beforeMessages = estimateTokens(messages)
  const before = beforeSystem + beforeMessages

  if (!Array.isArray(draft?.messages)) {
    return {
      before,
      after: before,
      systemTokens: beforeSystem,
      systemTokensBefore: beforeSystem,
      messageTokens: beforeMessages,
      actions,
    }
  }

  const deduped = dedupeCheckpointMessages(messages)
  if (deduped > 0) actions.push(`deduped ${deduped} checkpoint sections`)

  const reasoning = dropReasoningParts(messages)
  if (reasoning > 0) actions.push(`dropped reasoning in ${reasoning} parts`)

  const tool = capToolResults(messages, COMPACTION_KEEP_TOOL_RESULTS, COMPACTION_TOOL_RESULT_MAX)
  if (tool.capped > 0) actions.push(`kept/capped ${tool.capped} recent tool results`)
  if (tool.omitted > 0) actions.push(`omitted ${tool.omitted} old tool results`)

  const assistantText = capAssistantText(messages, COMPACTION_ASSISTANT_TEXT_MAX)
  if (assistantText > 0) actions.push(`capped ${assistantText} assistant text/tool-call parts`)

  let systemTokens = estimateTokens(draft.system)
  let messageTokens = estimateTokens(messages)

  if (systemTokens + messageTokens > COMPACTION_INPUT_BUDGET) {
    const userText = capUserText(messages, 8000)
    if (userText > 0) actions.push(`capped ${userText} user texts`)
    messageTokens = estimateTokens(messages)
  }

  if (systemTokens + messageTokens > COMPACTION_INPUT_BUDGET) {
    const dropped = dropOldestUserTurns(messages, Math.max(0, COMPACTION_INPUT_BUDGET - systemTokens), 2)
    if (dropped > 0) actions.push(`dropped ${dropped} old user turns`)
    messageTokens = estimateTokens(messages)
  }

  systemTokens = estimateTokens(draft.system)
  if (systemTokens + messageTokens > COMPACTION_INPUT_BUDGET && Array.isArray(draft.system) && draft.system.length > 0) {
    // The default compaction template is appended as a user message, so
    // clearing the system prompt does not remove the template. We add no
    // custom text here: instructions in the system prompt can be copied into
    // the summary and then obeyed by the next agent.
    draft.system.splice(0, draft.system.length)
    actions.push("cleared oversized system prompt")
    systemTokens = 0
  }

  messageTokens = estimateTokens(messages)
  return {
    before,
    after: systemTokens + messageTokens,
    systemTokens,
    systemTokensBefore: beforeSystem,
    messageTokens,
    actions,
  }
}

/**
 * The compaction service asks the model to update the previous checkpoint.
 * Small local models often append a fresh set of `##` sections instead of
 * replacing the old ones, so summaries accumulate duplicate Next Move /
 * Relevant Files / Important Context blocks. Keeping the last occurrence of
 * each heading gives the model one clean checkpoint without losing the newest
 * content.
 */
function dedupeCheckpointMessages(messages: any[]): number {
  let removed = 0
  for (const message of messages) {
    if (!message || typeof message !== "object") continue
    if (typeof message.content === "string") {
      const result = dedupeCheckpointText(message.content)
      if (result.removed > 0) {
        message.content = result.text
        removed += result.removed
      }
      continue
    }
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (!part || part.type !== "text" || typeof part.text !== "string") continue
      const result = dedupeCheckpointText(part.text)
      if (result.removed > 0) {
        part.text = result.text
        removed += result.removed
      }
    }
  }
  return removed
}

function dedupeCheckpointText(text: string): { text: string; removed: number } {
  if (!text.includes("## Objective") || !text.includes("## Next Move")) {
    return { text, removed: 0 }
  }

  const lines = text.split("\n")
  const preamble: string[] = []
  const sections: { heading: string; lines: string[]; index: number }[] = []
  let current: { heading: string; lines: string[]; index: number } | undefined
  let inFence = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith("```")) {
      if (current) current.lines.push(line)
      else preamble.push(line)
      inFence = !inFence
      continue
    }
    if (!inFence && /^##\s+/.test(trimmed)) {
      if (current) sections.push(current)
      current = { heading: trimmed, lines: [line], index: sections.length }
      continue
    }
    if (current) current.lines.push(line)
    else preamble.push(line)
  }
  if (current) sections.push(current)
  if (sections.length === 0) return { text, removed: 0 }

  const last = new Map<string, { heading: string; lines: string[]; index: number }>()
  for (const section of sections) last.set(section.heading, section)
  if (last.size === sections.length) return { text, removed: 0 }

  const kept = [...last.values()].sort((a, b) => a.index - b.index)
  return {
    text: [...preamble, ...kept.flatMap((section) => section.lines)].join("\n"),
    removed: sections.length - kept.length,
  }
}

function dropReasoningParts(messages: any[]): number {
  let count = 0
  for (const message of messages) {
    if (!message || !Array.isArray(message.content)) continue
    const next: any[] = []
    for (const part of message.content) {
      const type = String(part?.type ?? "")
      if (type.includes("reasoning") || type.includes("thinking")) {
        count++
        continue
      }
      next.push(part)
    }
    if (next.length === 0 && message.content.length > 0) next.push({ type: "text", text: "[reasoning omitted]" })
    message.content = next
  }
  return count
}

function capToolResults(messages: any[], keep: number, maxChars: number): { capped: number; omitted: number } {
  let seen = 0
  let capped = 0
  let omitted = 0
  const placeholder = "[old tool output omitted during compaction]"

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message || typeof message !== "object") continue
    const role = String(message.role ?? "")
    const content = message.content

    if (role === "tool") {
      if (typeof content === "string") {
        seen++
        if (seen > keep) {
          message.content = placeholder
          omitted++
        } else {
          if (content.length > maxChars) message.content = capString(content, maxChars, "[tool output truncated]")
          capped++
        }
        continue
      }
      if (Array.isArray(content)) {
        for (let partIndex = content.length - 1; partIndex >= 0; partIndex--) {
          const part = content[partIndex]
          if (!part || typeof part !== "object") continue
          seen++
          if (seen > keep) {
            replacePartText(part, placeholder)
            omitted++
          } else {
            capPartStrings(part, maxChars, "[tool output truncated]")
            capped++
          }
        }
        continue
      }
    }

    if (Array.isArray(content)) {
      for (let partIndex = content.length - 1; partIndex >= 0; partIndex--) {
        const part = content[partIndex]
        if (!part || typeof part !== "object") continue
        const type = String(part.type ?? "")
        if (type !== "tool-result" && type !== "tool") continue
        seen++
        if (seen > keep) {
          replacePartText(part, placeholder)
          omitted++
        } else {
          capPartStrings(part, maxChars, "[tool output truncated]")
          capped++
        }
      }
    }
  }

  return { capped, omitted }
}

function capAssistantText(messages: any[], maxChars: number): number {
  let count = 0
  for (const message of messages) {
    if (!message || String(message.role ?? "") !== "assistant" || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (!part || typeof part !== "object") continue
      const type = String(part.type ?? "")
      if (type === "text") {
        if (typeof part.text === "string" && part.text.length > maxChars) {
          part.text = capString(part.text, maxChars, "[assistant text truncated]")
          count++
        }
        continue
      }
      if (type === "tool-call" && part.input && typeof part.input === "object") {
        const serialized = JSON.stringify(part.input)
        if (serialized.length > maxChars) {
          part.input = { _truncated: serialized.slice(0, maxChars) }
          count++
        }
      }
    }
  }
  return count
}

function capUserText(messages: any[], maxChars: number): number {
  let count = 0
  for (const message of messages) {
    if (!message || String(message.role ?? "") !== "user") continue
    const content = message.content
    if (typeof content === "string") {
      // The previous checkpoint is the source for the updated summary. Never
      // truncate it as ordinary user text; the budget pass below may drop
      // older user turns instead.
      if (isCheckpointText(content)) continue
      if (content.length > maxChars) {
        message.content = capString(content, maxChars, "[user text truncated]")
        count++
      }
      continue
    }
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (part?.type !== "text" || typeof part.text !== "string") continue
      if (isCheckpointText(part.text)) continue
      if (part.text.length > maxChars) {
        part.text = capString(part.text, maxChars, "[user text truncated]")
        count++
      }
    }
  }
  return count
}

function replacePartText(part: any, text: string, depth = 0) {
  if (!part || typeof part !== "object" || depth > 4) return
  for (const key of ["text", "value", "result"]) {
    if (typeof part[key] === "string") part[key] = text
  }
  if (part.output && typeof part.output === "object") {
    for (const key of ["text", "value", "content"]) {
      if (typeof part.output[key] === "string") part.output[key] = text
    }
  }
  if (Array.isArray(part.content)) {
    for (const child of part.content) replacePartText(child, text, depth + 1)
  }
}

function dropOldestUserTurns(messages: any[], messageBudget: number, keepTurns: number): number {
  if (!Array.isArray(messages) || messages.length === 0) return 0

  const groups: any[][] = []
  let current: any[] = []
  for (const message of messages) {
    if (message?.role === "user" && current.length > 0) {
      groups.push(current)
      current = []
    }
    current.push(message)
  }
  if (current.length > 0) groups.push(current)

  let dropped = 0
  while (groups.length > keepTurns && estimateTokens(groups.flat()) > messageBudget) {
    groups.shift()
    dropped++
  }
  if (dropped > 0) messages.splice(0, messages.length, ...groups.flat())
  return dropped
}

// ---------------------------------------------------------------------------
// Pruning helpers
// ---------------------------------------------------------------------------

function estimateTokens(value: unknown): number {
  if (value === undefined || value === null) return 0
  let text: string
  try {
    text = typeof value === "string" ? value : JSON.stringify(value)
  } catch {
    return 0
  }
  if (!text) return 0
  let ascii = 0
  let nonAscii = 0
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) < 128) ascii++
    else nonAscii++
  }
  return Math.ceil(ascii / 3.6 + nonAscii)
}

function capString(value: string, max: number, placeholder: string): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n${placeholder} (${value.length} chars)`
}

function capPartStrings(part: any, max: number, placeholder: string, depth = 0) {
  if (!part || typeof part !== "object" || depth > 4) return
  for (const key of ["text", "value", "result"]) {
    if (typeof part[key] === "string") part[key] = capString(part[key], max, placeholder)
  }
  if (part.output && typeof part.output === "object") {
    for (const key of ["text", "value", "content"]) {
      if (typeof part.output[key] === "string") {
        part.output[key] = capString(part.output[key], max, placeholder)
      }
    }
  }
  if (Array.isArray(part.content)) {
    for (const child of part.content) capPartStrings(child, max, placeholder, depth + 1)
  }
}

// ---------------------------------------------------------------------------
// file_outline
// ---------------------------------------------------------------------------

async function outlineFile(filePath: string, maxItems: number, cwd?: string): Promise<string> {
  if (!filePath) throw new Error("filePath is required")
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(cwd || process.cwd(), filePath)
  const stat = await fs.stat(absolute)
  if (!stat.isFile()) throw new Error(`Not a file: ${absolute}`)

  let text = await fs.readFile(absolute, "utf8")
  if (text.length > 2_000_000) text = text.slice(0, 2_000_000)
  const lines = text.split(/\r?\n/)
  const extension = path.extname(absolute).toLowerCase()

  let hits: string[] = []
  if (extension === ".json" || extension === ".jsonc") {
    try {
      const value = JSON.parse(text)
      hits = jsonHits(value, lines, maxItems)
    } catch {
      // JSONC / malformed JSON: fall back to the generic scanner.
    }
  }

  if (hits.length === 0) {
    for (let index = 0; index < lines.length && hits.length < maxItems; index++) {
      const line = lines[index]
      if (isSymbolLine(line)) hits.push(`${index + 1}: ${line.trim().slice(0, 180)}`)
    }
  }

  if (hits.length === 0) {
    for (let index = 0; index < Math.min(lines.length, 80); index++) {
      hits.push(`${index + 1}: ${lines[index].slice(0, 180)}`)
    }
  }

  const ranges = suggestedRanges(lines.length, hits)
  return [
    `OUTLINE ${absolute}`,
    `${lines.length} lines; ${stat.size} bytes; ${hits.length} structural hits (max ${maxItems}).`,
    `Suggested reads: ${ranges.join(", ")}`,
    "",
    ...hits.slice(0, maxItems),
  ]
    .join("\n")
    .slice(0, 12000)
}

function jsonHits(value: any, lines: string[], maxItems: number): string[] {
  if (!value || typeof value !== "object") return []
  const hits: string[] = []
  const lineOf = (key: string): number => {
    const needle = JSON.stringify(key)
    for (let index = 0; index < lines.length; index++) {
      if (lines[index].includes(needle)) return index + 1
    }
    return 1
  }

  for (const key of Object.keys(value)) {
    const rendered = /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`
    hits.push(`${lineOf(key)}: $${rendered}`)
    if (hits.length >= maxItems) return hits
  }

  for (const container of ["$defs", "definitions"]) {
    const defs = (value as any)[container]
    if (!defs || typeof defs !== "object") continue
    for (const key of Object.keys(defs)) {
      hits.push(`${lineOf(key)}: ${container}.${key}`)
      if (hits.length >= maxItems) return hits
    }
  }
  return hits
}

function isSymbolLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return false
  return (
    /^#{1,6}\s+/.test(trimmed) ||
    /^(export\s+)?(default\s+)?(async\s+)?(function|class|interface|type|enum|struct|trait|impl)\b/.test(trimmed) ||
    /^(export\s+)?(const|let|var)\s+[A-Za-z_$][\w$]*\s*=/.test(trimmed) ||
    /^(async\s+)?def\s+[A-Za-z_]/.test(trimmed) ||
    /^(public|private|protected|static|async|final|abstract)\s+.*\([^)]*\)\s*\{?\s*$/.test(trimmed) ||
    /^(func|type)\s+[A-Za-z_]/.test(trimmed) ||
    /^[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{\s*$/.test(trimmed)
  )
}

function suggestedRanges(lineCount: number, hits: string[]): string[] {
  const ranges = new Set<string>()
  ranges.add(`1-${Math.min(60, Math.max(1, lineCount))}`)
  const numbers = hits
    .map((hit) => Number.parseInt(hit, 10))
    .filter((value) => Number.isFinite(value))
  for (const number of numbers.slice(0, 3)) {
    ranges.add(`${Math.max(1, number - 5)}-${Math.min(lineCount, number + 25)}`)
  }
  return [...ranges].slice(0, 5)
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

function safeParse(value: string): any {
  if (!value || !value.startsWith("{")) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}
