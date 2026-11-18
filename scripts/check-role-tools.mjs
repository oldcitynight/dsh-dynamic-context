// SPDX-License-Identifier: GPL-3.0-only
// Offline inventory: read installed native definitions; never start a DSH session.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROLE_TOOL_CATALOG, roleToolCoverage } from '../role-tool-defaults.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
export function inventoryRoleTools() {
  const directory = path.dirname(path.dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-tools/package.json')))), native = new Set(), packages = [], unparsed = []
  for (const name of fs.readdirSync(directory).sort()) {
    // Plan mode and MCP resources define tools outside dsh-tool-* packages.
    // Inspect every installed native entry point so these cannot evade policy.
    const entry = path.join(directory, name, 'lib/index.js')
    if (!fs.existsSync(entry)) continue
    const source = fs.readFileSync(entry, 'utf8'), tools = new Set()
    const definitions = [...source.matchAll(/(?:defineTool|tools\.register)\(\{\s*name:\s*([^\n,]+)/g)]
    for (const row of definitions) {
      const literal = row[1].match(/^["']([^"']+)["']$/)
      if (literal) tools.add(literal[1])
      else if (row[1] === 'EXIT_PLAN_MODE' && /const EXIT_PLAN_MODE = ["']exit_plan_mode["']/.test(source)) tools.add('exit_plan_mode')
      else if (row[1] === 'RUN_CODE_NAME' && /const RUN_CODE_NAME = ["']run_code["']/.test(source)) tools.add('run_code')
      else if (row[1] === 'PROPOSE_ACTION' && /const PROPOSE_ACTION = ["']propose_action["']/.test(source)) tools.add('propose_action')
      else if (row[1] === 'RUN_CODE_NAME$1' && source.includes('RUN_CODE_NAME as RUN_CODE_NAME$1') && source.includes('from "@deepseek-ai/dsh-tools"')) tools.add('run_code')
      else if (row[1] === 'toolName') {
        const configured = source.match(/toolName:\s*z\.string\(\)\.default\(["']([^"']+)["']\)/)
        if (configured) tools.add(configured[1]); else unparsed.push({ package: name, expression: row[1] })
      } else unparsed.push({ package: name, expression: row[1] })
    }
    if (name === 'dsh-tools') tools.add('run_code')
    if (tools.size) packages.push({ package: '@deepseek-ai/' + name, tools: [...tools].sort() })
    for (const tool of tools) native.add(tool)
  }
  const plugin = new Set()
  for (const file of fs.readdirSync(root).filter(name => name.endsWith('.mjs') && name !== 'role-tool-defaults.mjs')) {
    for (const row of fs.readFileSync(path.join(root, file), 'utf8').matchAll(/["'](dynamic_context_[a-z_]+|dynamic_task_status)["']/g)) plugin.add(row[1])
  }
  for (const name of ['transaction_graph_read', 'transaction_graph_create', 'transaction_graph_begin', 'transaction_graph_finish', 'transaction_graph_skip']) plugin.add(name)
  const coverage = roleToolCoverage([...native, ...plugin])
  return { native: [...native].sort(), plugin: [...plugin].sort(), packages, unparsed, ...coverage,
    catalogCount: ROLE_TOOL_CATALOG.length, scope: 'Current installed native packages and both plugins; configured aliases and external tools require registration.' }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inventory = inventoryRoleTools(); console.log(JSON.stringify(inventory, null, 2))
  if (!inventory.native.length || inventory.unparsed.length || inventory.unclassified.length) process.exitCode = 1
}
