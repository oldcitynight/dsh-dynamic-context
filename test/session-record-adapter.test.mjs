import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Session, KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { assertReleasedV4Relationships } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { appendPluginRecord } from '../native-records.mjs'
import { patchNativeSession, restoreNativeSessionSource } from '../scripts/patch-native-session.mjs'
import { createRuntimeHarness } from '../testing/runtime-harness.mjs'

test('legacy native-record backport is exact, idempotent and rejects changed or partial upstream code', t => {
  const require = createRequire(import.meta.url), directory = path.dirname(require.resolve('@deepseek-ai/dsh-session/package.json'))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-record-patch-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const target = path.join(root, '@deepseek-ai/dsh-session'), file = path.join(target, 'lib/index.js')
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.copyFileSync(path.join(directory, 'package.json'), path.join(target, 'package.json'))
  const original = restoreNativeSessionSource(fs.readFileSync(path.join(directory, 'lib/index.js'), 'utf8'))
  fs.writeFileSync(file, original)
  assert.equal(patchNativeSession(root).changed, true)
  const patched = fs.readFileSync(file, 'utf8')
  assert.equal(patchNativeSession(root).changed, false)
  assert.equal(restoreNativeSessionSource(patched), original)
  fs.writeFileSync(file, patched + '\n// unrelated modification\n')
  assert.throws(() => patchNativeSession(root), /SOURCE_CHANGED/)
  assert.equal(fs.readFileSync(file, 'utf8'), patched + '\n// unrelated modification\n')
  fs.writeFileSync(file, patched.replace('return session.__dshPluginRecord(type, data);', 'return 0;'))
  assert.throws(() => patchNativeSession(root), /PARTIAL_PATCH/)
  fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ version: '0.0.0' }))
  assert.throws(() => patchNativeSession(root), /VERSION_UNSUPPORTED/)
})

test('backported records preserve durable replay, exact sequence, ignored model surface and reentrancy', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-record-flow-')), projectRoot = path.join(root, 'project')
  fs.mkdirSync(projectRoot)
  const h = await createRuntimeHarness({ projectRoot, directory: path.join(root, 'state'), config: { storageRoot: root }, respond: () => ({ text: 'unused' }) })
  t.after(async () => { await h.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const handle = await h.ctx.agents.create({ sessionId: 'record-owner', meta: { cwd: projectRoot } })
  t.after(() => handle.dispose())
  const session = handle.agent.session, before = session.snapshotEvents().length, messages = session.deriveMessages()
  const data = { facts: ['one'] }; let reentrant = false
  h.ctx.on('session/event', (owner, row) => {
    if (owner === session && row.type === 'plugin:fixture/fact') {
      assert.throws(() => appendPluginRecord(session, 'plugin:fixture/reentered', {}), /reenter/)
      assert.throws(() => session.append('session/title', { title: 'nested' }), /reenter/)
      reentrant = true
    }
  })
  assert.equal(appendPluginRecord(session, 'plugin:fixture/fact', data), before)
  data.facts.push('not committed')
  assert.equal(reentrant, true)
  assert.equal(session.snapshotEvents().length, before + 1)
  const record = session.snapshotEvents().at(-1)
  assert.equal(record.ignorable, true); assert.deepEqual(record.data, { facts: ['one'] }); assert.equal(Object.isFrozen(record.data.facts), true)
  assert.deepEqual(session.deriveMessages(), messages)
  assert.throws(() => appendPluginRecord(session, 'user/message', {}), /invalid plugin record/)
  assert.throws(() => appendPluginRecord(session, 'plugin:fixture/invalid', { n: NaN }), /JSON/)
  assert.equal(session.snapshotEvents().length, before + 1)
  assert.equal(await h.ctx.sessions.flush(session), true)
  const stored = await h.ctx.sessionPersistence.open(session.id, 'read')
  try {
    const events = (await stored.read(0, before + 1)).events
    const restored = Session.create(session.id, events, session.header, session.inheritedEventCount)
    assert.deepEqual(events, session.snapshotEvents())
    assert.deepEqual(restored.snapshotEvents().slice(0, events.length), events)
    assert.deepEqual(restored.deriveMessages(), session.deriveMessages())
    assertReleasedV4Relationships({ header: session.header, events, inheritedEventCount: session.inheritedEventCount }, KNOWN_SESSION_EVENT_TYPES)
  } finally { await stored.close() }
  assert.equal(h.backend.requests.length, 0)
})
