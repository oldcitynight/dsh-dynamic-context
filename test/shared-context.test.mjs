// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRuntimeHarness, runtimeProposal } from '../testing/runtime-harness.mjs'
import { startFakeLlama } from '../testing/fake-llama.mjs'
import { revisionSnapshot } from '../revision-runtime.mjs'

const read = 'dynamic_context_shared_read', update = 'dynamic_context_shared_update'
const oldPath = 'language-reference/index.adoc'
const correctedPath = 'language-reference/pages/index.adoc'
const submitCall = (name, args) => ({ tools: [{ name, arguments: args }] })
const assembly = payload => JSON.parse(payload.messages[1].content.split('\n\n').at(-1))

test('a leaf publishes a shared correction directly; the next leaf sees it and can read the previous version', async t => {
  const storageRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-shared-context-')))
  const projectRoot = path.join(storageRoot, 'workspace')
  fs.mkdirSync(projectRoot)
  let id, unboundId
  const observed = []
  const backend = await startFakeLlama({ respond: ({ index, payload }) => {
    observed.push(index)
    if (index === 1) {
      const seed = assembly(payload)
      assert.deepEqual(seed.contexts.map(node => [node.id, node.revision, node.content]), [[id, 1, oldPath]])
      return submitCall(update, { id, content: correctedPath, reason: 'Correct the reference documentation path.' })
    }
    if (index === 2) {
      assert.equal(assembly(payload).contexts[0].content, oldPath)
      const reply = JSON.parse(payload.messages.at(-1).content)
      assert.deepEqual([reply.status, reply.revision, reply.content], ['APPLIED', 2, correctedPath])
      return { text: 'The reference location was corrected.' }
    }
    if (index === 3) {
      assert.deepEqual(assembly(payload).contexts.map(node => [node.id, node.revision, node.content]), [[id, 2, correctedPath]])
      return submitCall(read, { id, revision: 1 })
    }
    if (index === 4) {
      const reply = JSON.parse(payload.messages.at(-1).content)
      assert.deepEqual([reply.status, reply.revision, reply.content, reply.latestRevision], ['FOUND', 1, oldPath, 2])
      return submitCall(update, { id: unboundId, content: 'not authorized for this leaf' })
    }
    const reply = JSON.parse(payload.messages.at(-1).content)
    assert.deepEqual(reply, { status: 'UNAVAILABLE', id: unboundId })
    return { text: 'Read the original location and used the current one.' }
  } })
  const handles = []
  t.after(async () => {
    for (const handle of handles) await handle.close()
    await backend.close()
    fs.rmSync(storageRoot, { recursive: true, force: true })
  })
  const open = async () => {
    const handle = await createRuntimeHarness({ projectRoot, directory: path.join(storageRoot, 'state'), backend,
      config: { storageRoot, allowedTools: [read, update], direct: { durable: true, runtime: { modules: ['state'] } } } })
    handles.push(handle)
    return handle.runner
  }
  const first = await open()
  const proposal = runtimeProposal([read, update])
  proposal.contextGraph.nodes[0] = { key: 'task_data', mutable: true, content: oldPath, parents: [] }
  proposal.contextGraph.nodes.push({ key: 'unbound', mutable: true, content: 'UNRELATED_SHARED_CONTENT', parents: [] })
  proposal.taskGraph.nodes.push({ key: 'next', kind: 'leaf', label: 'Use corrected context', parent: 'root' })
  proposal.taskGraph.edges.push({ kind: 'prerequisite', from: 'task', to: 'next' })
  proposal.contextGraph.bindings.push({ ...proposal.contextGraph.bindings[0], task: 'next' })
  const initial = first.submit(proposal)
  ;[id, unboundId] = initial.contexts.nodes.map(row => row.id)
  const paused = await first.runNext({ expectedRevision: 1, pauseAfterRequests: 1 })
  assert.equal(paused.paused, true)
  const state = first.graph.read()
  assert.equal(state.revision, 2)
  assert.equal(state.contexts.version, initial.contexts.version)
  assert.equal(state.contexts.nodes[0].content, oldPath)
  assert.equal(state.sharedContextHistory.length, 1)
  assert.equal(revisionSnapshot(first).sharedContexts.find(row => row.id === id).content, correctedPath)
  const saved = state.sharedContextHistory[0]
  assert.deepEqual(first.graph.sharedContext(paused.trace.assembly, { id, content: saved.content, reason: saved.reason }, saved.callId),
    { status: 'APPLIED', ...saved })
  assert.equal(first.graph.read().sharedContextHistory.length, 1)
  await handles[0].close()

  const second = await open()
  const resumed = await second.resumeActive({ expectedRevision: 2, checkpointChecksum: paused.checkpoint.checksum })
  assert.equal(resumed.trace.assembly.contexts[0].revision, 1)
  const result = await second.runNext({ expectedRevision: resumed.revision })
  assert.equal(result.trace.assembly.contexts[0].revision, 2)
  assert.equal(second.graph.read().sharedContextHistory.length, 1)
  assert.deepEqual(observed, [1, 2, 3, 4, 5])
  assert.equal(backend.requests.some(row => JSON.stringify(row.payload).includes('UNRELATED_SHARED_CONTENT')), false)
})
