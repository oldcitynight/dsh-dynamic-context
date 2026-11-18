// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { digest } from 'dsh-better-task-grapth/core'
import { groupAuditSchema } from '../hierarchy-protocol.mjs'
import { blockageDecisionSchema,lookupPointer,verifyReference } from '../blockage-protocol.mjs'
import { workspaceAuditTools,WORKSPACE_TOOLS } from '../workspace-audit.mjs'
import { registerGroupObservations,blockageTools,saveBlockage } from '../blockage-evidence.mjs'
import { BLOCKAGE_TOOLS } from '../blockage-protocol.mjs'

test('group action discrimination preserves acceptance but locates malformed rework fields',()=>{
  const old=z.union([groupAuditSchema.options[0],blockageDecisionSchema])
  const finding={taskId:'task',attemptId:'attempt',reasonCode:'CONTRADICTED_RESULT',criterion:'square required',problem:'circle observed',correction:'deliver square',
    evidence:[{source:'report:attempt',sha256:'a'.repeat(64),path:'/result/summary',quote:'declared square'}]}
  const rework={action:'REWORK',report:{version:1,findings:[finding]}}
  const malformed=structuredClone(rework);malformed.report.findings[0].reasonCode='INVALID_VISUAL'
  const result=groupAuditSchema.safeParse(malformed)
  assert.equal(result.success,false);assert.deepEqual(result.error.issues[0].path,['report','findings',0,'reasonCode'])
  assert.notEqual(result.error.issues[0].message,'Invalid input')
  for(const value of [rework,malformed,{action:'REPLAN'},{action:'REPLAN',reason:'extra'},
    {action:'PAUSE'},null,{}, {action:'UNKNOWN'}, {action:'COMPLETE',summary:'ok',children:[{nodeId:'task',conclusion:'SATISFIED',reason:'ok',evidence:finding.evidence}],limitations:[]}])
    assert.equal(groupAuditSchema.safeParse(value).success,old.safeParse(value).success,JSON.stringify(value))
})
test('accepted audit observations are frozen readable sources without new filesystem or trace permissions',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'archived-observation-'))
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}))
  const runId='revision_group_audit_fixture',source=`workspace:${runId}:1`,value={path:'delivery.txt',fileSha256:'a'.repeat(64),text:'original accepted bytes'},hash=digest(value)
  const receipt=path.join(directory,'revisions',runId,'workspace-tool-results','1.json')
  const stored={identity:{ordinal:1},value:{source,sourceSha256:hash,value}}
  saveBlockage(receipt,stored)
  const earlierSource=`workspace:${runId}:2`,earlierValue={path:'delivery.txt',text:'earlier page of the same unchanged file'},earlierHash=digest(earlierValue)
  saveBlockage(path.join(directory,'revisions',runId,'workspace-tool-results','2.json'),{identity:{ordinal:2},value:{source:earlierSource,sourceSha256:earlierHash,value:earlierValue}})
  const state={graph:{state:{hierarchy:{groups:{group_a:{runId,workspaceInspection:{observations:[{source,sourceSha256:hash}]},
    audit:{children:[{evidence:[{source:earlierSource,sha256:earlierHash,path:'/text',quote:'earlier page'}]}]}},
    alias:{aliasOf:'group_a',runId,workspaceInspection:{observations:[{source,sourceSha256:hash}]}}}}}}}
  const catalog=new Map();registerGroupObservations({config:{directory}},state,catalog,new AbortController().signal)
  assert.equal(catalog.size,2);assert.equal(catalog.get(source).taskId,'group_a')
  const tools=blockageTools(catalog,path.join(directory,'reader'),new AbortController().signal)
  let ordinal=0;const call=(name,args)=>tools.execute({id:'call'+(++ordinal),function:{name,arguments:JSON.stringify(args)}})
  assert.equal(call(BLOCKAGE_TOOLS.report,{source,path:'/text'}).text,'original accepted bytes')
  assert.equal(call(BLOCKAGE_TOOLS.report,{source:earlierSource,path:'/text'}).text,earlierValue.text)
  assert.equal(call(BLOCKAGE_TOOLS.report,{source:`workspace:${runId}:3`}).error,'BLOCKAGE_SOURCE_SCOPE_MISMATCH')
  for(const name of [BLOCKAGE_TOOLS.trace,BLOCKAGE_TOOLS.shared])assert.equal(call(name,{source}).error,'BLOCKAGE_SOURCE_SCOPE_MISMATCH')
  assert.equal(call(BLOCKAGE_TOOLS.report,{source:'workspace:other:1'}).error,'BLOCKAGE_SOURCE_SCOPE_MISMATCH')
  // Even a recomputed journal checksum cannot replace the identity committed
  // in the accepted group report. No current project path is opened here.
  stored.value.value.text='replacement';saveBlockage(receipt,stored)
  assert.equal(call(BLOCKAGE_TOOLS.report,{source,path:'/text'}).error,'BLOCKAGE_ARCHIVED_OBSERVATION_CHANGED')
})
test('missing evidence paths identify the actual source keys without accepting wrapper aliases',()=>{
  assert.throws(()=>lookupPointer({fileSha256:'a',image:{attachmentId:'image'}},'/value/image/fileSha256','/evidence/0/path'),error=>{
    assert.equal(error.code,'BLOCKAGE_EVIDENCE_POINTER_MISSING');assert.equal(error.details.path,'/evidence/0/path')
    assert.deepEqual(error.details.availableKeys,['fileSha256','image']);return true
  })
  assert.equal(lookupPointer({value:{text:'actual nested value'}},'/value/text'),'actual nested value')
})
test('workspace citation examples validate source hashes and failed pagination identifies the exact argument',t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'citation-feedback-'))),projectRoot=path.join(root,'project'),directory=path.join(root,'state')
  fs.mkdirSync(projectRoot);fs.mkdirSync(directory)
  fs.writeFileSync(path.join(projectRoot,'text.txt'),'a'.repeat(239)+'😀tail')
  fs.writeFileSync(path.join(projectRoot,'binary.dat'),Buffer.from([0,255,3]))
  const catalog=new Map(),reader=workspaceAuditTools({config:{projectRoot,directory,storageRoot:root,direct:{}},ctx:{get:()=>undefined}},path.join(directory,'audit'),catalog,new AbortController().signal)
  t.after(()=>{reader.close();fs.rmSync(root,{recursive:true,force:true})})
  let n=0;const call=(name,args)=>reader.execute({id:'call'+(++n),function:{name,arguments:JSON.stringify(args)}})
  for(const [name,args] of [[WORKSPACE_TOOLS.read,{path:'text.txt'}],[WORKSPACE_TOOLS.list,{path:'.'}]]){
    const result=call(name,args);assert.equal(result.sourceSha256,digest(result.value));assert.ok(result.citationExamples.length)
    result.citationExamples.forEach(ref=>{assert.equal(verifyReference(ref,catalog,'/citation').kind,'workspace');assert.doesNotMatch(ref.path,/^\/value\//);assert.doesNotMatch(ref.quote,/[\uD800-\uDBFF]$/)})
  }
  const observed=call(WORKSPACE_TOOLS.read,{path:'binary.dat',start:0,end:1})
  assert.equal(observed.value.pagination.applied,false)
  assert.equal(observed.value.content,'binary-identity-only')
  assert.equal(verifyReference(observed.citationExamples[0],catalog,'/citation').kind,'workspace')
  const rejected=call(WORKSPACE_TOOLS.read,{path:'binary.dat',start:0,end:0})
  assert.equal(rejected.error,'SCHEMA_VALIDATION_FAILED');assert.equal(rejected.diagnostic.issues[0].path,'/end')
  assert.deepEqual(rejected.retryArguments,{path:'binary.dat'})
})
