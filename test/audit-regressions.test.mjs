// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { digest } from 'dsh-better-task-grapth/core'
import { bindLayerRules, layerRuleTools } from '../rule-editor.mjs'
import { directRevisionRole, readRoleRecord } from '../revision-runtime.mjs'
import { startFakeLlama } from '../testing/fake-llama.mjs'
import { validateConfig } from '../index.mjs'
import { openWorkflowStorage } from '../workflow-io.mjs'
import { createPrivatePathGuard } from '../execution-privacy.mjs'
import { materialBundle, materialView } from '../context-budget.mjs'
import { applicableGuidance, GUIDANCE_RECORD } from '../guidance-state.mjs'

const signal = () => new AbortController().signal
const tool = (name, args) => ({ tools: [{ name, arguments: args }] })
const roles = { objective: 'Check the current material.', requirements: [{ id: 'current', text: 'Verify current material.' }] }
function directories(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-audit-regressions-')))
  const projectRoot = path.join(root, 'work'), directory = path.join(root, 'state')
  fs.mkdirSync(projectRoot); fs.mkdirSync(directory)
  return { root, projectRoot, directory }
}

test('layer rule reads and repeated edits retain exact receipts across pause and a fresh draft has no rejected edits', async t => {
  const { root, projectRoot, directory } = directories(t)
  const backend = await startFakeLlama({ respond: ({ index }) => {
    if (index === 1) return tool('dynamic_context_read_rules', { target: 'child' })
    if (index === 2) return tool('dynamic_context_set_rule_tree', { target: 'child', expected_revision: 0, rules: [] })
    if (index === 3) return tool('dynamic_context_manage_rules', { target: 'child', expected_revision: 1, action: 'reopen' })
    if (index === 4) return { tools: [{ name: 'dynamic_context_read_rules', argumentsText: '{' }] }
    return { text: '{"done":true}' }
  } })
  const config = validateConfig({ projectRoot, storageRoot: root, directory, provider: 'fixture', model: 'fake-llama', systemPrompt: 'Fixture.',
    storageFormat: process.env.DSH_FIXTURE_STORAGE_FORMAT ?? 'files', transport: 'direct',
    revision: { policy: roles }, direct: { endpoint: backend.origin + '/v1/chat/completions', durable: true } })
  const storage = openWorkflowStorage(config)
  t.after(async () => { storage?.close(); await backend.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const runId = 'revision_scope_update_' + randomUUID()
  const state = { revision: 1, supervision: { hierarchy: { scopeId: 'root', stage: 'UPDATE', ruleDraftRunId: runId } },
    graph: { state: { plan: { nodes: [] } } } }
  let pause = true
  const runner = { config, storage, graph: { read: () => state }, admitWorkflowRelease() {}, ctx: { get: () => undefined },
    workflowControl: { beforeRequest() {
      if (pause && backend.requests.length === 3) throw Object.assign(Error('test pause'), { code: 'WORKFLOW_PAUSE_REQUESTED' })
    } } }
  const run = () => {
    const editor = layerRuleTools(runner, state, 'root')
    return directRevisionRole(runner, { runId, role: 'scope_update', signal: signal(), messages: [
      { role: 'system', content: 'Use the editor.' }, { role: 'user', content: '{}' },
    ], readOnlyTools: { tools: editor.tools, execute: (call, _config, ordinal) => editor.execute(call, ordinal) },
    validateOutput: false })
  }
  await assert.rejects(run(), { code: 'WORKFLOW_PAUSE_REQUESTED' })
  assert.equal(readRoleRecord(runner, runId).phase, 'PAUSED')
  pause = false
  assert.deepEqual(await run(), { done: true })
  assert.equal(backend.requests.length, 5)
  const history = backend.requests.at(-1).payload.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content))
  assert.deepEqual(history.slice(0, 3).map(row => row.revision), [0, 1, 2])
  assert.equal(history[3].error, 'MODEL_JSON_SYNTAX')
  assert.throws(() => bindLayerRules(runner, state, 'root', { nodes: [] }), { code: 'RULE_DRAFT_NOT_CONFIRMED' })
  state.supervision.hierarchy.ruleDraftRunId = 'revision_scope_update_' + randomUUID()
  assert.deepEqual(bindLayerRules(runner, state, 'root', { nodes: [] }), { nodes: [] })
})

test('identical report rejection pauses the role and resume sends only the next fresh request', async t => {
  const { root, projectRoot, directory } = directories(t)
  const attempts = [
    '{"report":{"accepted":false,"note":"first"}}',
    '{ "report" : { "accepted": false, "note": "second" } }',
    '{"report":{"note":"second","accepted":false}}',
    '{"report":{"accepted":true}}',
  ]
  const backend = await startFakeLlama({ respond: ({ index }) => ({ tools: [
    { name: 'dynamic_context_generate_report', argumentsText: attempts[index - 1] },
  ] }) })
  t.after(async () => { await backend.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const config = validateConfig({ projectRoot, storageRoot: root, directory, provider: 'fixture', model: 'fake-llama', systemPrompt: 'Fixture.',
    transport: 'direct', revision: { policy: roles }, direct: { endpoint: backend.origin + '/v1/chat/completions', durable: true } })
  const runner = { config, ctx: { get: () => undefined } }, runId = 'revision_scope_update_' + randomUUID()
  const run = () => directRevisionRole(runner, { runId, role: 'scope_update', signal: signal(), messages: [
    { role: 'system', content: 'Submit a report.' }, { role: 'user', content: '{}' },
  ], validateResult(value) {
    if (!value.accepted) throw Object.assign(Error('The report needs an accepted field.'), { code: 'FIXTURE_REPORT_FIELD' })
    return value
  } })
  await assert.rejects(run(), { code: 'WORKFLOW_NO_PROGRESS' })
  assert.equal(backend.requests.length, 3)
  assert.equal(readRoleRecord(runner, runId).phase, 'PAUSED')
  assert.deepEqual(await run(), { accepted: true })
  assert.equal(backend.requests.length, 4)
  const recorded = backend.requests.at(-1).payload.messages.flatMap(message => message.tool_calls ?? [])
  assert.deepEqual(recorded.map(call => call.function.arguments), attempts.slice(0, 3))
})

test('configured credential references are removed at the protected subprocess boundary', t => {
  const { root, projectRoot, directory } = directories(t), seen = []
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const subprocess = { spawn(spec) { seen.push(spec) } }
  const make = name => createPrivatePathGuard({ subprocess, workspaceRoot: projectRoot, protectedRoots: [directory],
    maskRoot: directory, credentialEnvironment: () => [name] })
  const one = make('FIXTURE_A'), two = make('FIXTURE_B')
  t.after(() => { one.close(); two.close() })
  for (const guard of [one, two]) guard.run(() => subprocess.spawn({ argv: ['true'], env: { FIXTURE_A: 'sample', FIXTURE_B: 'sample', ORDINARY: 'keep' } }))
  assert.deepEqual(seen.map(spec => Object.keys(spec.env).sort()), [['FIXTURE_B', 'ORDINARY'], ['FIXTURE_A', 'ORDINARY']])
  assert.deepEqual(seen.map(spec => spec.argv[spec.argv.indexOf('--unsetenv') + 1]), ['FIXTURE_A', 'FIXTURE_B'])
})

test('material projection preserves verification and fact locators with exact archived ranges', () => {
  const raw = { contract: { objective: 'Verify current response.' }, contexts: [{ id: 'bound_fact', revision: 2, content: 'a'.repeat(65536) }],
    verificationPlan: { requirements: [{ id: 'criterion', required: true }] },
    reports: [{ taskId: 'child', _reportIndex: { source: 'role-input:fixture' } }] }
  const bundle = materialBundle(raw, 4096)
  const view = materialView(raw, bundle, { tool: 'reader', arguments: { id: 'fixture' } }, 4096, true)
  assert.deepEqual(view.contract, raw.contract)
  assert.deepEqual(view.materialNavigation.contexts.entries, [{ id: 'bound_fact', revision: 2 }])
  assert.deepEqual(view.materialNavigation.verificationPlan.entries, [{ id: 'criterion', required: true }])
  assert.equal(view.materialNavigation.reports.entries[0].source, 'role-input:fixture')
  for (const card of Object.values(view.materialNavigation)) assert.ok(bundle.text.slice(card.start, card.end))
})

test('applied fact updates notify only bound workers and give an exact version for a large fact', () => {
  const content = 'Updated material.'.repeat(100), message = { id: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: content }] }
  const messageHash = digest(message)
  const row = { version: 1, id: 'update', sessionId: 'fixture', phase: 'APPLIED', message, messageHash, route: { action: 'update_fact' } }
  const state = { contexts: { nodes: [{ id: 'fact', key: 'known', parents: [], content: 'old' }],
    bindings: [{ taskId: 'one', contexts: ['fact'] }, { taskId: 'other', contexts: [] }] },
  sharedContextHistory: [{ authority: 'user-guidance', guidanceId: row.id, messageHash, id: 'fact', revision: 2, content }] }
  const runner = { config: { workflowLimits: { dynamicMaterialBytes: 128 } }, graph: { read: () => state },
    controller: { session: { id: 'fixture', snapshotEvents: () => [{ type: GUIDANCE_RECORD, data: row, ignorable: true }] } } }
  const [notice] = applicableGuidance(runner, 'executor', { taskId: 'one' })
  assert.equal(notice.factUpdate.read, undefined)
  const [readable] = applicableGuidance(runner, 'executor', { taskId: 'one' }, (fact, inline) => {
    assert.equal(inline, false)
    return { tool: 'dynamic_context_shared_read', arguments: { id: fact.id, revision: fact.revision } }
  })
  assert.deepEqual(readable.factUpdate.read.arguments, { id: 'fact', revision: 2 })
  assert.equal(notice.factUpdate.sha256, digest(content))
  assert.equal(notice.content, undefined)
  assert.deepEqual(applicableGuidance(runner, 'executor', { taskId: 'other' }), [])
})
