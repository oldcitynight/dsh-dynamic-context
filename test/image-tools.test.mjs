// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { crc32, deflateSync } from 'node:zlib'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { symbols } from '@deepseek-ai/cordis'
import { createRuntimeHarness, runtimeProposal } from '../testing/runtime-harness.mjs'
import { startFakeMessages } from '../testing/fake-messages.mjs'
import { directRevisionRole, readRoleRecord } from '../revision-runtime.mjs'
import { ROLE_CONTRACTS, RoleToolRegistry } from '../role-policy.mjs'
import { workspaceAuditTools } from '../workspace-audit.mjs'
import { PLANNING_EXPLORATION, LEAF_AUTONOMY, WORKSPACE_AUDIT_INSTRUCTION, GROUP_OUTCOME_AUDIT, GRAPH_OUTCOME_AUDIT } from '../work-quality.mjs'
import { prepareDirectRequest, serializeDirectRequest } from '../direct-wire.mjs'
import { finishImageInspection, roleImageResult, imageWireByteBound } from '../image-content.mjs'
import { rolePressureTokens } from '../role-context.mjs'
import { validateConfig } from '../index.mjs'
const chunk = (name, data) => { const body=Buffer.concat([Buffer.from(name),data]),head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(data.length);tail.writeUInt32BE(crc32(body));return Buffer.concat([head,body,tail]) }
const header=Buffer.alloc(13);header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=6
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,40,120,200,255]))),chunk('IEND',Buffer.alloc(0))])
const signal = () => new AbortController().signal
const imageResults = payload => payload.messages.flatMap(m=>m.content).filter(b=>b.type==='tool_result').flatMap(b=>b.content).filter(b=>b.type==='image')
async function fixture(t, respond, vision = true, extra = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-images-'))), projectRoot = path.join(root,'project')
  fs.mkdirSync(projectRoot); fs.writeFileSync(path.join(projectRoot,'screen.png'),png)
  const backend = await startFakeMessages({ respond })
  const h = await createRuntimeHarness({ projectRoot, directory:path.join(root,'state'), backend, imageInput:vision,
    config: { storageRoot:root, maxRequestsPerTask:8, ...extra, direct:{ api:'deepseek', protocol:'messages', endpoint:backend.origin+'/v1/messages', reasoningEffort:'high', durable:true,
      runtime:{modules:['filesystem','state']}, ...extra.direct } },
    setup:ctx=>ctx.plugin(LocalAttachmentStore,{ dshHome:path.join(root,'home') }) })
  t.after(async()=>{ await h.close(); await backend.close(); fs.rmSync(root,{recursive:true,force:true}) })
  return { ...h,root,projectRoot,backend }
}
test('every declared role receives read_image; compaction receives no business execution tool', () => {
  const registry = new RoleToolRegistry()
  for(const role of Object.keys(ROLE_CONTRACTS)) assert.deepEqual(registry.select(role,['read_image']).allowed,['read_image'])
  assert.deepEqual(registry.select('compaction',['read_image','bash','write','dynamic_context_generate_report']).allowed,['read_image'])
})
test('native worker reads a real raster and the next Messages request contains pixels, not identity text alone', async t => {
  const h=await fixture(t,({payload,index})=>{
    assert.ok(payload.tools.some(x=>x.name==='read_image'))
    if(index===1)return {tools:[{name:'read_image',arguments:{file_path:'screen.png'}}]}
    const images=imageResults(payload);assert.equal(images.length,1,JSON.stringify(payload.messages.at(-1)).slice(0,1500));assert.equal(images[0].source.type,'base64')
    assert.equal(images[0].source.media_type,'image/png');assert.ok(Buffer.from(images[0].source.data,'base64').length>40)
    return {text:'Image inspected via the fixture transport; semantic recognition NOT_TESTED.'}
  })
  assert.ok(!h.runner.config.allowedTools.includes('read_image'))
  assert.throws(() => h.runner.submit(runtimeProposal(['read_image', 'fixture_forbidden'])),
    error => error.code === 'CONTEXT_CANNOT_GRANT_TOOL_PERMISSION' && error.details.unauthorized.join(',') === 'fixture_forbidden')
  h.runner.submit(runtimeProposal(['read_image']));await h.runner.runNext({expectedRevision:1})
  assert.equal(h.backend.requests.length,2);assert.deepEqual(h.backend.errors,[])
  assert.deepEqual(fs.readFileSync(path.join(h.projectRoot,'screen.png')),png)
})
test('a binding cannot enable read_image without native filesystem tools', async t => {
  const h = await fixture(t, () => assert.fail('No model request should be sent'), true, { direct: { runtime: { modules: ['state'] } } })
  assert.throws(() => h.runner.submit(runtimeProposal(['read_image'])),
    error => error.code === 'CONTEXT_CANNOT_GRANT_TOOL_PERMISSION' && error.details.unauthorized.includes('read_image'))
})
test('all isolated decision/report/guidance roles actually execute the image tool and send the image', async t => {
  const h=await fixture(t,({payload})=> { const prior=payload.messages.flatMap(m=>m.content).find(b=>b.type==='tool_result'); if(prior){ assert.equal(imageResults(payload).length,1,JSON.stringify(prior).slice(0,1500)); return {text:'{"observed":true}'} } return {tools:[{name:'read_image',arguments:{file_path:'screen.png'}}]} })
  const roles=Object.keys(ROLE_CONTRACTS).filter(r=>!['controller','preplanning','executor','result_work','compaction'].includes(r))
  for(const role of roles){
    const runId='revision_'+role+'_'+randomUUID()
    assert.deepEqual(await directRevisionRole(h.runner,{runId,role,messages:[{role:'system',content:'Inspect only image evidence and return JSON.'},{role:'user',content:'{"image":"screen.png"}'}],signal:signal()}),{observed:true})
    const record=readRoleRecord(h.runner,runId);assert.equal(record.imageTools,true)
    assert.ok(record.calls[0].payload.tools.some(t=>t.name==='read_image'))
    assert.equal(imageResults(record.calls[1].payload).length,1)
  }
  assert.equal(h.backend.requests.length,roles.length*2);assert.deepEqual(h.backend.errors,[])
})
test('a background role can still consume a v1 extension evidence reference', async t => {
  const name = 'fixture_legacy_image', entry = '256b7b12-bdd1-4d43-aa6d-64050764c087'
  const file_path = '@audit/' + entry + '/sample.png'
  const h = await fixture(t, ({ index, payload }) => {
    if (index === 1) {
      assert.ok(payload.tools.some(tool => tool.name === name))
      return { tools: [{ name, arguments: {} }] }
    }
    if (index === 2) {
      assert.match(JSON.stringify(payload.messages.at(-1)), /@audit/)
      return { tools: [{ name: 'read_image', arguments: { file_path } }] }
    }
    assert.equal(imageResults(payload).length, 1)
    return { text: '{"observed":true}' }
  })
  h.ctx.get('dynamicContextRoleTools').registerTool({ pluginId: 'fixture', registrationId: 'audit-image', toolId: name,
    roles: ['group_audit'], effect: 'read', workspaceRoot: h.projectRoot, auditArtifacts: true,
    schema: { type: 'function', function: { name, description: 'Create an image in this audit’s evidence area.', parameters: { type: 'object', properties: {} } } },
    authorize: ({ auditArtifacts }) => Boolean(auditArtifacts),
    execute(_args, { auditArtifacts }) {
      const directory = path.join(auditArtifacts.directory, entry)
      fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'sample.png'), png)
      return { file_path }
    } })
  const runId = 'revision_group_audit_' + randomUUID()
  assert.deepEqual(await directRevisionRole(h.runner, { runId, role: 'group_audit', signal: signal(),
    messages: [{ role: 'system', content: 'Inspect visual evidence.' }, { role: 'user', content: '{}' }] }), { observed: true })
  assert.equal(readRoleRecord(h.runner, runId).auditArtifacts, true)
  assert.deepEqual(h.backend.errors, [])
})
test('a non-media extension returns a role-owned reference to an extensionless design preview', async t => {
  let issued
  const name = 'fixture_design_preview'
  const h = await fixture(t, ({ index, payload }) => {
    if (index === 1) {
      assert.doesNotMatch(JSON.stringify(payload), /media_audit_frame_sheet|frame-sheet tool|完整可玩性/)
      return { tools: [{ name, arguments: {} }] }
    }
    if (index === 2) return { tools: [{ name: 'read_image', arguments: { file_path: issued } }] }
    assert.equal(imageResults(payload).length, 1)
    return { text: '{"observed":true}' }
  })
  h.ctx.get('dynamicContextRoleTools').registerTool({ pluginId: 'fixture', registrationId: 'design-preview', toolId: name,
    roles: ['group_audit'], effect: 'read', workspaceRoot: h.projectRoot, auditArtifacts: true,
    schema: { type: 'function', function: { name, description: 'Inspect the design preview.', parameters: { type: 'object', properties: {} } } },
    authorize: ({ auditArtifacts }) => Boolean(auditArtifacts),
    execute(_args, { auditArtifacts }) {
      const folder = path.join(auditArtifacts.outputDirectory, 'panels')
      fs.mkdirSync(folder, { recursive: true })
      fs.writeFileSync(path.join(folder, '组件预览'), png)
      issued = auditArtifacts.publish('panels', ['组件预览']) + '组件预览'
      return { file_path: issued }
    } })
  const runId = 'revision_group_audit_' + randomUUID()
  assert.deepEqual(await directRevisionRole(h.runner, { runId, role: 'group_audit', signal: signal(),
    messages: [{ role: 'system', content: 'Inspect the design.' }, { role: 'user', content: '{}' }] }), { observed: true })
  assert.deepEqual(h.backend.errors, [])
})

test('issued evidence is restricted to the originating audit, named files and original bytes', async t => {
  const h = await fixture(t, () => assert.fail('This check only reads local attachments.'))
  function reader(dir, ctx = h.ctx) {
    const tools = workspaceAuditTools({ ...h.runner, ctx }, path.join(h.runner.config.directory, dir), new Map(), signal(), { images: true })
    t.after(() => tools.close())
    return tools
  }
  const first = reader('audit-A'), other = reader('audit-B')
  const open = (tools, file_path) => tools.execute({ id: randomUUID(), function: { name: 'read_image', arguments: JSON.stringify({ file_path }) } })
  const dir = path.join(first.auditArtifacts.outputDirectory, 'review')
  fs.mkdirSync(dir, { recursive: true })
  for (const file of ['preview.png', 'unlisted.png']) fs.writeFileSync(path.join(dir, file), png)
  const prefix = first.auditArtifacts.publish('review', ['preview.png'])
  assert.ok((await open(first, prefix + 'preview.png')).value.image)
  const native = await open(first, 'screen.png')
  assert.ok(native.value.image)
  assert.match(native.value.display, /image\/png image, 1x1 px/)
  assert.doesNotMatch([PLANNING_EXPLORATION, LEAF_AUTONOMY, WORKSPACE_AUDIT_INSTRUCTION, GROUP_OUTCOME_AUDIT, GRAPH_OUTCOME_AUDIT,
    ...first.tools.map(tool => tool.function.description)].join('\n'), /Time Bomb|完整可玩性|帧表|frame[- ]sheet|out\/clip\.mp4|media_audit_/i)
  const relativeDirectory = path.join('@evidence', 'workspace-folder')
  fs.mkdirSync(path.join(h.projectRoot, relativeDirectory), { recursive: true })
  fs.writeFileSync(path.join(h.projectRoot, relativeDirectory, 'plan.png'), png)
  const workspaceImage = './' + relativeDirectory + '/plan.png'
  const ordinary = await open(first, workspaceImage)
  assert.equal(ordinary.value.path, workspaceImage)
  const legacyDir = path.join(first.auditArtifacts.directory, randomUUID())
  fs.mkdirSync(legacyDir, { recursive: true }); fs.writeFileSync(path.join(legacyDir, 'plan.png'), png)
  assert.ok((await open(first, '@audit/' + path.basename(legacyDir) + '/plan.png')).value.image)
  first.checkCurrent({ action: 'COMPLETE' })
  for (const name of ['unlisted.png', '../preview.png', '__proto__'])
    assert.equal((await open(first, prefix + name)).error, 'AUDIT_EVIDENCE_NOT_ISSUED')
  assert.equal((await open(other, prefix + 'preview.png')).error, 'AUDIT_EVIDENCE_NOT_ISSUED')
  fs.symlinkSync(path.join(dir,'preview.png'), path.join(dir,'link.png'))
  assert.throws(() => first.auditArtifacts.publish('review',['link.png']))
  fs.linkSync(path.join(dir,'unlisted.png'), path.join(dir,'hard.png'))
  assert.throws(() => first.auditArtifacts.publish('review',['hard.png']))
  fs.writeFileSync(path.join(dir, 'preview.png'), Buffer.concat([png, Buffer.of(1)]))
  assert.equal((await open(first, prefix + 'preview.png')).error, 'AUDIT_EVIDENCE_CHANGED')
  assert.throws(() => first.checkCurrent({ action: 'COMPLETE' }), /WORKSPACE_OBSERVATION_STALE/)
  const service = { imageLimits: { mediaTypes: ['image/jpeg'] }, saveImage: () => assert.fail('Native gate should run before storage') }
  const restricted = reader('audit-C', { get: key => key === 'attachments' ? service : h.ctx.get(key) })
  const refusal = await open(restricted, 'screen.png')
  assert.match(JSON.stringify(refusal.diagnostic), /not accepted by this deployment/)
  assert.equal((await open(first, 'missing.png')).error, 'FS_NOT_FOUND')
  const limits = { imageLimits: { mediaTypes: ['image/png'], maxImageBytes: 20, maxMessageImageBytes: 16 },
    saveImage: () => assert.fail('Oversized data must not enter storage') }
  const bounded = reader('audit-D', { get: key => key === 'attachments' ? limits : h.ctx.get(key) })
  const oversized = await open(bounded, 'screen.png')
  assert.equal(oversized.error, 'FS_TOO_LARGE')
  assert.match(JSON.stringify(oversized.diagnostic), /16 bytes/)
})
test('image failures are located tool observations; no identity-only success for text-only routes', async t=>{
  const h=await fixture(t,({payload,index})=>{
    if(index===1)return {tools:[{name:'read_image',arguments:{file_path:'screen.png'}}]}
    const result=payload.messages.flatMap(m=>m.content).find(b=>b.type==='tool_result')
    assert.equal(result.is_error,true);assert.match(JSON.stringify(result),/does not declare image input/)
    assert.equal(imageResults(payload).length,0);return {text:'Image unavailable; visual acceptance remains unverified.'}
  },false)
  h.runner.submit(runtimeProposal([]));await h.runner.runNext({expectedRevision:1})
  assert.equal(h.backend.requests.length,2)
})
for (const role of ['executor', 'group_audit']) for (const failures of [3, 4]) test(`${role} retries the saved attachment and reports exhaustion (${failures})`, async t => {
  const h = await fixture(t, ({ index, payload }) => {
    if (index === 1) return { tools: [{ name: 'read_image', id: 'retry-image', arguments: { file_path: 'screen.png' } }] }
    const result = payload.messages.flatMap(row => row.content).find(row => row.tool_use_id === 'retry-image')
    assert.ok(result)
    if (failures === 3) assert.equal(result.content.filter(row => row.type === 'image').length, 1)
    else {
      assert.equal(result.is_error, true)
      const [failure] = result.content.map(row => JSON.parse(row.text))
      assert.equal(failure.error, 'ATTACHMENT_NOT_FOUND')
      assert.equal(failure.attempts, 4); assert.equal(failure.retries, 3)
      assert.match(failure.diagnostic.reason, /image was not inspected/)
    }
    return { text: role === 'executor' ? 'Read-image result was received.' : '{"evidenceReceived":true}' }
  })
  const service = h.ctx.get('attachments'), attachments = service[symbols.original] ?? service
  const original = attachments.readImageRequest.bind(attachments)
  let reads = 0
  attachments.readImageRequest = (...args) => ++reads <= failures
    ? Promise.reject(Object.assign(new Error('The stored fixture attachment is temporarily unavailable'), { code: 'ATTACHMENT_NOT_FOUND' }))
    : original(...args)
  if (role === 'executor') {
    h.runner.submit(runtimeProposal([]))
    await h.runner.runNext({ expectedRevision: 1 })
  } else {
    const runId = 'revision_group_audit_' + randomUUID()
    const run = () => directRevisionRole(h.runner, { role, runId, signal: signal(),
      messages: [{ role: 'system', content: 'Audit the fixture.' }, { role: 'user', content: '{}' }] })
    if (failures === 4) {
      h.runner.toolErrorPolicy.register({ pluginId: 'fixture', ruleId: 'stop-on-missing-image', role, toolId: 'read_image',
        errorCode: 'ATTACHMENT_NOT_FOUND', reason: 'Check the attachment store.' })
      await assert.rejects(run(), { code: 'DIRECT_TOOL_ERROR_BLOCKED' })
      assert.equal(h.backend.requests.length, 1); assert.equal(reads, 4)
      h.runner.workflowControl = { ackToolError: readRoleRecord(h.runner, runId).toolErrorBlock, beforeRequest() {} }
    }
    assert.deepEqual(await run(), { evidenceReceived: true })
  }
  assert.equal(reads, 4)
  assert.equal(h.backend.requests.length, 2); assert.deepEqual(h.backend.errors, [])
})

test('paused worker continues with its original image attachment even after the workspace image changes', async t=>{
  const h=await fixture(t,({payload,index})=>{
    if(index===1)return {tools:[{name:'read_image',arguments:{file_path:'screen.png'}}]}
    assert.equal(imageResults(payload).length,1)
    assert.ok(Buffer.from(imageResults(payload)[0].source.data,'base64').length>40)
    return {text:'The old attachment remains historical evidence; current file was not reread.'}
  })
  h.runner.submit(runtimeProposal([]))
  const paused=await h.runner.runNext({expectedRevision:1,pauseAfterRequests:1})
  assert.equal(paused.paused,true);assert.equal(h.backend.requests.length,1)
  fs.writeFileSync(path.join(h.projectRoot,'screen.png'),'not an image any more')
  const result=await h.runner.resumeActive({expectedRevision:2,checkpointChecksum:paused.checkpoint.checksum})
  assert.equal(h.backend.requests.length,2)
  assert.equal(result.trace.events.filter(e=>e.type==='tool/call' && e.data.name==='read_image').length,1)
  assert.deepEqual(h.backend.errors,[])
})
test('repeated socket loss before HTTP headers compacts byte-bounded spans and resumes without repeating image tools', async t => {
  let task = 0, summaries = 0, failedBody
  const h = await fixture(t, ({ payload, record }) => {
    const images = imageResults(payload)
    if (record.headers['x-deepseek-harness-compact']) {
      summaries++
      assert.ok(images.length)
      assert.ok(Buffer.byteLength(record.rawBody) <= Math.floor(Buffer.byteLength(failedBody) * 0.8))
      return { text: 'Historical frame evidence archived and summarized. Continue with the most recent frame.' }
    }
    if (++task <= 6) return { tools: [{ name: 'read_image', arguments: { file_path: 'screen.png' } }] }
    if (task <= 8) {
      assert.equal(images.length, 6)
      if (failedBody) assert.equal(record.rawBody, failedBody)
      failedBody = record.rawBody
      return { disconnectBeforeResponse: true }
    }
    assert.equal(images.length, 1)
    assert.ok(Buffer.byteLength(record.rawBody) <= Math.floor(Buffer.byteLength(failedBody) * 0.8))
    return { text: 'Continued the original leaf and used the retained newest image.' }
  }, true, { direct: { maxRequestBytes: 8 * 1024 * 1024, maxJournalBytes: null, tracePayloads: 'references',
    compaction: { strategy: 'dsh-native', contextWindow: 1048576 } } })
  const size = 192, dimensions = Buffer.from(header)
  dimensions.writeUInt32BE(size, 0); dimensions.writeUInt32BE(size, 4)
  const pixels = randomBytes((size * 4 + 1) * size)
  for (let row = 0; row < size; row++) pixels[row * (size * 4 + 1)] = 0
  fs.writeFileSync(path.join(h.projectRoot, 'screen.png'), Buffer.concat([png.subarray(0, 8), chunk('IHDR', dimensions),
    chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]))
  h.runner.submit(runtimeProposal([]))
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }), /fetch failed/)
  const resume = () => h.runner.resumeActive({ expectedRevision: 2, recover: true, checkpointChecksum: h.runner.checkpointStatus().checksum })
  await assert.rejects(resume(), /fetch failed/)
  const result = await resume()
  assert.equal(task, 9)
  assert.equal(summaries, 2)
  assert.equal(result.trace.events.filter(event => event.type === 'tool/call' && event.data.name === 'read_image').length, 6)
  const interrupted = result.trace.requests.filter(request => request.status === 'UNKNOWN_OR_FAILED')
  assert.equal(interrupted.length, 2)
  assert.ok(interrupted.every(request => request.transportFailure.code === 'UND_ERR_SOCKET' && request.httpStatus === undefined && request.usage === null))
  assert.equal(result.trace.requests.at(-1).taskOrdinal, 7)
  assert.equal(result.trace.requests.at(-1).status, 'COMPLETE')
  assert.deepEqual(h.backend.errors, [])
})
test('scoped role images reject escapes and private paths, replay immutable reads and recheck current evidence', async t=>{
  const h=await fixture(t,()=>({text:'unused'})),catalog=new Map(),dir=path.join(h.root,'state','image-fixture')
  const reader=workspaceAuditTools(h.runner,dir,catalog,signal(),{imagesOnly:true})
  t.after(()=>reader.close());let ordinal=0
  const call=file_path=>({id:'img-'+(++ordinal),function:{name:'read_image',arguments:JSON.stringify({file_path})}})
  fs.symlinkSync(path.join(h.projectRoot,'screen.png'),path.join(h.projectRoot,'link.png'))
  fs.mkdirSync(path.join(h.projectRoot,'.dsh'));fs.writeFileSync(path.join(h.projectRoot,'.dsh','.credentials.yaml'),'PRIVATE')
  for(const name of ['../home/hidden.png','link.png','.dsh/.credentials.yaml'])assert.ok((await reader.execute(call(name))).error,name)
  const imageCall=call('screen.png'),value=await reader.execute(imageCall)
  assert.ok(value.value?.image?.attachmentId,JSON.stringify(value));assert.equal(roleImageResult('read_image',value).images.length,1)
  reader.checkCurrent({action:'COMPLETE'})
  fs.writeFileSync(path.join(h.projectRoot,'screen.png'),'changed')
  assert.throws(()=>reader.checkCurrent({action:'COMPLETE'}),/WORKSPACE_OBSERVATION_STALE/)
  const replay=workspaceAuditTools(h.runner,dir,new Map(),signal(),{imagesOnly:true});t.after(()=>replay.close())
  ordinal=0
  for(const name of ['../home/hidden.png','link.png','.dsh/.credentials.yaml'])await replay.execute(call(name))
  assert.deepEqual(await replay.execute(call('screen.png')),value)
  const normalized={model:'fake-llama',max_tokens:512,messages:[{role:'system',content:'Inspect.'},{role:'user',content:'Historical image',images:[value.value.image]}]}
  const prepared=await prepareDirectRequest(normalized,h.runner.config,h.ctx,signal())
  assert.equal(prepared.messages[0].content.at(-1).type,'image')
  assert.ok(rolePressureTokens(normalized)>0);assert.ok(imageWireByteBound(prepared)<Buffer.byteLength(JSON.stringify(prepared)))
  assert.throws(()=>serializeDirectRequest(normalized,h.runner.config.direct),/DIRECT_IMAGE_NOT_MATERIALIZED/)
  const chat=await prepareDirectRequest(normalized,{...h.runner.config,direct:{protocol:'chat-completions'}},h.ctx,signal())
  assert.match(chat.messages[1].content.at(-1).image_url.url,/^data:image\/png;base64,/)
  const missing=await reader.execute(call('missing.png'))
  assert.ok(missing.error);assert.match(JSON.stringify(missing.diagnostic),/file_path/)
  assert.ok((await reader.execute(call('screen.png'))).error,'corrupt image must not be a successful identity-only read')
})
test('compaction image loop never executes other tools and preserves image replies in its next request', async()=>{
  const first={finish:'tool_calls',responseId:'r1',message:{role:'assistant',content:'',tool_calls:[
    {id:'a',function:{name:'bash',arguments:'{}'}},{id:'b',function:{name:'read_image',arguments:'{"file_path":"e.png"}'}}]}}
  let called=0
  const result=await finishImageInspection({messages:[{role:'user',content:'Summarize.'}]},first,async payload=>{
    assert.match(payload.messages.at(-2).content,/COMPACTION_TOOL_FORBIDDEN/)
    assert.equal(payload.messages.at(-1).images.length,1);return {finish:'stop',text:'navigation checkpoint'}
  },async tool=>{called++;assert.equal(tool.function.name,'read_image');return {role:'tool',tool_call_id:tool.id,content:'visual evidence',images:[{attachmentId:'fixture'}]}})
  assert.equal(called,1);assert.equal(result.text,'navigation checkpoint')
})
test('real role compaction can inspect image evidence before finishing a checkpoint', async t=>{
  let summaries=0,inspections=0
  const h=await fixture(t,({payload,record})=>{
    if(record.headers['x-deepseek-harness-compact']){
      summaries++;assert.deepEqual(payload.tools.map(t=>t.name),['read_image'])
      if(!imageResults(payload).length)return {tools:[{name:'read_image',arguments:{file_path:'screen.png'}}]}
      inspections++;return {text:'Navigation checkpoint: raster was supplied. Original evidence remains authoritative.'}
    }
    return {text:'{"observed":true}'}
  })
  const runner={ctx:h.ctx,config:validateConfig({...h.runner.config,maxOutputTokens:32768,
    direct:{...h.runner.config.direct,compaction:{strategy:'dsh-native',contextWindow:262144}}})}
  const runId='revision_group_audit_'+randomUUID()
  const result=await directRevisionRole(runner,{runId,role:'group_audit',signal:signal(),messages:[{role:'system',content:'Read historical evidence only.'},
    {role:'user',content:JSON.stringify({evidence:'Historical text. '.repeat(12000),image:'screen.png'})}]})
  assert.deepEqual(result,{observed:true});assert.ok(summaries>=2);assert.ok(inspections>=1)
  assert.equal(readRoleRecord(runner,runId).phase,'COMPLETE')
})
for (const denyImages of [false,true]) test(`native worker compaction image inspection respects registered policy (denied=${denyImages})`, async t=>{
  let normal=0,summaries=0,visual=0
  const h=await fixture(t,({payload,record})=>{
    if(record.headers['x-deepseek-harness-compact']){
      summaries++;assert.deepEqual((payload.tools??[]).map(t=>t.name),denyImages?[]:['read_image'])
      if(denyImages)return {text:'Historical observations summarized without image inspection. Continue the current leaf.'}
      if(!imageResults(payload).length)return {tools:[{name:'read_image',arguments:{file_path:'screen.png'}}]}
      visual++;return {text:'Historical observations summarized. Continue the current leaf; visual data was supplied.'}
    }
    if(++normal<=5)return {text:'Historical detail. '.repeat(2000),tools:[{name:'read',arguments:{file_path:'input.txt'}}]}
    return {text:'Leaf continued after image-capable compaction.'}
  },true,{maxContextCharacters:8388608,maxOutputTokens:32768,direct:{maxRequestBytes:8388608,compaction:{strategy:'dsh-native',contextWindow:262144}}})
  fs.writeFileSync(path.join(h.projectRoot,'input.txt'),'Observed evidence.')
  if(denyImages)h.runner.roleTools.register({pluginId:'test',registrationId:'no-image-compaction',role:'compaction',mode:'blacklist',toolIds:['read_image']})
  h.runner.submit(runtimeProposal(['read']))
  const result=await h.runner.runNext({expectedRevision:1})
  assert.equal(normal,6);assert.ok(summaries >= (denyImages?1:2));assert.ok(denyImages ? visual===0 : visual>=1)
  assert.equal(result.trace.requests.filter(r=>r.purpose==='compaction').length,summaries)
  assert.deepEqual(h.backend.errors,[])
})

test('visual working set: independent batches, eviction, re-reading and durable tool pairing', async t => {
  const tool = (id) => ({ name: 'read_image', id, arguments: { file_path: 'screen.png' } })
  const batch = (first, count) => Array.from({ length: count }, (_, i) => tool('window-' + (first + i)))
  const h = await fixture(t, ({ index, payload }) => {
    const doc = payload.tools.find(entry => entry.name === 'read_image').description
    assert.match(doc, /at most 5 images/); assert.match(doc, /10 most recent/)
    const results = payload.messages.flatMap(row => row.content).filter(block => block.type === 'tool_result')
    const ids = results.filter(row => row.content.some(block => block.type === 'image')).map(row => row.tool_use_id)
    if (index === 1) return { tools: batch(1, 6) }
    const skipped = results.find(row => row.tool_use_id === 'window-6')
    assert.equal(skipped.is_error, true); assert.match(JSON.stringify(skipped.content), /READ_IMAGE_BATCH_LIMIT/)
    if (index === 2) { assert.deepEqual(ids, batch(1, 5).map(x => x.id)); return { tools: batch(7, 5) } }
    if (index === 3) { assert.equal(ids.length, 10); return { tools: batch(12, 2) } }
    assert.deepEqual(ids, [...batch(3, 3), ...batch(7, 7)].map(x => x.id))
    assert.match(JSON.stringify(results.find(row => row.tool_use_id === 'window-1')), /left the 10-image window/)
    return { text: 'Recovered the earlier image through a new read and completed the leaf.' }
  })
  h.runner.submit(runtimeProposal([]))
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.deepEqual(h.backend.errors, []); assert.equal(h.backend.requests.length, 4)
  assert.equal(result.trace.events.filter(row => row.type === 'tool/result' && row.data.name === 'read_image').length, 12)
  assert.equal(result.trace.events.filter(row => row.type === 'tool/deferred' && row.data.name === 'read_image').length, 1)
})

test('background audit and historical summarizer enforce image admission per response', async t => {
  const h = await fixture(t, ({index, payload}) => {
    if (index === 1) return { tools: Array.from({length: 6}, () => ({name: 'read_image', arguments: {file_path: 'screen.png'}})) }
    assert.equal(imageResults(payload).length, 5)
    assert.match(JSON.stringify(payload.messages.at(-1)), /READ_IMAGE_BATCH_LIMIT/)
    return {text: '{"checked":true}'}
  })
  const role = 'group_audit', runId = 'revision_group_audit_' + randomUUID()
  const input = { runId, role, messages: [{role:'system',content:'Inspect files and return JSON.'},{role:'user',content:JSON.stringify({image:'screen.png'})}], signal:signal() }
  assert.deepEqual(await directRevisionRole(h.runner,input), {checked:true})
  assert.deepEqual(h.backend.errors, [])
  const calls = Array.from({length:7}, (_,i) => ({id:'img'+i,function:{name:'read_image',arguments:'{}'}}))
  let executed = 0
  await finishImageInspection({messages:[]}, {finish:'tool_calls',message:{tool_calls:calls}}, async payload=>{
    assert.equal(payload.messages.filter(row=>row.isError).length,2); return {finish:'stop'}
  }, async call=>{executed++;return {role:'tool',tool_call_id:call.id,content:'ok'}})
  assert.equal(executed,5)
})

test('planner projects oldest visible occurrences using host sequence and original image indexes', async () => {
  const {windowPlannerStep} = await import('../preplanning.mjs')
  const image = () => ({type:'image'}), text = {type:'text',text:'retained evidence'}
  const session = {surface:{nodes:[2,3,4]},eventAt:seq=>({seq,type:seq===3?'assistant/message':'tool/result'}),
    deriveEventMessage:({seq})=>({content:seq===2?[{...image(),offloaded:true},text,image(),image()]:Array.from({length:7},image)}),
    append(type, data){assert.equal(type,'image/offload');this.targets=data.targets}}
  const incoming = {kind:'enter',messages:[{content:[image(),text,image(),image()]}]}
  assert.equal(windowPlannerStep(session,incoming,()=>{}),incoming)
  assert.deepEqual(session.targets,[{seq:2,imageIndexes:[1,2]}])
  const fresh = {kind:'enter',messages:[{content:Array.from({length:12},image)}]}
  const projected = windowPlannerStep({surface:{nodes:[]}},fresh,()=>assert.fail())
  assert.equal(projected.messages[0].content.filter(b=>b.offloaded).length,2)
  assert.equal(fresh.messages[0].content.some(b=>b.offloaded),false)
})
test('chat and Messages project ten occurrences without altering historical receipts or exact replay', async () => {
  const {imageWindowPayload, replaySavedRequestImages, IMAGE_WINDOW} = await import('../image-content.mjs')
  const {serializeDirectRequest} = await import('../direct-wire.mjs')
  const ids = Array.from({length:12}, (_,i)=>'sha256:'+i.toString(16).padStart(64,'0'))
  const refs=ids.map(attachmentId=>({attachmentId,bytes:1,width:1,height:1,mediaType:'image/png'}))
  const inputs = {model:'fixture',max_tokens:100,stream:true,messages:[{role:'user',content:'original evidence',images:refs}]}
  const bytes = new Map(ids.map((id,i)=>[id,{type:'image',source:{type:'base64',media_type:'image/png',data:Buffer.from([i]).toString('base64')}}]))
  for (const protocol of ['messages','chat-completions']) {
    for (const projected of [inputs,imageWindowPayload(inputs)]) {
      const wire=serializeDirectRequest(projected,{protocol},bytes)
      const recovered=replaySavedRequestImages(projected,wire,[])
      assert.deepEqual(serializeDirectRequest(recovered.payload,{protocol},recovered.images),wire)
      assert.equal(recovered.images.size,projected===inputs?12:IMAGE_WINDOW)
    }
  }
  assert.equal(inputs.messages[0].images.length,12); assert.equal(inputs.messages[0].content,'original evidence')
})

test('a confirmed generic HTTP 413 shortens the next request without repeating image reads', async t => {
  let task = 0, summaries = 0, failedBody
  const h = await fixture(t, ({ payload, record }) => {
    const images = imageResults(payload)
    if (record.headers['x-deepseek-harness-compact']) {
      summaries++
      assert.ok(images.length)
      assert.ok(Buffer.byteLength(record.rawBody) <= Math.floor(Buffer.byteLength(failedBody) * 0.8))
      return { text: 'Historical frame evidence archived and summarized. Continue with the most recent frame.' }
    }
    if (++task <= 6) return { tools: [{ name: 'read_image', arguments: { file_path: 'screen.png' } }] }
    if (task === 7) {
      assert.equal(images.length, 6)
      if (failedBody) assert.equal(record.rawBody, failedBody)
      failedBody = record.rawBody
      return { status: 413, body: 'Request Entity Too Large' }
    }
    assert.equal(images.length, 1)
    assert.ok(Buffer.byteLength(record.rawBody) <= Math.floor(Buffer.byteLength(failedBody) * 0.8))
    return { text: 'Continued the original leaf and used the retained newest image.' }
  }, true, { direct: { maxRequestBytes: 8 * 1024 * 1024, maxJournalBytes: null, tracePayloads: 'references',
    compaction: { strategy: 'dsh-native', contextWindow: 1048576 } } })
  const size = 192, dimensions = Buffer.from(header)
  dimensions.writeUInt32BE(size, 0); dimensions.writeUInt32BE(size, 4)
  const pixels = randomBytes((size * 4 + 1) * size)
  for (let row = 0; row < size; row++) pixels[row * (size * 4 + 1)] = 0
  fs.writeFileSync(path.join(h.projectRoot, 'screen.png'), Buffer.concat([png.subarray(0, 8), chunk('IHDR', dimensions),
    chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]))
  h.runner.submit(runtimeProposal([]))
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(task, 8); assert.ok(summaries > 0)
  assert.deepEqual(h.backend.errors, [])
  assert.equal(result.trace.requests.filter(r => r.status === 'REJECTED_IMAGE_PAYLOAD' && r.httpStatus === 413 && r.transportReceipt.responseRejected).length, 1)
  assert.equal(result.trace.events.filter(e => e.type === 'tool/call' && e.data.name === 'read_image').length, 6)
})
