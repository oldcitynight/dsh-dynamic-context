// SPDX-License-Identifier: GPL-3.0-only
import { legalNext, reworkClosure, revisionOutlook } from 'dsh-better-task-grapth/core'
import { ancestorsOf, descendantsOf, hierarchyComplete, hierarchyPrerequisiteSatisfied, groupRouting, isHierarchical, terminalDependencyIssue } from 'dsh-better-task-grapth/hierarchy'
import { located } from 'dsh-better-task-grapth/validation'
import { z } from 'zod'
import { globalDecisionOptions, validateBlockageDecision } from './blockage-protocol.mjs'

export const REVISION_PROGRESS_RULE = 'DYNAMIC_CONTEXT_REVISION_PROGRESS_V1\n以恢复可执行路径并满足原验收目标为前提，在有效方案中选改动最小的一个。先沿实际状态推演：维持现状，下一项可以执行的工作、合法终审或完成条件是什么？避免进入或再次进入 BLOCK。若现有前置会导致没有合法下一叶，保留旧结构、只改措辞或把缺口留给下游均不足以交差。需要跨层时申请上移；确实缺少外部条件时随转交说明实证，由阻塞处理者决定是否申请人工恢复。阻塞处理者的 reason 是调查意见，结合程序信号及原始证据独立核实。'
export function checkRevisionProgress(outlook, action, path, graph, preparedPlan) {
  if (!outlook || ['ACTIVE','SUSPENDED'].includes(outlook.status)) return
  if (action === 'NO_CHANGE' && outlook.status === 'NO_READY_LEAF') throw located('BLUEPRINT_UNCHANGED_WOULD_BLOCK', { path, observed: action, outlook,
    reason: 'The unchanged graph has no legal continuation after review. Propose a sufficient repair, escalate to the responsible layer, or hand the external constraint back to the investigator at the root.' })
  if (!preparedPlan) return
  const after = revisionOutlook(graph, preparedPlan)
  if (after.status !== 'NO_READY_LEAF') return
  if (outlook.status !== 'NO_READY_LEAF') throw located('BLUEPRINT_REVISION_INTRODUCES_BLOCK', { path, observed: after,
    reason: 'The existing graph could proceed after review, but this candidate would leave it unfinished with no legal continuation.' })
  // A graph may contain independent blockers. An effective partial repair can clear
  // one actual blocking result even while serial scheduling still waits on another.
  const remaining = new Set(after.blockedEdges.map(edge => edge.from))
  if (outlook.blockedEdges.some(edge => !remaining.has(edge.from))) return
  throw located('BLUEPRINT_REVISION_STILL_BLOCKED', { path, observed: after,
    reason: 'The candidate still has no next work or review and clears none of the original blocking results. Correct the blocked dependency, escalate, or document the external constraint.' })
}

const byId = (a, b) => a.id.localeCompare(b.id)
const failedDisposition = status => status === 'INCOMPLETE' || status === 'SKIPPED'

// Built from the committed scheduler state only. No reports, working files or trace headers are read here.
export function diagnoseBlockage(state, flatSituation, referral) {
  const graph = state.graph.state, { plan, leaves } = graph, hierarchical = isHierarchical(plan)
  const planIssue = terminalDependencyIssue(plan)
  const nodes = new Map(plan.nodes.map(node => [node.id, node]))
  const root = plan.nodes.find(node => node.parent === null)
  const groups = plan.nodes.filter(node => node.kind === 'container').sort(byId)
  const children = new Map(groups.map(group => [group.id, []]))
  const dependencies = new Map(plan.nodes.map(node => [node.id, []]))
  const requiredBy = new Map()
  const reported = new Map((state.supervision?.outcomes ?? []).map(row => [row.attemptId, row.result?.outcome]))
  for (const node of plan.nodes) if (node.parent) children.get(node.parent).push(node)
  for (const edge of plan.edges) if (edge.kind === 'prerequisite') dependencies.get(edge.to).push(edge.from)
  const completed = node => hierarchical ? hierarchyComplete(graph, node.id)
    : node.kind === 'leaf' ? leaves[node.id].status === 'COMPLETE' : children.get(node.id).every(completed)
  const routing = groupRouting(graph)
  const open = node => routing?.branch(node.id) !== 'NOT_SELECTED' && (node.kind === 'container' ? !graph.hierarchy?.groups[node.id] && !completed(node) : leaves[node.id].status === 'PENDING')
  const unmet = new Map()
  for (const node of plan.nodes) {
    if (!node.parent) { unmet.set(node.id, []); continue }
    const parent = nodes.get(node.parent)
    const failed = routing ? routing.unmet(node.id).sort() : dependencies.get(node.id).filter(id => hierarchical
      ? !hierarchyPrerequisiteSatisfied(graph, parent, node, nodes.get(id)) : !completed(nodes.get(id))).sort()
    unmet.set(node.id, failed)
    if (open(node) && !completed(parent)) for (const id of failed) {
      if (!requiredBy.has(id)) requiredBy.set(id, [])
      requiredBy.get(id).push(node.id)
    }
  }
  const causes = new Set(flatSituation?.causes ?? [])
  const decisionScopes = new Set()
  if (planIssue) {
    const owner = groups.find(group => group.key === planIssue.scope)
    for (const scope of [owner, ...ancestorsOf(plan, owner.id)]) decisionScopes.add(scope.id)
  }
  const summaries = []
  for (const group of groups) {
    if (completed(group) || routing && (graph.hierarchy.groups[group.id] || routing.branch(group.id) === 'NOT_SELECTED') || ancestorsOf(plan, group.id).some(completed)) continue
    const units = children.get(group.id), parentWait = ancestorsOf(plan, group.id).find(node => unmet.get(node.id).length)
    const blockers = units.filter(node => failedDisposition(leaves[node.id]?.status)
      && (requiredBy.has(node.id) || node.id === group.terminal || causes.has(node.id))).sort(byId)
    const pending = units.filter(open)
    const waitingOn = unmet.get(group.id)
    for (const node of blockers) causes.add(node.id)
    if (blockers.length) for (const owner of [group, ...ancestorsOf(plan, group.id)]) decisionScopes.add(owner.id)
    const reason = blockers.length ? 'UNSATISFIED_DISPOSITION' : waitingOn.length ? 'GROUP_PREREQUISITE'
      : parentWait ? 'ANCESTOR_PREREQUISITE' : pending.some(node => node.kind === 'container') ? 'CHILD_GROUP_UNFINISHED'
      : pending.some(node => !unmet.get(node.id).length) ? 'AWAITING_SERIAL_DISPATCH' : 'NO_READY_CHILD'
    summaries.push({ scopeId: group.id, key: group.key, reason, pendingChildren: pending.length,
      ...(waitingOn.length ? { waitingOn } : {}), ...(parentWait ? { waitingThrough: parentWait.id } : {}),
      blockers: blockers.map(node => ({ taskId: node.id, key: node.key, status: leaves[node.id].status,
        disposition: leaves[node.id].disposition, reportedOutcome: reported.get(leaves[node.id].attemptId), attemptId: leaves[node.id].attemptId ?? null,
        requiredBy: (requiredBy.get(node.id) ?? []).sort() })) })
  }
  if (!decisionScopes.size) {
    decisionScopes.add(root.id)
    for (const group of summaries) if (group.reason === 'NO_READY_CHILD') decisionScopes.add(group.scopeId)
  }
  const outlook = referral && revisionOutlook(graph)
  if (referral && graph.hierarchy?.pending) {
    const gate = graph.hierarchy.pending
    for (const group of [nodes.get(gate.scopeId), ...ancestorsOf(plan, gate.scopeId)]) decisionScopes.add(group.id)
  }
  function topology(id = root.id) {
    const scope = nodes.get(id) ?? groups.find(group => group.key === id)
    if (!scope || scope.kind !== 'container') throw located('BLOCKAGE_TOPOLOGY_SCOPE_UNKNOWN', {
      path: '/scopeId', reason: 'Use a container ID or key from this workflow; omit scopeId for its root.', observed: id })
    const units = children.get(scope.id)
    return { scope: { id: scope.id, key: scope.key, label: scope.label, parentId: scope.parent, terminalId: scope.terminal ?? null,
        acceptance: scope.acceptance ?? null }, ancestors: ancestorsOf(plan, scope.id).map(node => ({ id: node.id, key: node.key })),
      prerequisites: dependencies.get(scope.id), unmetPrerequisites: unmet.get(scope.id),
      children: units.map(node => ({ id: node.id, key: node.key, kind: node.kind, label: node.label,
        status: routing?.branch(node.id) === 'NOT_SELECTED' ? 'NOT_SELECTED' : leaves[node.id]?.status ?? graph.hierarchy?.groups[node.id]?.outcome ?? (completed(node) ? 'COMPLETE' : 'UNFINISHED'),
        ...(leaves[node.id]?.attemptId ? { attemptId: leaves[node.id].attemptId } : {}),
        ...(leaves[node.id]?.disposition ? { disposition: leaves[node.id].disposition } : {}),
        ...(node.terminal ? { terminalId: node.terminal } : {}),
        prerequisites: dependencies.get(node.id), unmetPrerequisites: unmet.get(node.id) })),
      edges: plan.edges.filter(edge => nodes.get(edge.from)?.parent === scope.id).map(({ kind, from, to, outcome }) => ({ kind, from, to, ...(outcome ? { outcome } : {}) })) }
  }
  return { rootId: root.id, groups, topology, causes: [...causes].sort(), eligibleScopeIds: [...decisionScopes].sort(),
    situation: { code: referral ? 'ROOT_UPDATE_ESCALATED' : 'NO_READY_LEAF',
      reason: referral ? 'The root updater exhausted its authority and handed the unresolved issue back for diagnosis.' : 'The graph is unfinished with no active leaf and no legal next leaf under the serial scheduler.',
      ...(planIssue ? { planIssue } : {}), ...(referral ? { referral, outlookAfterReview: outlook } : {}), rootScopeId: root.id,
      legalNextCount: referral ? legalNext(graph).length : 0, causes: [...causes].sort(), groups: summaries, eligibleScopeIds: [...decisionScopes].sort() } }
}

const scopedDecision = z.discriminatedUnion('action', globalDecisionOptions.map(option =>
  option.extend({ scopeId: z.string().min(1) })))
export function checkGlobalDecision(value, { state, diagnosis, catalog, reviewedScopes = [] }) {
  const { scopeId, ...decision } = scopedDecision.parse(value)
  const graph = state.graph.state, { plan } = graph
  if (!diagnosis.eligibleScopeIds.includes(scopeId)) throw located('BLOCKAGE_TARGET_SCOPE_INVALID', {
    path: '/scopeId', reason: 'Choose the group owning a blocking cause or an enclosing group. A downstream group waiting solely for its parent prerequisite cannot clear it.',
    observed: scopeId, allowed: diagnosis.eligibleScopeIds })
  if (decision.action === 'REPLAN' && reviewedScopes.includes(scopeId)) throw located('BLOCKAGE_SCOPE_ALREADY_REVIEWED', {
    path: '/scopeId', reason: 'This scope already returned or escalated the current investigation. Choose another relevant scope, evidence-backed rework, or an audited pause.', observed: scopeId })
  const related = [scopeId, ...descendantsOf(plan, scopeId).map(node => node.id)]
  let causes = diagnosis.causes.filter(id => related.includes(id))
  if (decision.action === 'REWORK') {
    // A prior completed report can itself be defective. Its actual native reopening closure must
    // reach a blocker, and every historical attempt that would be reopened must fit the selected scope.
    const explicit = decision.report.findings.map(finding => finding.taskId)
    for (const [index, id] of explicit.entries()) {
      if (!related.includes(id) || !['COMPLETE','INCOMPLETE'].includes(graph.leaves[id]?.status)) throw located('BLOCKAGE_REWORK_TARGET_INVALID', {
        path: '/report/findings/' + index + '/taskId', reason: 'Choose an executed leaf in the selected scope.', observed: id })
      const closure = reworkClosure(graph, [id])
      if (!closure.some(taskId => causes.includes(taskId))) throw located('BLOCKAGE_REWORK_UNRELATED', {
        path: '/report/findings/' + index + '/taskId', reason: 'Reopening this result does not affect a current blocking disposition.', observed: id })
      const outside = closure.filter(taskId => !related.includes(taskId))
      if (outside.length) throw located('BLOCKAGE_REWORK_SCOPE_TOO_NARROW', { path: '/scopeId',
        reason: 'The native reopen operation also reopens executed dependents outside this scope. Choose their common enclosing group.', outside })
    }
    causes = explicit
  }
  if (decision.action === 'PAUSE' && causes.length) {
    const affected = new Set(causes)
    for (const group of diagnosis.situation.groups) for (const blocker of group.blockers)
      if (affected.has(blocker.taskId)) for (const task of blocker.requiredBy) affected.add(task)
    if (!decision.report.constraints.some(row => row.affectedTasks.some(id => affected.has(id))))
      throw located('BLOCKAGE_PAUSE_CAUSE_REQUIRED', { path: '/report/constraints', reason: 'Connect the requested interruption to a current blocker or one of its directly affected tasks.', allowed: [...affected] })
  }
  if (decision.action !== 'REPLAN') validateBlockageDecision(decision, { state, catalog, situation: { causes, related } })
  return { ...decision, scopeId }
}

export function diagnosticInput(state, diagnosis, reviewedScopes = []) {
  return { protocol: 'global-blockage-v2', revision: state.revision, scopeId: diagnosis.rootId,
    graphChecksum: state.graph.checksum, contextVersion: state.contexts.version, situation: diagnosis.situation,
    ...(reviewedScopes.length ? { reviewedScopeIds: reviewedScopes } : {}) }
}
