/**
 * Dump the exact tool schemas that reach the provider.
 *
 * Run with `node test/dump.mjs` when a provider rejects a tool with
 * "Invalid schema for function ...". It prints the registered `parameters` and
 * `output.schema` trees so the offending node can be read directly.
 */

const { readTool, editTool, manageTool } = await import('../lib/tools.js')

const runtime = {
  read: async () => '',
  edit: async () => {},
  manage: async () => '',
  allDocuments: () => [],
}

for (const tool of [readTool(runtime), editTool(runtime), manageTool(runtime)]) {
  console.log(`\n===== ${tool.name} =====`)
  console.log(JSON.stringify(tool.parameters, null, 2))
  console.log('--- output.schema ---')
  console.log(JSON.stringify(tool.output.schema, null, 2))
}
