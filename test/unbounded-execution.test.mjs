import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { digest } from 'dsh-better-task-grapth/core'
import { FileGraphStore } from 'dsh-better-task-grapth/store'
import { artifactProof } from 'dsh-better-task-grapth/host'
import { createHash } from 'node:crypto'
import { validateConfig } from '../index.mjs'
import { DirectJournal } from '../durable-store.mjs'
import { createHarness } from '../testing/harness.mjs'
import { createRuntimeHarness, runtimeProposal } from '../testing/runtime-harness.mjs'
import { startFakeLlama } from '../testing/fake-llama.mjs'

const limits = { maxRequestsPerTask: null, timeoutMs: null, maxContextCharacters: null,
  maxStateBytes: null, maxReportCharacters: null, maxOutputTokens: 256000,
  direct: { maxRequestBytes: null, maxResponseBytes: null, maxJournalBytes: null } }
function temporary(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-native-limits-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}
const proposal = () => runtimeProposal(['fixture_read_a'])

test('explicit null removes added limits while finite defaults and native output controls remain', () => {
  const base = { projectRoot: '/tmp', directory: '/tmp/test', provider: 'fake', model: 'fake', transport: 'direct', systemPrompt: 'Policy.', direct: { endpoint: 'http://127.0.0.1:1' } }
  const defaults = validateConfig(base)
  assert.equal(defaults.maxRequestsPerTask, 4); assert.equal(defaults.timeoutMs, 10000)
  const config = validateConfig({ ...base, ...limits, direct: { ...base.direct, ...limits.direct } })
  assert.equal(config.maxRequestsPerTask, null); assert.equal(config.maxOutputTokens, 256000)
  assert.throws(() => validateConfig({ ...config, direct: { ...config.direct, reserveFinalReport: true } }), /finite request limit/)
  assert.throws(() => validateConfig({ ...config, transport: 'native-guarded' }), /require the direct route/)
})

test('the real direct loop crosses the former 256-call ceiling and preserves a long final report', async t => {
  const root = temporary(t)
  const report = 'Completed synthetic observation. '.repeat(560)
  const backend = await startFakeLlama({ maxRequests: 270, maxRequestBytes: 8388608,
    respond: ({ index }) => index <= 256 ? { tools: [{ name: 'fixture_read_a' }] } : { text: report } })
  let h
  t.after(async () => { await h?.close(); await backend.close() })
  h = await createHarness({ projectRoot: root, directory: path.join(root, 'state'), backend,
    config: { transport: 'direct', ...limits, direct: { ...limits.direct, durable: true, tracePayloads: 'references' } } })
  h.runner.submit(proposal())
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(backend.requests.length, 257)
  assert.equal(h.toolCalls.length, 256)
  assert.equal(result.report.text, report)
  assert.ok(report.length > 16000)
  assert.ok(backend.requests.every(r => r.payload.max_tokens === 256000))
  assert.equal(result.trace.requests.filter(r => r.payload).length, 1)
  const saved = JSON.parse(fs.readFileSync(result.report.evidence[0].ref))
  assert.equal(saved.payloadEncoding, 'request-files-v1')
  assert.ok(saved.requests.every(r => !r.payload && r.savedPayload))
  for (const [index, request] of saved.requests.entries()) {
    assert.deepEqual(JSON.parse(fs.readFileSync(request.savedPayload.ref)).payload, backend.requests[index].payload)
  }
})

test('referenced request bodies survive pause/restart and keep complete byte-checked history without replay', async t => {
  const root = temporary(t), directory = path.join(root, 'state')
  const backend = await startFakeLlama({ respond: ({ index }) => index < 3 ? { tools: [{ name: 'fixture_read_a' }] } : { text: 'Resumed correctly.' } })
  let h
  t.after(async () => { await h?.close(); await backend.close() })
  const config = { transport: 'direct', ...limits, direct: { ...limits.direct, durable: true, tracePayloads: 'references' } }
  h = await createHarness({ projectRoot: root, directory, backend, config })
  h.runner.submit(proposal())
  const paused = await h.runner.runNext({ expectedRevision: 1, pauseAfterRequests: 1 })
  assert.equal(paused.paused, true)
  const revision = h.runner.graph.read().revision, checksum = h.runner.checkpointStatus().checksum
  await h.close()
  h = await createHarness({ projectRoot: root, directory, backend, config })
  const result = await h.runner.resumeActive({ expectedRevision: revision, checkpointChecksum: checksum })
  assert.equal(result.report.text, 'Resumed correctly.')
  assert.equal(backend.requests.length, 3)
  assert.equal(h.toolCalls.length, 1)
  assert.deepEqual(backend.requests[1].payload.messages.slice(0, 2), backend.requests[0].payload.messages)
  const journal = new DirectJournal(result.runDirectory, {}, { maxBytes: null })
  const first = result.trace.requests[0]
  const record = JSON.parse(fs.readFileSync(first.savedPayload.ref))
  record.payload.messages[0].content = 'corrupt'
  fs.writeFileSync(first.savedPayload.ref, JSON.stringify(record))
  assert.throws(() => journal.referenceRequest(first), /HASH_OR_SCOPE_MISMATCH/)
})

test('an external total-money stop prevents the next HTTP request and does not replay completed effects', async t => {
  const root = temporary(t)
  const h = await createHarness({ projectRoot: root, directory: path.join(root, 'state'),
    respond: () => ({ tools: [{ name: 'fixture_read_a' }] }), config: { transport: 'direct', ...limits } })
  t.after(() => h.close())
  let requests = 0
  h.runner.registerInputMeter({ version: 'synthetic-total-money-only', measure: () => {
    if (++requests === 8) throw Object.assign(Error('TOTAL_MONEY_EXHAUSTED'), { code: 'TOTAL_MONEY_EXHAUSTED' })
    return { tokens: 100, method: 'estimate' }
  } })
  h.runner.submit(proposal())
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }), /TOTAL_MONEY_EXHAUSTED/)
  assert.equal(h.backend.requests.length, 7); assert.equal(h.toolCalls.length, 7)
  assert.equal(h.runner.graph.read().reports.length, 0)
  assert.ok(h.runner.graph.read().graph.state.active)
  await assert.rejects(h.runner.runNext({ expectedRevision: h.runner.graph.read().revision }))
  assert.equal(h.backend.requests.length, 7)
})

test('unbounded task status and instructions do not tell the model to reserve a last request', async t => {
  const root = temporary(t), projectRoot = path.join(root, 'work')
  fs.mkdirSync(projectRoot)
  const h = await createRuntimeHarness({ projectRoot, directory: path.join(root, 'state'),
    respond: ({ index }) => index === 1 ? { tools: [{ name: 'dynamic_task_status' }] } : { text: 'Status inspected.' },
    config: { storageRoot: root, ...limits, allowedTools: ['dynamic_task_status'],
      direct: { ...limits.direct, runtime: { modules: ['state'], maxToolOutputCharacters: null } } } })
  t.after(() => h.close())
  h.runner.submit(runtimeProposal(['dynamic_task_status']))
  await h.runner.runNext({ expectedRevision: 1 })
  const messages = h.backend.requests[1].payload.messages
  const status = JSON.parse(messages.find(m => m.role === 'tool').content)
  assert.equal(status.requestBudget.limit, null); assert.equal(status.requestBudget.remaining, null)
  assert.doesNotMatch(messages[0].content, /Budget investigation and tool use to leave room|The configured request limit includes/)
})

test('unbounded journal verifies and extends a chain beyond the old record ceiling without weakening hashes', t => {
  const root = temporary(t), journal = new DirectJournal(root, { taskId: 'synthetic' }, { maxBytes: null })
  let prior = null
  const seal = body => ({ ...body, checksum: digest(body) })
  for (let sequence = 1; sequence <= 4097; sequence++) {
    const value = seal({ schema: 1, sequence, identity: journal.identity, previous: prior, phase: 'MODEL_PENDING', data: {} })
    fs.writeFileSync(path.join(journal.directory, `record-${sequence}.json`), JSON.stringify(value))
    prior = value.checksum
  }
  fs.writeFileSync(path.join(journal.directory, 'head.json'), JSON.stringify(seal({ schema: 1, sequence: 4097, record: prior })))
  assert.equal(journal.latest().sequence, 4097)
  assert.equal(journal.append('BLOCKED', { code: 'SYNTHETIC_STOP' }).sequence, 4098)
  assert.throws(() => new DirectJournal(root, journal.identity).latest(), /DIRECT_JOURNAL_SEQUENCE/)
  const file = path.join(journal.directory, 'record-4000.json'), value = JSON.parse(fs.readFileSync(file))
  value.data.modified = true; fs.writeFileSync(file, JSON.stringify(value))
  assert.throws(() => journal.latest(), /CHECKSUM/)
})

test('explicit unbounded graph storage and artifact proofs keep CAS and hash checks', t => {
  const root = temporary(t)
  const store = new FileGraphStore({ projectRoot: root, directory: path.join(root, 'store'), maximumBytes: null,
    validator: value => { assert.equal(typeof value.payload, 'string') }, updateValidator: () => {} })
  const payload = 'x'.repeat(13 * 1024 * 1024)
  store.compareAndSwap(0, () => ({ revision: 1, payload }))
  assert.equal(store.read().payload.length, payload.length)
  assert.throws(() => store.compareAndSwap(0, () => ({ revision: 2, payload })))
  const ref = { kind: 'artifact', ref: store.file, sha256: createHash('sha256').update(fs.readFileSync(store.file)).digest('hex') }
  assert.throws(() => artifactProof(root, ref, undefined, { maxBytes: 1024 }), /ARTIFACT_BYTE_LIMIT/)
  assert.equal(artifactProof(root, ref, undefined, { maxBytes: null }).sha256, ref.sha256)
})
