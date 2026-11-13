// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRuntimeHarness } from './testing/runtime-harness.mjs'
import { startFakeLlama } from './testing/fake-llama.mjs'
import { checkpointData, checkDirectHistory } from './checkpoints.mjs'

const repository = fs.realpathSync(process.cwd())
const args = process.argv.slice(2)
if (args.length && (args.length !== 2 || args[0] !== '--output')) throw new Error('Usage: continuation-demo.mjs [--output NEW_DIRECTORY]')
const output = path.resolve(args[1] ?? path.join(repository, '.tmp', `dynamic-context-continuation-${Date.now()}`))
if (!output.startsWith(repository + path.sep)) throw new Error('DEMO_OUTPUT_MUST_BE_IN_PROJECT')
fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 }); fs.mkdirSync(output, { mode: 0o700 })
const workspace = path.join(output, 'workspace'); fs.mkdirSync(workspace)
fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'CONTINUATION_ROOT_RULE: preserve evidence and distinguish observations from acceptance.')
for (const name of ['a', 'b']) fs.writeFileSync(path.join(workspace, `${name}.txt`),
  'Historical observations: FAIL NOT_RUN UNKNOWN UNVERIFIED.\n' + Array.from({ length: 260 }, (_, i) => `${name}-source-${i}: ${'x'.repeat(60)}`).join('\n') + `\nPRIVATE_${name.toUpperCase()}_EXACT_TAIL\n`)
let firstSource, recoveredExactSource = false
const backend = await startFakeLlama({ respond: ({ index, payload }) => {
  const checkpoint = payload.messages.map(checkpointData).find(Boolean)
  if (index === 1) return { tools: [{ name: 'skill', arguments: { name: 'fixture-skill' } }, { name: 'read', arguments: { file_path: 'a.txt' } }] }
  if (index === 2) return { tools: [{ name: 'read', arguments: { file_path: 'b.txt' } }] }
  if (index === 3) {
    assert.equal(checkpoint.generation, 2)
    assert.match(checkpoint.residentInstructions.skills[0].content, /SKILL_FIXTURE_BODY/)
    firstSource = checkpoint.historicalToolFacts.find(row => row.tool === 'read')
    return { tools: [{ name: 'write', arguments: { file_path: 'result.txt', content: 'phase-one\n' } }] }
  }
  if (index === 4) {
    assert.equal(checkpoint.generation, 2)
    assert.match(checkpoint.residentInstructions.skills[0].content, /SKILL_FIXTURE_BODY/)
    assert.match(payload.messages[0].content, /restart empty/)
    return { tools: [{ name: 'dynamic_context_source_read', arguments: { archive_id: firstSource.source.archiveId,
      message_index: firstSource.source.messageIndex, offset: firstSource.resultCharacters - 100, length: 100 } }] }
  }
  if (index === 5) {
    assert.match(payload.messages.at(-1).content, /PRIVATE_A_EXACT_TAIL/); recoveredExactSource = true
    return { tools: [{ name: 'read', arguments: { file_path: 'result.txt' } }] }
  }
  if (index === 6) return { tools: [{ name: 'edit', arguments: { file_path: 'result.txt', old_string: 'phase-one', new_string: 'phase-two' } }] }
  if (index === 7) return { text: 'CONTINUATION_A_REPORT: inspected evidence and edited the output; semantic acceptance unverified.' }
  if (index === 8) return { tools: [{ name: 'dynamic_task_status', arguments: {} }] }
  if (index === 9) return { text: 'CONTINUATION_B_REPORT: inspected the declared A report and current task state; semantic acceptance unverified.' }
  throw new Error('Unexpected continuation demo request')
} })
const counters = { prompt: 0, toolProvider: 0, preStep: 0, nativeModel: 0, executionAgents: 0 }, calls = []
const allowedTools = ['read', 'write', 'edit', 'skill', 'dynamic_task_status', 'dynamic_context_source_read']
const config = { storageRoot: output, allowedTools, maxRequestsPerTask: 10, maxContextCharacters: 45000,
  direct: { durable: true, compaction: { triggerCharacters: 14000, maxCheckpointCharacters: 10000, maxCompactions: 4 },
    runtime: { modules: ['filesystem', 'skills', 'state'], skills: ['fixture-skill'], timeZone: 'Asia/Shanghai' } } }
const harnesses = []
const open = async () => {
  const h = await createRuntimeHarness({ projectRoot: workspace, directory: path.join(output, 'state'), backend, config,
    setup: ctx => {
      ctx.systemPrompt.section({ name: 'audit:unused-complete', complete: true, order: -1,
        text: () => { counters.prompt++; throw new Error('Default prompt was evaluated') } })
      ctx.systemPrompt.tools(() => { counters.toolProvider++; throw new Error('Default tool provider was evaluated') })
      ctx.on('agent/pre-step', () => { counters.preStep++; throw new Error('Default model loop was entered') })
      ctx.on('llm/stream', async function* () { counters.nativeModel++; throw new Error('Default model API was called') })
      ctx.on('tools/execute', (exec, next) => { calls.push({ name: exec.name, callId: exec.callId }); return next() })
      const create = ctx.agents.create.bind(ctx.agents)
      ctx.agents.create = options => { counters.executionAgents++; return create(options) }
    } })
  harnesses.push(h); return h
}
try {
  const first = await open()
  first.runner.submit({ taskGraph: { title: 'Compression and restart isolation', nodes: [
    { key: 'root', kind: 'container', label: 'Continuation validation' },
    ...['a', 'b'].map(key => ({ key, kind: 'leaf', label: key.toUpperCase(), parent: 'root' })),
  ], edges: [{ kind: 'prerequisite', from: 'a', to: 'b' }] }, contextGraph: {
    nodes: ['a', 'b'].map(key => ({ key, content: `CONTINUATION_${key.toUpperCase()}_TASK_PRIVATE`, parents: [] })),
    bindings: [
      { task: 'a', instruction: 'Load the skill, inspect evidence, and edit the output. Preserve source access across compression and restart.', contexts: ['a'], inheritReports: [], tools: allowedTools },
      { task: 'b', instruction: 'Inspect only the declared A report and active task state.', contexts: ['b'], inheritReports: ['a'], tools: ['dynamic_task_status', 'dynamic_context_source_read'] },
    ] } })
  const paused = await first.runner.runNext({ expectedRevision: 1, pauseAfterRequests: 3 })
  assert.equal(paused.paused, true)
  const reportsAtPause = first.runner.graph.read().reports.length
  const requestsAtPause = backend.requests.length
  await first.close()
  const second = await open()
  const a = await second.runner.resumeActive({ expectedRevision: paused.revision, checkpointChecksum: paused.checkpoint.checksum })
  const b = await second.runner.runNext({ expectedRevision: a.revision })
  const wire = backend.requests, compacted = a.trace.events.filter(event => event.type === 'history/compacted').map(row => row.data)
  const bText = JSON.stringify(b.trace.requests.map(row => row.payload.messages))
  const checks = {
    twoConsecutiveCompactions: compacted.length === 2 && compacted.every(row => row.afterCharacters < row.beforeCharacters),
    firstArchiveExactSourceRetrievedAfterRestart: recoveredExactSource,
    optionalLoadedSkillRetained: wire.slice(1, 7).every(row => row.payload.messages.some(message => checkpointData(message)?.residentInstructions.skills.some(skill => skill.name === 'fixture-skill' && skill.content.includes('SKILL_FIXTURE_BODY')))),
    pauseAtCompleteExchange: requestsAtPause === 3 && reportsAtPause === 0 && paused.checkpoint.phase === 'PAUSED',
    resumedSameLogicalAttempt: paused.trace.assembly.task.attemptId === a.report.attemptId && a.trace.resumptions.length === 1,
    distinctNativeExecutionEpisodes: paused.trace.sessionId !== a.report.sessionId && a.report.sessionId !== b.report.sessionId && counters.executionAgents === 3,
    noCompletedToolReplay: calls.filter(row => row.name === 'write').length === 1 && calls.filter(row => row.name === 'skill').length === 1 && calls.filter(row => row.name === 'read').length === 3,
    fileRereadBeforeResumedEdit: calls.findIndex(row => row.name === 'edit') === calls.findLastIndex(row => row.name === 'read') + 1,
    actualOutputEdited: fs.readFileSync(path.join(workspace, 'result.txt'), 'utf8') === 'phase-two\n',
    requestOrdinalsPreserved: a.trace.requests.map(row => row.ordinal).join(',') === '1,2,3,4,5,6,7',
    callIdsRemainUnique: new Set(calls.map(row => row.callId)).size === calls.length,
    wireByteHashes: [a, b].flatMap(result => result.trace.requests).every((row, i) => row.bodySha256 === createHash('sha256').update(wire[i].rawBody).digest('hex')),
    toolCallPairsRemainValid: wire.every(row => { checkDirectHistory(row.payload.messages, row.payload.messages.filter(message => checkpointData(message))); return true }),
    noDefaultPromptOrModelCalls: counters.prompt === 0 && counters.toolProvider === 0 && counters.preStep === 0 && counters.nativeModel === 0,
    rootInstructionsPreserved: wire.every(row => row.payload.messages[0].content.includes('CONTINUATION_ROOT_RULE')),
    bInheritsOnlyDeclaredReport: bText.includes('CONTINUATION_A_REPORT') && !/CONTINUATION_A_TASK_PRIVATE|PRIVATE_A_EXACT_TAIL|PRIVATE_B_EXACT_TAIL|SKILL_FIXTURE_BODY|direct-extractive-checkpoint-v1/.test(bText),
    onlyUnverifiedReports: [a, b].every(row => row.report.acceptance === 'UNVERIFIED_MODEL_REPORT'),
    goalNotCompleted: second.runner.graph.status().goalReached === false,
    noBackendErrors: backend.errors.length === 0,
  }
  for (const [name, passed] of Object.entries(checks)) assert.equal(passed, true, name)
  fs.writeFileSync(path.join(output, 'pause-receipt.json'), JSON.stringify({ revision: paused.revision, checkpoint: paused.checkpoint, runDirectory: paused.runDirectory }, null, 2) + '\n')
  fs.writeFileSync(path.join(output, 'wire-requests.json'), JSON.stringify(wire, null, 2) + '\n')
  const verification = { status: 'PASS_DIRECT_CONTINUATION_FAKE_MODEL_ONLY', date: new Date().toISOString(), tasks: 2,
    httpRequests: wire.length, compactions: compacted, checks, counters, toolCalls: calls, reports: [a.report, b.report], workspace,
    limits: ['Scripted model only; no quality, real token, cache or performance acceptance', 'Restart uses a new Cordis context with the same local HTTP fixture; isolated SIGKILL tests are in continuation.test.mjs',
      'Archived observations do not grant fresh filesystem observation authority', 'No production Web profile or model service changes'] }
  fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(verification, null, 2) + '\n')
  console.log(JSON.stringify({ status: verification.status, tasks: 2, requests: wire.length, compactions: compacted.length, checks: Object.keys(checks).length, verification: path.join(output, 'verification.json') }))
} finally { for (const h of harnesses) await h.close(); await backend.close() }
