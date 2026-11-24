// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { digest } from 'dsh-better-task-grapth/core'
import { DynamicContextGraph, validateState } from '../core.mjs'
import { planDefinition } from '../revision.mjs'
import { contextDefinition } from '../revision-runtime.mjs'
import { acceptancePlan, currentPlanningRecord, criteriaNotice, verificationAtStart } from '../acceptance-protocol.mjs'
import { resolveGuidanceSuspension } from '../suspension.mjs'

test('reviewed criteria supersede the former rubric without losing the active journal scope', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'approved-criteria-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const graph = new DynamicContextGraph({ projectRoot:root, directory:path.join(root,'state'), supervision:true, revision:{} })
  const rubric = id => ({version:1, deliveryRequired:false, requirements:[{id, origin:'USER', statement:id, source:'user message', verification:'inspect the actual artifact', required:true}]})
  const originalReport = { understanding:'Original goal', assumptions:[], design:'Two steps', acceptanceStrategy:'Original evidence', verification:rubric('original') }
  const submitted = graph.submit({
    planningReport:originalReport,
    taskGraph:{title:'Goal', hierarchy:{version:1,maxGroupDepth:3}, nodes:[
      {key:'root',kind:'container',label:'Root',terminal:'b',acceptance:'User goal'},
      {key:'a',kind:'leaf',parent:'root',label:'First'}, {key:'b',kind:'leaf',parent:'root',label:'Second'}],
      edges:[{kind:'prerequisite',from:'a',to:'b'}]},
    contextGraph:{nodes:[],bindings:['a','b'].map(task=>({task,contexts:[],instruction:'Original '+task,completion:{kind:'report'}}))}
  })
  graph.begin({expectedRevision:submitted.revision})
  const activeState=graph.read(), active=activeState.graph.state.active, sourceVersion=activeState.contexts.version
  const initialSeed=graph.assemble()
  const rootId=activeState.graph.state.plan.nodes.find(n=>n.key==='root').id
  const secondId=activeState.graph.state.plan.nodes.find(n=>n.key==='b').id
  graph.suspend({expectedRevision:activeState.revision,evidence:[{kind:'artifact',ref:'approved-operator-record',sha256:'1'.repeat(64)}],
    note:'Update pending criteria',metadata:{contextVersion:sourceVersion,contextHash:digest(activeState.contexts),scopeId:rootId}})
  const held=graph.read(), report={...originalReport,verification:rubric('current'),acceptanceStrategy:'Updated evidence'}
  const amendment={before:digest(originalReport),sourceMessageId:'real-user-1', evidence:['user-message:1'], report,
    bindings:[{taskId:secondId,base:digest('Original b'),instruction:'Check current evidence'}]}
  const make=criteriaAmendment=>({taskGraph:planDefinition(held.graph.state.plan),contextGraph:contextDefinition(held),criteriaAmendment,invalidateReports:[]})
  assert.throws(()=>graph.prepareRevision(make({...amendment,before:'a'.repeat(64)})),{code:'ACCEPTANCE_CRITERIA_SOURCE_MISMATCH'})
  assert.throws(()=>graph.prepareRevision(make({...amendment,bindings:[{taskId:active.nodeId,base:digest('Original a'),instruction:'replace running work'}]})),{code:'ACCEPTANCE_CRITERIA_BINDING_CHANGED'})
  assert.equal(graph.prepareRevision(make(amendment)).contexts.version, sourceVersion)
  // Redirect a future leaf without rebasing the running leaf's saved request history.
  const future = amendment.bindings[0]
  future.reportSources = { base: digest([]), previous: digest([]), sources: [active.nodeId] }
  const badSource = structuredClone(amendment)
  badSource.bindings[0].reportSources.sources = [secondId]
  assert.throws(() => graph.prepareRevision(make(badSource)), /REPORT_SOURCE_MUST_BE_PREDECESSOR|ACCEPTANCE_REPORT_SOURCE_INVALID/)
  const stale = structuredClone(amendment)
  stale.bindings[0].reportSources.previous = '0'.repeat(64)
  assert.throws(() => graph.prepareRevision(make(stale)), {code:'ACCEPTANCE_REPORT_SOURCE_INVALID'})
  const prepared=graph.prepareRevision(make(amendment)),proposal={criteriaAmendment:amendment},proposalHash=digest(proposal)
  const audit=graph.updateSupervision(held,{phase:'HIERARCHY',outcomes:[],hierarchy:{scopeId:rootId,stage:'UPDATE_AUDIT',updaterRunId:'updater',proposalHash},roleRunId:'reviewer'})
  prepared.baseChecksum=audit.checksum
  const review={verdict:'APPROVE',baseRevision:held.revision,planChecksum:digest(prepared.plan),preparedHash:digest(prepared),proposalHash,proposal,updaterRunId:'updater',reviewerRunId:'reviewer',scopeSignal:{scopeId:rootId,proposalHash}}
  assert.throws(()=>graph.commitRevision({expectedRevision:audit.revision,prepared,review:{...review,scopeSignal:{scopeId:secondId,proposalHash}}}),{code:'ACCEPTANCE_CRITERIA_SOURCE_MISMATCH'})
  const changed=graph.commitRevision({expectedRevision:audit.revision,prepared,review})
  graph.updateSupervision(changed,{phase:'READY',outcomes:[]})
  assert.equal(resolveGuidanceSuspension({graph,publish(){}}).mode,'resume')
  const state=validateState(graph.read())
  assert.deepEqual(state.graph.state.active,active)
  assert.deepEqual(state.planningRecord.report,originalReport)
  assert.deepEqual(acceptancePlan(state),rubric('current'))
  assert.deepEqual(currentPlanningRecord(state).report,report)
  assert.deepEqual(verificationAtStart(state,active.attemptId),rubric('original'))
  assert.deepEqual(graph.assemble(initialSeed),initialSeed)
  assert.equal(contextDefinition(state).bindings.find(row=>row.task==='b').instruction,'Check current evidence')
  assert.equal(state.contexts.version,sourceVersion)
  assert.deepEqual(contextDefinition(state).bindings.find(row=>row.task==='b').inheritReports,['a'])
  assert.throws(() => graph.checkInputs(state, secondId), {code:'INHERITED_REPORT_NOT_COMMITTED'})
  graph.suspend({expectedRevision:state.revision,evidence:[{kind:'artifact',ref:'next-review',sha256:'2'.repeat(64)}],
    note:'Next review',metadata:{contextVersion:sourceVersion,contextHash:digest(state.contexts),scopeId:rootId}})
  const next = graph.prepareRevision({ taskGraph:planDefinition(state.graph.state.plan), contextGraph:contextDefinition(state), invalidateReports:[] })
  assert.equal(next.contexts.version, sourceVersion)
  assert.deepEqual(criteriaNotice(state,'unrelated'),{})
  assert.deepEqual(criteriaNotice(state,'real-user-1').reviewedCriteria.verificationPlan,rubric('current'))
})

