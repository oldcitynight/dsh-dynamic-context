// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { WorkflowDatabase, sha256 } from '../workflow-database.mjs'
import { backupWorkflow, restoreWorkflow } from '../workflow-backup.mjs'

function fixture(t, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-storage-test-')))
  const db = new WorkflowDatabase(root, 'fixture', { create: true, ...options })
  t.after(() => {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, db }
}
test('scope, duplicate bytes, stale writers, rollback, and explicit history', (t) => {
  const { db, root } = fixture(t),
    doc = Buffer.from('repeat me\n'.repeat(20000))
  assert.equal(db.q('PRAGMA journal_size_limit').get().journal_size_limit, -1)
  const expected = db.put('graph/state', doc, { revision: 1 }).sha
  db.put('direct/snapshot', doc)
  assert.equal(db.q('SELECT count(*) AS n FROM documents').get().n, 1)
  assert.throws(() => db.put('graph/state', 'oops', { expected: 'wrong' }), { code: 'CAS_CONFLICT' })
  assert.throws(
    () =>
      db.transaction(() => {
        db.put('role/report', 'partial')
        throw Error('cancel')
      }),
    /cancel/
  )
  assert.equal(db.info('role/report'), undefined)
  db.put('graph/state', 'new', { expected, revision: 2 })
  assert.equal(db.read('direct/snapshot').compare(doc), 0)
  assert.deepEqual(db.list('graph'), ['state'])
  assert.throws(() => db.put('../bad', 'bad'), { code: 'WORKFLOW_STORAGE_INVALID_KEY' })
  assert.throws(() => new WorkflowDatabase(root, 'other'), { code: 'WORKFLOW_STORAGE_IDENTITY_MISMATCH' })
  const child = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    'import {WorkflowDatabase} from ' +
      JSON.stringify(new URL('../workflow-database.mjs', import.meta.url).href) +
      ';const db=new WorkflowDatabase(process.argv[1],"fixture");db.transaction(()=>{db.put("crash/intent","pending");process.kill(process.pid,"SIGKILL")})',
    root
  ])
  assert.equal(child.signal, 'SIGKILL')
  assert.equal(db.info('crash/intent'), undefined)
})
test('live lock excludes another writer and old versions can be reclaimed', (t) => {
  const { root, db } = fixture(t)
  const other = new WorkflowDatabase(root, 'fixture')
  try {
    other.db.exec('PRAGMA busy_timeout=5')
    db.transaction(() => assert.throws(() => other.put('race', 'lost'), /locked|busy/i))
    for (let i = 0; i < 20; i++) db.put('mutable', randomBytes(70000))
    assert.equal(db.q('SELECT count(*) AS n FROM documents').get().n, 1)
    assert.deepEqual(db.q('PRAGMA foreign_key_check').all(), [])
  } finally {
    other.close()
  }
})
test('media pins survive source deletion, checked range reads align without full decode', (t) => {
  const raw = randomBytes(400000),
    { db, root } = fixture(t, { mediaLookup: () => path.join(root, 'source') })
  fs.writeFileSync(path.join(root, 'source'), raw)
  const b = Buffer.from('{"image":"data:image/png;base64,' + raw.toString('base64') + '"}')
  db.put('wire/r', b)
  fs.unlinkSync(path.join(root, 'source'))
  assert.deepEqual(db.read('wire/r'), b)
  const metrics = { decodedBytes: 0 }
  assert.deepEqual(db.read('wire/r', 3301, 733, metrics), b.subarray(3301, 4034))
  assert.ok(metrics.decodedBytes < 600)
  const pin = path.join(root, 'media-pins', sha256(raw))
  const changed = Buffer.from(raw)
  changed[415] ^= 1
  fs.writeFileSync(pin, changed)
  assert.throws(() => db.read('wire/r', 3301, 733), { code: 'WORKFLOW_STORAGE_PIN_CONTENT_CHANGED' })
})
test('segmented two-generation backup replays exact pages, handles orphan segments and damaged evidence', (t) => {
  const { db, root } = fixture(t)
  db.put('one', randomBytes(800000))
  const a = backupWorkflow(db)
  db.put('two', 'B')
  const b = backupWorkflow(db)
  db.put('two', 'C')
  const c = backupWorkflow(db)
  const dir = path.join(root, 'recovery')
  assert.equal(c.retained, 2)
  assert.throws(() => restoreWorkflow(dir, path.join(root, 'old'), a.generation), /GENERATION_MISSING/)
  for (const [generation, expected] of [
    [b, 'B'],
    [c, 'C']
  ]) {
    const sub = path.join(root, generation.generation)
    fs.mkdirSync(sub)
    const target = path.join(sub, 'workflow.sqlite')
    restoreWorkflow(dir, target, generation.generation)
    assert.equal(sha256(fs.readFileSync(target)), generation.sha)
    const copy = new WorkflowDatabase(sub, 'fixture')
    try {
      assert.equal(copy.read('two').toString(), expected)
    } finally {
      copy.close()
    }
    assert.throws(() => restoreWorkflow(dir, target, generation.generation), { code: 'EEXIST' })
  }
  const orphan = path.join(dir, 'part-00000000-0000-0000-0000-000000000000')
  fs.writeFileSync(orphan, 'aborted')
  backupWorkflow(db)
  assert.equal(fs.existsSync(orphan), false)
  const { content } = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json')))
  const part = content.objects[content.generations[0].groups[0]].part
  fs.truncateSync(path.join(dir, part), 0)
  assert.throws(() => restoreWorkflow(dir, path.join(root, 'broken')))
  assert.equal(fs.existsSync(path.join(root, 'broken')), false)
})

test('native Messages and escaped history keep pinned media until their last recovery generation retires', (t) => {
  let source
  const { root, db } = fixture(t, { mediaLookup: () => source })
  const raw = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), randomBytes(20000)])
  source = path.join(root, 'original')
  fs.writeFileSync(source, raw)
  const message = JSON.stringify({ type: 'image', source: { type: 'base64', data: raw.toString('base64') } })
  db.put('wire/messages', message)
  db.put('role/private', JSON.stringify({ previous: message }))
  assert.equal(db.q('SELECT count(*) AS n FROM images').get().n, 1)
  const original = backupWorkflow(db)
  const pin = path.join(root, 'media-pins', sha256(raw))
  const recovery = path.join(root, 'recovery')
  fs.unlinkSync(source)
  const reader = new WorkflowDatabase(root, 'fixture')
  try {
    reader.db.exec('BEGIN')
    assert.equal(reader.read('wire/messages').toString(), message)
    db.remove('wire/messages')
    db.remove('role/private')
    db.db.exec('PRAGMA busy_timeout=2')
    assert.throws(() => backupWorkflow(db), { code: 'WORKFLOW_BACKUP_CHECKPOINT_BUSY' })
    assert.ok(fs.existsSync(pin))
    const whileBusy = path.join(root, 'offline-during-busy.sqlite')
    restoreWorkflow(recovery, whileBusy, original.generation)
    assert.equal(sha256(fs.readFileSync(whileBusy)), original.sha)
  } finally {
    reader.close()
  }
  backupWorkflow(db)
  assert.ok(fs.existsSync(pin))
  const previous = path.join(root, 'offline-copy.sqlite')
  restoreWorkflow(recovery, previous, original.generation)
  assert.equal(sha256(fs.readFileSync(previous)), original.sha)
  backupWorkflow(db)
  assert.equal(fs.existsSync(pin), false)
})

test('busy reader delays backup without invalidating an earlier restorable generation', (t) => {
  const { db, root } = fixture(t)
  db.put('a', 'prior')
  const a = backupWorkflow(db),
    reader = new WorkflowDatabase(root, 'fixture')
  try {
    reader.db.exec('BEGIN')
    assert.equal(reader.read('a').toString(), 'prior')
    db.put('a', 'next')
    db.db.exec('PRAGMA busy_timeout=2')
    assert.throws(() => backupWorkflow(db), { code: 'WORKFLOW_BACKUP_CHECKPOINT_BUSY' })
    restoreWorkflow(path.join(root, 'recovery'), path.join(root, 'prior.sqlite'), a.generation)
    reader.db.exec('ROLLBACK')
    assert.notEqual(backupWorkflow(db).sha, a.sha)
  } finally {
    reader.close()
  }
})

test('separate supervision commits on one graph revision retain their own state history', (t) => {
  const { db } = fixture(t)
  db.put('graph/state', '{"revision":9,"phase":"REVIEW"}', { revision: 9 })
  db.put('graph/state', '{"revision":9,"phase":"APPROVED"}', { revision: 9 })
  db.remove('graph/state')
  db.put('graph/state', '{"revision":10,"phase":"NEXT"}', { revision: 10 })
  const states = db
    .q(
      'SELECT ordinal,rev,d.sha,d.size,d.id AS doc FROM state_history h JOIN documents d ON h.doc=d.id ORDER BY ordinal'
    )
    .all()
  assert.deepEqual(
    states.map((s) => [s.ordinal, s.rev, JSON.parse(db.range(s)).phase]),
    [
      [1, 9, 'REVIEW'],
      [2, 9, 'APPROVED'],
      [3, 10, 'NEXT']
    ]
  )
})

test('offline restore rebuilds virtual record directories and refuses a symlink without publishing a database', (t) => {
  const { root, db } = fixture(t)
  db.put('revisions/role/role.json', JSON.stringify({ phase: 'PAUSED' }))
  db.put('attempt_a/continuation/head.json', 'original head')
  backupWorkflow(db)
  const recovery = path.join(root, 'recovery'),
    output = path.join(root, 'restored')
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-restore-link-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  fs.symlinkSync(outside, path.join(root, 'revisions'))
  assert.throws(() => restoreWorkflow(recovery, output), { code: 'WORKFLOW_BACKUP_DIRECTORY_INVALID' })
  assert.equal(fs.existsSync(output), false)
  assert.deepEqual(fs.readdirSync(outside), [])
  assert.equal(fs.existsSync(path.join(root, 'attempt_a')), false)
  fs.unlinkSync(path.join(root, 'revisions'))
  restoreWorkflow(recovery, output)
  assert.ok(fs.statSync(path.join(root, 'revisions', 'role')).isDirectory())
  assert.deepEqual(fs.readdirSync(path.join(root, 'attempt_a', 'continuation')), [])
})

test('sparse page changes across five backups retain both generations with a single verified delta base', (t) => {
  const { root, db } = fixture(t)
  const data = randomBytes(1024 * 1024)
  db.db.exec('CREATE TABLE fixture_bytes(n INTEGER PRIMARY KEY, payload BLOB)')
  const store = db.q('INSERT OR REPLACE INTO fixture_bytes VALUES(1,?)')
  const saved = []
  for (let i = 0; i < 5; i++) {
    data[1000 + i] ^= 0xff
    store.run(data)
    saved.push(backupWorkflow(db))
  }
  const latest = saved.at(-1),
    dir = path.join(root, 'recovery')
  assert.ok(latest.deltaGroups > 0)
  assert.ok(latest.storedBlockBytes < latest.fullRepresentationBytes)
  const { content } = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json')))
  for (const object of Object.values(content.objects))
    if (object.base) {
      assert.ok(content.objects[object.base])
      assert.equal(content.objects[object.base].base, undefined)
    }
  for (const gen of saved.slice(-2)) {
    const target = path.join(root, 'recover-' + gen.generation)
    restoreWorkflow(dir, target, gen.generation)
    assert.equal(sha256(fs.readFileSync(target)), gen.sha)
  }
})

test('one-tuple layouts reuse legacy SHA keys and detect corruption after a verified read', t => {
  const { db, root } = fixture(t)
  const data = Buffer.from('legacy chunk')
  const { chunk, layout } = db.transaction(() => {
    const chunk = db.chunk(data)
    const entries = Buffer.alloc(12)
    entries.writeInt32LE(chunk)
    entries.writeUInt32LE(data.length, 4)
    const layout = Number(db.q('INSERT INTO layouts(hash,entries) VALUES(?,?)')
      .run(Buffer.from(sha256(entries), 'hex'), entries).lastInsertRowid)
    db.q('INSERT INTO members VALUES(?,?)').run(layout, chunk)
    return { chunk, layout }
  })
  db.db.exec('DROP INDEX layouts_compact_legacy')
  const live = new WorkflowDatabase(root, 'fixture')
  try {
    live.put('old-layout', data)
    assert.equal(live.q('SELECT layout FROM spans WHERE doc=?').get(live.info('old-layout').doc).layout, layout)
    live.put('new-layout', 'another chunk')
    const key = live.q('SELECT hash,entries FROM layouts JOIN spans ON layout=layouts.id WHERE doc=?')
      .get(live.info('new-layout').doc)
    assert.deepEqual(key.hash, key.entries)
    assert.deepEqual(live.read('old-layout'), data)
    // Keep the stored size and digest. Both full and partial reads must check the actual bytes.
    live.q('UPDATE chunks SET data=? WHERE id=?').run(Buffer.alloc(data.length, 65), chunk)
    assert.throws(() => live.read('old-layout'), { code: 'WORKFLOW_STORAGE_CONTENT_CHANGED' })
    assert.throws(() => live.range(live.info('old-layout'), 1, 3), { code: 'WORKFLOW_STORAGE_CONTENT_CHANGED' })
    live.q('UPDATE chunks SET data=? WHERE id=?').run(data, chunk)
    assert.deepEqual(live.read('old-layout'), data)
    assert.deepEqual(live.q('PRAGMA foreign_key_check').all(), [])
  } finally { live.close() }
})

test('short request wrappers retain addressable messages, tools, system prompts and witnessed graphs', t => {
  const { db } = fixture(t)
  const message = { role: 'user', content: 'hi' }
  const tools = [{ name: 'local_tool' }]
  const system = 'guide'
  const graph = { revision: 1 }
  const request = JSON.stringify({ payload: { messages: [message], tools, system } })
  const witness = JSON.stringify({ committed: graph })
  db.put('direct/request-small.json', request)
  db.put('graph/witness', witness)
  assert.equal(db.read('direct/request-small.json').toString(), request)
  assert.equal(db.read('graph/witness').toString(), witness)
  for (const [kind, value] of Object.entries({ message, tools, system, graph })) {
    const bytes = Buffer.from(JSON.stringify(value))
    const row = db.q(`SELECT d.id AS doc, d.sha, d.size FROM versions v JOIN documents d ON d.id=v.doc
      WHERE v.kind=? AND d.sha=?`).get(kind, sha256(bytes))
    assert.ok(row, kind)
    assert.deepEqual(db.range(row), bytes)
  }
})
