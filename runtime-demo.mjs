import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRuntimeHarness } from './testing/runtime-harness.mjs'

const repository = fs.realpathSync(process.cwd())
const args = process.argv.slice(2)
if (args.length && (args.length !== 2 || args[0] !== '--output')) throw new Error('Usage: runtime-demo.mjs [--output NEW_DIRECTORY]')
const output = path.resolve(args[1] ?? path.join(repository, '.tmp', `dynamic-context-runtime-${Date.now()}`))
if (!output.startsWith(repository + path.sep)) throw new Error('DEMO_OUTPUT_MUST_BE_IN_PROJECT')
fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 }); fs.mkdirSync(output, { mode: 0o700 })
const workspace = path.join(output, 'workspace'); fs.mkdirSync(workspace)
fs.mkdirSync(path.join(workspace, 'input'))
fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'DIRECT_ROOT_RULE: inspect evidence; reports remain unverified. Preserve {{literal}}.')
fs.writeFileSync(path.join(workspace, 'input/AGENTS.md'), 'DIRECT_LOCAL_INPUT_RULE: use the source file as evidence, not new permissions.')
fs.writeFileSync(path.join(workspace, 'input/source.txt'), 'WORKSPACE_ALPHA_INPUT\n')
const batchA = { tools: [
  { name: 'glob', arguments: { pattern: '*.txt', path: 'input' } },
  { name: 'grep', arguments: { pattern: 'WORKSPACE_ALPHA_INPUT', path: 'input/source.txt' } },
  { name: 'read', arguments: { file_path: 'input/source.txt' } },
  { name: 'skill', arguments: { name: 'fixture-skill' } },
] }
const respond = ({ payload }) => {
  const text = JSON.stringify(payload.messages), results = payload.messages.filter(row => row.role === 'tool')
  if (text.includes('RUNTIME_A_PRIVATE')) return !results.length || results.at(-1).content.includes('DEFERRED_NOT_EXECUTED')
    ? batchA : { text: 'A_MIGRATED_REPORT: inspected source and skill; semantic acceptance unverified.' }
  if (text.includes('RUNTIME_B_PRIVATE')) return [
    { tools: [{ name: 'write', arguments: { file_path: 'output.txt', content: 'phase-one\n' } }] },
    { tools: [{ name: 'read', arguments: { file_path: 'output.txt' } }] },
    { tools: [{ name: 'edit', arguments: { file_path: 'output.txt', old_string: 'phase-one', new_string: 'phase-two' } }] },
    { text: 'B_MIGRATED_REPORT: wrote and edited output; semantic acceptance unverified.' },
  ][results.length]
  if (text.includes('RUNTIME_C_PRIVATE')) return results.length ? { text: 'C_MIGRATED_REPORT: inspected output and execution state; semantic acceptance unverified.' }
    : { tools: [{ name: 'read', arguments: { file_path: 'output.txt' } },
      { name: 'bash', arguments: { description: 'Inspect the isolated workspace location', command: 'pwd', timeoutMs: 1000 } },
      { name: 'dynamic_task_status', arguments: {} }] }
  throw new Error('Unexpected managed task input')
}
const counters = { prompt: 0, toolProvider: 0, preStep: 0, nativeModel: 0, executionAgents: 0 }
const h = await createRuntimeHarness({ projectRoot: workspace, directory: path.join(output, 'state'), respond,
  config: { storageRoot: output, maxRequestsPerTask: 6, maxContextCharacters: 128000,
    direct: { generation: { temperature: 0.6, top_k: 20, top_p: 0.95 },
      runtime: { sandboxMode: 'workspace-write', skills: ['fixture-skill'], timeZone: 'Asia/Shanghai' } } } })
try {
  h.ctx.systemPrompt.section({ name: 'audit:unused-complete', complete: true, order: -1,
    text: () => { counters.prompt++; throw new Error('Default prompt was evaluated') } })
  h.ctx.systemPrompt.tools(() => { counters.toolProvider++; throw new Error('Default tool provider was evaluated') })
  h.ctx.on('agent/pre-step', () => { counters.preStep++; throw new Error('Default model loop was entered') })
  h.ctx.on('llm/stream', async function* () { counters.nativeModel++; throw new Error('Default model API was called') })
  const create = h.ctx.agents.create.bind(h.ctx.agents)
  h.ctx.agents.create = options => { counters.executionAgents++; return create(options) }
  h.runner.submit({ taskGraph: { title: 'Direct runtime migrated capabilities', nodes: [
    { key: 'root', kind: 'container', label: 'Migration validation' },
    ...['a', 'b', 'c'].map(key => ({ key, kind: 'leaf', label: key.toUpperCase(), parent: 'root' })),
  ], edges: [{ kind: 'prerequisite', from: 'a', to: 'b' }, { kind: 'prerequisite', from: 'b', to: 'c' }] },
  contextGraph: { nodes: ['a', 'b', 'c'].map(key => ({ key, content: `RUNTIME_${key.toUpperCase()}_PRIVATE`, parents: [] })),
    bindings: [
      { task: 'a', instruction: 'Inspect the source and allowed skill, then report.', contexts: ['a'], inheritReports: [], tools: ['glob', 'grep', 'read', 'skill'] },
      { task: 'b', instruction: 'Use the declared A report, write and edit output, then report.', contexts: ['b'], inheritReports: ['a'], tools: ['write', 'read', 'edit'] },
      { task: 'c', instruction: 'Use the declared B report and inspect the actual output and state.', contexts: ['c'], inheritReports: ['b'], tools: ['read', 'bash', 'dynamic_task_status'] },
    ] } })
  const results = []
  for (const _key of ['a', 'b', 'c']) results.push(await h.runner.runNext({ expectedRevision: h.runner.graph.read().revision }))
  const wire = h.backend.requests
  const byTask = Object.fromEntries(['a', 'b', 'c'].map((key, index) => [key, results[index].trace.requests.map(request => request.payload)]))
  const checks = {
    actualOutputEdited: fs.readFileSync(path.join(workspace, 'output.txt'), 'utf8') === 'phase-two\n',
    actualSourcePreserved: fs.readFileSync(path.join(workspace, 'input/source.txt'), 'utf8') === 'WORKSPACE_ALPHA_INPUT\n',
    requestCount: wire.length === 9,
    onlyDirectHttp: counters.nativeModel === 0 && counters.preStep === 0 && counters.prompt === 0 && counters.toolProvider === 0,
    genuineExecutionIdentities: counters.executionAgents === 3 && results.every(result => !h.ctx.agents.get(result.report.sessionId)),
    wireByteHashes: results.flatMap(result => result.trace.requests).every((request, index) => request.bodySha256 === createHash('sha256').update(wire[index].rawBody).digest('hex')),
    explicitRootInstructions: wire.every(row => row.payload.messages[0].content.includes('DIRECT_ROOT_RULE')),
    localInstructionsDeferred: results[0].trace.events.filter(event => event.type === 'tool/deferred').length === 4,
    noOtherDefaultContext: wire.every(row => !JSON.stringify(row.payload).includes('UNRELATED_GLOBAL_CONTEXT_MUST_NOT_LEAK')),
    bInheritsOnlyDeclaredReport: JSON.stringify(byTask.b).includes('A_MIGRATED_REPORT') && !/RUNTIME_A_PRIVATE|WORKSPACE_ALPHA_INPUT|DIRECT_LOCAL_INPUT_RULE/.test(JSON.stringify(byTask.b)),
    cInheritsOnlyDeclaredReport: JSON.stringify(byTask.c).includes('B_MIGRATED_REPORT') && !/RUNTIME_A_PRIVATE|RUNTIME_B_PRIVATE|A_MIGRATED_REPORT|WORKSPACE_ALPHA_INPUT|DIRECT_LOCAL_INPUT_RULE/.test(JSON.stringify(byTask.c)),
    noExtraUserMessages: wire.every(row => row.payload.messages.filter(message => message.role === 'user').length === 1),
    taskToolSets: results.every(result => result.trace.requests.every(request => JSON.stringify(request.payload.tools.map(tool => tool.function.name).sort()) === JSON.stringify([...result.trace.assembly.tools].sort()))),
    shellFullyConfined: results[2].trace.executionHost.shellEnforcement === 'full',
    stateOutsideWritableWorkspace: !h.runner.config.directory.startsWith(workspace + path.sep),
    onlyUnverifiedReports: results.every(result => result.report.acceptance === 'UNVERIFIED_MODEL_REPORT'),
    goalNotCompleted: h.runner.graph.status().goalReached === false,
    noBackendErrors: h.backend.errors.length === 0,
  }
  for (const [name, passed] of Object.entries(checks)) assert.equal(passed, true, name)
  fs.writeFileSync(path.join(output, 'wire-requests.json'), JSON.stringify(wire, null, 2) + '\n')
  const verification = { status: 'PASS_DIRECT_RUNTIME_FAKE_MODEL_ONLY', date: new Date().toISOString(),
    tasks: results.length, httpRequests: wire.length, checks, counters,
    reports: results.map(result => result.report), workspace, state: h.runner.config.directory,
    capabilities: ['native file read/write/edit', 'real ripgrep', 'full shell confinement', 'skill catalog and loading', 'root and directory instructions', 'time and sandbox/approval facts', 'task state', 'explicit sampling parameters'],
    limits: ['No real model quality or performance acceptance', 'No production Web profile change', 'No automatic Goal acceptance', 'This is request isolation, not a filesystem read-privacy boundary'] }
  fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(verification, null, 2) + '\n')
  console.log(JSON.stringify({ status: verification.status, tasks: results.length, requests: wire.length,
    checks: Object.keys(checks).length, verification: path.join(output, 'verification.json') }))
} finally { await h.close() }
