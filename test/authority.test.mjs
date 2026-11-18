import test from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { digest } from 'dsh-better-task-grapth/core'
import { authorityHeader, authorityInputs, legacyInputs, matchesHistoricalAuthority, inputDigestMatches } from '../authority.mjs'

const hash = controller => digest({ config: { model: 'pinned-model' }, controller })
function fixture() {
  const header = { version: 4, id: 'authority-fixture', cwd: '/tmp/project', createdAt: 1, isSeeded: false, agentPreset: 'standard' }
  const session = Session.create(header.id, [], header, 0)
  const append = (kind, text) => session.append('user/message', createUserMessage({ source: { kind }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
  append('user', 'Implement and verify the authorized deliverable.')
  append('runtime-context', 'Runtime instructions sampled before execution.')
  append('time-context', 'Old time.')
  const controller = { header, cwd: header.cwd, sandbox: { mode: 'workspace-write', workspaceRoot: header.cwd }, approval: 'ask', plan: false, goal: null }
  const expected = hash({ ...controller, input: legacyInputs(session) }), ownerHash = digest(legacyInputs(session))
  append('dynamic-context', 'The result report needs its test citation corrected.')
  append('time-context', 'New time.')
  append('tool-registry', 'The controller now exposes workflow recovery tools.')
  const reloaded = Session.create(session.id, session.snapshotEvents(), { ...header, delegationDepth: 0 }, 0)
  return { session: reloaded, controller: { ...controller, header: reloaded.header, input: authorityInputs(reloaded) }, expected, ownerHash }
}

test('old authority survives generated messages and native default-header hydration without mutating evidence', () => {
  const h = fixture(), before = digest(h.session.snapshotEvents())
  assert.equal(matchesHistoricalAuthority(h.session, h.expected, h.controller, hash), true)
  assert.equal(inputDigestMatches(h.session, h.ownerHash), true)
  assert.equal(digest(h.session.snapshotEvents()), before)
  assert.equal(Object.hasOwn(authorityHeader(h.controller.header), 'delegationDepth'), false)
})

test('actual instruction, policy, directory, Goal and non-default lineage changes remain fenced', () => {
  const h = fixture()
  for (const patch of [{ approval: 'never' }, { cwd: '/different' }, { plan: true }, { goal: { id: 'new', revision: 1, phase: 'active' } },
    { sandbox: { mode: 'read-only', workspaceRoot: '/tmp/project' } }, { header: { ...h.controller.header, delegationDepth: 1 } }])
    assert.equal(matchesHistoricalAuthority(h.session, h.expected, { ...h.controller, ...patch }, hash), false)
  h.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Change the authorized task.' }] }), { surfaceOp: 'append' })
  assert.equal(matchesHistoricalAuthority(h.session, h.expected, { ...h.controller, input: authorityInputs(h.session) }, hash), false)
  assert.equal(inputDigestMatches(h.session, h.ownerHash), false)
})
