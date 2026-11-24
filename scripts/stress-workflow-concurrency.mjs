// SPDX-License-Identifier: GPL-3.0-only
// Stress the shipped background backup while another connection commits to WAL.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { WorkflowDatabase } from '../workflow-database.mjs'
import { backupWorkflow, restoreWorkflow } from '../workflow-backup.mjs'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-concurrent-storage-')))
const dir = path.join(root, 'recovery'),
  binding = 'overlapping-backup'
const db = new WorkflowDatabase(root, binding, { create: true })
const timings = [],
  metrics = { seededBytes: 0, maximumWAL: 0 }
let worker
try {
  db.transaction(() => {
    for (let i = 0; i < 128; i++) {
      const bytes = randomBytes(512 * 1024)
      db.put('source/' + i, bytes)
      metrics.seededBytes += bytes.length
    }
  })
  worker = new Worker(new URL('../workflow-backup-worker.mjs', import.meta.url), {
    workerData: { directory: root, binding },
    execArgv: []
  })
  const response = once(worker, 'message'),
    exit = once(worker, 'exit')
  let finished = false
  response.then(
    () => {
      finished = true
    },
    () => {
      finished = true
    }
  )
  const deadline = Date.now() + 60000
  while (!finished && !(fs.existsSync(dir) && fs.readdirSync(dir).some((p) => p.startsWith('part-')))) {
    assert.ok(Date.now() < deadline, 'backup did not begin writing')
    await delay(1)
  }
  for (let i = 0; !finished && i < 256; i++) {
    const start = performance.now()
    const marker = 'foreground update ' + i
    db.put('work/last', marker)
    assert.equal(db.read('work/last').toString(), marker)
    timings.push(performance.now() - start)
    const stat = fs.statSync(db.file + '-wal', { throwIfNoEntry: false })
    metrics.maximumWAL = Math.max(metrics.maximumWAL, stat?.size ?? 0)
    await delay(2)
  }
  const [first] = await response
  assert.equal((await exit)[0], 0)
  assert.equal(first.error, undefined, first.message)
  assert.ok(timings.length > 0, 'required an overlapping foreground commit')
  const second = backupWorkflow(db)
  assert.notEqual(first.result.generation, second.generation)
  for (const [g, expected] of [
    [first.result, null],
    [second, 'foreground update ' + (timings.length - 1)]
  ]) {
    const target = path.join(root, g.generation)
    fs.mkdirSync(target)
    restoreWorkflow(dir, path.join(target, 'workflow.sqlite'), g.generation)
    const restored = new WorkflowDatabase(target, binding)
    try {
      assert.equal(restored.info('work/last') ? restored.read('work/last').toString() : null, expected)
      assert.equal(restored.q('PRAGMA integrity_check').get().integrity_check, 'ok')
    } finally {
      restored.close()
    }
  }
  timings.sort((a, b) => a - b)
  Object.assign(metrics, {
    foregroundWriteAndReadPairs: timings.length,
    p95ms: timings[Math.ceil(timings.length * 0.95) - 1],
    maxMs: timings.at(-1),
    preservedBothSnapshots: true,
    latestGeneration: second,
    status: 'PASS'
  })
} finally {
  if (worker) await worker.terminate()
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
}
metrics.temporaryDatabasesRemoved = !fs.existsSync(root)
console.log(JSON.stringify(metrics, null, 2))
