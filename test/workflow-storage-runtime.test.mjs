// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRuntimeHarness, runtimeProposal } from '../testing/runtime-harness.mjs'
import { startFakeLlama } from '../testing/fake-llama.mjs'
import { DirectJournal } from '../durable-store.mjs'
import { restoreWorkflow } from '../workflow-backup.mjs'
import { openWorkflowStorage } from '../workflow-io.mjs'
import { monitorHotPath } from '../testing/hot-path-probe.mjs'

test('new instance checkpoints a real local tool effect, restarts and resumes once through Direct', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sqlite-fake-')))
  const projectRoot = path.join(root, 'work'),
    directory = path.join(root, 'state')
  fs.mkdirSync(projectRoot)
  const backend = await startFakeLlama({
    respond: ({ index }) =>
      index === 1
        ? { tools: [{ name: 'write', arguments: { file_path: 'effect.txt', content: 'once' } }] }
        : { text: 'Done' }
  })
  let h,
    writes = 0
  t.after(async () => {
    await h?.close()
    await backend.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  async function open() {
    h = await createRuntimeHarness({
      projectRoot,
      directory,
      backend,
      config: {
        storageRoot: root,
        storageFormat: 'auto',
        direct: { durable: true, tracePayloads: 'references' }
      },
      setup: (ctx) =>
        ctx.on('tools/execute', (exec, next) => {
          if (exec.name === 'write') writes++
          return next()
        })
    })
  }
  await open()
  assert.ok(h.runner.storage)
  h.runner.submit(runtimeProposal(['write']))
  await h.runner.runNext({ expectedRevision: 1, pauseAfterRequests: 1 })
  assert.equal(writes, 1)
  assert.equal(fs.readFileSync(path.join(projectRoot, 'effect.txt'), 'utf8'), 'once')
  const state = h.runner.graph.read(),
    attempt = h.runner.activeRunDirectory(state)
  const saved = DirectJournal.open(attempt, { attemptId: state.graph.state.active.attemptId }).latest()
  assert.equal(saved.phase, 'PAUSED')
  assert.equal(fs.existsSync(path.join(attempt, 'continuation', 'head.json')), false)
  assert.equal(fs.existsSync(path.join(attempt, 'trace.json')), false)
  assert.equal(fs.existsSync(path.join(directory, 'dynamic-context.json')), false)
  const view = await monitorHotPath(
    'graph status x5',
    () => {
      for (let i = 0; i < 5; i++) h.runner.graphSnapshot()
    },
    { diagnostic: t.diagnostic.bind(t) }
  )
  assert.equal(view.report.warnings.filter((row) => row.action === 'hash:sha256').length, 0)
  await h.close()
  h = null
  fs.unlinkSync(path.join(directory, 'workflow.sqlite'))
  fs.rmSync(path.join(attempt, 'continuation'), { recursive: true })
  restoreWorkflow(path.join(directory, 'recovery'), path.join(directory, 'workflow.sqlite'))
  assert.ok(fs.statSync(path.join(attempt, 'continuation')).isDirectory())
  await open()
  assert.equal(h.runner.graph.read().checksum, state.checksum)
  const { value: result, report } = await monitorHotPath(
    'resume and commit a completed tool effect',
    () =>
      h.runner.resumeActive({
        expectedRevision: state.revision,
        checkpointChecksum: saved.checksum
      }),
    { diagnostic: t.diagnostic.bind(t) }
  )
  assert.equal(writes, 1)
  assert.equal(backend.requests.length, 2)
  assert.equal(result.report.text, 'Done')
  const identityIO = report.samples.filter(row => row.site.includes('recovery-versions.mjs:'))
  assert.deepEqual(identityIO.map(({ action, calls, distinctTargets }) => ({ action, calls, distinctTargets })),
    [{ action: 'readFile', calls: 2, distinctTargets: 2 }])
  assert.equal(result.trace.events.filter((event) => event.type === 'tool/result').length, 1)
  assert.deepEqual(h.runner.storage.db.q('PRAGMA foreign_key_check').all(), [])
})

test('legacy evidence pins old storage; missing new DB fails closed even with an empty graph directory', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-format-test-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const directory = path.join(root, 'old')
  fs.mkdirSync(directory)
  fs.mkdirSync(path.join(directory, 'attempt_old'))
  assert.equal(openWorkflowStorage({ projectRoot: root, directory }), null)
  const fresh = path.join(root, 'fresh'),
    store = openWorkflowStorage({ projectRoot: root, directory: fresh })
  store.close()
  fs.unlinkSync(path.join(fresh, 'workflow.sqlite'))
  assert.throws(() => openWorkflowStorage({ projectRoot: root, directory: fresh }), {
    code: 'WORKFLOW_STORAGE_DATABASE_MISSING'
  })
  fs.rmSync(fresh, { recursive: true })
  assert.throws(() => openWorkflowStorage({ projectRoot: root, directory: fresh }), {
    code: 'WORKFLOW_STORAGE_DATABASE_MISSING'
  })
})

test('unpublished initialization can resume without adopting a foreign database or following links', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-init-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const directory = path.join(root, 'fresh'),
    staging = path.join(directory, '.workflow-init-v1')
  const options = { projectRoot: root, directory }
  const first = openWorkflowStorage(options)
  first.db.put('receipt', 'preserved')
  first.close()
  const registry = path.join(root, '.dsh', 'workflow-sqlite-v1')
  // Model the crash before the first mount returned or registered an external identity.
  for (const entry of fs.readdirSync(registry)) fs.unlinkSync(path.join(registry, entry))
  fs.mkdirSync(staging)
  fs.renameSync(path.join(directory, '.workflow-storage-v1'), path.join(staging, 'binding'))
  const second = openWorkflowStorage(options)
  assert.equal(second.db.read('receipt').toString(), 'preserved')
  second.close()
  assert.equal(fs.existsSync(staging), false)
  fs.renameSync(path.join(directory, '.workflow-storage-v1'), path.join(root, 'elsewhere'))
  assert.throws(() => openWorkflowStorage(options), { code: 'WORKFLOW_STORAGE_IDENTITY_MARKER_MISSING' })
  fs.symlinkSync(path.join(root, 'elsewhere'), path.join(directory, '.workflow-storage-v1'))
  assert.throws(() => openWorkflowStorage(options), { code: 'WORKFLOW_STORAGE_UNSAFE_FILE' })
  const interrupted = path.join(root, 'interrupted')
  fs.mkdirSync(path.join(interrupted, '.workflow-init-v1'), { recursive: true })
  fs.writeFileSync(path.join(interrupted, '.workflow-init-v1', 'workflow.sqlite'), 'unfinished')
  const clean = openWorkflowStorage({ projectRoot: root, directory: interrupted })
  assert.equal(clean.db.q('PRAGMA integrity_check').get().integrity_check, 'ok')
  clean.close()
})

test('cold display opens 40 rows by index, survives restart and rejects a filesystem shadow', async (t) => {
  const { ExecutionOutput } = await import('../execution-output.mjs')
  const { readStored } = await import('../workflow-io.mjs')
  const { randomUUID } = await import('node:crypto')
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-display-index-')))
  const directory = path.join(root, 'instance'),
    options = { projectRoot: root, directory }
  let store = openWorkflowStorage(options)
  t.after(() => {
    store?.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const db = store.db,
    template = {
      updatedAt: new Date().toISOString(),
      at: new Date().toISOString(),
      stage: 'EXECUTING',
      kind: 'message',
      title: 'activity',
      bytes: 0,
      state: 'complete',
      taskId: null,
      sessionId: null,
      step: 0
    }
  db.transaction(() => {
    for (let seq = 1; seq <= 1600; seq++) {
      const id = randomUUID(),
        row = { ...template, id, key: 'event-' + seq, sequence: seq, revision: seq }
      db.put('execution-view-v1/' + id + '.json', JSON.stringify(row))
    }
  })
  store.close()
  store = openWorkflowStorage(options)
  const output = new ExecutionOutput(directory)
  const first = output.read()
  assert.equal(first.items.length, 40)
  assert.equal(first.items[0].sequence, 1561)
  assert.ok(first.older)
  assert.equal(output.rows.size, 0, 'finished rows stay on disk')
  const next = output.read({ before: 1561 })
  assert.equal(next.items.length, 40)
  assert.equal(next.items.at(-1).sequence, 1560)
  assert.equal(output.read({ cursor: 1597 }).items.length, 3)
  assert.equal(
    output.create({}, 'message', 'activity', 'event-1580'),
    first.items.find((r) => r.sequence === 1580).id
  )
  const file = path.join(directory, 'revisions', 'rogue', 'role.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{}')
  assert.throws(() => readStored(file), { code: 'WORKFLOW_STORAGE_UNTRACKED_FILE' })
})
