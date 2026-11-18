import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DirectJournal } from '../durable-store.mjs'
import { searchEvidence } from '../evidence-search.mjs'

function journal(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-search-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const value = new DirectJournal(root, { taskId: 'task-a', attemptId: 'attempt-a' })
  value.append('PREPARING')
  return { root, value }
}
test('original archive search is literal, paginated and survives process reconstruction', t => {
  const { root, value } = journal(t)
  const text = 'prefix😀 ' + 'x'.repeat(10000) + ' UNIQUE[.*] ' + 'x'.repeat(10000) + ' UNIQUE[.*] tail'
  const a = value.archive([{ role: 'tool', tool_call_id: 'call-a', content: text },
    { role: 'assistant', content: 'done', reasoning_content: 'UNIQUE[.*] reason',
      tool_calls: [{ id: 'call-z', function: { name: 'read', arguments: '{"x":"UNIQUE[.*]"}' } }] }])
  const restored = DirectJournal.open(root, value.identity)
  restored.restoreArchives([...value.archives.values()])
  let cursor, found = []
  do {
    const page = restored.searchSources({ query: 'UNIQUE[.*]', limit: 1, ...(cursor ? { cursor } : {}) })
    found.push(...page.hits); cursor = page.nextCursor
  } while (cursor)
  assert.equal(found.length, 4)
  for (const hit of found) {
    assert.equal(hit.archive_id, a.id)
    const read = restored.readSource(hit.read.arguments)
    assert.equal(read.sourceSha256, hit.sourceSha256)
    assert.equal(read.archiveSha256, hit.archiveSha256)
    assert.ok(read.text.includes('UNIQUE[.*]'))
  }
  const first = restored.searchSources({ query: 'UNIQUE[.*]', limit: 1 })
  assert.throws(() => restored.searchSources({ query: 'different', cursor: first.nextCursor }), /EVIDENCE_SEARCH_ARGUMENT/)
  assert.throws(() => restored.searchSources({ query: 'x', path: '/etc/passwd' }), /EVIDENCE_SEARCH_ARGUMENT/)
  assert.throws(() => restored.searchSources({ query: 'x', cursor: { scope: first.nextCursor.scope, document: 100, offset: 0 } }), /EVIDENCE_SEARCH_ARGUMENT/)
  assert.equal(restored.searchSources({ query: 'absent' }).complete, true)
})
test('search cannot cross attempts or silently trust changed archive bytes', t => {
  const { root, value } = journal(t)
  const archive = value.archive([{ role: 'user', content: 'original evidence' }])
  fs.mkdirSync(path.join(root, 'other'))
  const foreign = new DirectJournal(path.join(root, 'other'), { taskId: 'task-b' })
  assert.equal(foreign.searchSources({ query: 'original' }).hits.length, 0)
  assert.throws(() => foreign.restoreArchives([...value.archives.values()]), /DIRECT_/)
  fs.appendFileSync(archive.ref, ' ')
  assert.throws(() => value.searchSources({ query: 'original' }), /DIRECT_ARCHIVE_HASH_OR_SCOPE_MISMATCH/)
})
test('malformed search requests return precisely located argument errors', () => {
  for (const args of [null, [], {}, { query: '' }, { query: 'a', limit: 0 }, { query: 'a', cursor: {} }])
    assert.throws(() => searchEvidence([], 'scope', args), /EVIDENCE_SEARCH_ARGUMENT/)
})
