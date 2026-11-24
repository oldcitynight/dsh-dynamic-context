// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { digest } from 'dsh-better-task-grapth/core'
import { DynamicContextGraph, currentSharedContexts, validateState } from '../core.mjs'
import { planDefinition } from '../revision.mjs'
import { contextDefinition } from '../revision-runtime.mjs'

test('approved changed goal and versioned facts are applied atomically and replayable', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-facts-'))
  t.after(() => fs.rmSync(root, { recursive:true, force:true }))
  const graph = new DynamicContextGraph({ projectRoot:root, directory:path.join(root,'state'), supervision:true, revision:{} })
  const original = graph.submit({
    planningReport:{understanding:'Original goal',assumptions:[],design:'One leaf',acceptanceStrategy:'Check report'},
    taskGraph:{title:'Goal',hierarchy:{version:1,maxGroupDepth:3},nodes:[
      {key:'root',kind:'container',label:'Root',terminal:'task',acceptance:'Original goal'},
      {key:'task',kind:'leaf',parent:'root',label:'Task'}],edges:[]},
    contextGraph:{nodes:[{key:'brief',content:'Historical brief'}],bindings:[
      {task:'task',contexts:['brief'],instruction:'Do the task',completion:{kind:'report'}}]}
  })
  const taskGraph=planDefinition(original.graph.state.plan),contextGraph=contextDefinition(original)
  const rootId=original.graph.state.plan.nodes.find(n=>n.key==='root').id, id=original.contexts.nodes[0].id
  taskGraph.nodes.find(n=>n.key==='root').acceptance='Current goal'
  const fact={id,revision:2,content:'Current brief',reason:'User changed the goal',evidence:['user-message:42']}
  const rootGoalAuthority={scopeId:rootId,before:digest('Original goal'),after:digest('Current goal'),messageId:'42',messageSha256:digest('Current goal')}
  const change={taskGraph,contextGraph,factAmendments:[fact],invalidateReports:[]}
  assert.throws(()=>graph.prepareRevision(change),{code:'REVISION_ROOT_IMMUTABLE'})
  assert.throws(()=>graph.prepareRevision(change,{rootGoalAuthority:{...rootGoalAuthority,before:digest('wrong')}}),{code:'REVISION_ROOT_IMMUTABLE'})
  assert.throws(()=>graph.prepareRevision({...change,factAmendments:[{...fact,revision:3}]},{rootGoalAuthority}),{code:'SHARED_CONTEXT_AMENDMENT_STALE'})
  const draft=graph.prepareRevision(change,{rootGoalAuthority})
  const proposal={rootGoalAuthority,factAmendments:[fact]},proposalHash=digest(proposal)
  const gate=graph.updateSupervision(original,{phase:'HIERARCHY',outcomes:[],hierarchy:{scopeId:rootId,stage:'UPDATE_AUDIT',updaterRunId:'update',proposalHash},roleRunId:'review'})
  const prepared={...draft,baseChecksum:gate.checksum}
  const review={verdict:'APPROVE',baseRevision:1,planChecksum:digest(prepared.plan),proposalHash,proposal,
    scopeSignal:{scopeId:rootId,proposalHash},preparedHash:digest(prepared),updaterRunId:'update',reviewerRunId:'review'}
  const tampered={...proposal,factAmendments:[{...fact,content:'unapproved'}]}
  assert.throws(()=>graph.commitRevision({expectedRevision:1,prepared,review:{...review,proposal:tampered,proposalHash:digest(tampered)}}),{code:'REVISION_APPROVED_DRAFT_MISMATCH'})
  const state=graph.commitRevision({expectedRevision:1,prepared,review})
  assert.deepEqual(state.planningRecord,original.planningRecord)
  assert.equal(state.contexts.nodes[0].content,'Historical brief')
  assert.equal(currentSharedContexts(validateState(state))[0].content,'Current brief')
  const corrupt=structuredClone(state);corrupt.sharedContextHistory[0].content='fabricated'
  const {checksum,...body}=corrupt;corrupt.checksum=digest(body)
  assert.throws(()=>validateState(corrupt),{code:'SHARED_CONTEXT_HISTORY_INVALID'})
  graph.updateSupervision(state,{phase:'READY',outcomes:[]})
  graph.begin({expectedRevision:2})
  const seed=graph.assemble()
  assert.equal(seed.contexts[0].content,'Current brief')
  assert.equal(graph.sharedContext(seed,{id,revision:1},'read').content,'Historical brief')
  assert.equal(graph.sharedContext(seed,{id,content:'unauthorized write'},'edit').status,'UNAVAILABLE')
})

