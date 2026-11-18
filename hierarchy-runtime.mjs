import { acceptanceEnabled, acceptancePlan } from './acceptance-protocol.mjs'
// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs'
import { roleMessagesMatch, roleInputsMatch, leafBindingTools, workspaceLeafTools } from './role-policy.mjs'
import { withUserGuidance } from './guidance-state.mjs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { digest, canonical } from 'dsh-better-task-grapth/core'
import { isHierarchical, aliasScopes, childrenOf, descendantsOf, hierarchyComplete, hierarchyFocus, scopeSignature } from 'dsh-better-task-grapth/hierarchy'
import { located, parseModelJSON } from 'dsh-better-task-grapth/validation'
import { directRevisionRole, readRoleRecord, roleRecordValue } from './revision-runtime.mjs'
import { HIERARCHY_PROMPTS, groupAuditSchema, scopePlanSchema, scopeProposalSchema, scopeAuditSchema, finalReportSchema } from './hierarchy-protocol.mjs'
import { hierarchyContext, effectiveScope, finalAuditMandate, prepareScopeProposal, terminalLeaf } from './hierarchy-context.mjs'
import { blockageTools } from './blockage-evidence.mjs'
import { workspaceAuditTools, registerWorkspaceReceipts, WORKSPACE_AUDIT_MARKER } from './workspace-audit.mjs'
import { GROUP_OUTCOME_AUDIT, GRAPH_OUTCOME_AUDIT } from './work-quality.mjs'
import { blockageDecisionSchema, validateBlockageDecision, verifyReference, lookupPointer, BLOCKAGE_INSTRUCTION, BLOCKAGE_AUDIT_INSTRUCTION, blockageTemplates } from './blockage-protocol.mjs'
import { fail } from './core.mjs'

const summary = (runner, status, extra = {}) => ({ status, revision: runner.graph.read().revision, supervision: runner.supervisionStatus(), ...extra })
const pendingState = (state, flow) => ({ phase: 'HIERARCHY', outcomes: state.supervision.outcomes, ...(flow ? { hierarchy: flow } : {}) })
function update(runner, state, flow) { return runner.graph.updateSupervision(state, pendingState(state, flow)) }
function situationFor(state, scopeId, terminalOnly = false) {
  const nodes = descendantsOf(state.graph.state.plan, scopeId)
  const related = nodes.map(node => node.id)
  const causes = terminalOnly ? [terminalLeaf(state.graph.state.plan, scopeId).id] : childrenOf(state.graph.state.plan, scopeId)
    .filter(node => ['INCOMPLETE', 'SKIPPED'].includes(state.graph.state.leaves[node.id]?.status)).map(node => node.id)
  return { code: 'SCOPED_BLOCKAGE', scopeId, causes, related }
}
function validateDecision(value, state, scopeId, catalog, terminalOnly) {
  const decision = blockageDecisionSchema.parse(value), situation = situationFor(state, scopeId, terminalOnly)
  if (terminalOnly && decision.action === 'REWORK' && decision.report.findings.some(row => !situation.causes.includes(row.taskId)))
    throw located('GROUP_REWORK_TERMINAL_ONLY', { path: '/report/findings', reason: 'This final audit can return only the terminal work unit. Other changes require scoped replanning.', allowed: situation.causes })
  return validateBlockageDecision(decision, { state, situation, catalog })
}
function validateGroup(value, state, scopeId, catalog) {
  const result = groupAuditSchema.parse(value)
  if (result.action !== 'COMPLETE') return validateDecision(result, state, scopeId, catalog, true)
  const nodes = childrenOf(state.graph.state.plan, scopeId)
  if (canonical(result.children.map(row => row.nodeId).sort()) !== canonical(nodes.map(node => node.id).sort()))
    throw located('GROUP_AUDIT_COVERAGE_REQUIRED', { path: '/children', reason: 'Explain every direct child exactly once.', required: nodes.map(node => node.id) })
  for (const [i, row] of result.children.entries()) {
    if (!hierarchyComplete(state.graph.state, row.nodeId) && row.conclusion !== 'ACCEPTED_LIMITATION')
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
  if (acceptanceEnabled(state)) instruction += '\nDYNAMIC_CONTEXT_ACCEPTANCE_V1\ncurrentSharedFacts 是最新事实，蓝图原始内容仅供结构与 retain 身份使用。按原始用户目标检查 verificationPlan 和 publicEvidence，不能把 DESIGN 数量指标替代 USER 体验目标。核对验证方法、真实接口/模拟边界、消费者目录是否从实际交付物开始、入口与依赖是否齐备。组 COMPLETE 增加 goalCoverage 数组：每项 {"requirementId":"user_goal","conclusion":"SUPPORTED","reason":"证据支持范围","evidence":[实际source引用]}，conclusion 可为 LIMITED 或 NOT_APPLICABLE；有效根覆盖所有需求，其余组覆盖适用需求。固定合同不允许的未证实必需目标不能当作完成。任务报告者仍只总结已审结果；给出 publicEvidence 中的实际交付路径、使用步骤与外部依赖，禁止把历史产物当作最新交付。'
  let messages = withUserGuidance(runner, name, [{ role: 'system', content: instruction }, { role: 'user', content: JSON.stringify(input) }])
  const prior = state.supervision.roleRunId && readRoleRecord(runner, state.supervision.roleRunId)
  if (prior?.phase === 'PAUSED' && prior.role === name && roleInputsMatch(prior, messages)) messages = prior.payload.messages
  const valid = prior && prior.role === name && roleMessagesMatch(prior, messages)
    && !['INVALID_RESPONSE', 'ABANDONED_UNVERIFIED'].includes(prior.phase)
  if (!valid) state = runner.graph.updateSupervision(state, { ...state.supervision, roleRunId: `revision_${name}_${randomUUID()}` })
  const runId = state.supervision.roleRunId, directory = path.join(runner.config.directory, 'revisions', runId)
  // Only final group/root audits receive this capability. Old paused inputs
  // without the marker retain their exact tool contract when resumed.
  const workspace = name === 'group_audit' && messages[0].content.includes(WORKSPACE_AUDIT_MARKER)
    ? workspaceAuditTools(runner, directory, catalog, signal, { images: readRoleRecord(runner, runId)?.imageTools ?? !readRoleRecord(runner, runId) }) : null
  const records = catalog && blockageTools(catalog, directory, signal)
  const readOnlyTools = workspace ? { tools: [...records.tools, ...workspace.tools], auditArtifacts: workspace.auditArtifacts, execute: tool =>
    workspace.tools.some(row => row.function.name === tool.function.name) ? workspace.execute(tool) : records.execute(tool) } : records
  try {
    const value = await directRevisionRole(runner, { runId, role: name, messages, signal, validateOutput: true,
      validateResult: value => { const result = validateResult(value); workspace?.checkCurrent(result); return result },
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
function archiveRework(runner, state, flow, decision, runId) {
  const roundId = `hierarchy_${randomUUID()}`
  const file = path.join(runner.config.directory, 'revisions', runId, 'rework-decision.json')
  const bytes = Buffer.from(JSON.stringify({ roundId, scopeId: flow.scopeId, revision: state.revision, decision }))
  if (fs.existsSync(file) && !fs.readFileSync(file).equals(bytes)) {
    const stored = JSON.parse(fs.readFileSync(file))
    if (digest(stored.decision) !== digest(decision) || stored.revision !== state.revision || stored.scopeId !== flow.scopeId) fail('HIERARCHY_REWORK_RECEIPT_CHANGED')
    return { roundId: stored.roundId, ref: { kind: 'artifact', ref: file, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') } }
  }
  const fd = fs.openSync(file, 'wx', 0o600)
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  return { roundId, ref: { kind: 'artifact', ref: file, sha256: createHash('sha256').update(bytes).digest('hex') } }
}
function commitDecision(runner, checked, flow) {
  const { state, value, runId } = checked
  if (value.action === 'REWORK') {
    const proof = archiveRework(runner, state, flow, value, runId)
    runner.graph.reopenReports({ expectedRevision: state.revision, baseChecksum: state.checksum,
      nodeIds: value.report.findings.map(row => row.taskId), decisionId: proof.roundId, evidence: [proof.ref] })
    runner.publish('group-rework')
    return summary(runner, 'REWORKED')
  }
  update(runner, state, { scopeId: flow.scopeId, stage: value.action === 'REPLAN' ? 'UPDATE' : 'PAUSE_AUDIT', triggerRunId: runId,
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
  for (;;) {
    signal.throwIfAborted(); assertAuthority()
    let state = runner.graph.read()
    const root = state.graph.state.plan.nodes.find(node => node.parent === null)
    if (state.supervision.phase !== 'HIERARCHY') return summary(runner, 'RESULT_COMMITTED')
    if (hierarchyComplete(state.graph.state, root.id)) {
      const scopeId = effectiveScope(state, root.id), { input, catalog } = hierarchyContext(runner, state, scopeId, { final: true, signal })
      const checked = await role(runner, state, 'task_reporter', HIERARCHY_PROMPTS.task_reporter, input, catalog, value => {
        const report = finalReportSchema.parse(value)
        report.evidence.forEach((ref, i) => verifyReference(ref, catalog, `/evidence/${i}`)); return report
      }, signal)
      assertAuthority()
      const receipt = { runId: checked.runId, inputHash: digest(input), report: checked.value }
      runner.graph.updateSupervision(checked.state, { phase: 'READY', outcomes: checked.state.supervision.outcomes, finalReport: receipt })
      publishHierarchyReport(runner, receipt); runner.publish('task-reported')
      return summary(runner, 'TASK_REPORTED', { goalReached: true, report: checked.value })
    }
    let flow = state.supervision.hierarchy
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
    const { input, catalog } = hierarchyContext(runner, state, flow.scopeId, { signal })
    if (flow.feedback) input.priorReview = flow.feedback
    if (flow.stage === 'GATE') {
      if (!gate || gate.scopeId !== flow.scopeId) fail('HIERARCHY_GATE_DISAPPEARED')
      const group = gate.kind === 'GROUP_REVIEW'
      let instruction = HIERARCHY_PROMPTS[group ? 'group_audit' : 'scope_plan']
      if (group) {
        const prior = state.supervision.roleRunId && readRoleRecord(runner, state.supervision.roleRunId)
        const oldPausedInput = prior?.role === 'group_audit' && prior.phase === 'PAUSED' && !JSON.parse(prior.payload.messages[1].content).auditMandate
        if (!oldPausedInput) {
          input.auditMandate = finalAuditMandate(state, flow.scopeId)
          instruction += '\n' + (input.auditMandate.level === 'graph' ? GRAPH_OUTCOME_AUDIT : GROUP_OUTCOME_AUDIT)
        }
      }
      const checked = await role(runner, state, group ? 'group_audit' : 'scope_plan', instruction, input, catalog,
        value => group ? validateGroup(value, state, flow.scopeId, catalog) : scopePlanSchema.parse(value), signal)
      assertAuthority()
      if (!group && checked.value.verdict === 'REVIEW_REQUIRED') {
        update(runner, checked.state, { scopeId: flow.scopeId, stage: 'UPDATE', triggerRunId: checked.runId }); continue
      }
      if (group && checked.value.action !== 'COMPLETE') {
        const result = commitDecision(runner, checked, flow); if (result) return result; continue
      }
      const report = group ? { outcome: 'COMPLETE', summary: checked.value.summary, audit: checked.value,
        ...(checked.workspaceInspection ? { workspaceInspection: checked.workspaceInspection } : {}),
        ...(acceptanceEnabled(state) ? { verification: input.publicEvidence.flatMap(row => row.verification), deliveries: input.publicEvidence.find(row => row.taskId === state.graph.state.plan.nodes.find(node => node.id === flow.scopeId).terminal)?.deliveries ?? [] } : {}),
        children: childrenOf(state.graph.state.plan, flow.scopeId).map(node => ({ id: node.id,
          sha256: digest(node.kind === 'leaf' ? state.graph.state.leaves[node.id] : state.graph.state.hierarchy.groups[node.id]) })) } : undefined
      runner.graph.reviewHierarchy({ state: checked.state, scopeId: flow.scopeId, inputHash: scopeSignature(state.graph.state, flow.scopeId), runId: checked.runId, kind: gate.kind, report })
      runner.publish(group ? 'group-accepted' : 'scope-plan-checked'); continue
    }
    if (flow.stage === 'BLOCKAGE') {
      input.situation = situationFor(state, flow.scopeId)
      const checked = await role(runner, state, 'scope_blockage', 'DYNAMIC_CONTEXT_SCOPED_BLOCKAGE_V1\n本次仅处理指定层的阻塞；子组内部只按需下钻，不得修改范围外的叶或兄弟组。\n' + BLOCKAGE_INSTRUCTION + '\n' + blockageTemplates,
        input, catalog, value => validateDecision(value, state, flow.scopeId, catalog, false), signal)
      assertAuthority()
      const result = commitDecision(runner, checked, flow); if (result) return result; continue
    }
    if (flow.stage === 'PAUSE_AUDIT') {
      if (flow.triggerRunId) registerWorkspaceReceipts(path.join(runner.config.directory, 'revisions', flow.triggerRunId), catalog)
      validateDecision(flow.decision, state, flow.scopeId, catalog, false)
      const auditInput = { contract: input.contract, scopeId: flow.scopeId, submission: flow.decision.report,
        evidence: flow.decision.report.constraints.flatMap(row => row.evidence).map(ref => ({ ...verifyReference(ref, catalog, '/submission'), value: lookupPointer(catalog.get(ref.source).load(), ref.path) })) }
      const checked = await role(runner, state, 'scope_pause', BLOCKAGE_AUDIT_INSTRUCTION,
        auditInput, null, value => checkedIssues(value, auditInput), signal)
      assertAuthority()
      if (checked.value.verdict === 'APPROVE') {
        update(runner, checked.state, { ...flow, stage: 'WAITING_USER' }); runner.publish('scope-waiting-user')
        return summary(runner, 'WAITING_USER', { report: flow.decision.report })
      }
      update(runner, checked.state, { scopeId: gate?.scopeId ?? flow.scopeId, stage: gate ? 'GATE' : 'BLOCKAGE', feedback: JSON.stringify(checked.value) }); continue
    }
    if (flow.stage === 'UPDATE') {
      if (workspaceLeafTools(runner).length) input.hostAllowedTools = leafBindingTools(runner)
      const checked = await role(runner, state, 'scope_update', HIERARCHY_PROMPTS.scope_update, input, catalog, value => {
        const result = scopeProposalSchema.parse(value)
        if (result.action === 'REVISE') prepareScopeProposal(runner, state, flow.scopeId, result, catalog)
        else if (result.action === 'ESCALATE' && !state.graph.state.plan.nodes.find(node => node.id === flow.scopeId).parent)
          throw located('SCOPE_ALREADY_ROOT', { path: '/action', reason: 'The root has no parent. Revise within the contract, return NO_CHANGE, or request an evidence-backed pause.' })
        else if (result.action === 'PAUSE') validateDecision(result, state, flow.scopeId, catalog, false)
        return result
      }, signal)
      assertAuthority()
      if (checked.value.action === 'ESCALATE') {
        const parent = state.graph.state.plan.nodes.find(node => node.id === flow.scopeId).parent
        update(runner, checked.state, { scopeId: parent, stage: 'UPDATE', triggerRunId: checked.runId }); continue
      }
      if (checked.value.action === 'PAUSE') { commitDecision(runner, checked, flow); continue }
      if (checked.value.action === 'NO_CHANGE') {
        if (state.graph.state.suspended) {
          runner.graph.updateSupervision(checked.state, { phase: 'READY', outcomes: checked.state.supervision.outcomes })
          return summary(runner, 'GUIDANCE_BLUEPRINT_UNCHANGED')
        }
        if (gate?.kind === 'PLAN_REVIEW' && gate.scopeId === flow.scopeId) {
          runner.graph.reviewHierarchy({ state: checked.state, scopeId: flow.scopeId, inputHash: scopeSignature(state.graph.state, flow.scopeId), runId: checked.runId, kind: gate.kind }); continue
        }
        update(runner, checked.state, { scopeId: gate?.scopeId ?? flow.scopeId, stage: gate ? 'GATE' : 'BLOCKAGE', feedback: JSON.stringify(checked.value) }); continue
      }
      update(runner, checked.state, { ...flow, stage: 'UPDATE_AUDIT', updaterRunId: checked.runId, proposalHash: digest(checked.value) }); continue
    }
    if (flow.stage === 'UPDATE_AUDIT') {
      const record = readRoleRecord(runner, flow.updaterRunId)
      if (record?.phase !== 'COMPLETE' || record.role !== 'scope_update') fail('SCOPED_UPDATER_RECEIPT_REQUIRED')
      const value = roleRecordValue(record)
      if (digest(value) !== flow.proposalHash || record.resultHash !== flow.proposalHash) fail('SCOPED_UPDATER_RECEIPT_CHANGED')
      const candidate = prepareScopeProposal(runner, state, flow.scopeId, value, catalog)
      const auditInput = { contract: input.contract, acceptance: input.acceptance, scopeId: flow.scopeId,
        modificationReport: value.modifications, changes: candidate.changes,
        contextUse: candidate.contextUse,
        evidence: value.modifications.flatMap(row => row.evidence).map(ref => ({ ...ref, value: lookupPointer(catalog.get(ref.source).load(), ref.path) })),
        programValidation: { passed: true, privateSubtreesRetained: true, scopeBounded: true, executedHistoryRetained: true, hostPermissionsRetained: true } }
      const checked = await role(runner, state, 'scope_audit', HIERARCHY_PROMPTS.scope_audit, auditInput, null, value => checkedIssues(value, auditInput), signal)
      assertAuthority()
      if (checked.value.verdict === 'REJECT') {
        update(runner, checked.state, { scopeId: flow.scopeId, stage: 'UPDATE', triggerRunId: flow.triggerRunId, feedback: JSON.stringify({ proposal: value, review: checked.value }) }); continue
      }
      // Preparing against the checksum after the auditor was registered is
      // intentional; the graph and context identities are revalidated unchanged.
      const fresh = prepareScopeProposal(runner, checked.state, flow.scopeId, value, catalog)
      runner.graph.commitRevision({ expectedRevision: checked.state.revision, prepared: fresh.prepared, review: {
        verdict: 'APPROVE', baseRevision: checked.state.revision, planChecksum: digest(fresh.prepared.plan), proposalHash: digest(value), proposal: value,
        preparedHash: digest(fresh.prepared), updaterRunId: flow.updaterRunId, reviewerRunId: checked.runId,
        scopeSignal: { scopeId: flow.scopeId, proposalHash: flow.proposalHash },
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
    const { scopeId } = state.supervision.hierarchy
    const gate = state.graph.state.hierarchy.pending
    update(runner, state, { scopeId: gate?.scopeId ?? scopeId, stage: gate ? 'GATE' : 'BLOCKAGE' }); return true
  }
  if (hierarchyComplete(state.graph.state, state.graph.state.plan.nodes.find(node => node.parent === null).id)) fail('HIERARCHY_ALREADY_COMPLETE')
  if (state.supervision.phase !== 'READY' || runner.graph.status(state).legalNext.length) fail('HIERARCHY_BLOCKAGE_NOT_QUIESCENT')
  update(runner, state, { scopeId: hierarchyFocus(state.graph.state), stage: 'BLOCKAGE' }); return true
}
