// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { digest } from 'dsh-better-task-grapth/core'
import { createRoleContext } from '../role-context.mjs'
import { roleEvidenceCandidate, chooseRoleEvidence, auditReportInput, INDEX_READER } from '../role-input-index.mjs'
import { blockageTools } from '../blockage-evidence.mjs'
import { validateReview } from '../review-feedback.mjs'

const text = '证据字段/section~with evidence. '.repeat(2000)
const compactBytes = value => Buffer.byteLength(JSON.stringify(value))
const source = (item, i = 0) => ({ source: 'report:attempt_' + i, sha256: digest(item), hashFormat: 'canonical-json-object', value: item })
const record = (i = 0, body = text) => ({ taskId: 'task_' + i, attemptId: 'attempt_' + i,
  result: { outcome: 'SUCCEEDED', executionReport: { verification: [{ id: 'criterion', quote: body }], limitations: ['caveat'] } } })
const inputRows = (n, body) => Array.from({ length: n }, (_, i) => source(record(i, body), i))
const expected = (root, pointer) => pointer.split('/').slice(1).reduce((row, key) => row[key.replaceAll('~1', '/').replaceAll('~0', '~')], root)
const tmp = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'role-evidence-index-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
function makeContext(directory, role, data, { window = 262144, saved, catalog, toolPolicy, measure = async p => compactBytes(p) } = {}) {
  let decision = saved
  const original = JSON.stringify(data)
  const ctx = createRoleContext({ config: { model: 'fake', dynamicContextMaxBytes: 8388608, direct: { api: 'openai', contextWindow: window }, maxOutputTokens: 4096 },
    messages: [{ role: 'system', content: 'Role instruction unchanged.' }, { role: 'user', content: original }],
    directory, signal: new AbortController().signal, role, toolPolicy,
    ...(catalog ? { readOnlyTools: blockageTools(catalog, path.join(directory, 'workflow')) } : {}),
    inputIndex: { saved, save: value => { decision = value } }, measureTokens: measure })
  return { ctx, decision: () => decision }
}
async function get(ctx, args, id = 'read-1') {
  await ctx.continueRead({ finish: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [
    { id, type: 'function', function: { name: INDEX_READER, arguments: JSON.stringify(args) } }] } })
  return JSON.parse((await ctx.prepare()).messages.at(-1).content)
}

test('small, moderate and collectively large reports use the remaining role window', async t => {
  const reports = [{ task: 'one', summary: 'a'.repeat(24576) }]
  const data = { contract: { requirement: 'exact' }, snapshot: { executionReports: reports } }
  const small = makeContext(tmp(t), 'plan_check', data)
  const payload = await small.ctx.prepare()
  assert.equal(payload.messages[1].content, JSON.stringify(data))
  assert.equal(small.decision().mode, 'inline')
  assert.ok(!payload.tools?.some(row => row.function.name === INDEX_READER))
  await assert.rejects(get(small.ctx, { source: 'invented' }), { code: 'REVISION_ROLE_TOOLS_FORBIDDEN' })
  const medium = Array.from({ length: 12 }, (_, i) => ({ task: 't' + i, summary: 'm'.repeat(8192) }))
  const many = { ...data, snapshot: { executionReports: medium } }
  for (const [window, mode] of [[262144, 'index'], [1048576, 'inline']]) {
    const h = makeContext(tmp(t), 'plan_check', many, { window })
    const view = JSON.parse((await h.ctx.prepare()).messages[1].content)
    assert.equal(h.decision().mode, mode)
    if (mode === 'index') assert.equal(view.snapshot.executionReports[3]._reportIndex.location, '/snapshot/executionReports/3')
    else assert.deepEqual(view, many)
  }
  const crowded = makeContext(tmp(t), 'plan_check', { ...data, contract: { requirement: 'x'.repeat(155000) } })
  const view = JSON.parse((await crowded.ctx.prepare()).messages[1].content)
  assert.equal(crowded.decision().mode, 'index')
  assert.equal(view.contract.requirement.length, 155000)
  assert.equal(view.snapshot.executionReports[0].task, 'one')
})

test('many individually tiny flat reports can be read by their original array index', async t => {
  const rows = Array.from({ length: 900 }, (_, i) => ({ task: 't' + i, summary: 'tiny'.repeat(24) }))
  const h = makeContext(tmp(t), 'plan_check', { snapshot: { executionReports: rows } })
  const view = JSON.parse((await h.ctx.prepare()).messages[1].content)
  const field = view.snapshot.executionReports
  assert.equal(h.decision().mode, 'index')
  assert.deepEqual(field.tasks, rows.map(row => row.task))
  const page = await get(h.ctx, { source: field._reportIndex.source, path: '/899/summary' })
  assert.equal(page.text, rows[899].summary)
  assert.equal(page.sourceSha256, digest(rows))
})

test('the admission boundary uses the complete pair of measured requests and keeps equal thresholds inline', async () => {
  const options = { full: { n: 36000 }, indexed: { n: 20000 }, measure: async p => p.n, threshold: 100000 }
  assert.equal((await chooseRoleEvidence(options)).mode, 'inline')
  assert.equal((await chooseRoleEvidence({ ...options, full: { n: 36001 } })).mode, 'index')
  assert.equal((await chooseRoleEvidence({ ...options, full: { n: 19000 } })).mode, 'inline')
  const bounded = await chooseRoleEvidence({ ...options, fullBytes: 10001, indexedBytes: 7000, maxRequestBytes: 10000 })
  assert.equal(bounded.mode, 'index'); assert.equal(bounded.basis, 'request-byte-limit')
  for (const [dynamicMaterialBytes, expected] of [[10000, 'inline'], [9999, 'index']]) {
    assert.equal((await chooseRoleEvidence({ threshold: null, fullBytes: 11000, indexedBytes: 1000,
      dynamicMaterialBytes, measure: () => assert.fail() })).mode, expected)
  }
  for (const extra of [65536, 65537]) assert.equal((await chooseRoleEvidence({ threshold: null,
    fullBytes: 1000 + extra, indexedBytes: 1000, measure: () => assert.fail() })).mode, extra > 65536 ? 'index' : 'inline')
})

for (const [role, data, field] of [
  ['result_check', { acceptanceContext: { startContext: { inheritedReports: [record()] }, submissionContext: { inheritedReports: [record()] } } }, '/acceptanceContext/startContext/inheritedReports/0'],
  ['plan_check', { latest: { result: record() } }, '/latest/result'],
  ['updater', { facts: [{ id: 'planning', text }, { id: 'f', text: JSON.stringify(record()) }], priorReview: { proposalText: JSON.stringify(record(1)) } }, '/facts/1/text'],
  ['reviewer', { changes: [{ path: '/taskGraph/nodes/leaf', before: record(), after: { id: 'new' } }], modificationReport: { changes: [{ path: '/taskGraph/nodes/leaf', why: text }] } }, '/changes/0/before'],
  ['scope_audit', { changes: [{ path: '/nodes/leaf', before: record() }], modificationReport: [{ path: '/nodes/leaf', reason: text, evidence: [{ quote: 'cited' }] }] }, '/changes/0/before'],
  ['scope_pause', { submission: { constraints: [{ description: 'blocked', affectedTasks: ['A'] }] }, evidence: [{ source: 'report:A', quote: 'cited', value: record() }] }, '/evidence/0/value'],
  ['blockage_audit', { evidence: [{ source: 'report:A', quote: 'cited', value: record() }] }, '/evidence/0/value'],
]) test(role + ' scopes its file-free reader to material already in the invocation', async t => {
  const fixed = { contract: { objective: '保持合同' }, currentSharedFacts: [{ content: 'live truth' }], blueprint: { instruction: 'keep this prompt' } }
  const original = { ...data, ...fixed }, initialHash = digest(original)
  const h = makeContext(tmp(t), role, original)
  const wire = await h.ctx.prepare(), view = JSON.parse(wire.messages[1].content), entry = expected(view,field)._reportIndex
  assert.equal(h.decision().mode, 'index')
  assert.deepEqual(wire.tools.map(row => row.function.name), [INDEX_READER])
  for (const key of Object.keys(fixed)) assert.deepEqual(view[key], fixed[key])
  assert.equal(entry.location, field)
  assert.equal(entry.sha256, digest(expected(original,field)))
  const page = await get(h.ctx, { source: entry.source, path: '/result/executionReport/verification/0/quote', start: 21, end: 49 })
  assert.equal(page.text, text.slice(21,49)); assert.equal(page.next, 49); assert.equal(page.sourceSha256, entry.sha256)
  const other = await get(h.ctx, { source: 'report:other-workflow' }, 'unavailable')
  assert.equal(other.error, 'BLOCKAGE_SOURCE_SCOPE_MISMATCH')
  assert.equal(digest(original), initialHash)
  if (role === 'updater') assert.equal(view.facts[0].text, text)
  if (role === 'result_check') assert.equal(entry.source, view.acceptanceContext.submissionContext.inheritedReports[0]._reportIndex.source)
  if (role === 'reviewer') assert.equal(validateReview(role, { verdict:'REJECT', reason:'issue', violations:['issue'],
    issues:[{item:'leaf',path:field+'/result/outcome',reason:'actual source'}] },original).verdict,'REJECT')
})

for (const role of ['group_audit', 'scope_plan', 'scope_update']) test(role + ' preserves the frozen workflow source, its SHA and scope', async t => {
  const reports = inputRows(3), publicEvidence = reports.map(row => ({ source: row.source, verification: row.value.result.executionReport.verification }))
  const data = { reports, publicEvidence, scopeId: 'group', currentSharedFacts: ['fact'] }
  const catalog = new Map(reports.map(row => [row.source, { kind: 'report', load: () => row.value }]))
  const h = makeContext(tmp(t), role, data, { catalog })
  const wire = await h.ctx.prepare(), view = JSON.parse(wire.messages[1].content)
  assert.equal(h.decision().mode, 'index')
  assert.equal(view.reports[0].source, reports[0].source)
  assert.equal(view.publicEvidence[0].paths.verification, '/result/executionReport/verification')
  const page = await get(h.ctx, { source: view.reports[0].source, path: '/result/executionReport/verification/0/id' })
  assert.equal(page.sourceSha256, reports[0].sha256); assert.equal(page.text,'criterion')
  assert.equal(data.reports[0].value.taskId,'task_0')
})

test('excluded roles, inaccessible readers, escaped pointers and replay use the original input scope', async t => {
  const data = { snapshot: { executionReports: [{ task: 't', 'a/b~c': '😀'.repeat(18000) }] } }
  for (const role of ['result_repair','executor','task_reporter']) assert.equal(roleEvidenceCandidate(role,data),null)
  const dir = tmp(t), first = makeContext(dir, 'plan_check', data)
  const wire = await first.ctx.prepare(), saved = first.decision()
  const source = JSON.parse(wire.messages[1].content).snapshot.executionReports[0]._reportIndex.source
  const a = await get(first.ctx, { source, path:'/a~1b~0c', start:0, end:10 })
  assert.equal(a.text,'😀'.repeat(5))
  const replay = makeContext(dir,'plan_check',data,{ saved, window:1048576, measure:()=>assert.fail('do not recompute a frozen decision') })
  assert.deepEqual(await replay.ctx.prepare(),wire)
  assert.deepEqual(await get(replay.ctx,{source,path:'/a~1b~0c',start:0,end:10}),a)
  for (const other of [{...saved, mode:'inline'}, saved]) {
    const h=makeContext(dir,'plan_check',other===saved?{...data,changed:true}:data,{saved:other})
    await assert.rejects(h.ctx.prepare(),{code:'REVISION_ROLE_INDEX_CHANGED'})
  }
  const policy={tools:(_role,surface)=>({...surface, tools:[]}),extensions:()=>[]}
  const denied=makeContext(tmp(t),'plan_check',data,{toolPolicy:policy})
  const inline=await denied.ctx.prepare()
  assert.equal(denied.decision().basis,'reader-unavailable');assert.equal(inline.messages[1].content,JSON.stringify(data))
  assert.deepEqual(auditReportInput({reports:inputRows(1,'short')}).reports[0].value,record(0,'short'))
  assert.ok(auditReportInput({reports:inputRows(1)}).reports[0].sections)
})

test('scoped updater can dereference a child report and its own prior audit feedback in the same turn', async t => {
  const reports=inputRows(2), originalFeedback=JSON.stringify({ review: { rejectedPath:'/nodes/revise', quote:text } })
  const data={ reports, priorReview:originalFeedback }
  const catalog=new Map(reports.map(row=>[row.source,{kind:'report',load:()=>row.value}]))
  const h=makeContext(tmp(t),'scope_update',data,{catalog})
  const wire=await h.ctx.prepare(), view=JSON.parse(wire.messages[1].content)
  assert.equal(wire.tools.filter(t=>t.function.name===INDEX_READER).length,1)
  const old=await get(h.ctx,{source:view.reports[0].source,path:'/result/outcome'})
  assert.equal(old.text,'SUCCEEDED')
  const feedback=await get(h.ctx,{source:view.priorReview._reportIndex.source,path:'/review/rejectedPath'},'feedback')
  assert.equal(feedback.text,'/nodes/revise'); assert.equal(feedback.sourceSha256,digest(originalFeedback))
})

test('the old group projection still returns its small reports inline and ignores new window settings', () => {
  const medium = { reports:inputRows(1,'x'.repeat(24000)) }
  assert.ok(auditReportInput(medium).reports[0].sections)
  const local = roleEvidenceCandidate('group_audit',medium,{workflowReports:true})
  assert.ok(local.view.reports[0].sections)
  assert.deepEqual(medium.reports[0].value,record(0,'x'.repeat(24000)))
})

test('a wide group of tiny receipts pages its directory and preserves independently citable child hashes', async t => {
  const reports=Array.from({length:900},(_,i)=>source({taskId:'task_'+i,result:{outcome:'SUCCEEDED',summary:'ok'}},i))
  const data={reports,publicEvidence:reports.map(row=>({source:row.source,deliveries:[]})),scopeId:'wide'}
  const catalog=new Map(reports.map(row=>[row.source,{kind:'report',load:()=>row.value}]))
  const h=makeContext(tmp(t),'group_audit',data,{catalog})
  const wire=await h.ctx.prepare(), view=JSON.parse(wire.messages[1].content)
  assert.equal(h.decision().mode,'index')
  assert.equal(view.reports.tasks.at(-1),'task_899')
  const directory=await get(h.ctx,{source:view.reports._reportIndex.source,path:'/899/source'})
  assert.equal(directory.text,reports.at(-1).source)
  const child=await get(h.ctx,{source:directory.text,path:'/result/summary'},'child')
  assert.equal(child.text,'ok'); assert.equal(child.sourceSha256,reports.at(-1).sha256)
  assert.notEqual(child.sourceSha256,directory.sourceSha256)
})
