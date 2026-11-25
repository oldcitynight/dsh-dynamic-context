import { acceptanceEnabled, acceptancePlan } from './acceptance-protocol.mjs'
// SPDX-License-Identifier: GPL-3.0-only
import { hasStored,readStored,writeStored } from './workflow-io.mjs'
import fs from 'node:fs'
import { roleMessagesMatch, roleInputsMatch, unitBindingTools, workspaceLeafTools } from './role-policy.mjs'
import { withUserGuidance } from './guidance-state.mjs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { layerRuleTools, ruleTools, RULE_GUIDE } from './rule-editor.mjs'
import { unitBaselineSchema, UNIT_PLANNING } from './unit-baseline.mjs'
import { z } from 'zod'
import { runtimeRules } from 'dsh-better-task-grapth/rules'
import { stalledUnitScope } from 'dsh-better-task-grapth/hierarchy'
import { digest, canonical, legalNext, revisionOutlook } from 'dsh-better-task-grapth/core'
import { isHierarchical, aliasScopes, childrenOf, descendantsOf, hierarchyComplete, scopeSignature, groupRouting, childUnitResult, permitsBlockedOutcome } from 'dsh-better-task-grapth/hierarchy'
import { located, parseModelJSON } from 'dsh-better-task-grapth/validation'
import { directRevisionRole, readRoleRecord, roleRecordValue } from './revision-runtime.mjs'
import { HIERARCHY_PROMPTS, LEGACY_SCOPE_UPDATE_PROMPT, groupAuditSchema, binaryGroupAuditSchema, scopePlanSchema, scopeProposalSchema, runtimeScopeProposalSchema, scopeAuditSchema, finalReportSchema } from './hierarchy-protocol.mjs'
import { hierarchyContext, auditReportInput, effectiveScope, finalAuditMandate, prepareScopeProposal, terminalExecutionUnit } from './hierarchy-context.mjs'
import { blockageCatalog, blockageTools } from './blockage-evidence.mjs'
import { diagnoseBlockage, diagnosticInput, checkGlobalDecision, checkRevisionProgress } from './blockage-diagnosis.mjs'
import { workspaceAuditTools, registerWorkspaceReceipts, WORKSPACE_AUDIT_MARKER } from './workspace-audit.mjs'
import { GROUP_OUTCOME_AUDIT, GRAPH_OUTCOME_AUDIT } from './work-quality.mjs'
import { blockageDecisionSchema, validateBlockageDecision, verifyReference, lookupPointer, BLOCKAGE_INSTRUCTION, BLOCKAGE_AUDIT_INSTRUCTION, blockageTemplates, globalBlockageInstruction } from './blockage-protocol.mjs'
import { fail } from './core.mjs'
import { unitRouteSchema, UNIT_ROUTE_PROMPT, BASELINE_AUDIT_PROMPT, unitRouteInput, changedUnitBaselines, baselineAuditInput } from './unit-roles.mjs'

const summary = (runner, status, extra = {}) => ({ status, revision: runner.graph.read().revision, supervision: runner.supervisionStatus(), ...extra })
const pendingState = (state, flow) => ({ phase: 'HIERARCHY', outcomes: state.supervision.outcomes, ...(flow ? { hierarchy: flow } : {}) })
function pendingBaselineChanges(state, flow, candidate) {
  return changedUnitBaselines(state, flow.scopeId, candidate).filter(({ baseline, hash }) =>
    !(flow.rebaseline?.auditRunId && baseline.unitId === flow.scopeId && baseline.field === 'baseline') &&
    !flow.baselineReviews?.some(review => review.hash === hash))
}
function update(runner, state, flow) {
  const authority = state.supervision.hierarchy?.routeAuthority
  const next = authority && flow ? { routeAuthority: authority, ...flow } : flow
  return runner.graph.updateSupervision(state, pendingState(state, next))
}
function releaseUnit(runner, state, flow, runId) {
  runner.graph.updateSupervision(state, { phase: 'READY', outcomes: state.supervision.outcomes,
    routedUnit: { taskId: flow.routeTaskId, revision: state.revision, runId, authorityHash: flow.routeAuthority } })
  return summary(runner, 'UNIT_READY')
}

// Called under the execution lease before BEGUN. A resumed attempt already has its route.
export async function routeReadyUnit(runner, state, expectedRevision, choice, authorityHash, signal, assertAuthority) {
  // Let the existing begin operation return its original stale/illegal-choice diagnostics.
  if (state.revision !== expectedRevision || !Number.isSafeInteger(choice)) return
  const stalled = stalledUnitScope(state.graph.state)
  if (stalled) {
    update(runner, state, { scopeId: stalled, stage: 'BLOCKAGE' })
    return advanceHierarchy(runner, signal, assertAuthority)
  }
  const target = legalNext(state.graph.state)[choice]
  if (!target) return
  const saved = state.supervision.routedUnit
  if (saved?.taskId === target.id && saved.revision === state.revision) {
    if (saved.authorityHash === authorityHash) return
    try { assertAuthority(saved.authorityHash); return } catch (error) {
      if (error.code !== 'SUPERVISION_AUTHORITY_CHANGED') throw error
    }
  }
  update(runner, state, { scopeId: state.graph.state.plan.hierarchy.version === 2 ? target.id : target.parent, stage: 'UNIT_ROUTE', routeTaskId: target.id, routeAuthority: authorityHash })
  const result = await advanceHierarchy(runner, signal, assertAuthority)
  if (result.status !== 'UNIT_READY') return result
}
function globalFlow(state, reviewedScopes = []) {
  return { scopeId: stalledUnitScope(state.graph.state) ?? state.graph.state.plan.nodes.find(node => node.parent === null).id, stage: 'BLOCKAGE', ...(state.graph.state.plan.hierarchy.version === 2 ? {} : { reviewedScopes }) }
}
function situationFor(state, scopeId, terminalOnly = false) {
  const nodes = descendantsOf(state.graph.state.plan, scopeId)
  const related = nodes.map(node => node.id)
  const causes = terminalOnly ? [terminalExecutionUnit(state.graph.state.plan, scopeId).id] : childrenOf(state.graph.state.plan, scopeId)
    .filter(node => ['INCOMPLETE', 'SKIPPED'].includes(state.graph.state.leaves[node.id]?.status)).map(node => node.id)
  return { code: 'SCOPED_BLOCKAGE', scopeId, causes, related,
    ...(state.graph.state.plan.hierarchy.version === 2 && !terminalOnly ? { allowPartialRework: true } : {}) }
}
function validateDecision(value, state, scopeId, catalog, terminalOnly) {
  const decision = blockageDecisionSchema.parse(value), situation = situationFor(state, scopeId, terminalOnly)
  if (terminalOnly && decision.action === 'REWORK' && decision.report.findings.some(row => !situation.causes.includes(row.taskId)))
    throw located('GROUP_REWORK_TERMINAL_ONLY', { path: '/report/findings', reason: 'This final audit can return only the terminal work unit. Other changes require scoped replanning.', allowed: situation.causes })
  return validateBlockageDecision(decision, { state, situation, catalog })
}
export function validateGroup(value, state, scopeId, catalog) {
  const binary=state.graph.state.plan.ruleVersion===1
  if (binary && ['BLOCKED','COMPLETE'].includes(value?.action) || !binary && ['PASS','FAILED'].includes(value?.action)) fail('GROUP_OUTCOME_PROTOCOL_MISMATCH')
  const result = (binary ? binaryGroupAuditSchema : groupAuditSchema).parse(value)
  const graph = state.graph.state, nodes = childrenOf(graph.plan, scopeId)
  if (['BLOCKED','FAILED'].includes(result.action)) {
    if (!binary && !permitsBlockedOutcome(graph.plan, scopeId)) throw located('GROUP_BLOCKED_ROUTE_REQUIRED', { path: '/action', reason: 'Only a group declared as an outcome source may record a terminal BLOCKED audit.' })
    const refs = result.evidence.map((ref, i) => verifyReference(ref, catalog, '/evidence/' + i))
    if (!refs.some(ref => nodes.some(node => node.id === ref.taskId))) throw located('GROUP_CHILD_EVIDENCE_REQUIRED', { path: '/evidence', reason: 'Cite the affected direct child report or its original evidence.' })
    return result
  }
  if (!['COMPLETE','PASS'].includes(result.action)) return validateDecision(result, state, scopeId, catalog, true)
  const routing = groupRouting(graph)
  if (canonical(result.children.map(row => row.nodeId).sort()) !== canonical(nodes.map(node => node.id).sort()))
    throw located('GROUP_AUDIT_COVERAGE_REQUIRED', { path: '/children', reason: 'Explain every direct child exactly once.', required: nodes.map(node => node.id) })
  for (const [i, row] of result.children.entries()) {
    const excluded = routing?.branch(row.nodeId) === 'NOT_SELECTED'
    if (excluded !== (row.conclusion === 'NOT_SELECTED')) throw located('GROUP_ROUTE_COVERAGE_MISMATCH', { path: '/children/' + i + '/conclusion', reason: 'Use NOT_SELECTED exactly for a branch excluded by its recorded route.' })
    if (!excluded && !hierarchyComplete(state.graph.state, row.nodeId) && row.conclusion !== 'ACCEPTED_LIMITATION')
      throw located('GROUP_AUDIT_FALSE_SUCCESS', { path: `/children/${i}/conclusion`, reason: 'An accepted BLOCKED/FAILED disposition is not leaf completion. Explain the contract-compatible limitation or request rework/replanning.' })
    const refs = row.evidence.map((ref, j) => verifyReference(ref, catalog, `/children/${i}/evidence/${j}`))
    if (!refs.some(ref => ref.taskId === row.nodeId)) throw located('GROUP_CHILD_EVIDENCE_REQUIRED', { path: `/children/${i}/evidence`, reason: 'Cite this child report or its execution record.' })
  }
  if (acceptanceEnabled(state)) {
    const root = state.graph.state.plan.nodes.find(node => node.parent === null)
    const isRoot = effectiveScope(state, root.id) === scopeId || root.id === scopeId || aliasScopes(state.graph.state.plan, scopeId).some(node => node.id === root.id)
    const rows = result.goalCoverage ?? [], plan = acceptancePlan(state), ids = rows.map(row => row.requirementId)
    if (new Set(ids).size !== ids.length || ids.some(id => !plan.requirements.some(row => row.id === id))
      || isRoot && plan.requirements.some(row => !ids.includes(row.id)))
      throw located('GROUP_GOAL_COVERAGE_REQUIRED', { path: '/goalCoverage', reason: 'The effective root must address every original requirement exactly once; intermediate groups address relevant requirements only.', required: isRoot ? plan.requirements.map(row => row.id) : [] })
    rows.forEach((row, i) => row.evidence.forEach((ref, j) => verifyReference(ref, catalog, `/goalCoverage/${i}/evidence/${j}`)))
  }
  return result
}
async function role(runner, state, name, instruction, input, catalog, validateResult, signal) {
  if (acceptanceEnabled(state) && !['unit_router', 'baseline_audit'].includes(name) && !(name === 'scope_blockage' && input.protocol === 'global-blockage-v2')) instruction += '\nDYNAMIC_CONTEXT_ACCEPTANCE_V1\ncurrentSharedFacts 是最新事实，蓝图原始内容仅供结构与 retain 身份使用。按原始用户目标检查 verificationPlan 和 publicEvidence，不能把 DESIGN 数量指标替代 USER 体验目标。核对验证方法、真实接口/模拟边界、消费者目录是否从实际交付物开始、入口与依赖是否齐备。组 COMPLETE 增加 goalCoverage 数组：每项 {"requirementId":"user_goal","conclusion":"SUPPORTED","reason":"证据支持范围","evidence":[实际source引用]}，conclusion 可为 LIMITED 或 NOT_APPLICABLE；有效根覆盖所有需求，其余组覆盖适用需求。固定合同不允许的未证实必需目标不能当作完成。任务报告者仍只总结已审结果；给出 publicEvidence 中的实际交付路径、使用步骤与外部依赖，禁止把历史产物当作最新交付。'
  if (state.graph.state.plan.ruleVersion && name === 'group_audit') instruction = instruction.replaceAll('组 COMPLETE', '组 PASS')
  if (input.groupRoutes?.length && name === 'scope_update') instruction += '\n当前层的条件边是双图的一部分。按组终审结果选择同层 route（outcome 为 complete 或 blocked），同一目标的多个入向 route 为或关系；逐点说明变动。'
  if (state.graph.state.plan.ruleVersion && name === 'scope_update') instruction = instruction.replace(
    /普通依赖使用 prerequisite。.*?父层和兄弟内部不可修改/u,
    '当前层使用 nodes[].rules、稳定 key、all/any/not 与 PASS/FAILED/BLOCK，edges 为 []。取反保留未决，规则列表任一成立即可。父层和兄弟内部不可修改')
  const prior = state.supervision.roleRunId && readRoleRecord(runner, state.supervision.roleRunId)
  const flow = state.supervision.hierarchy
  const logicalName = name
  if (state.graph.state.plan.hierarchy.version === 2 && prior?.role !== name) {
    if (name === 'group_audit') name = 'unit_audit'
    if (name === 'scope_update' && flow?.stage === 'BASELINE_WRITE') name = 'unit_rebaseline'
    else if ((flow?.routeRunId || flow?.rebaseline) && name === 'scope_update') name = 'unit_planner'
    else if ((flow?.routeRunId || flow?.rebaseline) && name === 'scope_audit') name = 'unit_plan_audit'
  }
  const assemble = value => withUserGuidance(runner, name, [{ role: 'system', content: instruction }, { role: 'user', content: JSON.stringify(value) }])
  let messages = assemble(input)
  // Recreate the exact v1 input only for a ticket issued by the old group auditor.
  if (name === 'group_audit' && prior?.role === name && !prior.inputIndexVersion
      && !['INVALID_RESPONSE', 'ABANDONED_UNVERIFIED'].includes(prior.phase) && !roleInputsMatch(prior, messages)) {
    const legacy = assemble(auditReportInput(input))
    if (roleInputsMatch(prior, legacy)) messages = legacy
  }
  if (prior?.phase === 'PAUSED' && prior.role === name && roleInputsMatch(prior, messages)) messages = prior.payload.messages
  const valid = prior && prior.role === name && roleMessagesMatch(prior, messages)
    && !['INVALID_RESPONSE', 'ABANDONED_UNVERIFIED'].includes(prior.phase)
  const editingRules = state.graph.state.plan.hierarchy.version === 2 && logicalName === 'scope_update' && flow?.stage === 'UPDATE'
  if (!valid) {
    const roleRunId = 'revision_' + name + '_' + randomUUID()
    state = runner.graph.updateSupervision(state, { ...state.supervision, roleRunId,
      ...(editingRules ? { hierarchy: { ...flow, ruleDraftRunId: roleRunId } } : {}) })
  }
  const runId = state.supervision.roleRunId, directory = path.join(runner.config.directory, 'revisions', runId)
  // Only final group/root audits receive this capability. Old paused inputs
  // without the marker retain their exact tool contract when resumed.
  const workspace = logicalName === 'group_audit' && messages[0].content.includes(WORKSPACE_AUDIT_MARKER)
    ? workspaceAuditTools(runner, directory, catalog, signal, { images: readRoleRecord(runner, runId)?.imageTools ?? !readRoleRecord(runner, runId) }) : null
  const records = catalog && blockageTools(catalog, directory, signal)
  const editor = editingRules ? layerRuleTools(runner, state, flow.scopeId) : null
  const readOnlyTools = editor ? { tools: [...records.tools, ...editor.tools], execute: (call, _modelConfig, ordinal) => Object.hasOwn(ruleTools, call.function.name) ? editor.execute(call, ordinal) : records.execute(call) } : workspace ? { tools: [...records.tools, ...workspace.tools], auditArtifacts: workspace.auditArtifacts, execute: (tool, modelConfig) =>
    workspace.tools.some(row => row.function.name === tool.function.name) ? workspace.execute(tool, modelConfig) : records.execute(tool) } : records
  try {
    const value = await directRevisionRole(runner, { runId, role: name, messages, signal, validateOutput: true,
      validateResult: value => { const result = validateResult(value, state); workspace?.checkCurrent(result); return result },
      revalidateCompleted: Boolean(workspace), ...(readOnlyTools ? { readOnlyTools } : {}) })
    signal.throwIfAborted()
    if (runner.graph.read().checksum !== state.checksum) fail('HIERARCHY_ROLE_STALE_BASE')
    return { state, value, runId, record: readRoleRecord(runner, runId), ...(workspace ? { workspaceInspection: workspace.index() } : {}) }
  } finally { workspace?.close() }
}
function checkedIssues(value, input) {
  const verdict = scopeAuditSchema.parse(value)
  verdict.issues.forEach((issue, index) => lookupPointer(input, issue.path, `/issues/${index}/path`))
  return verdict
}
function approvedBaseline(runner, review) {
  const record = readRoleRecord(runner, review.runId)
  if (record?.phase !== 'COMPLETE' || record.role !== 'baseline_audit') fail('UNIT_BASELINE_APPROVAL_REQUIRED')
  const input = JSON.parse(record.payload.messages[1].content), verdict = checkedIssues(roleRecordValue(record), input)
  if (verdict.verdict !== 'APPROVE' || digest(verdict) !== record.resultHash || input.baseline.unitId !== review.unitId
      || digest({ scopeId: input.editingScopeId, baseline: input.baseline }) !== review.hash || input.baselineHash !== review.hash)
    fail('UNIT_BASELINE_APPROVAL_CHANGED')
  return { ...review, baseline: input.baseline, reason: verdict.reason }
}
function archiveRework(runner, state, flow, decision, runId) {
  const roundId = `hierarchy_${randomUUID()}`
  const file = path.join(runner.config.directory, 'revisions', runId, 'rework-decision.json')
  const bytes = Buffer.from(JSON.stringify({ roundId, scopeId: flow.scopeId, revision: state.revision, decision }))
  if(hasStored(file)) {
    const prior=readStored(file),stored=JSON.parse(prior)
    if (digest(stored.decision)!==digest(decision) || stored.revision!==state.revision || stored.scopeId!==flow.scopeId)fail('HIERARCHY_REWORK_RECEIPT_CHANGED')
    return {roundId:stored.roundId,ref:{kind:'artifact',ref:file,sha256:createHash('sha256').update(prior).digest('hex')}}
  }
  const saved=writeStored(file,bytes,{exclusive:true})
  if(saved)return {roundId,ref:{kind:'artifact',...saved}}
  const fd=fs.openSync(file,'wx',0o600)
  try {fs.writeFileSync(fd,bytes);fs.fsyncSync(fd)} finally {fs.closeSync(fd)}
  return {roundId,ref:{kind:'artifact',ref:file,sha256:createHash('sha256').update(bytes).digest('hex')}}
}
function commitDecision(runner, checked, flow) {
  const { state, value, runId } = checked
  if (value.action === 'REWORK') {
    const proof = archiveRework(runner, state, { ...flow, scopeId: value.scopeId ?? flow.scopeId }, value, runId)
    runner.graph.reopenReports({ expectedRevision: state.revision, baseChecksum: state.checksum,
      nodeIds: value.report.findings.map(row => row.taskId), decisionId: proof.roundId, evidence: [proof.ref] })
    runner.publish('group-rework')
    return summary(runner, 'REWORKED')
  }
  update(runner, state, { scopeId: value.scopeId ?? flow.scopeId, stage: value.action === 'REBASELINE' ? 'BASELINE_WRITE' : value.action === 'REPLAN' ? 'UPDATE' : 'PAUSE_AUDIT', triggerRunId: runId,
    ...(flow.reviewedScopes ? { reviewedScopes: flow.reviewedScopes } : {}),
    ...(flow.rootReferral ? { rootReferral: flow.rootReferral } : {}),
    ...(value.action === 'REBASELINE' ? { feedback: value.reason } : {}),
    ...(value.action === 'REPLAN' && value.reason ? { blockageSignal: { runId, scopeId: value.scopeId, reason: value.reason } } : {}),
    ...(value.action === 'PAUSE' ? { decision: value } : {}) })
  return null
}
export function publishHierarchyReport(runner, receipt = runner.graph.read()?.supervision.finalReport) {
  if (!receipt || !runner.output) return
  const r = receipt.report, body = [r.title, r.summary,
    ...[['成果', r.achievements], ['验证', r.verification], ['限制', r.limitations], ['后续事项', r.nextSteps]]
      .filter(([, items]) => items.length).map(([label, items]) => `${label}\n${items.map(item => '- ' + item).join('\n')}`)].join('\n\n')
  let deliveryText = ''
  const state = runner.graph.read()
  if (acceptanceEnabled(state)) {
    const root = state.graph.state.plan.nodes.find(node => node.parent === null), group = state.graph.state.hierarchy.groups[effectiveScope(state, root.id)]
    const items = group?.deliveries ?? []
    if (items.length) deliveryText = '\n\n交付入口\n' + items.map(item => '- [' + item.id.replaceAll('[', '').replaceAll(']', '') + '](<' + path.resolve(runner.config.projectRoot, item.path).replaceAll('>', '%3E').replaceAll('<', '%3C').replaceAll('\n', '%0A') + '>)' + (item.userSteps?.length ? '：' + item.userSteps.join('；') : '')).join('\n')
  }
  runner.output.publishText?.({ stage: 'task_reporter', step: 0 }, '完整任务报告', body + deliveryText, 'hierarchy-final:' + receipt.runId)
}
/** Called under the existing direct lease. Each request uses the same pause,
 * compaction, accounting and main-chat observation path as existing roles. */
export async function advanceHierarchy(runner, signal, assertAuthority = () => {}) {
  const attemptedRevisions = new Set()
  for (;;) {
    signal.throwIfAborted(); assertAuthority()
    let state = runner.graph.read()
    const root = state.graph.state.plan.nodes.find(node => node.parent === null)
    if (state.supervision.phase !== 'HIERARCHY') return summary(runner, 'RESULT_COMMITTED')
    const units = state.graph.state.plan.hierarchy.version === 2
    const rootOutcome = units ? runtimeRules(state.graph.state).outcome(root.id) : null
    if (units && rootOutcome && rootOutcome !== 'BLOCK' && runner.config.unitFinalReport === false) {
      runner.graph.updateSupervision(state, { phase: 'READY', outcomes: state.supervision.outcomes })
      return summary(runner, 'ROOT_SETTLED', { rootOutcome })
    }
    if (hierarchyComplete(state.graph.state, root.id) || units && rootOutcome === 'FAILED') {
      const scopeId = effectiveScope(state, root.id), { input, catalog } = hierarchyContext(runner, state, scopeId, { final: true, signal })
      const checked = await role(runner, state, 'task_reporter', HIERARCHY_PROMPTS.task_reporter, input, catalog, value => {
        const report = finalReportSchema.parse(value)
        report.evidence.forEach((ref, i) => verifyReference(ref, catalog, `/evidence/${i}`)); return report
      }, signal)
      assertAuthority()
      const receipt = { runId: checked.runId, inputHash: digest(input), report: checked.value }
      runner.graph.updateSupervision(checked.state, { phase: 'READY', outcomes: checked.state.supervision.outcomes, finalReport: receipt })
      publishHierarchyReport(runner, receipt); runner.publish('task-reported')
      return summary(runner, 'TASK_REPORTED', { goalReached: rootOutcome !== 'FAILED', report: checked.value })
    }
    let flow = state.supervision.hierarchy
    if (flow?.stage === 'UPDATE' && flow.feedback) {
      const signature = digest({ revision: state.revision, scope: flow.scopeId, feedback: flow.feedback, approvals: flow.baselineReviews })
      if (attemptedRevisions.has(signature)) fail('WORKFLOW_NO_PROGRESS', { scopeId: flow.scopeId,
        reason: 'The same plan review feedback returned without a change to the graph or its approvals.' })
      attemptedRevisions.add(signature)
    }
    const gate = state.graph.state.hierarchy.pending
    if (!flow) {
      if (!gate) {
        runner.graph.updateSupervision(state, { phase: 'READY', outcomes: state.supervision.outcomes })
        return summary(runner, 'RESULT_COMMITTED')
      }
      flow = { scopeId: gate.scopeId, stage: 'GATE' }
      state = update(runner, state, flow)
    }
    if (flow.stage === 'WAITING_USER') return summary(runner, 'WAITING_USER', { report: flow.decision.report })
    if (flow.stage === 'UNIT_ROUTE') {
      const task = legalNext(state.graph.state).find(node => node.id === flow.routeTaskId && (units ? node.id : node.parent) === flow.scopeId)
      if (!state.unitRoleVersion || !task) fail('UNIT_ROUTE_NOT_READY')
      const routeInput = unitRouteInput(runner, state, task)
      const checked = await role(runner, state, 'unit_router', UNIT_ROUTE_PROMPT, routeInput,
        null, value => {
          const decision = unitRouteSchema.parse(value)
          if (!routeInput.capacity.allowedActions.includes(decision.action)) fail('UNIT_EXPANSION_CAPACITY_EXHAUSTED')
          return decision
        }, signal)
      assertAuthority()
      if (checked.value.action === 'EXECUTE') return releaseUnit(runner, checked.state, flow, checked.runId)
      update(runner, checked.state, { ...flow, stage: 'UPDATE', routeRunId: checked.runId })
      continue
    }
    // A previously issued v1 ticket retains its exact prompt and tools. A paused boundary without
    // a ticket, or the next diagnostic round, can start at the root under the new protocol.
    if (!units && flow.stage === 'BLOCKAGE' && !flow.reviewedScopes && !state.supervision.roleRunId) {
      flow = globalFlow(state)
      state = update(runner, state, flow)
    }
    const globalHandler = !units && flow.stage === 'BLOCKAGE' && flow.reviewedScopes !== undefined
    const globalPause = flow.stage === 'PAUSE_AUDIT' && Boolean(flow.decision?.scopeId && flow.reviewedScopes)
    if (globalHandler && !flow.rootReferral && (gate || legalNext(state.graph.state).length)) {
      if (gate) update(runner, state, { scopeId: gate.scopeId, stage: 'GATE' })
      else runner.graph.updateSupervision(state, { phase: 'READY', outcomes: state.supervision.outcomes })
      continue
    }
    const diagnosis = globalHandler || globalPause || flow.stage === 'UPDATE' && flow.blockageSignal
      ? diagnoseBlockage(state, undefined, flow.rootReferral) : null
    const { input, catalog } = globalHandler || globalPause
      ? { input: diagnosticInput(state, diagnosis, flow.reviewedScopes), catalog: blockageCatalog(runner, state, signal, diagnosis) }
      : hierarchyContext(runner, state, flow.scopeId, { signal })
    if (flow.feedback) input.priorReview = flow.feedback
    if (units && flow.stage === 'BASELINE_WRITE') {
      const checked = await role(runner, state, 'scope_update', 'UNIT_REBASELINE_V2\n根据证据重建本单元基线，提交 {"baseline":{"conditions":[],"objective":"目标","executionCriteria":["准则"],"acceptanceCriteria":["标准"],"facts":[]},"reason":"具体变更依据"}。保留原始用户合同。', input, catalog, value => {
        const proposal = z.object({ baseline: unitBaselineSchema, reason: z.string().trim().min(1) }).strict().parse(value)
        if (digest(proposal.baseline) === digest(input.unitBaseline)) fail('UNIT_REBASELINE_UNCHANGED')
        return proposal
      }, signal)
      assertAuthority()
      update(runner, checked.state, { ...flow, stage: 'BASELINE_REVIEW', rebaseline: { ...checked.value, authorRunId: checked.runId } })
      continue
    }
    if (units && flow.stage === 'BASELINE_REVIEW') {
      const original = readRoleRecord(runner, flow.rebaseline.authorRunId)
      const { baseline, reason } = flow.rebaseline
      if (original?.phase !== 'COMPLETE' || !['unit_rebaseline', 'scope_update'].includes(original.role) || original.resultHash !== digest({ baseline, reason })) fail('UNIT_BASELINE_CANDIDATE_CHANGED')
      const audit = { contract: input.contract, scopeId: flow.scopeId, baseline: { before: input.unitBaseline, after: baseline }, reason, blueprint: input.blueprint, evidence: input.reports, currentSharedFacts: input.currentSharedFacts ?? [] }
      const checked = await role(runner, state, 'baseline_audit', BASELINE_AUDIT_PROMPT, audit, catalog, value => checkedIssues(value, audit), signal)
      assertAuthority()
      if (checked.value.verdict === 'APPROVE') update(runner, checked.state, { ...flow, stage: 'UPDATE', rebaseline: { ...flow.rebaseline, auditRunId: checked.runId } })
      else { const { rebaseline, ...rest } = flow; update(runner, checked.state, { ...rest, stage: 'BASELINE_WRITE', feedback: JSON.stringify(checked.value) }) }
      continue
    }
    if (flow.stage === 'GATE') {
      if (!gate || gate.scopeId !== flow.scopeId) fail('HIERARCHY_GATE_DISAPPEARED')
      const group = gate.kind === 'GROUP_REVIEW'
      let instruction = HIERARCHY_PROMPTS[group ? 'group_audit' : 'scope_plan']
      if (group) {
        const prior = state.supervision.roleRunId && readRoleRecord(runner, state.supervision.roleRunId)
        if (input.groupRoutes?.length) instruction += '\n组级条件分支按实际终审结果选择。若本组是条件边的来源，已查明的验收标准未满足且超出本组可处理范围，可以提交 {"action":"BLOCKED","summary":"检查结论","unmetCriterion":"未满足的用户标准","scopeBoundary":"为什么应交由后继修复组","evidence":[原始引用]}。只有匹配 blocked 的后继才会启动；没有匹配项时保留受阻结果。列出全部子项时，未选分支用 NOT_SELECTED 并引用 route 记录。'
        const oldPausedInput = prior?.role === 'group_audit' && prior.phase === 'PAUSED' && !JSON.parse(prior.payload.messages[1].content).auditMandate
        if (!oldPausedInput) {
          input.auditMandate = finalAuditMandate(state, flow.scopeId)
          instruction += '\n' + (input.auditMandate.level === 'graph' ? GRAPH_OUTCOME_AUDIT : GROUP_OUTCOME_AUDIT)
        }
      }
      if (group && state.graph.state.plan.ruleVersion) instruction = instruction
        .replaceAll('BLOCKED/FAILED', '由程序判定的 BLOCK 或已确认的 FAILED')
        .replaceAll('COMPLETE', 'PASS').replaceAll('BLOCKED', 'FAILED') +
          '\nRULE_GROUP_AUDIT_V1：验收处置只提交 PASS 或 FAILED。FAILED 给出 summary、unmetCriterion、evidence，引用直属子项。未进入的子项用 NOT_SELECTED，并引用其 route 记录中的 BLOCK 依据。各组单独终审。路线 BLOCK 由程序计算。'
      if (units && group) {
        instruction += '\n提交组审计时先数清本层 children 和合同 requirements。每个必需条目保留一行，已有单条证据足以证明时只引这一条。子单元优先引自己的已审报告；目标优先引直接证明该项的实测结果或交付物。只有结论必须组合多份独立证据时才再加引用。每个 reason 用一句说明事实与条件的对应，quote 截取能定位该事实的连续短原文，散列与路径按工具原值填全。summary 写总判定和仍有的限制。把篇幅留给覆盖所有必需项；近似证据、重复摘要和回执全文无需逐条转录。'
        const terminal = state.graph.state.plan.nodes.find(node => node.id === state.graph.state.plan.nodes.find(row => row.id === flow.scopeId).terminal)
        input.completionRequest = { submittedBy: 'program', terminalUnitId: terminal.id, proposedOutcome: runtimeRules(state.graph.state).outcome(terminal.id) }
      }
      if (units && !group) instruction += '\n复查选 CURRENT、REVIEW_REQUIRED（本层蓝图更新）或 REBASELINE（重建本单元基线），格式 {"verdict":"REBASELINE"}。'
      const checked = await role(runner, state, group ? 'group_audit' : 'scope_plan', instruction, input, catalog,
        value => group ? validateGroup(value, state, flow.scopeId, catalog) : (units ? scopePlanSchema.extend({ verdict: z.enum(['CURRENT', 'REVIEW_REQUIRED', 'REBASELINE']) }) : scopePlanSchema).parse(value), signal)
      assertAuthority()
      if (!group && checked.value.verdict === 'REBASELINE') {
        update(runner, checked.state, { scopeId: flow.scopeId, stage: 'BASELINE_WRITE', triggerRunId: checked.runId }); continue
      }
      if (!group && checked.value.verdict === 'REVIEW_REQUIRED') {
        update(runner, checked.state, { scopeId: flow.scopeId, stage: 'UPDATE', triggerRunId: checked.runId }); continue
      }
      if (group && !['COMPLETE','BLOCKED','PASS','FAILED'].includes(checked.value.action)) {
        const result = commitDecision(runner, checked, flow); if (result) return result; continue
      }
      const routing = group && groupRouting(state.graph.state)
      const report = group ? { outcome: checked.value.action, summary: checked.value.summary, audit: checked.value,
        ...(checked.workspaceInspection ? { workspaceInspection: checked.workspaceInspection } : {}),
        ...(acceptanceEnabled(state) ? { verification: input.publicEvidence.flatMap(row => row.verification), deliveries: input.publicEvidence.find(row => row.taskId === state.graph.state.plan.nodes.find(node => node.id === flow.scopeId).terminal)?.deliveries ?? [] } : {}),
        children: childrenOf(state.graph.state.plan, flow.scopeId).map(node => ({ id: node.id,
          sha256: digest(childUnitResult(state.graph.state, node, routing)) })) } : undefined
      runner.graph.reviewHierarchy({ state: checked.state, scopeId: flow.scopeId, inputHash: scopeSignature(state.graph.state, flow.scopeId), runId: checked.runId, kind: gate.kind, report })
      runner.publish(group ? checked.value.action === 'FAILED' ? 'group-failed' : checked.value.action === 'BLOCKED' ? 'group-blocked' : 'group-accepted' : 'scope-plan-checked'); continue
    }
    if (flow.stage === 'BLOCKAGE') {
      if (globalHandler) {
        const checked = await role(runner, state, 'scope_blockage', globalBlockageInstruction(true), input, catalog,
          value => checkGlobalDecision(value, { state, diagnosis, catalog, reviewedScopes: flow.reviewedScopes }), signal)
        assertAuthority()
        const result = commitDecision(runner, checked, flow); if (result) return result
        continue
      }
      input.situation = situationFor(state, flow.scopeId)
      if (units) input.rebaselineOption = { action: 'REBASELINE', reason: '当前单元基线需重建的依据' }
      const checked = await role(runner, state, 'scope_blockage', (units ? '本层可 REWORK 已审单元及其后继。findings[].taskId 指定单元，attemptId 使用直接执行的尝试 ID 或已展开单元终审的 runId，并引用其已审报告。基线失效时可提交 {"action":"REBASELINE","reason":"证据与原因"}，交由本单元重整并独立审计。\n' : '') + 'DYNAMIC_CONTEXT_SCOPED_BLOCKAGE_V1\n本次仅处理指定层的阻塞；子组内部只按需下钻，不得修改范围外的叶或兄弟组。\n' + BLOCKAGE_INSTRUCTION + '\n' + blockageTemplates,
        input, catalog, value => units && value?.action === 'REBASELINE' ? z.object({ action: z.literal('REBASELINE'), reason: z.string().trim().min(1) }).strict().parse(value) : validateDecision(value, state, flow.scopeId, catalog, false), signal)
      assertAuthority()
      const result = commitDecision(runner, checked, flow); if (result) return result; continue
    }
    if (flow.stage === 'PAUSE_AUDIT') {
      if (flow.triggerRunId) registerWorkspaceReceipts(path.join(runner.config.directory, 'revisions', flow.triggerRunId), catalog)
      if (globalPause) checkGlobalDecision(flow.decision, { state, diagnosis, catalog, reviewedScopes: flow.reviewedScopes })
      else validateDecision(flow.decision, state, flow.scopeId, catalog, false)
      const auditInput = { contract: globalPause ? runner.config.revision.policy : input.contract, scopeId: flow.scopeId, submission: flow.decision.report,
        ...(globalPause ? { situation: diagnosis.situation } : {}),
        evidence: flow.decision.report.constraints.flatMap(row => row.evidence).map(ref => ({ ...verifyReference(ref, catalog, '/submission'), value: lookupPointer(catalog.get(ref.source).load(), ref.path) })) }
      const checked = await role(runner, state, 'scope_pause', BLOCKAGE_AUDIT_INSTRUCTION,
        auditInput, null, value => checkedIssues(value, auditInput), signal)
      assertAuthority()
      if (checked.value.verdict === 'APPROVE') {
        update(runner, checked.state, { ...flow, stage: 'WAITING_USER' }); runner.publish('scope-waiting-user')
        return summary(runner, 'WAITING_USER', { report: flow.decision.report })
      }
      update(runner, checked.state, { ...(gate && !flow.rootReferral ? { scopeId: gate.scopeId, stage: 'GATE' } : globalFlow(state, flow.reviewedScopes)),
        ...(flow.rootReferral ? { rootReferral: flow.rootReferral } : {}), feedback: JSON.stringify({ submission: flow.decision.report, review: checked.value }) }); continue
    }
    if (flow.stage === 'UPDATE') {
      if (flow.routeRunId) {
        const receipt = readRoleRecord(runner, flow.routeRunId)
        if (receipt?.role !== 'unit_router' || receipt.phase !== 'COMPLETE') fail('UNIT_ROUTE_RECEIPT_REQUIRED')
        input.unitRoute = { taskId: flow.routeTaskId, ...unitRouteSchema.parse(roleRecordValue(receipt)) }
      }
      if (flow.baselineReviews?.length) input.approvedBaselines = flow.baselineReviews.map(review => approvedBaseline(runner, review))
      const prior = state.supervision.roleRunId && readRoleRecord(runner, state.supervision.roleRunId)
      const currentProtocol = !prior || !['unit_planner', 'scope_update'].includes(prior.role) || Boolean(JSON.parse(prior.payload.messages[1].content).revisionGuard)
      const outlook = currentProtocol ? revisionOutlook(state.graph.state) : null
      if (currentProtocol) {
        input.revisionGuard = { avoid: 'BLOCK', unchanged: outlook }
        if (flow.blockageSignal) input.blockageSignal = flow.blockageSignal
      }
      if (diagnosis && currentProtocol) {
        const ids = new Set([flow.scopeId, ...descendantsOf(state.graph.state.plan, flow.scopeId).map(node => node.id)])
        input.blockageReason = { code: diagnosis.situation.code, groups: diagnosis.situation.groups.filter(group => ids.has(group.scopeId)) }
      }
      if (units || workspaceLeafTools(runner).length) input.hostAllowedTools = unitBindingTools(runner)
      let instruction = currentProtocol ? HIERARCHY_PROMPTS.scope_update : LEGACY_SCOPE_UPDATE_PROMPT
      if (units) instruction = 'DYNAMIC_CONTEXT_SCOPE_UPDATE_V1\n' + UNIT_PLANNING + '\n' + RULE_GUIDE + '\n' + (flow.routeRunId || flow.rebaseline ? '本轮必须提交 REVISE。' : '保留计划用 NO_CHANGE 与 reason，父层协调可用 ESCALATE 与 reason。')
      if (units && flow.routeRunId) {
        const parent = input.blueprint.value.scope.key
        const evidence = [{ source: input.blueprint.source, sha256: input.blueprint.sha256, path: '/scope/key', quote: parent }]
        const key = 'child_example'
        const template = { action: 'REVISE', terminal: key, nodes: [{ key, parent, kind: 'unit', label: '当前子目标' }], edges: [],
          contextGraph: { nodes: [], bindings: [{ unit: key, instruction: '执行当前子目标', contexts: [], inheritReports: [], tools: [],
            completion: { kind: 'report' }, baseline: { conditions: [], objective: '当前子目标', executionCriteria: ['所需操作'], acceptanceCriteria: ['可观察的结果'], facts: [] } }] },
          modifications: ['/taskGraph/terminal', '/taskGraph/nodes/' + key, '/contextGraph/bindings/' + key].map(path => ({ path, reason: '结合实际合同填写本项原因', evidence })) }
        instruction += '\n本层 REVISE 字段模板（当前作用域标识和证据已填，按真实子项数量展开，替换示例内容）：' + JSON.stringify(template)
      }
      if (units && flow.rebaseline?.auditRunId) {
        const audit = readRoleRecord(runner, flow.rebaseline.auditRunId)
        const value = audit && JSON.parse(audit.payload.messages[1].content)
        if (audit?.phase !== 'COMPLETE' || audit.role !== 'baseline_audit' || value.scopeId !== flow.scopeId ||
            digest(value.baseline.after) !== digest(flow.rebaseline.baseline) || checkedIssues(roleRecordValue(audit), value).verdict !== 'APPROVE') fail('UNIT_BASELINE_APPROVAL_REQUIRED')
        input.approvedUnitBaseline = flow.rebaseline; instruction += '\n在 REVISE.baseline 中原样提交获准基线，编写本层的新一轮子图并指定新一轮可执行的终点。' }
      if (input.unitRoute && !units) instruction += '\n单元路由者请求先规划此单元。核对其理由，提交本层候选蓝图；若现有安排已足够，说明 NO_CHANGE 的依据。'
      if (input.approvedBaselines) instruction += '\n基线已获独立批准。按 approvedBaselines 重新规划本层，提交包含这些基线的完整 REVISE 候选，随后由独立变更审计者核验。'
      const checked = await role(runner, state, 'scope_update', instruction, input, catalog, (value, current) => {
        const result = (currentProtocol ? runtimeScopeProposalSchema : scopeProposalSchema).parse(value)
        if (units && (flow.routeRunId || flow.rebaseline) && result.action !== 'REVISE') fail('UNIT_CHILD_PLAN_REQUIRED')
        if (units && digest(result.baseline ?? null) !== digest(flow.rebaseline?.baseline ?? null)) fail('UNIT_BASELINE_APPROVAL_REQUIRED')
        if (result.action === 'REVISE') {
          const candidate = prepareScopeProposal(runner, current, flow.scopeId, result, catalog)
          if (units && flow.rebaseline && runtimeRules(state.graph.state).outcome(state.graph.state.plan.nodes.find(node => node.key === result.terminal)?.id ?? flow.scopeId) !== null) fail('UNIT_NEW_TERMINAL_REQUIRED')
          if (input.approvedBaselines) {
            const changes = changedUnitBaselines(state, flow.scopeId, candidate)
            if (flow.baselineReviews.some(review => !changes.some(change => change.hash === review.hash)))
              fail('APPROVED_UNIT_BASELINE_REQUIRED', { path: '/modifications', reason: 'The new plan must carry each independently approved unit baseline.', approved: input.approvedBaselines })
          }
          checkRevisionProgress(outlook, result.action, '/modifications', state.graph.state, candidate.prepared.plan)
        } else if (input.approvedBaselines) fail('APPROVED_UNIT_BASELINE_PLAN_REQUIRED', { path: '/action', reason: 'Replan under the approved baseline and submit REVISE.' })
        else if (result.action === 'NO_CHANGE') checkRevisionProgress(outlook, result.action, '/action', state.graph.state)
        else if (!currentProtocol && result.action === 'ESCALATE' && !state.graph.state.plan.nodes.find(node => node.id === flow.scopeId).parent)
          throw located('SCOPE_ALREADY_ROOT', { path: '/action', reason: 'The root has no parent. Revise within the contract, return NO_CHANGE, or request an evidence-backed pause.' })
        else if (result.action === 'PAUSE') validateDecision(result, state, flow.scopeId, catalog, false)
        return result
      }, signal)
      assertAuthority()
      if (checked.value.action === 'ESCALATE') {
        const parent = state.graph.state.plan.nodes.find(node => node.id === flow.scopeId).parent
        const considered = [...new Set([...(flow.reviewedScopes ?? []), flow.scopeId])]
        if (!parent || flow.reviewedScopes?.includes(parent)) {
          update(runner, checked.state, { ...globalFlow(state, considered), rootReferral: { runId: checked.runId, reason: checked.value.reason } })
        } else update(runner, checked.state, { ...flow, scopeId: parent, stage: 'UPDATE', triggerRunId: checked.runId,
          reviewedScopes: considered,
          ...(checked.value.reason ? { feedback: JSON.stringify({ escalatedFrom: flow.scopeId, reason: checked.value.reason }) } : {}) })
        continue
      }
      if (checked.value.action === 'PAUSE') { commitDecision(runner, checked, flow); continue }
      if (checked.value.action === 'NO_CHANGE') {
        if (flow.routeRunId) return releaseUnit(runner, checked.state, flow, flow.routeRunId)
        if (state.graph.state.suspended) {
          runner.graph.updateSupervision(checked.state, { phase: 'READY', outcomes: checked.state.supervision.outcomes })
          return summary(runner, 'GUIDANCE_BLUEPRINT_UNCHANGED')
        }
        if (gate?.kind === 'PLAN_REVIEW' && gate.scopeId === flow.scopeId) {
          runner.graph.reviewHierarchy({ state: checked.state, scopeId: flow.scopeId, inputHash: scopeSignature(state.graph.state, flow.scopeId), runId: checked.runId, kind: gate.kind }); continue
        }
        update(runner, checked.state, gate ? { scopeId: gate.scopeId, stage: 'GATE', feedback: JSON.stringify(checked.value) }
          : globalFlow(state, [...new Set([...(flow.reviewedScopes ?? []), flow.scopeId])])); continue
      }
      const candidate = state.unitRoleVersion && prepareScopeProposal(runner, checked.state, flow.scopeId, checked.value, catalog)
      const missing = candidate && pendingBaselineChanges(checked.state, flow, candidate)[0]
      update(runner, checked.state, { ...checked.state.supervision.hierarchy, stage: missing ? 'BASELINE_AUDIT' : 'UPDATE_AUDIT',
        ...(missing ? { baselineUnitId: missing.baseline.unitId, baselineCandidateHash: missing.hash } : {}),
        updaterRunId: checked.runId, proposalHash: digest(checked.value) }); continue
    }
    if (flow.stage === 'UPDATE_AUDIT' || flow.stage === 'BASELINE_AUDIT') {
      const record = readRoleRecord(runner, flow.updaterRunId)
      if (record?.phase !== 'COMPLETE' || !(units && (flow.routeRunId || flow.rebaseline) ? ['unit_planner', 'scope_update'] : ['scope_update']).includes(record.role)) fail('SCOPED_UPDATER_RECEIPT_REQUIRED')
      const value = roleRecordValue(record)
      if (digest(value) !== flow.proposalHash || record.resultHash !== flow.proposalHash) fail('SCOPED_UPDATER_RECEIPT_CHANGED')
      const candidate = prepareScopeProposal(runner, state, flow.scopeId, value, catalog)
      if (flow.stage === 'BASELINE_AUDIT') {
        const changes = pendingBaselineChanges(state, flow, candidate)
        const pending = changes.find(change => change.baseline.unitId === flow.baselineUnitId &&
          (!flow.baselineCandidateHash || change.hash === flow.baselineCandidateHash))
        if (!pending && !flow.baselineCandidateHash && flow.rebaseline?.auditRunId && flow.baselineUnitId === flow.scopeId) {
          // Older checkpoints may have queued the already-approved parent.
          const { baselineUnitId, updaterRunId, proposalHash, ...rest } = flow
          const next = changes[0]
          update(runner, state, next ? { ...flow, baselineUnitId: next.baseline.unitId, baselineCandidateHash: next.hash }
            : { ...rest, stage: 'UPDATE' }); continue
        }
        if (!pending || !state.unitRoleVersion) fail('UNIT_BASELINE_CANDIDATE_CHANGED')
        const audit = baselineAuditInput(runner, state, flow.scopeId, pending, catalog)
        const checked = await role(runner, state, 'baseline_audit', BASELINE_AUDIT_PROMPT, audit, null,
          result => checkedIssues(result, audit), signal)
        assertAuthority()
        const { baselineUnitId, baselineCandidateHash, baselineReviews = [], updaterRunId, proposalHash, ...rest } = flow
        if (checked.value.verdict === 'REJECT') {
          update(runner, checked.state, { ...rest, stage: 'UPDATE', feedback: JSON.stringify({ baseline: pending.baseline, review: checked.value }) })
          continue
        }
        const reviews = [...baselineReviews, { unitId: baselineUnitId, hash: pending.hash, runId: checked.runId }]
        const next = pendingBaselineChanges(state, { ...flow, baselineReviews: reviews }, candidate)[0]
        update(runner, checked.state, next
          ? { ...flow, baselineReviews: reviews, baselineUnitId: next.baseline.unitId, baselineCandidateHash: next.hash }
          : { ...rest, stage: 'UPDATE', baselineReviews: reviews })
        continue
      }
      if (state.unitRoleVersion && pendingBaselineChanges(state, flow, candidate).length) fail('UNIT_BASELINE_APPROVAL_REQUIRED')
      const auditInput = { contract: input.contract, acceptance: input.acceptance, scopeId: flow.scopeId,
        ...(flow.blockageSignal ? { blockageSignal: flow.blockageSignal } : {}),
        ...(flow.baselineReviews ? { approvedBaselines: flow.baselineReviews.map(review => approvedBaseline(runner, review)) } : {}),
        ...(units ? { unitPlan: candidate.proposal, unitBaseline: input.unitBaseline, approvedUnitBaseline: flow.rebaseline ?? null } : {}), modificationReport: value.modifications, changes: candidate.changes,
        contextUse: candidate.contextUse,
        evidence: value.modifications.flatMap(row => row.evidence).map(ref => ({ ...ref, value: lookupPointer(catalog.get(ref.source).load(), ref.path) })),
        programValidation: { passed: true, privateSubtreesRetained: true, scopeBounded: true, executedHistoryRetained: true, hostPermissionsRetained: true } }
      const checked = await role(runner, state, 'scope_audit', HIERARCHY_PROMPTS.scope_audit, auditInput, null, value => checkedIssues(value, auditInput), signal)
      assertAuthority()
      if (checked.value.verdict === 'REJECT') {
        const { updaterRunId, proposalHash, baselineReviews, ...investigation } = flow
        update(runner, checked.state, { ...investigation, stage: 'UPDATE', feedback: JSON.stringify({ proposal: value, review: checked.value }) }); continue
      }
      // Preparing against the checksum after the auditor was registered is
      // intentional; the graph and context identities are revalidated unchanged.
      const fresh = prepareScopeProposal(runner, checked.state, flow.scopeId, value, catalog)
      runner.graph.commitRevision({ expectedRevision: checked.state.revision, prepared: fresh.prepared, review: {
        verdict: 'APPROVE', baseRevision: checked.state.revision, planChecksum: digest(fresh.prepared.plan), proposalHash: digest(value), proposal: value,
        preparedHash: digest(fresh.prepared), updaterRunId: flow.updaterRunId, reviewerRunId: checked.runId,
        scopeSignal: { scopeId: flow.scopeId, proposalHash: flow.proposalHash,
          ...(flow.rebaseline ? { rebaseline: flow.rebaseline } : {}), ...(flow.baselineReviews ? { baselineReviews: flow.baselineReviews } : {}),
          ...(flow.blockageSignal ? { blockageRunId: flow.blockageSignal.runId, reason: flow.blockageSignal.reason } : {}) },
      } })
      runner.publish('scope-revised'); continue
    }
    fail('HIERARCHY_UNKNOWN_PHASE')
  }
}
export function beginHierarchyBlockage(runner, { expectedRevision, baseChecksum, resume = false }) {
  let state = runner.graph.read()
  if (!isHierarchical(state.graph.state.plan) || state.revision !== expectedRevision || state.checksum !== baseChecksum || state.graph.state.active)
    fail('HIERARCHY_BLOCKAGE_STALE')
  if (state.supervision.hierarchy?.stage === 'WAITING_USER') {
    if (!resume) return false
    const gate = state.graph.state.hierarchy.pending
    update(runner, state, gate ? { scopeId: gate.scopeId, stage: 'GATE' } : globalFlow(state)); return true
  }
  if (hierarchyComplete(state.graph.state, state.graph.state.plan.nodes.find(node => node.parent === null).id)) fail('HIERARCHY_ALREADY_COMPLETE')
  if (state.supervision.phase !== 'READY' || runner.graph.status(state).legalNext.length && !stalledUnitScope(state.graph.state)) fail('HIERARCHY_BLOCKAGE_NOT_QUIESCENT')
  update(runner, state, globalFlow(state)); return true
}
