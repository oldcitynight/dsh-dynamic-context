import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHarness } from '../testing/harness.mjs'
import { proposal } from '../testing/scenario.mjs'

test('native comparison without the external wire hook fails before claiming a task or creating an execution Agent', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-missing-wire-hook-')))
  const h = await createHarness({ projectRoot: root, directory: path.join(root, 'state'), respond: () => ({ text: 'must not send' }) })
  const key = Symbol.for('dsh.project.contextGuard.adapter.v1'), previous = globalThis[key]
  t.after(async () => { globalThis[key] = previous; await h.close(); fs.rmSync(root, { recursive: true, force: true }) })
  globalThis[key] = false
  h.runner.submit(proposal())
  h.ctx.agents.create = () => { throw new Error('Must not create an Agent before rejecting the unavailable route') }
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }), /NATIVE_WIRE_GUARD_UNAVAILABLE/)
  assert.equal(h.runner.graph.read().revision, 1); assert.equal(h.runner.graph.read().graph.state.active, null)
  assert.equal(h.backend.requests.length, 0)
})
