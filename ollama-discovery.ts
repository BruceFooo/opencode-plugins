// opencode 2.x discovers Ollama models natively from the gateway (/api/tags).
// This plugin only applies uniform limits to every discovered Ollama model.
// It uses the 2.x plugin format: a default { id, setup } definition.

const CONTEXT_LIMIT = 32768
const OUTPUT_LIMIT = 16184
const DEFAULT_COMPACTION_MODEL = "flint:latest"

export default {
  id: "ollama-limits",
  setup: async (ctx: any) => {
    // Only the model the compaction agent actually uses needs a no-thinking
    // variant. Resolve it from the agent config instead of adding `none` to
    // every Ollama model.
    let compactionModelID = DEFAULT_COMPACTION_MODEL
    try {
      const compaction = await ctx.agent?.get?.({ agentID: "compaction" })
      const info = compaction?.data ?? compaction
      if (typeof info?.model?.id === "string" && info.model.id.length > 0) {
        compactionModelID = info.model.id
      }
    } catch {}

    await ctx.model.transform((editor: any) => {
      for (const model of editor.list("ollama")) {
        editor.update("ollama", model.id, (item: any) => {
          item.limit.context = CONTEXT_LIMIT
          item.limit.output = OUTPUT_LIMIT

          // Normal agents keep their default/high variant. Only the model
          // selected by the compaction agent gets `none`.
          if (model.id !== compactionModelID) return

          item.variants ??= []
          if (!item.variants.some((variant: any) => variant?.id === "none")) {
            item.variants.push({ id: "none", settings: { reasoningEffort: "none" } })
          }
        })
      }
    })
  },
}
