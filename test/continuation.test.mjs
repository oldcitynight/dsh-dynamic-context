import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRuntimeHarness, runtimeProposal } from '../testing/runtime-harness.mjs'
import { startFakeLlama } from '../testing/fake-llama.mjs'
import { DirectJournal, acquireDirectLease } from '../durable-store.mjs'
import { namesStored, readStored, writeStored } from '../workflow-io.mjs'
import { checkpointData } from '../checkpoints.mjs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { durableConfigHash } from '../index.mjs'
import { readPluginVersionsSync } from '../recovery-versions.mjs'
import { watchValidation } from '../testing/validation-probe.mjs'
import { createHash } from 'node:crypto'

async function location(t, respond) {
  const storageRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-continuation-')))
  const projectRoot = path.join(storageRoot, 'workspace'); fs.mkdirSync(projectRoot)
  const backend = await startFakeLlama({ respond }), harnesses = []
  t.after(async () => { for (const h of harnesses) await h.close(); await backend.close(); fs.rmSync(storageRoot, { recursive: true, force: true }) })
  return { storageRoot, projectRoot, backend,
    async open(config = {}, setup) {
      const h = await createRuntimeHarness({ projectRoot, directory: path.join(storageRoot, 'state'), backend, setup,
        config: { storageRoot, ...config, direct: { durable: true, ...config.direct } } })
      harnesses.push(h); return h
    } }
}
const writeResponse = { tools: [{ name: 'write', arguments: { file_path: 'effect.txt', content: 'written once\n' } }] }
function appendToReceipt(file, text) {
  const bytes = Buffer.concat([readStored(file), Buffer.from(text)])
  if (!writeStored(file, bytes)) fs.appendFileSync(file, text)
}

// Source-hash checkpoints must first be opened by their recorded transition build.
function simulateSourceTransitionBuild(t) {
  const { pluginVersions } = JSON.parse(fs.readFileSync(new URL('../recovery-compatibility.json', import.meta.url))).versionTransition
  const paths = new Map([
    [new URL('../package.json', import.meta.url).href, 'dsh-dynamic-context'],
    [new URL('./package.json', import.meta.resolve('dsh-better-task-grapth')).href, 'dsh-better-task-grapth'],
  ])
  const versioned = (file, data) => paths.has(file?.href)
    ? JSON.stringify({ ...JSON.parse(data), version: pluginVersions[paths.get(file.href)] }) : data
  const sync = fs.readFileSync.bind(fs), read = fs.promises.readFile.bind(fs.promises)
  t.mock.method(fs, 'readFileSync', (file, ...args) => versioned(file, sync(file, ...args)))
  t.mock.method(fs.promises, 'readFile', async (file, ...args) => versioned(file, await read(file, ...args)))
}

test('downgrading either plugin pauses recovery before dispatch and leaves the checkpoint intact', async t => {
  const where = await location(t, ({ index }) => index === 1 ? writeResponse : { text: 'Continued on the same declared versions.' })
  let writes = 0
  const setup = ctx => ctx.on('tools/execute', (exec, next) => { if (exec.name === 'write') writes++; return next() })
  const first = await where.open({}, setup)
  first.runner.submit(runtimeProposal(['write']))
  const paused = await first.runner.runNext({ expectedRevision: 1, pauseAfterRequests: 1 })
  const options = { expectedRevision: 2, checkpointChecksum: paused.checkpoint.checksum }
  const journal = DirectJournal.open(paused.runDirectory, {})
  const original = journal.loadCheckpoint(journal.latest()).pluginVersions
  assert.deepEqual(original, readPluginVersionsSync())
  await first.close()
  const second = await where.open({}, setup)
  const read = fs.promises.readFile.bind(fs.promises)
  for (const name of Object.keys(original)) {
    const manifest = new URL(name === 'dsh-dynamic-context' ? '../package.json' : './package.json',
      name === 'dsh-dynamic-context' ? import.meta.url : import.meta.resolve('dsh-better-task-grapth'))
    const changed = '0.0.0'
    const override = t.mock.method(fs.promises, 'readFile', (file, ...args) => file?.href === manifest.href
      ? Promise.resolve(JSON.stringify({ name, version: changed, workflowCompatibilityEpoch: 1 })) : read(file, ...args))
    for (const recover of [false, true]) {
      await assert.rejects(second.runner.resumeActive({ ...options, recover }), error =>
        error.code === 'WORKFLOW_PLUGIN_DOWNGRADE' && error.message.includes(name)
        && error.message.includes(changed))
      assert.equal(second.runner.checkpointStatus().checksum, options.checkpointChecksum)
    }
    override.mock.restore()
  }
  assert.equal(where.backend.requests.length, 1)
  assert.equal(writes, 1)
  const result = await second.runner.resumeActive(options)
  assert.equal(result.report.text, 'Continued on the same declared versions.')
  assert.equal(writes, 1)
  assert.equal(where.backend.requests.length, 2)
})

test('opening an idle workflow with a newer installation raises the floor before another command or model request', async t => {
  const where = await location(t, () => { throw Error('unexpected model call') })
  const first = await where.open({ storageFormat: 'sqlite' })
  first.runner.submit(runtimeProposal(['write']))
  await first.close()
  const url = new URL('../package.json', import.meta.url).href, read = fs.readFileSync.bind(fs)
  const mock = t.mock.method(fs, 'readFileSync', (file, ...args) => file?.href === url
    ? JSON.stringify({ name: 'dsh-dynamic-context', version: '99.0.0', workflowCompatibilityEpoch: 1 }) : read(file, ...args))
  const upgraded = await where.open({ storageFormat: 'sqlite' })
  assert.equal(JSON.parse(upgraded.runner.storage.db.q('SELECT workflow_release FROM instance WHERE id=1').get().workflow_release).pluginVersions['dsh-dynamic-context'], '99.0.0')
  assert.equal(upgraded.runner.graph.read().revision, 1)
  await upgraded.close()
  mock.mock.restore()
  const older = await where.open({ storageFormat: 'sqlite' })
  assert.equal(older.runner.status().code, 'WORKFLOW_PLUGIN_DOWNGRADE')
  await assert.rejects(older.runner.runNext({ expectedRevision: 1 }), { code: 'WORKFLOW_PLUGIN_DOWNGRADE' })
  assert.equal(older.runner.graph.read().revision, 1)
  assert.equal(where.backend.requests.length, 0)
})

test('untagged checkpoints require exact admission, then an upgrade advances the graph before dispatch and fences rollback', async t => {
  const graphRelease = runner => JSON.parse(runner.storage.db.q('SELECT workflow_release FROM instance WHERE id=1').get().workflow_release)
  let running, expected, writes = 0
  const where = await location(t, ({ index }) => {
    if (expected) assert.deepEqual(graphRelease(running).pluginVersions, expected)
    return index === 1 ? writeResponse : index < 4 ? { tools: [{ name: 'read', arguments: { file_path: 'effect.txt' } }] } : { text: 'Finished once.' }
  })
  const setup = ctx => ctx.on('tools/execute', (exec, next) => { if (exec.name === 'write') writes++; return next() })
  const first = await where.open({ storageFormat: 'sqlite' }, setup)
  first.runner.submit(runtimeProposal(['write', 'read']))
  const paused = await first.runner.runNext({ expectedRevision: 1, pauseAfterRequests: 1 })
  const j = DirectJournal.open(paused.runDirectory, {})
  const old = j.loadCheckpoint(j.latest(), { hydratePayloads: false })
  const original = old.pluginVersions, bumped = { ...original, 'dsh-dynamic-context': original['dsh-dynamic-context'].replace(/-rc\.\d+$/, '') }
  assert.equal(old.workflowCompatibilityEpoch, 1)
  delete old.workflowCompatibilityEpoch
  let checksum = j.checkpoint('PAUSED', old).checksum
  const url = new URL('../package.json', import.meta.url).href, read = fs.promises.readFile.bind(fs.promises)
  let version = bumped['dsh-dynamic-context'], epoch = 1
  t.mock.method(fs.promises, 'readFile', (file, ...args) => file?.href === url
    ? Promise.resolve(JSON.stringify({ name: 'dsh-dynamic-context', version, workflowCompatibilityEpoch: epoch })) : read(file, ...args))
  const resume = runner => runner.resumeActive({ expectedRevision: 2, checkpointChecksum: checksum, pauseAfterRequests: 1 })
  // Reconstruct the pre-epoch storage schema along with its untagged checkpoint.
  const db = first.runner.storage.db
  db.db.exec('ALTER TABLE instance DROP COLUMN workflow_release; PRAGMA user_version=1')
  assert.throws(() => first.runner.admitWorkflowRelease({ workflowCompatibilityEpoch: 1, pluginVersions: bumped }),
    { code: 'DIRECT_RESUME_CONFIGURATION_CHANGED' })
  await assert.rejects(resume(first.runner), { code: 'DIRECT_RESUME_CONFIGURATION_CHANGED' })
  assert.equal(db.q('PRAGMA user_version').get().user_version, 1)
  version = original['dsh-dynamic-context']
  const adopted = await resume(first.runner)
  checksum = adopted.checkpoint.checksum
  assert.equal(j.loadCheckpoint(j.latest()).workflowCompatibilityEpoch, 1)
  await first.close()

  version = bumped['dsh-dynamic-context']
  const changed = await where.open({ storageFormat: 'sqlite', systemPrompt: 'Changed execution instructions' }, setup)
  await assert.rejects(resume(changed.runner), { code: 'DIRECT_RESUME_CONFIGURATION_CHANGED' })
  assert.equal(changed.runner.checkpointStatus().checksum, checksum)
  assert.deepEqual(graphRelease(changed.runner).pluginVersions, original)
  await changed.close()
  const second = await where.open({ storageFormat: 'sqlite' }, setup)
  running = second.runner; expected = bumped
  epoch = 2
  await assert.rejects(resume(running), { code: 'WORKFLOW_COMPATIBILITY_EPOCH_MISMATCH' })
  epoch = 1
  const updated = await resume(running)
  checksum = updated.checkpoint.checksum
  const updatedJournal = DirectJournal.open(updated.runDirectory, {})
  const after = updatedJournal.loadCheckpoint(updatedJournal.latest())
  assert.deepEqual(after.pluginVersions, bumped)
  assert.equal(after.workflowCompatibilityEpoch, 1)
  assert.deepEqual(after.trace.events.findLast(row => row.type === 'task/code-migration').data.previousPluginVersions, original)
  await second.close()
  const third = await where.open({ storageFormat: 'sqlite' }, setup)
  running = third.runner
  version = original['dsh-dynamic-context']
  await assert.rejects(resume(running), { code: 'WORKFLOW_PLUGIN_DOWNGRADE' })
  assert.equal(running.checkpointStatus().checksum, checksum)
  assert.equal(where.backend.requests.length, 3)
  version = bumped['dsh-dynamic-context']
  const final = await resume(running)
  assert.equal(final.report.text, 'Finished once.')
  assert.equal(writes, 1)
  assert.equal(where.backend.requests.length, 4)
})

test('the last source-based build resumes normally, writes a versioned checkpoint and commits the tool effect once', async t => {
  simulateSourceTransitionBuild(t)
  const where = await location(t, ({ index }) => index === 1 ? writeResponse : index === 2
    ? { tools: [{ name: 'read', arguments: { file_path: 'effect.txt' } }] } : { text: 'Migrated and finished.' })
  let writes = 0
  const setup = ctx => ctx.on('tools/execute', (exec, next) => { if (exec.name === 'write') writes++; return next() })
  const first = await where.open({}, setup)
  first.runner.submit(runtimeProposal(['write','read']))
  const paused = await first.runner.runNext({ expectedRevision: 1, pauseAfterRequests: 1 })
  const journal = DirectJournal.open(paused.runDirectory, {})
  const saved = journal.loadCheckpoint(journal.latest(), { hydratePayloads: false })
  const { versionTransition } = JSON.parse(fs.readFileSync(new URL('../recovery-compatibility.json', import.meta.url)))
  delete saved.workflowCompatibilityEpoch
  delete saved.pluginVersions
  saved.configHash = durableConfigHash(first.runner.config, first.runner.inputMeter, [['local-only.mjs', '0'.repeat(64)]])
  const unrecognized = journal.checkpoint('PAUSED', saved).checksum
  await assert.rejects(first.runner.resumeActive({ expectedRevision: 2, checkpointChecksum: unrecognized, recover: true }),
    { code: 'DIRECT_RESUME_CONFIGURATION_CHANGED' })
  assert.equal(first.runner.checkpointStatus().checksum, unrecognized)
  saved.configHash = durableConfigHash(first.runner.config, first.runner.inputMeter, versionTransition.previousCode)
  const checksum = journal.checkpoint('PAUSED', saved).checksum
  await first.close()
  const changed = await where.open({ systemPrompt: 'Different execution instructions' }, setup)
  await assert.rejects(changed.runner.resumeActive({ expectedRevision: 2, checkpointChecksum: checksum, recover: true }),
    { code: 'DIRECT_RESUME_CONFIGURATION_CHANGED' })
  assert.equal(changed.runner.checkpointStatus().checksum, checksum)
  await changed.close()
  const second = await where.open({}, setup)
  const migrated = await second.runner.resumeActive({ expectedRevision: 2, checkpointChecksum: checksum, pauseAfterRequests: 1 })
  assert.equal(migrated.paused, true)
  const next = DirectJournal.open(migrated.runDirectory, {})
  assert.deepEqual(next.loadCheckpoint(next.latest()).pluginVersions, versionTransition.pluginVersions)
  const final = await second.runner.resumeActive({ expectedRevision: migrated.revision, checkpointChecksum: migrated.checkpoint.checksum })
  assert.equal(final.report.text, 'Migrated and finished.')
  assert.equal(final.trace.events.filter(row => row.type === 'task/code-migration').length, 1)
  assert.equal(writes, 1)
  assert.equal(where.backend.requests.length, 3)
})

test('a pre-role-model checkpoint explicitly recovers on its original API despite a newly registered executor', async t => {
  simulateSourceTransitionBuild(t)
  const where = await location(t, ({ index }) => index === 1 ? writeResponse : { text: 'Original backend resumed.' })
  const first = await where.open()
  first.runner.submit(runtimeProposal(['write']))
  await first.runner.runNext({ expectedRevision: 1, pauseAfterRequests: 1 })
  const state = first.runner.graph.read(), active = state.graph.state.active
  const journal = DirectJournal.open(first.runner.activeRunDirectory(state), { taskId: active.nodeId,
    attemptId: active.attemptId, contextVersion: state.contexts.version, owner: active.owner, graphRevision: state.revision })
  const saved = journal.loadCheckpoint(journal.latest(), { hydratePayloads: false })
  const legacy = JSON.parse(fs.readFileSync(new URL('../recovery-compatibility.json', import.meta.url))).previousCode
    .find(code => new Map(code).get('index.mjs') === 'ab5028498336ef36340324603d8b14323450c916850ed5e4c594aaecf9aad841')
  assert.ok(legacy)
  delete saved.trace.modelRoute
  delete saved.workflowCompatibilityEpoch
  delete saved.pluginVersions
  saved.configHash = durableConfigHash(first.runner.config, undefined, legacy)
  journal.checkpoint('PAUSED', saved)
  const checksum = journal.latest().checksum
  await first.close()
  const second = await where.open()
  second.ctx.get('dynamicContextRoleModels').register({ pluginId: 'later', registrationId: 'new-route', role: 'executor',
    backend: { model: 'new-model', direct: { endpoint: 'http://127.0.0.1:1/v1/chat/completions' } } })
  const result = await second.runner.resumeActive({ expectedRevision: 2, checkpointChecksum: checksum, recover: true })
  assert.equal(result.report.text, 'Original backend resumed.')
  assert.equal(where.backend.requests.length, 2)
  assert.ok(where.backend.requests.every(row => row.payload.model === 'fake-llama'))
  assert.equal(result.trace.events.filter(row => row.type === 'tool/call').length, 1)
})

for (const migration of [
  { label: 'hot permissions with unchanged config', file: 'index.mjs', sha: '2b3b07e8d9b5f111ed49ed6a11173cd5979402d8cbb31695767ba46bcc1aeef4' },
  { label: 'display-only', file: 'execution-output.mjs', sha: 'e3b86b4f7cf29adf8d7e19675050086a3197ab3f6ccab3e81eff20d42c4f62e2' },
  { label: 'performance-only', file: 'index.mjs', sha: 'dd5491148ef45a7e1d1a7bd10aeab9ecb816f4a87ab8ac7ce68462b9f1ce1cb2' },
  { label: 'command-entry with unchanged leaf inputs', file: 'index.mjs', sha: '4c7b3e55c77226136c4924697527663eda3c3f24f24d2f19965cb6dddd5db2c2' },
]) {
test(`approved ${migration.label} build migration resumes a normal pause without repeating prior effects`, async t => {
  simulateSourceTransitionBuild(t)
  const where = await location(t, ({ index }) => index === 1 ? writeResponse : { text: 'Continued after the display update.' })
  let writes = 0
  const setup = ctx => ctx.on('tools/execute', (exec, next) => { if (exec.name === 'write') writes++; return next() })
  const first = await where.open({}, setup)
  first.runner.submit(runtimeProposal(['write']))
  const paused = await first.runner.runNext({ expectedRevision: 1, pauseAfterRequests: 1 })
  const code = JSON.parse(fs.readFileSync(new URL('../recovery-compatibility.json', import.meta.url))).previousCode.find(code => new Map(code).get(migration.file) === migration.sha)
  assert.ok(code)
  const state = first.runner.graph.read(), active = state.graph.state.active
  const journal = DirectJournal.open(first.runner.activeRunDirectory(state), { taskId: active.nodeId, attemptId: active.attemptId,
    contextVersion: state.contexts.version, owner: active.owner, graphRevision: state.revision })
  const saved = journal.loadCheckpoint(journal.latest(), { hydratePayloads: false })
  delete saved.workflowCompatibilityEpoch
  delete saved.pluginVersions
  saved.configHash = durableConfigHash(first.runner.config, undefined, code)
  journal.checkpoint('PAUSED', saved)
  const checksum = journal.latest().checksum
  await first.close()
  const second = await where.open({}, setup)
  await assert.rejects(second.runner.resumeActive({ expectedRevision: 2, checkpointChecksum: checksum }), error => {
    assert.equal(error.code, 'DIRECT_RESUME_CONFIGURATION_CHANGED')
    assert.ok(error.message.includes('/continuation/configHash'))
    assert.ok(error.message.includes('does not prove that the model changed'))
    return true
  })
  assert.equal(where.backend.requests.length, 1)
  const result = await second.runner.resumeActive({ expectedRevision: 2, checkpointChecksum: checksum, recover: true })
  assert.equal(result.report.text, 'Continued after the display update.')
  assert.equal(writes, 1); assert.equal(where.backend.requests.length, 2)
  assert.ok(result.trace.events.some(row => row.type === 'task/code-migration' && row.data.inputsAndPolicyUnchanged))
  assert.deepEqual(result.trace.requests[0], paused.trace.requests[0])
})

test(`approved ${migration.label} old code cannot authorize a changed execution configuration`, async t => {
  const where = await location(t, () => writeResponse)
  const first = await where.open()
  first.runner.submit(runtimeProposal(['write']))
  await first.runner.runNext({ expectedRevision: 1, pauseAfterRequests: 1 })
  const code = JSON.parse(fs.readFileSync(new URL('../recovery-compatibility.json', import.meta.url))).previousCode.find(code => new Map(code).get(migration.file) === migration.sha)
  assert.ok(code)
  const state = first.runner.graph.read(), active = state.graph.state.active
  const journal = DirectJournal.open(first.runner.activeRunDirectory(state), { taskId: active.nodeId, attemptId: active.attemptId,
    contextVersion: state.contexts.version, owner: active.owner, graphRevision: state.revision })
  const saved = journal.loadCheckpoint(journal.latest(), { hydratePayloads: false })
  delete saved.workflowCompatibilityEpoch
  delete saved.pluginVersions
  saved.configHash = durableConfigHash(first.runner.config, undefined, code)
  journal.checkpoint('PAUSED', saved)
  const checksum = journal.latest().checksum
  await first.close()
  for (const changed of [{ model: 'another-model' }, { systemPrompt: 'Changed instructions' }, { maxOutputTokens: 700 },
    { direct: { endpoint: where.backend.origin + '/different-route' } }]) {
    const candidate = await where.open(changed)
    await assert.rejects(candidate.runner.resumeActive({ expectedRevision: 2, checkpointChecksum: checksum, recover: true }), /DIRECT_RESUME_CONFIGURATION_CHANGED/)
    assert.equal(candidate.runner.checkpointStatus().checksum, checksum)
    await candidate.close()
  }
  assert.equal(where.backend.requests.length, 1)
})
}

test('the runner retains its kernel lock after the acquisition helper exits, until explicit release', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-direct-lease-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const first = await acquireDirectLease(root)
  try { await assert.rejects(acquireDirectLease(root), /DIRECT_EXECUTION_LEASE_HELD/) }
  finally { await first.release() }
  const next = await acquireDirectLease(root)
  await next.release(); await next.release()
})

test('a paused real write resumes after restart without repeating either the write or first HTTP request', async t => {
  const where = await location(t, ({ index }) => index === 1 ? writeResponse : { text: 'Recovered report, still unverified.' })
  let writes = 0
  const setup = ctx => ctx.on('tools/execute', (exec, next) => { if (exec.name === 'write') writes++; return next() })
  const first = await where.open({}, setup)
  first.runner.submit(runtimeProposal(['write']))
  const paused = await first.runner.runNext({ expectedRevision: 1, pauseAfterRequests: 1 })
  assert.equal(paused.paused, true)
  assert.equal(first.runner.graph.read().reports.length, 0)
  const journalDirectory = path.join(paused.runDirectory, 'continuation')
  const head = JSON.parse(readStored(path.join(journalDirectory, 'head.json'), 'utf8'))
  const journalReads = watchValidation(t, fs, 'openSync', { label: 'checkpoint status journal chain', maxCalls: head.sequence + 1,
    matches: file => typeof file === 'string' && path.dirname(file) === journalDirectory && /^record-/.test(path.basename(file)) })
  const graphReads = watchValidation(t, first.runner.graph.store, 'inspect', { label: 'workflow status graph verification', maxCalls: 1 })
  assert.equal(first.runner.status().continuation.phase, 'PAUSED')
  journalReads()
  graphReads()
  assert.equal(writes, 1)
  assert.equal(where.backend.requests.length, 1)
  await first.close()
  const second = await where.open({}, setup)
  const checkpointReads = watchValidation(t, DirectJournal.prototype, 'readCheckpoint', { label: 'normal resume snapshot verification', maxCalls: 1 })
  const result = await second.runner.resumeActive({ expectedRevision: 2, checkpointChecksum: paused.checkpoint.checksum })
  assert.equal(checkpointReads(), 1)
  assert.equal(result.report.text, 'Recovered report, still unverified.')
  assert.equal(writes, 1)
  assert.equal(where.backend.requests.length, 2)
  assert.equal(fs.readFileSync(path.join(where.projectRoot, 'effect.txt'), 'utf8'), 'written once\n')
  assert.equal(result.trace.resumptions.length, 1)
  assert.notEqual(paused.trace.sessionId, result.report.sessionId)
  assert.equal(result.trace.executionHost.executionSessionId, result.report.sessionId)
})

test('a rejected outside path checkpoints and resumes with its no-effect receipt, without replay', async t => {
  let writes = 0, reads = 0
  const where = await location(t, ({ index, payload }) => {
    if (index === 1) return { tools: [{ name: 'read', arguments: { file_path: '/tmp/report.json' } }] }
    if (index === 2) {
      const receipt = JSON.parse(payload.messages.at(-1).content)
      assert.equal(receipt.code, 'DIRECT_RUNTIME_PATH_OUTSIDE_WORKSPACE')
      assert.equal(receipt.execution, 'DEFERRED_NOT_EXECUTED')
      assert.equal(receipt.rejectedCall.requestedPath, '/tmp/report.json')
      return writeResponse
    }
    return { text: 'Recovered the rejected path receipt and completed only the corrected call.' }
  })
  const setup = ctx => ctx.on('tools/execute', (exec, next) => {
    if (exec.name === 'write') writes++
    if (exec.name === 'read') reads++
    return next()
  })
  const first = await where.open({}, setup)
  first.runner.submit(runtimeProposal(['read', 'write']))
  const paused = await first.runner.runNext({ expectedRevision: 1, pauseAfterRequests: 1 })
  assert.equal(paused.paused, true)
  assert.equal(first.runner.checkpointStatus().phase, 'PAUSED')
  assert.equal(reads, 0)
  await first.close()
  const second = await where.open({}, setup)
  const result = await second.runner.resumeActive({ expectedRevision: 2, checkpointChecksum: paused.checkpoint.checksum })
  assert.equal(where.backend.requests.length, 3)
  assert.equal(reads, 0)
  assert.equal(writes, 1)
  assert.equal(fs.readFileSync(path.join(where.projectRoot, 'effect.txt'), 'utf8'), 'written once\n')
  assert.equal(result.trace.events.filter(row => row.type === 'tool/deferred').length, 1)
})

test('the reserved report-only ordinal survives a safe restart without resetting the request window', async t => {
  const where = await location(t, ({ index }) => index === 1 ? writeResponse : { text: 'Work is handed off with verification still pending.' })
  const config = { maxRequestsPerTask: 2, direct: { reserveFinalReport: true } }
  const first = await where.open(config)
  first.runner.submit(runtimeProposal(['write']))
  const paused = await first.runner.runNext({ expectedRevision: 1, pauseAfterRequests: 1 })
  await first.close()
  const second = await where.open(config)
  const result = await second.runner.resumeActive({ expectedRevision: 2, checkpointChecksum: paused.checkpoint.checksum })
  assert.equal(where.backend.requests.length, 2)
  assert.equal(where.backend.requests[1].payload.tool_choice, 'none')
  assert.match(result.report.text, /pending/)
})

test('a tampered saved wire body cannot enter a resumed history even with an unchanged snapshot ticket', async t => {
  const where = await location(t, ({ index }) => index === 1 ? writeResponse : { text: 'Must not resume a tampered payload.' })
  const first = await where.open()
  first.runner.submit(runtimeProposal(['write']))
  const paused = await first.runner.runNext({ expectedRevision: 1, pauseAfterRequests: 1 })
  const directory = path.join(first.runner.config.directory, first.runner.graph.status().active.attemptId, 'continuation')
  const file = namesStored(directory).find(f => /^request-/.test(f))
  await first.close()
  const second = await where.open()
  appendToReceipt(path.join(directory, file), 'tampered')
  await assert.rejects(second.runner.resumeActive({ expectedRevision: 2, checkpointChecksum: paused.checkpoint.checksum }), /DIRECT_REQUEST_PAYLOAD_HASH_OR_SCOPE_MISMATCH/)
  assert.equal(where.backend.requests.length, 1)
})

test('resume detects a previously checked request changed between asynchronous validation slices', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-resume-evidence-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const identity = { taskId: 'fixture', attemptId: 'fixture' }
  const writer = new DirectJournal(root, identity)
  const requests = [1, 2].map(index => {
    const payload = { messages: [{ role: 'user', content: 'request ' + index }] }
    return { payload, bodySha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex') }
  })
  const checkpoint = writer.checkpoint('PAUSED', { trace: { requests } })
  const reader = DirectJournal.open(root, identity)
  const load = reader.loadPayload
  t.mock.method(reader, 'loadPayload', function (reference, checksum) {
    const payload = load.call(this, reference, checksum)
    if (checksum === requests[0].bodySha256) setImmediate(() => fs.appendFileSync(reference.ref, 'changed'))
    return payload
  })
  await assert.rejects(reader.loadResumeCheckpoint(checkpoint, { hydratePayloads: false }), /DIRECT_REQUEST_PAYLOAD_CHANGED/)
})

test('a changed resume ticket cannot poison the valid paused checkpoint', async t => {
  const where = await location(t, ({ index }) => index === 1 ? writeResponse : { text: 'Safe result.' })
  const first = await where.open(); first.runner.submit(runtimeProposal(['write']))
  const paused = await first.runner.runNext({ expectedRevision: 1, pauseAfterRequests: 1 }); await first.close()
  const second = await where.open()
  await assert.rejects(second.runner.resumeActive({ expectedRevision: 2, checkpointChecksum: 'f'.repeat(64) }), /DIRECT_RESUME_CHECKPOINT_CHANGED/)
  assert.equal(second.runner.checkpointStatus().checksum, paused.checkpoint.checksum)
  await second.runner.resumeActive({ expectedRevision: 2, checkpointChecksum: paused.checkpoint.checksum })
  assert.equal(where.backend.requests.length, 2)
})

test('configuration changes and altered checkpoint bytes stop recovery before HTTP', async t => {
  const where = await location(t, () => writeResponse)
  const first = await where.open(); first.runner.submit(runtimeProposal(['write']))
  const paused = await first.runner.runNext({ expectedRevision: 1, pauseAfterRequests: 1 }); await first.close()
  const changed = await where.open({ direct: { generation: { seed: 7 } } })
  await assert.rejects(changed.runner.resumeActive({ expectedRevision: 2, checkpointChecksum: paused.checkpoint.checksum }), /DIRECT_RESUME_CONFIGURATION_CHANGED/)
  await changed.close()
  const corrupted = await where.open()
  appendToReceipt(paused.checkpoint.snapshot.ref, '\n')
  await assert.rejects(corrupted.runner.resumeActive({ expectedRevision: 2, checkpointChecksum: paused.checkpoint.checksum }), /DIRECT_CHECKPOINT_HASH_MISMATCH/)
  assert.equal(where.backend.requests.length, 1)
})

test('input meters with the same function source and different declared configuration stop durable resume', async t => {
  const where = await location(t, ({ index }) => index === 1 ? writeResponse : { text: 'Safe result.' })
  const meter = (tokens, configurationFingerprint) => ({
    version: 'fixture-meter', configurationFingerprint, measure: () => ({ tokens, method: 'exact' })
  })
  const first = await where.open()
  assert.throws(() => first.runner.registerInputMeter(meter(10, ' ')), { code: 'DIRECT_INPUT_METER_FINGERPRINT_INVALID' })
  first.runner.registerInputMeter(meter(10, 'counting-table-a'))
  first.runner.submit(runtimeProposal(['write']))
  const paused = await first.runner.runNext({ expectedRevision: 1, pauseAfterRequests: 1 })
  await first.close()
  const resume = runner => runner.resumeActive({ expectedRevision: 2, checkpointChecksum: paused.checkpoint.checksum })
  const changed = await where.open()
  changed.runner.registerInputMeter(meter(20, 'counting-table-b'))
  await assert.rejects(resume(changed.runner), { code: 'DIRECT_RESUME_CONFIGURATION_CHANGED' })
  assert.equal(changed.runner.checkpointStatus().checksum, paused.checkpoint.checksum)
  assert.equal(where.backend.requests.length, 1)
  await changed.close()
  const same = await where.open()
  same.runner.registerInputMeter(meter(10, 'counting-table-a'))
  assert.equal((await resume(same.runner)).report.text, 'Safe result.')
  assert.equal(where.backend.requests.length, 2)
})

const compactionConfig = {
  allowedTools: ['read', 'dynamic_context_source_read'], maxRequestsPerTask: 8, maxContextCharacters: 28000,
  direct: { compaction: { triggerCharacters: 14000, maxCheckpointCharacters: 10000, maxCompactions: 4 } },
}
function writeLongSource(where, name, marker) {
  const content = 'Observed status terms: FAIL NOT_RUN UNKNOWN UNVERIFIED. These are historical, not current acceptance.\n'
    + Array.from({ length: 260 }, (_, i) => `source-line-${i}: ${'x'.repeat(55)}`).join('\n') + `\n${marker}\n`
  fs.writeFileSync(path.join(where.projectRoot, name), content)
}

test('two extractive compactions retain status provenance and retrieve exact source from the first archive', async t => {
  const where = await location(t, ({ index, payload }) => {
    if (index <= 2) return { tools: [{ name: 'read', arguments: { file_path: index === 1 ? 'a.txt' : 'b.txt' } }] }
    const checkpoint = payload.messages.map(checkpointData).find(Boolean)
    assert.ok(checkpoint)
    if (index === 3) {
      assert.equal(checkpoint.generation, 2)
      const first = checkpoint.historicalToolFacts[0]
      assert.deepEqual(first.observedStatusTerms.sort(), ['FAIL', 'NOT_RUN', 'UNKNOWN', 'UNVERIFIED'])
      assert.equal(first.role, 'tool')
      assert.equal(first.acceptance, 'HISTORICAL_OBSERVATION_NOT_CURRENT_VERIFICATION')
      return { tools: [{ name: 'dynamic_context_source_read', arguments: { archive_id: first.source.archiveId,
        message_index: first.source.messageIndex, offset: first.resultCharacters - 100, length: 100 } }] }
    }
    assert.match(payload.messages.at(-1).content, /A_EXACT_TAIL/)
    return { text: 'Archived evidence inspected; acceptance unverified.' }
  })
  writeLongSource(where, 'a.txt', 'A_EXACT_TAIL'); writeLongSource(where, 'b.txt', 'B_EXACT_TAIL')
  const h = await where.open(compactionConfig)
  h.runner.submit(runtimeProposal(['read', 'dynamic_context_source_read']))
  const result = await h.runner.runNext({ expectedRevision: 1 })
  const checkpoints = result.trace.events.filter(event => event.type === 'history/compacted')
  assert.equal(checkpoints.length, 2)
  assert.ok(checkpoints.every(event => event.data.afterCharacters < event.data.beforeCharacters))
  assert.equal(where.backend.requests.length, 4)
  assert.equal(result.report.acceptance, 'UNVERIFIED_MODEL_REPORT')
  for (const request of where.backend.requests) {
    assert.equal(request.payload.messages[0].role, 'system')
    assert.match(request.payload.messages[1].content, /DIRECT_RUNTIME_TASK_DATA/)
    assert.deepEqual(request.payload.tools.map(tool => tool.function.name).sort(), ['dynamic_context_source_read', 'read'])
  }
})

test('a compacted checkpoint resumes with its original archive and without repeating the prior read', async t => {
  const where = await location(t, ({ index, payload }) => {
    if (index === 1) return { tools: [{ name: 'read', arguments: { file_path: 'a.txt' } }] }
    const checkpoint = payload.messages.map(checkpointData).find(Boolean)
    if (index === 2) return { tools: [{ name: 'dynamic_context_source_read', arguments: {
      archive_id: checkpoint.historicalToolFacts[0].source.archiveId,
      message_index: checkpoint.historicalToolFacts[0].source.messageIndex, offset: 0, length: 512 } }] }
    assert.match(payload.messages.at(-1).content, /Observed status/)
    return { text: 'Checkpoint recovered with exact source.' }
  })
  writeLongSource(where, 'a.txt', 'RECOVERED_TAIL')
  let reads = 0
  const setup = ctx => ctx.on('tools/execute', (exec, next) => { if (exec.name === 'read') reads++; return next() })
  const first = await where.open(compactionConfig, setup)
  first.runner.submit(runtimeProposal(['read', 'dynamic_context_source_read']))
  const paused = await first.runner.runNext({ expectedRevision: 1, pauseAfterRequests: 2 })
  assert.equal(paused.paused, true); await first.close()
  const second = await where.open(compactionConfig, setup)
  const result = await second.runner.resumeActive({ expectedRevision: 2, checkpointChecksum: paused.checkpoint.checksum })
  assert.equal(result.report.text, 'Checkpoint recovered with exact source.')
  assert.equal(reads, 1)
  assert.equal(where.backend.requests.length, 3)
})

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(callback) {
  const deadline = performance.now() + 10000
  while (performance.now() < deadline) {
    const value = callback()
    if (value) return value
    await delay(20)
  }
  throw new Error('Isolated crash worker did not reach its expected boundary')
}
function crashWorker(t, where, mode) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../testing/crash-worker.mjs', import.meta.url)), where.storageRoot, where.backend.origin, mode],
    { stdio: ['ignore', 'pipe', 'pipe'] })
  let diagnostic = ''
  child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-8000) })
  let ready = false
  child.stdout.on('data', bytes => { if (bytes.toString().includes('READY\n')) ready = true })
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal, diagnostic })))
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited })
  return { child, exited, async waitUntilReady() {
    await waitFor(() => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Crash worker stopped before READY: ' + diagnostic)
      return ready
    })
  } }
}
async function resumeAfterLeaseRelease(h, options) {
  for (let i = 0; i < 100; i++) {
    try { return await h.runner.resumeActive(options) }
    catch (error) { if (error.code !== 'DIRECT_EXECUTION_LEASE_HELD') throw error; await delay(20) }
  }
  throw new Error('Kernel lease did not release after the worker exited')
}

for (const mode of ['safe-ready', 'report-ready']) test(`a real process crash at ${mode} recovers without replaying its completed write`, async t => {
  const where = await location(t, ({ index }) => index === 1 ? writeResponse : { text: 'Crash-recovered response.' })
  const worker = crashWorker(t, where, mode)
  const exit = await worker.exited
  assert.equal(exit.signal, 'SIGKILL', exit.diagnostic)
  const h = await where.open(), status = h.runner.checkpointStatus()
  assert.equal(status.phase, mode === 'safe-ready' ? 'READY' : 'REPORT_READY')
  const beforeRequests = where.backend.requests.length
  const result = await resumeAfterLeaseRelease(h, { expectedRevision: 2, checkpointChecksum: status.checksum })
  assert.equal(result.report.text, 'Crash-recovered response.')
  assert.equal(where.backend.requests.length, 2)
  assert.equal(mode === 'report-ready' ? beforeRequests : beforeRequests + 1, 2)
  assert.equal(fs.readFileSync(path.join(where.projectRoot, 'effect.txt'), 'utf8'), 'written once\n')
})

test('a crash after the write effect but before its checkpoint remains unresolved and cannot replay', async t => {
  const where = await location(t, () => writeResponse)
  const worker = crashWorker(t, where, 'tool-pending'), exit = await worker.exited
  assert.equal(exit.signal, 'SIGKILL', exit.diagnostic)
  assert.equal(fs.readFileSync(path.join(where.projectRoot, 'effect.txt'), 'utf8'), 'written once\n')
  const h = await where.open(), status = h.runner.checkpointStatus()
  assert.equal(status.phase, 'TOOL_PENDING')
  assert.equal(status.resumablePhase, false)
  await assert.rejects(resumeAfterLeaseRelease(h, { expectedRevision: 2, checkpointChecksum: status.checksum }), /DIRECT_RESUME_UNCERTAIN_EFFECT/)
  assert.equal(where.backend.requests.length, 1)
  assert.equal(h.runner.graph.read().reports.length, 0)
  assert.ok(h.runner.graph.status().active)
})

test('a live process owns even a safe READY checkpoint until its kernel lease is released', async t => {
  const where = await location(t, ({ index }) => index === 1 ? writeResponse : { text: 'Lease-protected response.' })
  const worker = crashWorker(t, where, 'hold-ready')
  await worker.waitUntilReady()
  const h = await where.open()
  const status = h.runner.checkpointStatus()
  assert.equal(status?.phase, 'READY')
  assert.equal(fs.readFileSync(path.join(where.projectRoot, 'effect.txt'), 'utf8'), 'written once\n')
  await assert.rejects(h.runner.resumeActive({ expectedRevision: 2, checkpointChecksum: status.checksum }), /DIRECT_EXECUTION_LEASE_HELD/)
  worker.child.kill('SIGKILL'); await worker.exited
  await resumeAfterLeaseRelease(h, { expectedRevision: 2, checkpointChecksum: status.checksum })
  assert.equal(where.backend.requests.length, 2)
})

test('a process interrupted while its model HTTP response is unknown cannot resend it', async t => {
  const where = await location(t, () => ({ hang: true }))
  const worker = crashWorker(t, where, 'hang')
  await waitFor(() => where.backend.requests.length === 1)
  worker.child.kill('SIGKILL'); await worker.exited
  const h = await where.open(), status = h.runner.checkpointStatus()
  assert.equal(status.phase, 'MODEL_PENDING')
  await assert.rejects(resumeAfterLeaseRelease(h, { expectedRevision: 2, checkpointChecksum: status.checksum }), /DIRECT_RESUME_UNCERTAIN_EFFECT/)
  assert.equal(where.backend.requests.length, 1)
})

test('corrupted archive bytes cannot be carried into a resumed checkpoint', async t => {
  const where = await location(t, ({ index }) => index === 1
    ? { tools: [{ name: 'read', arguments: { file_path: 'a.txt' } }] }
    : { tools: [{ name: 'dynamic_context_source_read', arguments: { archive_id: '0'.repeat(64), message_index: 0 } }] })
  writeLongSource(where, 'a.txt', 'ARCHIVE_TAIL')
  const first = await where.open(compactionConfig)
  first.runner.submit(runtimeProposal(['read', 'dynamic_context_source_read']))
  // Pause after the first request, then resume for a single request against
  // the compacted view. The invalid model source call is not used here.
  const paused = await first.runner.runNext({ expectedRevision: 1, pauseAfterRequests: 1 })
  const active = first.runner.graph.read().graph.state.active
  const journal = DirectJournal.open(paused.runDirectory, { attemptId: active.attemptId })
  const snapshot = journal.loadCheckpoint(journal.latest())
  const archive = journal.archive(snapshot.history.slice(2))
  snapshot.archives.push(archive)
  const archived = journal.checkpoint('PAUSED', snapshot)
  await first.close()
  const second = await where.open(compactionConfig)
  appendToReceipt(archive.ref, '\n')
  await assert.rejects(second.runner.resumeActive({ expectedRevision: 2, checkpointChecksum: archived.checksum }), /DIRECT_ARCHIVE_HASH_OR_SCOPE_MISMATCH/)
  assert.equal(where.backend.requests.length, 1)
})

test('mandatory directory rules are never truncated to make a checkpoint fit', async t => {
  const where = await location(t, ({ index, payload }) => {
    if (index === 2) assert.match(payload.messages.at(-1).content, /MANDATORY_RULE_END/)
    return { tools: [{ name: 'read', arguments: { file_path: 'child/long.txt' } }] }
  })
  fs.mkdirSync(path.join(where.projectRoot, 'child'))
  fs.writeFileSync(path.join(where.projectRoot, 'child/AGENTS.md'), 'MANDATORY_RULE_BEGIN\n' + 'z'.repeat(9000) + '\nMANDATORY_RULE_END')
  writeLongSource(where, 'child/long.txt', 'DIRECTORY_TAIL')
  const h = await where.open({ ...compactionConfig, direct: { ...compactionConfig.direct,
    compaction: { ...compactionConfig.direct.compaction, maxCheckpointCharacters: 2048 } } })
  h.runner.submit(runtimeProposal(['read', 'dynamic_context_source_read']))
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }), /DIRECT_COMPACTION_RESIDENT_BUDGET/)
  assert.equal(where.backend.requests.length, 2)
  assert.equal(h.runner.graph.read().reports.length, 0)
})

test('the compaction budget is preserved across a restart', async t => {
  const where = await location(t, ({ index }) => ({ tools: [{ name: 'read', arguments: { file_path: index === 1 ? 'a.txt' : 'b.txt' } }] }))
  writeLongSource(where, 'a.txt', 'A_TAIL'); writeLongSource(where, 'b.txt', 'B_TAIL')
  const config = { ...compactionConfig, direct: { ...compactionConfig.direct, compaction: { ...compactionConfig.direct.compaction, maxCompactions: 1 } } }
  const first = await where.open(config); first.runner.submit(runtimeProposal(['read', 'dynamic_context_source_read']))
  const paused = await first.runner.runNext({ expectedRevision: 1, pauseAfterRequests: 2 }); await first.close()
  const second = await where.open(config)
  await assert.rejects(second.runner.resumeActive({ expectedRevision: 2, checkpointChecksum: paused.checkpoint.checksum }), /DIRECT_COMPACTION_LIMIT/)
  assert.equal(where.backend.requests.length, 2)
})

test('changed live workspace instructions cannot resume under the old host contract', async t => {
  const where = await location(t, () => writeResponse)
  const first = await where.open(); first.runner.submit(runtimeProposal(['write']))
  const paused = await first.runner.runNext({ expectedRevision: 1, pauseAfterRequests: 1 }); await first.close()
  fs.writeFileSync(path.join(where.projectRoot, 'AGENTS.md'), 'New current restriction: do not write.')
  const second = await where.open()
  await assert.rejects(second.runner.resumeActive({ expectedRevision: 2, checkpointChecksum: paused.checkpoint.checksum }), /DIRECT_RESUME_RUNTIME_FACTS_CHANGED/)
  assert.equal(where.backend.requests.length, 1)
})

test('changed tool declarations are rejected before a resumed model request', async t => {
  const where = await location(t, () => ({ tools: [{ name: 'versioned_fixture', arguments: {} }] }))
  const setup = description => ctx => ctx.tools.register(defineTool({ name: 'versioned_fixture', description, parameters: {},
    output: { schema: { type: 'object', properties: {}, additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async () => ({ value: 'known observation' }) }))
  const config = { allowedTools: ['versioned_fixture'], direct: { runtime: { modules: [], registeredTools: ['versioned_fixture'] } } }
  const first = await where.open(config, setup('Original contract')); first.runner.submit(runtimeProposal(['versioned_fixture']))
  const paused = await first.runner.runNext({ expectedRevision: 1, pauseAfterRequests: 1 }); await first.close()
  const second = await where.open(config, setup('Changed contract'))
  await assert.rejects(second.runner.resumeActive({ expectedRevision: 2, checkpointChecksum: paused.checkpoint.checksum }), /DIRECT_RESUME_TOOL_DEFINITIONS_CHANGED/)
  assert.equal(where.backend.requests.length, 1)
})

for (const changedArguments of [false, true]) {
  test(`a paused leaf keeps its extension wording and checks its argument contract (changed=${changedArguments})`, async t => {
    const name = 'fixture_inspect_design', original = 'Original workspace instructions'
    let effects = 0
    const where = await location(t, ({ index, payload }) => {
      assert.equal(payload.tools.find(tool => tool.function.name === name).function.description, original)
      return index === 1 ? { tools: [{ name, arguments: {} }] } : { text: 'Observation received.' }
    })
    function register(h, description, properties = {}) {
      h.ctx.get('dynamicContextRoleTools').registerTool({ pluginId: 'fixture', registrationId: 'design', toolId: name,
        roles: ['executor'], effect: 'read', workspaceRoot: where.projectRoot,
        schema: { type: 'function', function: { name, description, parameters: { type: 'object', properties, additionalProperties: false } } },
        authorize: () => true, execute: () => { effects++; return { observed: true } } })
    }
    const first = await where.open()
    register(first, original)
    first.runner.submit(runtimeProposal([name]))
    const paused = await first.runner.runNext({ expectedRevision: 1, pauseAfterRequests: 1 })
    await first.close()
    const next = await where.open()
    register(next, 'New tool instructions', changedArguments ? { page: { type: 'integer' } } : {})
    const resume = next.runner.resumeActive({ expectedRevision: 2, checkpointChecksum: paused.checkpoint.checksum })
    if (changedArguments) await assert.rejects(resume, /DIRECT_RESUME_TOOL_DEFINITIONS_CHANGED/)
    else assert.equal((await resume).report.text, 'Observation received.')
    assert.equal(effects, 1)
    assert.equal(where.backend.requests.length, changedArguments ? 1 : 2)
    assert.deepEqual(where.backend.errors, [])
  })
}

test('an uncommitted journal tail blocks recovery instead of trusting an older READY head', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-journal-tail-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const journal = new DirectJournal(root, { taskId: 'task', attemptId: 'attempt' })
  journal.checkpoint('READY', { history: [] })
  const rename = fs.renameSync
  try {
    fs.renameSync = () => { throw new Error('Injected crash before atomic head rename') }
    assert.throws(() => journal.append('MODEL_PENDING'), /Injected crash/)
  } finally { fs.renameSync = rename }
  assert.throws(() => journal.latest(), /DIRECT_JOURNAL_UNCOMMITTED_TAIL/)
})

test('controller tools expose an explicit pause receipt and resume the same attempt', async t => {
  const where = await location(t, ({ index }) => index === 1 ? writeResponse : { text: 'Controller recovered report.' })
  const h = await where.open({ exposeControlTools: true })
  const controller = await h.ctx.agents.create({ sessionId: 'continuation-controller', meta: { cwd: where.projectRoot } })
  t.after(() => controller.dispose())
  h.runner.submit(runtimeProposal(['write']))
  const invoke = (name, args, callId) => h.ctx.tools.execute({ name, arguments: args, callId, agent: controller.agent, signal: new AbortController().signal })
  const paused = await invoke('dynamic_context_run_next', { expectedRevision: 1, pauseAfterRequests: 1 }, 'pause-run')
  assert.equal(Boolean(paused.isError), false)
  assert.equal(paused.value.paused, true)
  const result = await invoke('dynamic_context_resume', { expectedRevision: 2, checkpointChecksum: paused.value.checkpoint.checksum }, 'resume-run')
  assert.equal(Boolean(result.isError), false)
  assert.equal(result.value.report.text, 'Controller recovered report.')
  assert.equal(where.backend.requests.length, 2)
})

test('another task cannot read the preceding task archive even when its ID is guessed correctly', async t => {
  let reference
  const where = await location(t, ({ index, payload }) => {
    if (index === 1) return { tools: [{ name: 'read', arguments: { file_path: 'a.txt' } }] }
    if (index === 2) {
      reference = payload.messages.map(checkpointData).find(Boolean).historicalToolFacts[0].source
      return { text: 'ONLY_A_DECLARED_REPORT: raw input remains private to task A.' }
    }
    assert.match(JSON.stringify(payload.messages), /ONLY_A_DECLARED_REPORT/)
    assert.doesNotMatch(JSON.stringify(payload.messages), /TASK_A_PRIVATE_SOURCE|Observed status/)
    assert.equal(payload.messages.map(checkpointData).filter(Boolean).length, 0)
    if (index === 3) return { tools: [{ name: 'dynamic_context_source_read', arguments: { archive_id: reference.archiveId, message_index: reference.messageIndex } }] }
    assert.match(JSON.stringify(payload.messages), /DIRECT_ARCHIVE_NOT_OWNED/)
    return { text: 'Foreign archive denied; only the declared report was accessible.' }
  })
  writeLongSource(where, 'a.txt', 'TASK_A_PRIVATE_SOURCE')
  const h = await where.open(compactionConfig), proposal = runtimeProposal(['read', 'dynamic_context_source_read'])
  proposal.taskGraph.nodes.push({ key: 'b', kind: 'leaf', label: 'Task B', parent: 'root' })
  proposal.taskGraph.edges.push({ kind: 'prerequisite', from: 'task', to: 'b' })
  proposal.contextGraph.bindings.push({ task: 'b', instruction: 'Inspect only the declared report.', contexts: [], tools: ['dynamic_context_source_read'], inheritReports: ['task'] })
  h.runner.submit(proposal)
  await h.runner.runNext({ expectedRevision: 1 })
  const { trace } = await h.runner.runNext({ expectedRevision: h.runner.graph.read().revision })
  assert.match(JSON.stringify(trace.events.findLast(row => row.type === 'tool/result')), /DIRECT_ARCHIVE_NOT_OWNED/)
  assert.equal(h.runner.graph.read().reports.length, 2)
  assert.equal(where.backend.requests.length, 4)
})

test('tool call IDs remain used after both compaction and restart', async t => {
  const where = await location(t, ({ index }) => index === 2 ? { tools: [{ name: 'dynamic_task_status', arguments: {} }] }
    : { tools: [{ id: 'original-read-id', name: 'read', arguments: { file_path: 'a.txt' } }] })
  writeLongSource(where, 'a.txt', 'ORIGINAL_READ')
  const config = { ...compactionConfig, allowedTools: [...compactionConfig.allowedTools, 'dynamic_task_status'] }
  let reads = 0
  const setup = ctx => ctx.on('tools/execute', (exec, next) => { if (exec.name === 'read') reads++; return next() })
  const first = await where.open(config, setup)
  first.runner.submit(runtimeProposal(config.allowedTools))
  const paused = await first.runner.runNext({ expectedRevision: 1, pauseAfterRequests: 2 }); await first.close()
  assert.equal(paused.trace.events.filter(row => row.type === 'history/compacted').length, 1)
  const second = await where.open(config, setup)
  await assert.rejects(second.runner.resumeActive({ expectedRevision: 2, checkpointChecksum: paused.checkpoint.checksum }), /DIRECT_TOOL_CALL_ID_REUSED/)
  assert.equal(reads, 1)
  assert.equal(where.backend.requests.length, 3)
})

test('cooperative pause waits for the complete native tool batch before sealing its receipt', async t => {
  let release, enter
  const entered = new Promise(resolve => { enter = resolve }), pending = new Promise(resolve => { release = resolve })
  const where = await location(t, ({ index }) => index === 1 ? writeResponse : { text: 'Resumed after the tool finished.' })
  const first = await where.open({}, ctx => ctx.on('tools/execute', async (exec, next) => {
    if (exec.name === 'write') { enter(); await pending }
    return next()
  }))
  first.runner.submit(runtimeProposal(['write']))
  const work = first.runner.runNext({ expectedRevision: 1 })
  await entered
  assert.equal(first.runner.checkpointStatus().phase, 'TOOL_PENDING')
  const pauseReads = watchValidation(t, first.runner.graph.store, 'inspect', { label: 'pause admission graph verification', maxCalls: 1 })
  const receipt = first.runner.pauseActive({ expectedRevision: 2 })
  pauseReads()
  assert.equal(receipt.status, 'PAUSE_REQUESTED')
  assert.equal(fs.existsSync(path.join(where.projectRoot, 'effect.txt')), false)
  release()
  const paused = await work
  assert.equal(paused.checkpoint.phase, 'PAUSED')
  assert.equal(fs.readFileSync(path.join(where.projectRoot, 'effect.txt'), 'utf8'), 'written once\n')
  await first.close()
  const second = await where.open()
  await second.runner.resumeActive({ expectedRevision: 2, checkpointChecksum: paused.checkpoint.checksum })
  assert.equal(where.backend.requests.length, 2)
})

for (const reread of [false, true]) test(`resumed filesystem guards require a new read before editing (reread=${reread})`, async t => {
  const where = await location(t, ({ index }) => {
    if (index === 1 || reread && index === 2) return { tools: [{ name: 'read', arguments: { file_path: 'existing.txt' } }] }
    if (index === (reread ? 3 : 2)) return { tools: [{ name: 'edit', arguments: { file_path: 'existing.txt', old_string: 'original', new_string: 'updated' } }] }
    return { text: reread ? 'Edited after observing the current file.' : 'Edit refused; no fresh read was performed.' }
  })
  fs.writeFileSync(path.join(where.projectRoot, 'existing.txt'), 'original\n')
  const first = await where.open(); first.runner.submit(runtimeProposal(['read', 'edit']))
  const paused = await first.runner.runNext({ expectedRevision: 1, pauseAfterRequests: 1 }); await first.close()
  const second = await where.open()
  const resume = second.runner.resumeActive({ expectedRevision: 2, checkpointChecksum: paused.checkpoint.checksum })
  const result = await resume
  if (!reread) {
    assert.equal(result.report.acceptance, 'UNVERIFIED_MODEL_REPORT')
    assert.equal(result.trace.events.find(row => row.type === 'tool/observation-required').data.effects, 'NOT_EXECUTED')
    assert.equal(result.trace.events.find(row => row.type === 'tool/result' && row.data.name === 'edit').data.isError, true)
  }
  assert.equal(fs.readFileSync(path.join(where.projectRoot, 'existing.txt'), 'utf8'), reread ? 'updated\n' : 'original\n')
  assert.equal(where.backend.requests.length, reread ? 4 : 3)
})

test('restart does not reset the total model request budget', async t => {
  const where = await location(t, () => ({ tools: [{ name: 'dynamic_task_status', arguments: {} }] }))
  const config = { maxRequestsPerTask: 3 }
  const first = await where.open(config); first.runner.submit(runtimeProposal(['dynamic_task_status']))
  const paused = await first.runner.runNext({ expectedRevision: 1, pauseAfterRequests: 2 }); await first.close()
  const second = await where.open(config)
  await assert.rejects(second.runner.resumeActive({ expectedRevision: 2, checkpointChecksum: paused.checkpoint.checksum }), /TASK_REQUEST_LIMIT/)
  assert.equal(where.backend.requests.length, 3)
})

test('explicit recovery of a crashed tool submits its saved log and UNKNOWN notice without replaying the write', async t => {
  const where = await location(t, ({ index, payload }) => {
    if (index === 1) return writeResponse
    assert.match(JSON.stringify(payload.messages), /UNKNOWN|意外中断/)
    assert.equal(payload.messages.filter(row => row.role === 'tool').length, 1)
    return { text: 'Recovered the saved write with its original uncertainty recorded.' }
  })
  const worker = crashWorker(t, where, 'tool-pending'); await worker.exited
  const h = await where.open(), status = h.runner.checkpointStatus()
  assert.equal(status.recoverable, true)
  const recoverReads = watchValidation(t, DirectJournal.prototype, 'readCheckpoint', { label: 'unexpected resume snapshot verification', maxCalls: 1 })
  const result = await resumeAfterLeaseRelease(h, { expectedRevision: 2, checkpointChecksum: status.checksum, recover: true })
  assert.equal(recoverReads(), 1)
  assert.equal(where.backend.requests.length, 2)
  assert.equal(fs.readFileSync(path.join(where.projectRoot, 'effect.txt'), 'utf8'), 'written once\n')
  const recovery = result.trace.events.find(row => row.type === 'task/interruption-recovered')
  assert.equal(recovery.data.kind, 'tools'); assert.equal(recovery.data.repeatedTools, false)
})

test('explicit recovery of an interrupted model resends the same request without repeating prior tool effects', async t => {
  const where = await location(t, ({ index }) => index === 1 ? { hang: true } : { text: 'Recovered model request.' })
  const worker = crashWorker(t, where, 'hang'); await waitFor(() => where.backend.requests.length === 1); worker.child.kill('SIGKILL'); await worker.exited
  const h = await where.open(), status = h.runner.checkpointStatus()
  await resumeAfterLeaseRelease(h, { expectedRevision: 2, checkpointChecksum: status.checksum, recover: true })
  assert.equal(where.backend.requests.length, 2)
  assert.deepEqual(where.backend.requests[1].payload, where.backend.requests[0].payload)
})

test('exact installed permission defaults may migrate to auto without permitting unrelated configuration changes', async t => {
  simulateSourceTransitionBuild(t)
  const where = await location(t, ({ index }) => index === 1 ? writeResponse : { text: 'Continued with live inherited permissions.' })
  const first = await where.open({ direct: { runtime: { sandboxMode: 'workspace-write', approvalPolicy: 'ask' } } })
  first.runner.submit(runtimeProposal(['write']))
  await first.runner.runNext({ expectedRevision: 1, pauseAfterRequests: 1 })
  const code = JSON.parse(fs.readFileSync(new URL('../recovery-compatibility.json', import.meta.url))).previousCode.find(code => new Map(code).get('index.mjs') === '2b3b07e8d9b5f111ed49ed6a11173cd5979402d8cbb31695767ba46bcc1aeef4')
  const state = first.runner.graph.read(), active = state.graph.state.active
  const journal = DirectJournal.open(first.runner.activeRunDirectory(state), { taskId: active.nodeId, attemptId: active.attemptId,
    contextVersion: state.contexts.version, owner: active.owner, graphRevision: state.revision })
  const saved = journal.loadCheckpoint(journal.latest(), { hydratePayloads: false })
  delete saved.workflowCompatibilityEpoch
  delete saved.pluginVersions
  saved.configHash = durableConfigHash(first.runner.config, undefined, code)
  journal.checkpoint('PAUSED', saved); const checksum = journal.latest().checksum
  await first.close()
  const changed = await where.open({ model: 'another-model', direct: { runtime: { sandboxMode: 'auto', approvalPolicy: 'auto' } } })
  await assert.rejects(changed.runner.resumeActive({ expectedRevision: 2, checkpointChecksum: checksum, recover: true }), /DIRECT_RESUME_CONFIGURATION_CHANGED/)
  await changed.close()
  const second = await where.open({ direct: { runtime: { sandboxMode: 'auto', approvalPolicy: 'auto' } } })
  const result = await second.runner.resumeActive({ expectedRevision: 2, checkpointChecksum: checksum, recover: true })
  const event = result.trace.events.find(row => row.type === 'task/code-migration')
  assert.equal(event.data.inputsAndPolicyUnchanged, false)
  assert.equal(event.data.permissionMigration.to.sandboxMode, 'auto')
  assert.equal(where.backend.requests.length, 2)
})
