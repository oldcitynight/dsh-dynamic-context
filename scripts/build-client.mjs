// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs'
import { Script } from 'node:vm'
import { flattenClientModules } from './client-module.mjs'
const root = new URL('../', import.meta.url)
const values = fs.readFileSync(new URL(import.meta.resolve('@deepseek-ai/dsh-util-values')), 'utf8')
const settingsForm = fs.readFileSync(new URL(import.meta.resolve('dsh-better-task-grapth/settings-form')), 'utf8')
const sources = [['@deepseek-ai/dsh-util-values', values], ['dsh-better-task-grapth/settings-form', settingsForm],
  ...['performance-common.mjs', 'client-enhancements.mjs', 'settings-client.mjs', 'tool-display-names.mjs', 'client.source.mjs']
    .map(file => ['./' + file, fs.readFileSync(new URL(file, root), 'utf8')])]
const output = `// SPDX-License-Identifier: GPL-3.0-only
// Generated from client.source.mjs with native PartialArguments.
// Upstream utility license: DSH-VALUES-LICENSE.txt.
window.__ModuleLoader__.load({id:"dsh-dynamic-context",factory(require){
${flattenClientModules(sources)}
return createExecutionClient(PartialArguments, require("react"), require("@deepseek-ai/dsh-client-ui-primitives"));
}});
`
new Script(output, { filename: 'dsh-dynamic-context/client.js' })
if (process.argv[2] === '--check') {
  if (fs.readFileSync(new URL('client.js', root), 'utf8') !== output) throw Error('Execution client bundle is stale')
} else if (process.argv.length === 2) fs.writeFileSync(new URL('client.js', root), output)
else throw Error('Use no arguments or --check')
