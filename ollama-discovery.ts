// opencode 2.x discovers Ollama models natively from the gateway (/api/tags).
// This plugin only applies uniform limits to every discovered Ollama model.
// It uses the 2.x plugin format: a default { id, setup } definition.

const CONTEXT_LIMIT = 32768
const OUTPUT_LIMIT = 16184

export default {
  id: "ollama-limits",
  setup: async (ctx: any) => {
    await ctx.model.transform((editor: any) => {
      for (const model of editor.list("ollama")) {
        editor.update("ollama", model.id, (item: any) => {
          item.limit.context = CONTEXT_LIMIT
          item.limit.output = OUTPUT_LIMIT
        })
      }
    })
  },
}
