import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createHarness, GLOBAL_PRIVATE } from './testing/harness.mjs'
import { proposal, scenarioResponse } from './testing/scenario.mjs'

const projectRoot = fs.realpathSync(process.cwd())
const args = process.argv.slice(2)
const flags = new Map()
for (let i = 0; i < args.length; i += 2) {
  if (!['--output', '--transport'].includes(args[i]) || !args[i + 1] || flags.has(args[i])) throw new Error('Usage: demo.mjs [--output NEW_DIRECTORY] [--transport direct|native-guarded]')
  flags.set(args[i], args[i + 1])
}
const transport = flags.get('--transport') ?? 'direct'
if (!['direct', 'native-guarded'].includes(transport)) throw new Error('Invalid transport')
const output = path.resolve(flags.get('--output') ?? path.join(projectRoot, '.tmp', `dynamic-context-${transport}-demo-${Date.now()}`))
if (!output.startsWith(projectRoot + path.sep)) throw new Error('DEMO_OUTPUT_MUST_BE_IN_PROJECT')
fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 })
fs.mkdirSync(output, { mode: 0o700 })
const h = await createHarness({ projectRoot, directory: path.join(output, 'state'), respond: scenarioResponse, config: { transport } })
try {
  fs.writeFileSync(path.join(output, 'proposal.json'), JSON.stringify(proposal(), null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  h.runner.submit(proposal())
  const completed = []
  for (const task of ['a', 'b', 'c']) {
    const result = await h.runner.runNext({ expectedRevision: h.runner.graph.read().revision })
    assert.equal(result.trace.assembly.task.key, task)
    completed.push(result)
  }
  const wire = h.backend.requests, text = row => JSON.stringify(row.payload.messages)
  const checks = {
    threeDistinctTaskSessions: new Set(completed.map(row => row.report.sessionId)).size === 3,
    onlyBoundContexts: wire.slice(0, 2).every(row => !/B_CONTEXT_PRIVATE|C_CONTEXT_PRIVATE/.test(text(row)))
      && wire.slice(2, 4).every(row => !/A_CONTEXT_PRIVATE|A_TOOL_PRIVATE_RAW|C_CONTEXT_PRIVATE/.test(text(row))),
    declaredReportInheritedExactly: completed[1].trace.assembly.inheritedReports[0].text === completed[0].report.text,
    cReceivesNoPriorReports: !/A_REPORT_DECLARED|B_REPORT_NOT_INHERITED|A_CONTEXT_PRIVATE|B_CONTEXT_PRIVATE|COMMON_CONTEXT/.test(text(wire[4])),
    noUnboundOrGlobalContext: wire.every(row => !text(row).includes(GLOBAL_PRIVATE) && !text(row).includes('UNUSED_CONTEXT_MUST_NOT_LEAK')),
    toolScopes: JSON.stringify(wire.map(row => (row.payload.tools ?? []).map(tool => tool.function.name)))
      === JSON.stringify([['fixture_read_a'], ['fixture_read_a'], ['fixture_read_b'], ['fixture_read_b'], []]),
    inputContractValidated: completed.every(row => row.trace.requests.every(request => request.validation === 'PASS' && request.contractHash === row.trace.contract.hash)),
    accountingAndRequestUseSameInput: transport === 'direct'
      ? completed.flatMap(row => row.trace.requests).every((request, index) => request.bodySha256 === createHash('sha256').update(wire[index].rawBody).digest('hex'))
      : completed.every(row => row.trace.requests.every(request => request.wireValidated && request.derivesSameMessages
        && JSON.stringify(request.measuredSurfaceSeqs) === JSON.stringify(request.requestSurfaceSeqs))),
    durableTraceHashes: completed.every(row => row.report.evidence.every(ref =>
      createHash('sha256').update(fs.readFileSync(ref.ref)).digest('hex') === ref.sha256)),
    noBackendErrors: h.backend.errors.length === 0,
    goalRemainsUnverified: h.runner.graph.status().goalReached === false,
  }
  const summary = { schema: 2, date: new Date().toISOString(), status: Object.values(checks).every(Boolean) ? 'PASS_PROTOTYPE_ONLY' : 'FAIL',
    transport, modelBackend: 'synthetic fake llama; no model inference',
    route: transport === 'direct' ? 'plugin-owned JSON -> direct loopback HTTP/SSE; native ToolRuntime for explicitly allowed agentless tools'
      : 'guarded native DSH -> shipped PiAiAdapter -> loopback HTTP/SSE',
    dshVersion: JSON.parse(fs.readFileSync(path.join(projectRoot, 'node_modules/@deepseek-ai/dsh/package.json'))).version,
    taskGraphCoreVersion: JSON.parse(fs.readFileSync(path.join(projectRoot, 'dsh-better-task-grapth/package.json'))).version,
    nodeVersion: process.version, requests: wire.length,
    taskRuns: completed.map(row => ({ task: row.trace.assembly.task.key, conversationId: row.report.sessionId,
      identityKind: transport === 'direct' ? 'plugin-owned conversation; not a native DSH Session' : 'native DSH Session',
      report: row.report.text, requests: row.trace.requests.length, evidence: row.report.evidence })), checks,
    notRun: ['real model quality', 'same-session history filtering', 'native compaction compatibility',
      'interrupted active-task recovery', 'existing task-graph host tool integration', 'production installation',
      'direct integration of native Agent-bound tools and per-Agent sandbox policy', 'multimodal transports'],
  }
  fs.writeFileSync(path.join(output, 'wire-requests.json'), JSON.stringify(wire, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  assert.equal(summary.status, 'PASS_PROTOTYPE_ONLY')
  console.log(JSON.stringify({ status: summary.status, transport, tasks: completed.length, requests: wire.length,
    passedChecks: Object.values(checks).filter(Boolean).length, verification: path.join(output, 'verification.json') }))
} finally { await h.close() }
