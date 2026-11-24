// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { admitWorkflowRelease, openWorkflowStorage } from '../workflow-io.mjs'

const release = (a, b, epoch = 1) => ({ workflowCompatibilityEpoch: epoch,
  pluginVersions: { 'dsh-dynamic-context': '1.0.0-rc.' + a, 'dsh-better-task-grapth': '2.0.0-rc.' + b } })

for (const storageFormat of ['files', 'sqlite']) {
  test(storageFormat + ' freezes before the first unit, advances both floors atomically and preserves them across restarts', t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-floor-')))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const options = { projectRoot: root, directory: path.join(root, 'state'), storageFormat }
    let store = openWorkflowStorage(options)
    t.after(() => store?.close())
    const admit = (installed, opts) => admitWorkflowRelease(options, store, installed, opts)
    admit(release(9, 9))
    if (store) assert.equal(store.db.q('PRAGMA user_version').get().user_version, 2)
    else assert.match(fs.readFileSync(path.join(options.directory, '.workflow-storage-v1'), 'utf8'), /^files-compatibility-v1\n/)
    admit(release(10, 10), { checkOnly: true })
    admit(release(9, 9))
    admit(release(10, 10))
    const generation = store?.db.generation
    admit(release(10, 10))
    assert.equal(store?.db.generation, generation)
    store?.close()
    store = openWorkflowStorage({ ...options, storageFormat: 'auto' })
    assert.equal(Boolean(store), storageFormat === 'sqlite')
    for (const rejected of [release(11, 9), release(9, 11), release(9, 9)]) {
      assert.throws(() => admit(rejected), { code: 'WORKFLOW_PLUGIN_DOWNGRADE' })
      admit(release(10, 10))
    }
    for (const rejected of [release(10, 10, 2), release(11, 11, 2)])
      assert.throws(() => admit(rejected), { code: 'WORKFLOW_COMPATIBILITY_EPOCH_MISMATCH' })
    admit(release(11, 10))
    assert.throws(() => admit(release(10, 10)), { code: 'WORKFLOW_PLUGIN_DOWNGRADE' })
    const other = { ...options, directory: path.join(root, 'other') }
    const second = openWorkflowStorage(other)
    try { admitWorkflowRelease(other, second, release(1, 1, 2)) } finally { second?.close() }
  })
}
