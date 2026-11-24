import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { startWorkflowWeb, until } from '../testing/web-workflow-harness.mjs'
import { rootTask, unitReport } from '../testing/unit-proposal.mjs'

test('fresh Web bundle exposes both plugin settings, validates atomic edits, resets, and remounts across restart', { timeout: 60000 }, async t => {
  const h = await startWorkflowWeb({ bundleDefaults: true, respond: () => ({ text: 'Local fixture.' }) })
  t.after(() => h.stop())
  const dynamic = 'dsh-dynamic-context', graph = 'dsh-better-task-grapth'
  const view = async ns => (await h.call('settings/describe', {})).namespaces.find(item => item.ns === ns)
  const set = (key, value) => ({ op: 'set', path: key.split('.'), value })
  const save = async (ns, ops) => h.call('settings/mutate', { ns, ops, expectedRevision: (await view(ns)).revision })
  const first = await view(dynamic)
  assert.equal(first.value.enabled, true)
  assert.deepEqual(first.value.interaction, { mode: 'interactive', orchestration: true, commandMode: 'full' })
  assert.equal(first.value.direct.durable, true)
  assert.equal(first.value.direct.compaction.strategy, 'dsh-native')
  assert.equal(first.value.direct.runtime.sandboxMode, 'auto')
  assert.equal(first.value.supervision, true)
  assert.equal(first.value.direct.auth, 'deepseek-account')
  assert.deepEqual(first.value.workflowLimits, { maxUnits: 512, maxDepth: 32, preloadBytes: 10240, dynamicMaterialBytes: 65536 })
  assert.equal((await view(graph)).value.enableSwitch, false)
  await h.call('session/create', { cwd: h.workspace })
  assert.equal(h.backend.requests.length, 0)
  const at = await save(dynamic, [set('workflowLimits.maxUnits', 513), set('preferences.contextWindow', 131072)])
  assert.equal(at.value.workflowLimits.maxUnits, 513)
  assert.equal((await h.rpc('settings/mutate', { ns: dynamic, expectedRevision: first.revision,
    ops: [set('workflowLimits.maxUnits', 514)] })).ok, false)
  assert.equal((await h.rpc('settings/mutate', { ns: dynamic, expectedRevision: at.revision,
    ops: [set('workflowLimits.maxDepth', -1), set('model', 'discarded')] })).ok, false)
  assert.equal((await view(dynamic)).value.model, first.value.model)
  const policy = path.join(h.workspace, 'roles.json')
  fs.writeFileSync(policy, JSON.stringify({ version: 1, roleStrategies: { unit_router: 'whitelist' }, toolErrors: { includeDefaults: false } }))
  const configured = await save(dynamic, [set('rolePolicyFile', policy), set('rolePolicy.roleStrategies', { baseline_audit: 'blacklist' }),
    set('rolePolicy.modelBackends', { local: { provider: 'deepseek-account', model: 'worker-test' } }), set('rolePolicy.roleModels', { executor: 'local' }),
    set('rolePolicy.toolErrors.mode', 'whitelist'), set('model','saved-model')])
  assert.deepEqual(configured.value.rolePolicy.roleStrategies, { unit_router: 'whitelist', baseline_audit: 'blacklist' })
  assert.equal(configured.value.rolePolicy.toolErrors.includeDefaults, false)
  assert.equal(configured.value.rolePolicy.roleModels.executor, 'local')
  await save(graph, [set('enableSwitch',true),set('workflowLimits.maxDepth',40)])
  await h.restart()
  assert.equal((await view(dynamic)).value.model, 'saved-model')
  assert.equal((await view(graph)).value.workflowLimits.maxDepth, 40)
  assert.equal((await save(dynamic, [{ op:'unset', path:['model'] }])).value.model, first.value.model)
  assert.equal((await save(dynamic, [set('enabled',false)])).value.enabled, false)
  assert.equal((await save(dynamic, [set('enabled',true)])).value.enabled, true)
  assert.equal(h.backend.requests.length, 0)
})

test('the installed preset keeps ordinary chat native and runs the explicit command through an audited root and final report', { timeout: 60000 }, async t => {
  const marker = 'Ordinary conversation fixture.'
  let normal = 0, planning = 0, work = 0
  const h = await startWorkflowWeb({ bundleDefaults: true, respond: ({ payload }) => {
    const system = payload.messages[0]?.content ?? ''
    if (payload.messages.some(row => row.role === 'user' && JSON.stringify(row.content).includes(marker))) {
      normal++
      return { text: 'Native reply.' }
    }
    if (system.includes('DYNAMIC_CONTEXT_PREPLANNER_V1')) {
      planning++
      const proposal = rootTask()
      proposal.planningReport.verification = { version: 1, deliveryRequired: false, requirements: [{
        id: 'goal', origin: 'USER', statement: 'Verify a local fixture.', source: 'User request',
        verification: 'Review the unit report.', required: true,
      }] }
      return { tools: [{ name: 'dynamic_context_submit', arguments: { proposal } }] }
    }
    if (system.includes('<direct_host_facts>')) {
      work++
      const report = unitReport('Verified the local fixture.')
      report.executionReport.verification = [{ requirementId: 'goal', status: 'LIMITED', method: 'ANALYSIS',
        target: 'fixture', environment: 'local', testIds: [], limits: ['Local fixture only.'], conclusion: 'The unit was checked.' }]
      return { text: JSON.stringify(report) }
    }
    return { text: 'Recorded.' }
  } })
  t.after(() => h.stop())
  const session = async () => (await h.call('session/create', { cwd: h.workspace })).sessionId
  const ordinary = await session(), managed = await session()
  const status = sessionId => h.call('transactionGraphView/status', { sessionId })
  assert.equal(h.backend.requests.length, 0)

  await h.call('session/prompt', { requestId: randomUUID(), sessionId: ordinary, mode: 'queue', content: [{ type: 'text', text: marker }] })
  await until(() => h.backend.requests.filter(row => row.completed).length, n => n === 1, 'native reply')
  assert.equal(normal, 1)
  assert.equal(planning, 0)
  assert.equal((await status(ordinary)).status, 'empty')

  // Only substitute the isolated provider connection. All workflow settings come from the shipped bundle.
  const ns = 'dsh-dynamic-context', settings = (await h.call('settings/describe')).namespaces.find(row => row.ns === ns)
  const local = { provider: 'fixture', model: 'fake-llama', 'direct.endpoint': h.backend.origin + '/v1/chat/completions',
    'direct.auth': 'api-key', 'direct.api': 'openai-compatible', 'direct.protocol': 'chat-completions', 'direct.apiKeyEnv': 'DSH_WORKFLOW_FIXTURE_KEY' }
  const ops = Object.entries(local).map(([key, value]) => ({ op: 'set', path: key.split('.'), value }))
  await h.call('settings/mutate', { ns, expectedRevision: settings.revision, ops })
  await h.call('commands/execute', { agentId: managed, line: '/task-graph Verify a local fixture.', submittedAttachments: [] })
  const done = await until(() => status(managed), value => value.execution?.state === 'complete', 'audited root completion', 30000)
  assert.equal(done.execution.reason, 'ROOT_ACCEPTED_AND_REPORTED')
  assert.equal(done.graph.hierarchy.version, 2)
  assert.equal(done.graph.nodes[0].ruleState, 'PASS')
  assert.equal(planning, 1)
  assert.equal(work, 1)
  assert.equal((await status(ordinary)).execution?.workflowId, undefined)
  assert.deepEqual(h.backend.errors, [])
})
