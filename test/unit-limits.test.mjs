// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DynamicContextGraph } from '../core.mjs'
import { DynamicContextRuntime, durableConfigHash, validateConfig } from '../index.mjs'
import { profileUnitLimitReader } from '../unit-limits.mjs'

const plan = count => {
  const leaves = Array.from({ length: count }, (_, i) => ({ key: 'leaf' + i,
    kind: 'leaf', label: 'Leaf ' + i, parent: 'root' }))
  return { taskGraph: { title: 'Leaf admission', nodes: [{ key: 'root', kind: 'container', label: 'Root' }, ...leaves], edges: [] },
    contextGraph: { nodes: [], bindings: leaves.map(({ key }) => ({ task: key, contexts: [], instruction: 'Verify this leaf' })) } }
}
const revision = count => ({ ...plan(count), invalidateReports: [] })
function fixture(t, limit) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-leaf-limit-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const config = { projectRoot: directory, directory: path.join(directory, 'state'), workflowLimits: limit === undefined ? {} : { maxUnits: limit } }
  return { graph: new DynamicContextGraph(config), config, directory }
}
const config = { projectRoot: '.', directory: 'logs', transport: 'direct', provider: 'fake', model: 'fake',
  systemPrompt: 'Verify work.', direct: { endpoint: 'http://127.0.0.1:11/v1/chat/completions', apiKeyEnv: 'FAKE_KEY' } }

test('configured unit count includes the root and defaults to 512 and checks complete linked submissions', t => {
  assert.equal(validateConfig(config).workflowLimits.maxUnits, 512)
  for (const invalid of [0, -1, '64', null, 2.5]) assert.throws(() => validateConfig({ ...config, workflowLimits: { maxUnits: invalid } }))
  const { graph } = fixture(t)
  assert.throws(() => graph.submit(plan(512)), { code: 'UNIT_LIMIT' })
  assert.equal(graph.read(), null)
  assert.equal(graph.submit(plan(511)).contexts.bindings.length, 511)
})

test('hot raising a config cap admits expansion of an original 32-unit graph without rewriting it', async t => {
  const { graph, config: graphConfig, directory } = fixture(t, 32)
  const original = graph.submit(plan(31))
  assert.throws(() => graph.prepareRevision(revision(50)), { code: 'UNIT_LIMIT' })
  const profile = { dir: directory, name: 'test', installAnchor: path.join(directory, 'package.json'),
    home: directory, patchPath: path.join(directory, 'cordis.patch.yml'), overlays: [] }
  fs.writeFileSync(profile.installAnchor, JSON.stringify({ name: 'profile-fixture', dsh: { profile: { bundles: [] } } }))
  const setProfile = limit => fs.writeFileSync(profile.patchPath, [
    '- insert:', '    - id: dsh-dynamic-context', '      name: dsh-dynamic-context',
    '      config:', '        workflowLimits:', '          maxUnits: ' + limit, ''
  ].join('\n'))
  const runner = { graph, busy: false, closed: false,
    readConfiguredUnitLimit: profileUnitLimitReader({ get: () => profile }, 'dsh-dynamic-context') }
  const refresh = () => DynamicContextRuntime.prototype.refreshUnitLimit.call(runner)
  setProfile(32)
  await refresh()
  assert.equal(graph.unitLimit().maximum, 32)
  setProfile(64)
  assert.equal(graph.unitLimit().maximum, 32)
  await refresh()
  assert.deepEqual(graph.unitLimit(), { configured: 64, current: 32, maximum: 64 })
  assert.equal(graph.prepareRevision(revision(50)).contexts.bindings.length, 50)
  assert.deepEqual(new DynamicContextGraph(graphConfig).read(), original)
  setProfile(15)
  await refresh()
  assert.deepEqual(graph.unitLimit(), { configured: 15, current: 32, maximum: 32 })
  assert.equal(graph.prepareRevision(revision(31)).contexts.bindings.length, 31)
  assert.throws(() => graph.prepareRevision(revision(33)), { code: 'UNIT_LIMIT' })
  assert.deepEqual(graph.read(), original)
  setProfile(0)
  await assert.rejects(refresh(), { code: 'UNIT_LIMIT_CONFIG_INVALID' })
  assert.deepEqual(graph.read(), original)
  assert.equal(graph.unitLimit().configured, 15)
  runner.busy = true
  setProfile(64)
  await assert.rejects(refresh(), { code: 'UNIT_LIMIT_UPDATE_BUSY' })
})

test('executor checkpoint identity is independent of future graph admission', () => {
  const checked = validateConfig(config)
  assert.equal(durableConfigHash(checked), durableConfigHash({ ...checked, workflowLimits: { ...checked.workflowLimits, maxUnits: 80 } }))
  assert.notEqual(durableConfigHash(checked), durableConfigHash({ ...checked, model: 'different' }))
})
