import test from 'node:test'
import assert from 'node:assert/strict'
import { revisionChanges, validateModificationReport, scopedReviewInput, revisionEvidenceCatalog } from '../revision-report.mjs'
import { digest } from 'dsh-bettertaskgraphs/core'
const snapshot = () => ({ linked: true, revision: 3, checksum: 'base',
  taskGraph: { title: 'Task', nodes: [{ key: 'root', kind: 'container', label: 'Root' }, { key: 'a', kind: 'leaf', parent: 'root', label: 'A' }, { key: 'b', kind: 'leaf', parent: 'root', label: 'B' }], edges: [] },
  contextGraph: { nodes: [{ key: 'shared', content: 'Required source data', parents: [] }, { key: 'private', content: 'UNRELATED_CONTEXT_DATA', parents: [] }],
    bindings: [{ task: 'a', instruction: 'Check the source.', contexts: ['shared'], inheritReports: [], tools: [], completion: { kind: 'report' } },
      { task: 'b', instruction: 'Unrelated work.', contexts: ['private'], inheritReports: [], tools: [], completion: { kind: 'report' } }] }, invalidatedReports: [] })
const facts = [{ id: 'fact_0', text: JSON.stringify({ summary: 'Result exposes a missing target field.' }) }]
test('evidence navigation points inside parsed content, with escaped keys and literal text handled explicitly', () => {
  const catalog = revisionEvidenceCatalog([...facts, { id: 'escaped', text: JSON.stringify({ 'a/b': { '~key': 'original evidence' } }) }, { id: 'plain', text: 'Plain original source' }])
  assert.equal(catalog[0].fields[0].pointer, '/summary')
  assert.equal(catalog[1].fields[0].pointer, '/a~1b/~0key')
  assert.equal(catalog[2].fields[0].pointer, '')
})
test('pointer rejection identifies the wrong wrapper path and real children; coverage lists missing changes', () => {
  const s = snapshot(), p = proposal(s)
  p.modificationReport.changes[0].evidence[0].pointer = '/text'
  assert.throws(() => validateModificationReport(s, p, facts), error => error.code === 'REVISION_REPORT_EVIDENCE_POINTER_INVALID'
    && error.message.includes('"pointer":"/text"') && error.message.includes('"availableChildren":["summary"]'))
  p.modificationReport.changes = []
  assert.throws(() => validateModificationReport(s, p, facts), error => error.message.includes('/contextGraph/bindings/a/instruction') && error.message.includes('missing'))
})
function proposal(s) {
  const p = { disposition: 'REVISE', taskGraph: structuredClone(s.taskGraph), contextGraph: structuredClone(s.contextGraph), evidenceIds: ['fact_0'], invalidateReports: [], coverage: [], retirements: [],
    modificationReport: { summary: 'Clarify the check.', changes: [{ path: '/contextGraph/bindings/a/instruction', why: 'The reported target needs explicit verification.', evidence: [{ factId: 'fact_0', pointer: '/summary', quote: 'missing target field' }] }] } }
  p.contextGraph.bindings[0].instruction = 'Check the missing target field.'
  return p
}
test('retained and reordered context nodes produce no fake changes; report coverage matches the effective diff', () => {
  const s = snapshot(), p = proposal(s)
  p.contextGraph.nodes = [...s.contextGraph.nodes].reverse().map(node => ({ key: node.key, retain: true, sha256: digest(node) }))
  assert.deepEqual(revisionChanges(s, p).map(row => row.path), ['/contextGraph/bindings/a/instruction'])
  assert.equal(validateModificationReport(s, p, facts).evidence[0].sourceValue, 'Result exposes a missing target field.')
})
for (const fault of ['omission', 'extra', 'duplicate', 'forged-quote', 'unknown-source', 'bad-pointer', 'hidden-order']) test('program rejects modification report ' + fault, () => {
  const s = snapshot(), p = proposal(s), change = p.modificationReport.changes[0]
  if (fault === 'omission') p.contextGraph.bindings[1].instruction = 'Undocumented extra change'
  if (fault === 'extra') p.modificationReport.changes.push({ ...change, path: '/taskGraph/title' })
  if (fault === 'duplicate') p.modificationReport.changes.push(structuredClone(change))
  if (fault === 'forged-quote') change.evidence[0].quote = 'A fabricated statement'
  if (fault === 'unknown-source') change.evidence[0].factId = 'other'
  if (fault === 'bad-pointer') change.evidence[0].pointer = '/does-not-exist'
  if (fault === 'hidden-order') p.taskGraph.nodes.reverse()
  assert.throws(() => validateModificationReport(s, p, facts))
})
test('audit includes affected closure and exact source field, excluding unrelated graph and unreferenced facts', () => {
  const s = snapshot(), p = proposal(s), validated = validateModificationReport(s, p, facts)
  const input = scopedReviewInput({ contract: { objective: 'Fixed' }, snapshot: s, proposal: p, validated, programValidation: { passed: true } })
  assert.equal(input.affectedContexts.length, 1)
  assert.equal(input.affectedContexts[0].task, 'a')
  assert.equal(input.evidence[0].sourceSha256, digest('Result exposes a missing target field.'))
  assert.doesNotMatch(JSON.stringify(input), /UNRELATED_CONTEXT_DATA|Unrelated work/)
  assert.ok(!input.snapshot && !input.proposal && !input.facts)
})
test('audit retains fixed runtime semantics and only task states implicated by the actual changes', () => {
  const s = snapshot(), p = proposal(s)
  s.supervisionReview = { runtimeSemantics: { relations: { inheritReports: 'Only COMPLETE valid reports can be inherited.' } } }
  s.taskStates = { a: { status: 'PENDING' }, b: { status: 'UNRELATED_PRIVATE_STATE' } }
  s.executionReports = [{ task: 'a', outcome: 'BLOCKED', reportValid: true }, { task: 'b', outcome: 'COMPLETE', reportValid: true }]
  const input = scopedReviewInput({ contract: {}, snapshot: s, proposal: p, validated: validateModificationReport(s, p, facts), programValidation: {} })
  assert.deepEqual(input.runtimeSemantics, s.supervisionReview.runtimeSemantics)
  assert.deepEqual(Object.keys(input.programValidation.affectedTaskStates), ['a'])
  assert.deepEqual(input.programValidation.acceptedDispositions.map(r => r.task), ['a'])
  assert.doesNotMatch(JSON.stringify(input), /UNRELATED_PRIVATE_STATE/)
})
test('large context nodes shared by a diff and its before/after closure are losslessly deduplicated', () => {
  const s = snapshot(); s.contextGraph.nodes[0].content = 'Unique reference body. '.repeat(400)
  const p = proposal(s); p.contextGraph.bindings[0].instruction = s.contextGraph.bindings[0].instruction
  p.contextGraph.nodes[0].content += ' Current source is v2; verification remains required.'
  p.modificationReport.changes[0].path = '/contextGraph/nodes/shared'
  const validated = validateModificationReport(s, p, facts), original = structuredClone(validated)
  const result = scopedReviewInput({ contract: {}, snapshot: s, proposal: p, validated, programValidation: {} })
  assert.deepEqual(validated, original, 'The retained actual diff is never rewritten')
  assert.equal(result.contextCatalog.length, 2)
  const catalog = new Map(result.contextCatalog.map(item => [item.id, item.node]))
  for (const phase of ['before', 'after']) {
    const ref = result.changes[0][phase]
    assert.equal(ref.sha256, digest(catalog.get(ref.contextRef)))
    assert.deepEqual(catalog.get(ref.contextRef), original.changes[0][phase])
    assert.deepEqual(catalog.get(result.affectedContexts[0][phase].contexts[0].contextRef), original.changes[0][phase])
  }
  assert.doesNotMatch(JSON.stringify(result), /UNRELATED_CONTEXT_DATA/)
  assert.ok(JSON.stringify(result).length < JSON.stringify({ changes: validated.changes, affectedContexts: [{ before: { contexts: [validated.changes[0].before] }, after: { contexts: [validated.changes[0].after] } }] }).length)
})
test('no-change decisions require an empty modification list', () => {
  const s = snapshot(), p = proposal(s); p.disposition = 'NO_CHANGE'
  assert.throws(() => validateModificationReport(s, p, facts))
  p.modificationReport.changes = []
  assert.deepEqual(validateModificationReport(s, p, facts).changes, [])
})
