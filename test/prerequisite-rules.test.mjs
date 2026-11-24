// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { layerRuleTools, RuleDrafts } from '../rule-editor.mjs'
import { prepareRuleSubmission } from '../rule-audit.mjs'
import { checkOutcome, binaryInstruction } from '../rule-protocol.mjs'
import { openWorkflowStorage } from '../workflow-io.mjs'
import { proposalSchema } from '../core.mjs'
import { digest } from 'dsh-better-task-grapth/core'
import { EXECUTION_REPORT_INSTRUCTION } from '../report-evidence.mjs'

const a = { node: 'a', in: ['PASS'] },
  b = { node: 'b', in: ['FAILED'] },
  r = { id: 'match', when: { all: [a, { not: b }] } }
function layout() {
  return {
    title: 'Entrances',
    ruleVersion: 1,
    edges: [],
    hierarchy: { version: 1, maxGroupDepth: 3 },
    nodes: [
      { key: 'root', kind: 'container', label: 'root', terminal: 'target', acceptance: 'Evaluate output' },
      ...['a', 'b', 'target'].map((key) => ({ key, label: key, kind: 'leaf', parent: 'root' }))
    ]
  }
}
test('a layer planner can correct malformed layout and a redundant confirmation without losing its draft', t => {
  const { runner } = setup(t, 'sqlite')
  const state = { revision: 2, supervision: { hierarchy: { scopeId: 'root', stage: 'UPDATE' } }, graph: { state: { plan: { nodes: [] } } } }
  runner.graph.read = () => state
  const editor = layerRuleTools(runner, state, 'root')
  const call = (id, name, args) => editor.execute({ id, function: { name: 'dynamic_context_' + name, arguments: JSON.stringify(args) } })
  const args = { target: 'finish', expected_revision: 0, rules: [r] }
  assert.equal(call('bad', 'set_rule_tree', { ...args, layout: { nodes: ['a', 'finish'] } }).error, 'RULE_LAYOUT_INVALID')
  assert.equal(call('null_node', 'set_rule_tree', { ...args, layout: { nodes: [null] } }).error, 'RULE_LAYOUT_INVALID')
  const confirmed = call('valid', 'set_rule_tree', args)
  assert.equal(confirmed.status, 'confirmed')
  assert.equal(call('extra', 'manage_rules', { target: 'finish', expected_revision: confirmed.revision, action: 'confirm' }).error, 'RULE_REOPEN_REQUIRED')
  assert.deepEqual(call('read', 'read_rules', { target: 'finish' }).rules, [r])
  state.supervision.hierarchy.stage = 'UPDATE_AUDIT'
  assert.throws(() => call('stale', 'set_rule_tree', { ...args, target: 'elsewhere' }), { code: 'RULE_GRAPH_ALREADY_COMMITTED' })
})

function proposal() {
  return {
    taskGraph: layout(),
    contextGraph: {
      nodes: [],
      bindings: ['a', 'b', 'target'].map((task) => ({
        task,
        instruction: 'Check ' + task,
        contexts: [],
        inheritReports: [],
        tools: [],
        completion: { kind: 'report' }
      }))
    }
  }
}
function setup(t, backend) {
  const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rules-')))
  const config = {
    projectRoot,
    directory: path.join(projectRoot, 'state'),
    revision: { policy: { objective: 'Check the output' } }
  }
  const runner = { config, admitWorkflowRelease() {}, graph: { read: () => null } }
  function open() {
    runner.storage = backend === 'sqlite' ? openWorkflowStorage(config) : null
    runner.ruleDrafts = new RuleDrafts(runner)
    return runner.ruleDrafts
  }
  open()
  t.after(() => {
    runner.storage?.close()
    fs.rmSync(projectRoot, { recursive: true, force: true })
  })
  return {
    runner,
    restart: () => {
      runner.storage?.close()
      return open()
    }
  }
}
for (const backend of ['file', 'sqlite']) {
  test(backend + ' stores equivalent whole, single, named and resumable fragment inputs', (t) => {
    const { runner, restart } = setup(t, backend)
    let editor = runner.ruleDrafts
    const write = (tool, target, revision, extra) =>
      editor.edit(tool, { target, expected_revision: revision, ...extra })
    const whole = write('set_rule_tree', 'whole', 0, { rules: [r] })
    write('set_rule', 'single', 0, r)
    write('set_named_rule', 'named', 0, {
      id: r.id,
      parts: { a_ok: a, b_failed: b },
      root: { all: ['a_ok', { not: 'b_failed' }] }
    })
    write('edit_rule_part', 'pieces', 0, { id: r.id, when: { all: [a, { not: { hole: 'later' } }] } })
    assert.deepEqual(editor.edit('read_rules', { target: 'pieces' }).holes, [{ rule: 'match', slot: 'later' }])
    editor = restart()
    assert.throws(() => write('manage_rules', 'pieces', 1, { action: 'confirm' }), { code: 'RULE_EXPRESSION' })
    assert.match(editor.edit('read_rules', { target: 'pieces', format: 'mnemonic' }).mnemonic, /待填 later/)
    assert.equal(editor.edit('read_rules', { target: 'pieces', format: 'mnemonic' }).rules, undefined)
    write('edit_rule_part', 'pieces', 1, { id: r.id, slot: 'later', when: b })
    for (const [target, rev] of [
      ['single', 1],
      ['named', 1],
      ['pieces', 2]
    ]) {
      const out = write('manage_rules', target, rev, { action: 'confirm' })
      assert.deepEqual(out.rules, whole.rules)
      assert.equal(out.mnemonic, whole.mnemonic)
      assert.match(out.mnemonic, /取反/)
      assert.equal(out.status, 'confirmed')
    }
    const physical = path.join(runner.config.directory, 'planning-rules.json')
    assert.equal(fs.existsSync(physical), backend === 'file')
    if (backend === 'sqlite') assert.ok(runner.storage.db.info('planning-rules.json'))
  })
}
test('atomic whole write, idempotent retries, revision conflicts and version-bound duplicate confirmations', (t) => {
  const { runner, restart } = setup(t, 'sqlite')
  let editor = runner.ruleDrafts
  const args = { target: 'target', expected_revision: 0, rules: [r, { ...r, id: 'dup' }], layout: layout() }
  const warning = editor.edit('set_rule_tree', args, 'first')
  assert.equal(warning.status, 'needs_confirmation')
  assert.ok(warning.warnings[0].risk)
  editor = restart()
  assert.deepEqual(editor.edit('set_rule_tree', args, 'first'), warning)
  assert.throws(() => editor.edit('set_rule_tree', { ...args, rules: [] }, 'first'), { code: 'RULE_CALL_CHANGED' })
  const act = (action, revision, extra = {}) =>
    editor.edit('manage_rules', { target: 'target', action, expected_revision: revision, ...extra })
  assert.throws(() => act('merge', 1, { confirmation: 'old' }), { code: 'RULE_CONFIRMATION_STALE' })
  assert.throws(() => act('keep', 0, { confirmation: warning.confirmation }), { code: 'RULE_DRAFT_STALE' })
  const merged = act('merge', 1, { confirmation: warning.confirmation })
  assert.deepEqual(merged.rules, [r])
  assert.equal(merged.preflight, 'graph')
  assert.throws(() => editor.edit('set_rule_tree', { target: 'target', expected_revision: 2, rules: [] }), {
    code: 'RULE_REOPEN_REQUIRED'
  })
  act('reopen', 2)
  const invalid = [r, { id: 'wrong', when: { all: [a, { node: 'a', in: ['FAILED'] }] } }]
  assert.throws(() => editor.edit('set_rule_tree', { target: 'target', expected_revision: 3, rules: invalid }), {
    code: 'RULE_CONTRADICTION'
  })
  assert.equal(editor.edit('read_rules', { target: 'target' }).revision, 3)
  assert.deepEqual(editor.edit('read_rules', { target: 'target' }).rules, [r])
  const again = editor.edit('set_rule_tree', { ...args, expected_revision: 3 })
  const kept = act('keep', 4, { confirmation: again.confirmation })
  assert.equal(kept.rules.length, 2)
  const bound = editor.bind(proposal())
  assert.deepEqual(bound.taskGraph.nodes.at(-1).rules, kept.rules)
  bound.taskGraph.nodes.at(-1).rules = []
  assert.throws(() => editor.bind(bound), { code: 'RULE_SUBMISSION_CHANGED' })
})
test('graph preflight rejects impossible BLOCK and reports the first offending rule; absence has no dependencies', (t) => {
  const { runner } = setup(t, 'file'),
    editor = runner.ruleDrafts
  const save = (rules, layoutValue) =>
    editor.edit('set_rule_tree', { target: 'target', expected_revision: 0, rules, layout: layoutValue })
  assert.throws(() => save([{ id: 'bad', when: { node: 'a', in: ['BLOCK'] } }], layout()), {
    code: 'RULE_ROUTE_UNREACHABLE'
  })
  assert.equal(editor.edit('read_rules', { target: 'target' }).revision, 0)
  const saved = save([], layout())
  assert.deepEqual(saved.rules, [])
  assert.match(saved.mnemonic, /没有附加/)
})

for (const backend of ['file', 'sqlite']) test(backend + ' rejects terminal references during authoring and before blueprint audit', async t => {
  const { runner } = setup(t, backend), editor = runner.ruleDrafts
  const terminal = { node: 'target', in: ['FAILED', 'BLOCK'] }
  const bad = { id: 'alternative', when: { any: [b, { not: terminal }] } }
  const known = { target: 'a', expected_revision: 0, layout: layout() }
  for (const [tool, args] of [
    ['set_rule_tree', { rules: [bad] }],
    ['set_rule', { id: bad.id, when: bad.when }],
    ['set_named_rule', { id: bad.id, parts: { end: terminal }, root: { not: 'end' } }],
    ['edit_rule_part', { id: bad.id, when: { all: [terminal, { hole: 'later' }] } }]
  ]) {
    assert.throws(() => editor.edit(tool, { ...known, ...args }), { code: 'TERMINAL_AS_PREDECESSOR' })
    assert.equal(editor.read().targets.length, 0)
  }

  const draft = editor.edit('edit_rule_part', { ...known, id: 'wip', when: { any: [b, { hole: 'later' }] } })
  assert.throws(() => editor.edit('edit_rule_part', { ...known, expected_revision: draft.revision, id: 'wip', slot: 'later', when: terminal }),
    { code: 'TERMINAL_AS_PREDECESSOR' })
  assert.deepEqual(editor.edit('read_rules', { target: 'a' }), draft)
  const local = editor.edit('set_rule_tree', { target: 'a', expected_revision: draft.revision, rules: [bad] })
  assert.equal(local.status, 'confirmed')
  let reviews = 0
  await assert.rejects(prepareRuleSubmission(runner, proposal(), null, undefined, () => { reviews++ }), error => {
    assert.equal(error.code, 'TERMINAL_AS_PREDECESSOR')
    assert.equal(error.details.path, '/nodes/1/rules/0/when/any/1/not/node')
    return true
  })
  assert.equal(reviews, 0)
  assert.equal(editor.read().audit, undefined)
  assert.deepEqual(editor.edit('read_rules', { target: 'a' }), local)
})
test('audit is independent, binds both graphs, and rejects an edit racing its approval', async (t) => {
  const { runner } = setup(t, 'sqlite'),
    d = runner.ruleDrafts,
    original = proposal()
  d.edit('set_rule_tree', { target: 'target', expected_revision: 0, rules: [r] })
  const rejected = async () => ({ verdict: 'REJECT', reason: 'missing acceptance evidence' })
  await assert.rejects(prepareRuleSubmission(runner, original, null, undefined, rejected), {
    code: 'RULE_AUDIT_REJECTED'
  })
  assert.equal(d.read().approval, undefined)
  const review = async (_runner, request) => {
    assert.equal(request.role, 'reviewer')
    assert.match(request.messages[0].content, /独立审计/)
    return { verdict: 'APPROVE', reason: 'Validated scope and two distinct sources.' }
  }
  await assert.rejects(
    prepareRuleSubmission(runner, original, null, undefined, async (...args) => {
      d.edit('manage_rules', { target: 'target', expected_revision: 1, action: 'reopen' })
      return review(...args)
    }),
    { code: 'RULE_AUDIT_STALE' }
  )
  assert.equal(d.read().approval, undefined)
  d.edit('manage_rules', { target: 'target', expected_revision: 2, action: 'confirm' })
  const bound = await prepareRuleSubmission(runner, original, null, undefined, review)
  assert.equal(d.read().approval.proposalHash, digest(proposalSchema.parse(bound)))
  await prepareRuleSubmission(runner, original, null, undefined, () =>
    assert.fail('identical approved proposal reviewed twice')
  )
  original.contextGraph.bindings[0].instruction += ' changed'
  await assert.rejects(prepareRuleSubmission(runner, original, null, undefined, rejected), {
    code: 'RULE_AUDIT_REJECTED'
  })
})
test('only binary agent dispositions with traceable failed criteria or failed calls pass', () => {
  const tools = [
    { callId: 'check', outcome: 'COMPLETED', content: 'measured count 3' },
    { callId: 'error', outcome: 'FAILED', content: 'tool failed' }
  ]
  const criterion = {
    criterion: 'count >= 5',
    expected: '5',
    observed: '3',
    status: 'FAIL',
    callId: 'check',
    quote: 'count 3'
  }
  const result = { outcome: 'FAILED', executionReport: { tests: [criterion] } }
  for (const outcome of ['BLOCK', 'BLOCKED', 'COMPLETE'])
    assert.throws(() => checkOutcome(1, { outcome }, tools), { code: 'RULE_AGENT_BINARY_OUTCOME_REQUIRED' })
  checkOutcome(1, { outcome: 'PASS' }, tools)
  checkOutcome(1, result, tools)
  checkOutcome(1, { outcome: 'FAILED', failedCallId: 'error' }, tools)
  for (const modified of [{ quote: '7' }, { callId: 'none' }, { status: 'NOT_RUN' }, { criterion: '' }])
    assert.throws(
      () => checkOutcome(1, { ...result, executionReport: { tests: [{ ...criterion, ...modified }] } }, tools),
      { code: 'RULE_FAILED_EVIDENCE_REQUIRED' }
    )
  assert.throws(() => checkOutcome(1, { ...result, failedCallId: criterion.callId }, tools), error =>
    error.code === 'RULE_FAILED_EVIDENCE_REQUIRED' && error.diagnostic.issues[0].path === '/failedCallId')
  checkOutcome(undefined, { outcome: 'BLOCKED' }, tools)
  const prompt = binaryInstruction(EXECUTION_REPORT_INSTRUCTION)
  assert.match(prompt, /exact deliverable tree/)
  assert.match(prompt, /"outcome":"PASS"/)
  assert.doesNotMatch(prompt, /"outcome":"BLOCKED"/)
})
