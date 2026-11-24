// SPDX-License-Identifier: GPL-3.0-only
import { readStored } from './workflow-io.mjs'
import { isHierarchical, ancestorsOf, hierarchyComplete, groupRouting } from 'dsh-better-task-grapth/hierarchy'
import { acceptanceEnabled, acceptancePlan, currentPlanningRecord, criteriaInstruction, criteriaReportSources, verificationAtStart } from './acceptance-protocol.mjs'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { attachDiagnostic, feedbackText, withValidation } from 'dsh-better-task-grapth/validation'
import { z } from 'zod'
import { TransactionGraph, canonical, copy, digest, validateDocument, view, revisedPlan, legalNext, reworkClosure, expansionDepth, unitDefinition } from 'dsh-better-task-grapth/core'
import { FileGraphStore, MemoryGraphStore } from 'dsh-better-task-grapth/store'
import { artifactProof, artifactCurrentIdentity } from './artifacts.mjs'
import { completionSchema, reportSchema, planningReportSchema, supervisionSchema, validateSupervision, checkSupervisionUpdate } from './supervision-state.mjs'
import { TrackedGraphStore } from './graph-presence.mjs'
import { resolveWorkflowLimits } from 'dsh-better-task-grapth/workflow-limits'

const key = z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/)
const text = () => z.string().min(1).refine(value => value.trim().length > 0)
const unique = values => new Set(values).size === values.length
const keys = () => z.array(key).refine(unique, 'Duplicate reference')
const toolNames = z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)).refine(unique)
export const contextText = text()
const contextNode = z.object({ key, content: contextText, parents: keys().default([]), mutable: z.literal(true).optional() }).strict()
const sharedContextChange = z.object({
  id: key, revision: z.number().int().min(2), content: contextText,
  taskId: key, attemptId: key, callId: text(), sourceCallId: text().optional(), segmentId: key.optional(), reason: text().optional(),
}).strict()
const approvedFact = z.object({
  id: key, revision: z.number().int().min(2), content: contextText, reason: text(),
  evidence: z.array(text()).min(1), authority: z.literal('graph-review'), graphRevision: z.number().int().positive(),
}).strict()
const userFact = z.object({ authority: z.literal('user-guidance'), guidanceId: key, messageId: text(), messageHash: z.string().regex(/^[a-f0-9]{64}$/),
  scopeId: key, id: key, revision: z.number().int().min(2), content: contextText }).strict()
const factRequest = approvedFact.omit({ authority: true, graphRevision: true })
import { unitBaselineSchema } from './unit-baseline.mjs'
function bindingDefinition(row) {
  if (!row || !Object.hasOwn(row, 'unit') || Object.hasOwn(row, 'task')) return row
  const { unit, ...fields } = row
  return { ...fields, task: unit }
}
const binding = z.object({ task: key.optional(), unit: key.optional(), instruction: text(), baseline: unitBaselineSchema.optional(), contexts: keys(),
  inheritReports: keys().default([]), tools: toolNames.default([]), completion: completionSchema.optional() }).strict().refine(row => (row.unit === undefined) !== (row.task === undefined), 'Supply the unit binding key once.').overwrite(bindingDefinition)
export const unitNodeSchema = z.object({
  key, kind: z.enum(['unit', 'container', 'leaf']), mode: z.enum(['direct', 'planned']).optional(), label: text(), parent: key.optional(), terminal: key.optional(),
  acceptance: text().optional(), rules: z.array(z.object({ id: key, when: z.record(z.string(), z.unknown()) }).strict()).optional(),
}).strict()
export const proposalSchema = z.object({
  planningReport: planningReportSchema.optional(),
  taskGraph: z.object({ title: text(), ruleVersion: z.literal(1).optional(), hierarchy: z.object({
    version: z.number().int().min(1).max(2), maxGroupDepth: z.number().int().nonnegative().optional(),
  }).strict().optional(), nodes: z.array(unitNodeSchema.overwrite(unitDefinition)).min(1),
  edges: z.array(z.object({ kind: z.enum(['prerequisite', 'route']), from: key, to: key, outcome: z.enum(['complete', 'blocked']).optional() }).strict()
    .refine(edge => (edge.kind === 'route') === (edge.outcome !== undefined), { path: ['outcome'], message: 'Specify complete or blocked exactly for a conditional group route.' })) }).strict(),
  contextGraph: z.object({ nodes: z.array(contextNode), bindings: z.array(binding).min(1) }).strict(),
}).strict()

const normalizedContext = z.object({ graphId: key, creationChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  nodes: z.array(contextNode.extend({ id: key })),
  bindings: z.array(z.object({ taskId: key, instruction: text(), baseline: unitBaselineSchema.optional(), contexts: keys(),
    inheritReports: keys(), tools: toolNames, completion: completionSchema.optional() }).strict()).min(1),
  version: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
const stateSchema = z.object({ schema: z.literal(1), revision: z.number().int().positive(),
  unitRoleVersion: z.literal(1).optional(),
  ruleAudit:z.object({verdict:z.literal('APPROVE'),proposalHash:z.string().length(64),runId:z.string(),reason:z.string()}).strict().optional(),
  graph: z.unknown(), contexts: normalizedContext, reports: z.array(reportSchema),
  reportArchive: z.array(reportSchema).optional(),
  sharedContextHistory: z.array(z.union([sharedContextChange, approvedFact, userFact])).optional(),
  contextHistory: z.array(z.object({ graph: z.unknown(), contexts: normalizedContext }).strict()).optional(),
  invalidatedReports: z.array(key).refine(unique).optional(),
  supervision: supervisionSchema.optional(),
  planningRecord: z.object({ report: planningReportSchema, taskGraphSha256: z.string(), contextGraphSha256: z.string() }).strict().optional(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

export class DynamicContextError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${JSON.stringify(detail)}` : code)
    this.name = 'DynamicContextError'; this.code = code; attachDiagnostic(this, detail); this.message = feedbackText(this)
  }
}
export const fail = (code, detail) => { throw new DynamicContextError(code, detail) }
const seal = value => { const { checksum, ...body } = value; return { ...body, checksum: digest(body) } }
function reachable(source, target, edges) {
  const visited = new Set(), pending = [source]
  while (pending.length) {
    const next = pending.pop()
    if (visited.has(next)) continue
    visited.add(next)
    for (const edge of edges.filter(row => row.from === next)) {
      if (edge.to === target) return true
      pending.push(edge.to)
    }
  }
  return false
}

export function publicReportPredecessor(plan, sourceId, taskId) {
  const source = plan.nodes.find(node => node.id === sourceId), task = plan.nodes.find(node => node.id === taskId)
  if (!source || !task) return false
  const target = [task, ...ancestorsOf(plan, taskId)].find(node => node.parent === source.parent)
  return Boolean(target && target.id !== sourceId && reachable(sourceId, target.id, plan.edges)
    && (source.kind === 'container' || source.parent === task.parent))
}
function checkContexts(contexts, graph) {
  const { version, ...body } = normalizedContext.parse(contexts)
  if (digest(body) !== version || contexts.graphId !== graph.state.plan.id
      || contexts.creationChecksum !== graph.events[0].hash) fail('CONTEXT_GRAPH_VERSION_MISMATCH')
  const nodes = new Map(contexts.nodes.map(node => [node.id, node]))
  if (nodes.size !== contexts.nodes.length || !unique(contexts.nodes.map(node => node.key))) fail('DUPLICATE_CONTEXT_NODE')
  const visited = new Set(), visiting = new Set()
  const visit = id => {
    if (!nodes.has(id)) fail('UNKNOWN_CONTEXT_REFERENCE')
    if (visiting.has(id)) fail('CONTEXT_CYCLE', { path: '/contextGraph/nodes/' + contexts.nodes.findIndex(node => node.id === id) + '/parents', reason: 'Context inheritance must be acyclic.', cycleKeys: [...visiting, id].map(id => nodes.get(id)?.key ?? id) })
    if (visited.has(id)) return
    visiting.add(id); nodes.get(id).parents.forEach(visit); visiting.delete(id); visited.add(id)
  }
  nodes.forEach(node => visit(node.id))
  const units = graph.state.plan.hierarchy?.version === 2
  const boundUnits = graph.state.plan.nodes.filter(node => units || node.kind === 'leaf')
  if (units && (contexts.bindings.length !== boundUnits.length || contexts.bindings.some(row => !row.baseline)))
    fail('EXACT_UNIT_BASELINES_REQUIRED', { path: '/contextGraph/bindings', reason: 'Bind each unit, including the root and every expanded unit, to one complete baseline.' })
  if (contexts.bindings.length !== boundUnits.length || !unique(contexts.bindings.map(row => row.taskId))) fail(units ? 'EXACT_UNIT_BINDINGS_REQUIRED' : 'EXACT_LEAF_BINDINGS_REQUIRED', { path: '/contextGraph/bindings', reason: 'Every eligible unit requires exactly one binding.', missingTasks: boundUnits.filter(unit => !contexts.bindings.some(row => row.taskId === unit.id)).map(unit => unit.key), duplicateTaskIds: contexts.bindings.map(row => row.taskId).filter((id, i, ids) => ids.indexOf(id) !== i) })
  for (const row of contexts.bindings) {
    if (!boundUnits.some(unit => unit.id === row.taskId)) fail('UNKNOWN_BOUND_UNIT', { path: '/contextGraph/bindings/' + contexts.bindings.indexOf(row) + '/task', reason: 'The binding must name a declared unit.', observed: row.taskId ?? null, allowed: boundUnits.map(unit => unit.key) })
    row.contexts.forEach(id => { if (!nodes.has(id)) fail('UNKNOWN_CONTEXT_REFERENCE') })
    for (const source of row.inheritReports) {
      if (!(isHierarchical(graph.state.plan) ? publicReportPredecessor(graph.state.plan, source, row.taskId) : boundUnits.some(unit => unit.id === source) && reachable(source, row.taskId, graph.state.plan.edges))) fail('REPORT_SOURCE_MUST_BE_PREDECESSOR', { path: '/contextGraph/bindings/' + contexts.bindings.indexOf(row) + '/inheritReports/' + row.inheritReports.indexOf(source), reason: 'An inherited report must originate at a unit with a prerequisite path to this task.', source: boundUnits.find(unit => unit.id === source)?.key ?? source, target: boundUnits.find(unit => unit.id === row.taskId)?.key })
    }
  }
}

const criteriaAmendmentSchema = z.object({
  before: z.string().regex(/^[a-f0-9]{64}$/), sourceMessageId: z.string().min(1), evidence: z.array(z.string().min(1)).min(1),
  report: planningReportSchema, bindings: z.array(z.object({ taskId: key, base: z.string().regex(/^[a-f0-9]{64}$/), instruction: text(),
    reportSources: z.object({ base: z.string().regex(/^[a-f0-9]{64}$/), previous: z.string().regex(/^[a-f0-9]{64}$/),
      sources: z.array(key) }).strict().optional() }).strict())
}).strict()

function checkCriteriaDraft(state, raw, previous, scopeId) {
  const value = criteriaAmendmentSchema.parse(raw)
  if (!previous?.verification || !value.report.verification || value.before !== digest(previous)
      || (scopeId !== undefined && state.graph.state.plan.nodes.find(node => node.parent === null)?.id !== scopeId)
      || !unique(value.bindings.map(row => row.taskId))) fail('ACCEPTANCE_CRITERIA_SOURCE_MISMATCH')
  for (const row of value.bindings) {
    const binding = state.contexts.bindings.find(item => item.taskId === row.taskId)
    if (!binding || state.graph.state.suspended?.active.nodeId === row.taskId || state.graph.state.leaves[row.taskId]?.status !== 'PENDING'
        || digest(binding.instruction) !== row.base) fail('ACCEPTANCE_CRITERIA_BINDING_CHANGED')
    const update = row.reportSources
    if (update) {
      const plan = state.graph.state.plan
      if (state.graph.events.some(event => event.type === 'BEGUN' && event.data.nodeId === row.taskId)
          || update.base !== digest(binding.inheritReports) || update.previous !== digest(criteriaReportSources(state, binding))
          || !unique(update.sources) || update.sources.some(id => state.invalidatedReports?.includes(id)
            || !(isHierarchical(plan) ? publicReportPredecessor(plan, id, row.taskId)
              : state.graph.state.leaves[id] && reachable(id, row.taskId, plan.edges))))
        fail('ACCEPTANCE_REPORT_SOURCE_INVALID', { path: '/criteriaAmendment/bindings/' + value.bindings.indexOf(row) + '/reportSources',
          taskId: row.taskId, reason: 'Only unopened tasks may change report sources. Supply current binding hashes and unique, valid public predecessors.' })
    }
  }
  return value
}

/** Validate the one durable document holding both graphs and committed reports. */
export function validateState(value) {
  const state = stateSchema.parse(value), { checksum, ...body } = state
  if (digest(body) !== checksum) fail('DYNAMIC_CONTEXT_CHECKSUM')
  validateDocument(state.graph)
  if (state.graph.state.plan.ruleVersion && !state.ruleAudit) fail('RULE_INDEPENDENT_AUDIT_REQUIRED')
  if (state.unitRoleVersion && (state.graph.state.plan.ruleVersion !== 1 || !state.ruleAudit || !state.graph.state.plan.hierarchy || !state.supervision))
    fail('UNIT_ROLES_REQUIRE_AUDITED_HIERARCHY')
  if (state.revision !== state.graph.revision) fail('GRAPH_REVISION_MISMATCH')
  checkContexts(state.contexts, state.graph)
  for (const historical of state.contextHistory ?? []) {
    validateDocument(historical.graph); checkContexts(historical.contexts, historical.graph)
  }
  const allNodes = new Map([...(state.contextHistory ?? []).flatMap(row => row.contexts.nodes), ...state.contexts.nodes].map(node => [node.id, node]))
  const historyNodes = new Map()
  const approvals = new Map()
  for (const event of state.graph.events) {
    if (event.type !== 'REVISED') continue
    for (const value of event.data.review.proposal?.factAmendments ?? []) {
      const approved = { ...factRequest.parse(value), authority: 'graph-review', graphRevision: event.seq }
      approvals.set(event.seq + ':' + approved.id, approved)
    }
  }
  let priorCriteria = state.planningRecord?.report
  for (const event of state.graph.events) {
    const review = event.type === 'REVISED' && event.data.review
    const revision = review?.proposal?.criteriaAmendment
    if (!revision) continue
    criteriaAmendmentSchema.parse(revision)
    if (!priorCriteria?.verification || !revision.report.verification || revision.before !== digest(priorCriteria)
        || review.verdict !== 'APPROVE' || review.proposalHash !== digest(review.proposal)
        || review.scopeSignal?.scopeId !== state.graph.state.plan.nodes.find(node => node.parent === null)?.id
        || !unique(revision.bindings.map(row => row.taskId))) fail('ACCEPTANCE_CRITERIA_HISTORY_INVALID')
    priorCriteria = revision.report
  }
  const historyCalls = new Set()
  for (const row of state.sharedContextHistory ?? []) {
    const approved = row.authority === 'graph-review'
    const directed = row.authority === 'user-guidance'
    const call = directed ? row.guidanceId : approved ? row.graphRevision + ':' + row.id : row.attemptId + ':' + row.callId
    if (!allNodes.has(row.id) || (!approved && !directed && !allNodes.get(row.id).mutable)
        || (historyNodes.get(row.id) ?? 1) + 1 !== row.revision || historyCalls.has(call)
        || (approved && canonical(approvals.get(call)) !== canonical(row)))
      fail('SHARED_CONTEXT_HISTORY_INVALID')
    if (approved) approvals.delete(call)
    historyNodes.set(row.id, row.revision); historyCalls.add(call)
  }
  if (approvals.size) fail('SHARED_CONTEXT_APPROVAL_NOT_APPLIED')
  if (!unique(state.reports.map(row => row.taskId))) fail('DUPLICATE_REPORT')
  for (const report of state.reports) {
    const leaf = state.graph.state.leaves[report.taskId]
    if (leaf?.status !== 'COMPLETE' || leaf.attemptId !== report.attemptId
        || ![state.contexts, ...(state.contextHistory ?? []).map(row => row.contexts)].some(ctx => ctx.version === report.contextVersion
          && ctx.bindings.some(binding => binding.taskId === report.taskId))
        || canonical(leaf.evidence) !== canonical(report.evidence)) fail('REPORT_NOT_BOUND_TO_COMMITTED_TASK')
  }
  if (Object.entries(state.graph.state.leaves).some(([id, leaf]) =>
    leaf.status === 'COMPLETE' && !state.reports.some(report => report.taskId === id))) fail('COMPLETED_TASK_REPORT_MISSING')
  if ((state.invalidatedReports ?? []).some(id => !state.reports.some(report => report.taskId === id))) fail('INVALIDATED_REPORT_MISSING')
  for (const binding of state.contexts.bindings) if (['PENDING', 'INACTIVE'].includes(state.graph.state.leaves[binding.taskId]?.status)
      && criteriaReportSources(state, binding).some(id => state.invalidatedReports?.includes(id))) fail('INVALIDATED_REPORT_INHERITANCE')
  for (const report of state.reportArchive ?? []) {
    const finished = state.graph.events.find(event => event.type === 'FINISHED' && event.data.attemptId === report.attemptId
      && event.data.nodeId === report.taskId && event.data.outcome === 'complete')
    const reopened = state.graph.events.find(event => event.type === 'REOPENED'
      && event.data.attempts.some(row => row.nodeId === report.taskId && row.attemptId === report.attemptId))
    if (!finished || !reopened || canonical(finished.data.evidence) !== canonical(report.evidence)) fail('REWORK_ARCHIVE_NOT_BOUND')
  }
  if (!unique((state.reportArchive ?? []).map(report => report.attemptId))) fail('REWORK_ARCHIVE_DUPLICATE')
  validateSupervision(state)
  return state
}

function checkUpdate(previous, next) {
  // The store validates the candidate before checking its transition.
  if (previous && previous.checksum === next.checksum) return
  const event = next.graph.events.at(-1)
  const factRevision = previous && next.revision === previous.revision + 1 && event.type === 'REVISED' && event.data.review.proposal.factAmendments?.length
  if (factRevision) {
    const rows = approvedFacts(previous, event.data.review.proposal.factAmendments)
    if (canonical(next.sharedContextHistory) !== canonical([...(previous.sharedContextHistory ?? []), ...rows])) fail('SHARED_CONTEXT_HISTORY_IMMUTABLE')
  } else if (canonical(previous?.sharedContextHistory) !== canonical(next.sharedContextHistory)) {
    const history = previous?.sharedContextHistory ?? []
    const changes = next.sharedContextHistory
    const directed = changes?.at(-1)
    if (directed?.authority === 'user-guidance') {
      const { sharedContextHistory: _prior, checksum: _old, ...original } = previous
      const { sharedContextHistory: _next, checksum: _new, ...candidate } = next
      const binding = previous.contexts.bindings.find(row => row.taskId === directed.scopeId)
      if (previous.graph.state.plan.hierarchy?.version !== 2 || !binding || !contextClosure(previous.contexts, binding).some(row => row.id === directed.id)
          || changes.length !== history.length + 1 || canonical(changes.slice(0, -1)) !== canonical(history)
          || canonical(original) !== canonical(candidate)) fail('USER_FACT_SCOPE_OR_HISTORY_CHANGED')
      return
    }
    const active = previous?.graph.state.active
    if (!active || previous.supervision && !['READY', ...(acceptanceEnabled(previous) ? ['REWORK_RESULT'] : [])].includes(previous.supervision.phase)
        || changes?.length !== history.length + 1 || canonical(changes.slice(0, -1)) !== canonical(history))
      fail('SHARED_CONTEXT_HISTORY_IMMUTABLE')
    const { sharedContextHistory: _changes, checksum: _checksum, ...nextBody } = next
    const { sharedContextHistory: _history, checksum: _priorChecksum, ...previousBody } = previous
    const change = changes.at(-1)
    const node = boundMutableNode(previous, active, change.id)
    if (canonical(nextBody) !== canonical(previousBody) || !node
        || change.taskId !== active.nodeId || change.attemptId !== active.attemptId
        || change.revision !== sharedContextVersions(history, node).length + 1
        || history.some(row => row.attemptId === change.attemptId && row.callId === change.callId))
      fail('SHARED_CONTEXT_CHANGE_INVALID')
    return
  }
  if (previous && next.revision === previous.revision) {
    const graphState = ({ supervision, checksum, ...value }) => value
    if (!previous.supervision || canonical(graphState(next)) !== canonical(graphState(previous))) fail('SUPERVISION_GRAPH_CHANGED_WITHOUT_REVISION')
    checkSupervisionUpdate(previous, next)
    return
  }
  if (next.revision !== (previous?.revision ?? 0) + 1) fail('CONTEXT_CAS_REVISION')
  if (!previous) return
  if (canonical(next.ruleAudit) !== canonical(previous.ruleAudit)) fail('RULE_AUDIT_IMMUTABLE')
  if (next.unitRoleVersion !== previous.unitRoleVersion) fail('UNIT_ROLE_PROTOCOL_IMMUTABLE')
  if (canonical(next.planningRecord) !== canonical(previous.planningRecord)) fail('PLANNING_RECORD_IMMUTABLE')
  checkSupervisionUpdate(previous, next)
  if (next.graph.events.at(-1).type === 'REOPENED') {
    const reopened = new Set(next.graph.events.at(-1).data.attempts.map(row => row.nodeId))
    const expected = { ...previous, revision: next.revision, graph: next.graph,
      ...(isHierarchical(previous.graph.state.plan) || previous.supervision?.rootReferral ? { supervision: { phase: 'READY', outcomes: previous.supervision.outcomes } } : {}),
      reports: previous.reports.filter(report => !reopened.has(report.taskId)),
      reportArchive: [...previous.reportArchive ?? [], ...previous.reports.filter(report => reopened.has(report.taskId))],
      ...(previous.invalidatedReports ? { invalidatedReports: previous.invalidatedReports.filter(id => !reopened.has(id)) } : {}) }
    if (canonical(next.graph.events.slice(0, -1)) !== canonical(previous.graph.events)
        || seal(expected).checksum !== next.checksum) fail('REWORK_HISTORY_CHANGED')
    return
  }
  if (canonical(next.reportArchive) !== canonical(previous.reportArchive)) fail('REWORK_ARCHIVE_IMMUTABLE')
  if (canonical(next.graph.events.slice(0, -1)) !== canonical(previous.graph.events)
      || canonical(next.reports.slice(0, previous.reports.length)) !== canonical(previous.reports)
      || next.reports.length > previous.reports.length + 1) fail('COMMITTED_CONTEXT_HISTORY_IMMUTABLE')
  if (next.graph.events.at(-1).type !== 'REVISED') {
    if (canonical(next.contexts) !== canonical(previous.contexts)
        || canonical(next.contextHistory) !== canonical(previous.contextHistory)
        || canonical(next.invalidatedReports) !== canonical(previous.invalidatedReports)) fail('COMMITTED_CONTEXT_HISTORY_IMMUTABLE')
  } else {
    const history = previous.contextHistory ?? []
    const expected = next.contexts.version === previous.contexts.version ? history : [...history, { graph: previous.graph, contexts: previous.contexts }]
    if (canonical(next.contextHistory) !== canonical(expected)
        || (previous.invalidatedReports ?? []).some(id => !next.invalidatedReports?.includes(id))
        || canonical(next.reports) !== canonical(previous.reports)) fail('REVISION_HISTORY_MIGRATION_INVALID')
    preserveExecutedBindings(previous, next.contexts)
    const approved = next.graph.events.at(-1).data.review
    const prepared = { plan: next.graph.state.plan, contexts: next.contexts,
      invalidatedReports: next.invalidatedReports, baseChecksum: previous.checksum, effect: true }
    if (factRevision) prepared.factAmendments = approved.proposal.factAmendments
    if (approved.proposal.criteriaAmendment) prepared.criteriaAmendment = checkCriteriaDraft(previous, approved.proposal.criteriaAmendment, currentPlanningRecord(previous)?.report, approved.scopeSignal?.scopeId)
    if (approved.preparedHash !== digest(prepared) || approved.proposalHash !== digest(approved.proposal)) fail('REVISION_APPROVED_DRAFT_MISMATCH')
  }
}

function contextClosure(contexts, binding) {
  const selected = new Map(), visit = id => {
    if (selected.has(id)) return
    const node = contexts.nodes.find(row => row.id === id)
    if (!node) fail('UNKNOWN_CONTEXT_REFERENCE')
    selected.set(id, node); node.parents.forEach(visit)
  }
  binding.contexts.forEach(visit)
  return [...selected.values()].sort((a, b) => a.id.localeCompare(b.id))
}
function boundMutableNode(state, active, id) {
  const binding = state.contexts.bindings.find(row => row.taskId === active.nodeId)
  return contextClosure(state.contexts, binding).find(row => row.id === id && row.mutable)
}
function sharedContextVersions(history, node) {
  return [{ id: node.id, revision: 1, content: node.content }, ...history.filter(row => row.id === node.id)]
}
function approvedFacts(state, requests) {
  const entries = z.array(factRequest).min(1).parse(requests)
  if (!unique(entries.map(entry => entry.id))) fail('SHARED_CONTEXT_DUPLICATE_AMENDMENT')
  return entries.map(entry => {
    const node = state.contexts.nodes.find(row => row.id === entry.id)
    const versions = node && sharedContextVersions(state.sharedContextHistory ?? [], node)
    if (!versions || entry.revision !== versions.length + 1 || entry.content === versions.at(-1).content) fail('SHARED_CONTEXT_AMENDMENT_STALE')
    return { ...entry, authority: 'graph-review', graphRevision: state.revision + 1 }
  })
}
export function currentSharedContexts(state) {
  const amended = new Set((state.sharedContextHistory ?? []).filter(row => row.authority).map(row => row.id))
  return state.contexts.nodes.filter(node => node.mutable || amended.has(node.id)).map(node => ({
    key: node.key, ...sharedContextVersions(state.sharedContextHistory ?? [], node).at(-1),
  }))
}
export function describeContextBindings(contexts, plan, leaves, state) {
  const keys = new Map(plan.nodes.map(node => [node.id, node.key]))
  return contexts.bindings.map(binding => ({ task: keys.get(binding.taskId),
    future: !leaves[binding.taskId] || ['PENDING', 'INACTIVE'].includes(leaves[binding.taskId].status),
    contextKeys: contextClosure(contexts, binding).map(node => node.key).sort(),
    inheritReports: criteriaReportSources(state, binding).map(id => keys.get(id)),
  }))
}
function preserveExecutedBindings(previous, contexts) {
  for (const binding of previous.contexts.bindings) {
    if (previous.graph.state.plan.hierarchy?.version === 2 && !previous.graph.state.leaves[binding.taskId]) continue
    if (['PENDING', 'INACTIVE'].includes(previous.graph.state.leaves[binding.taskId]?.status)
        && !previous.graph.state.leaves[binding.taskId].reopenedFrom) continue
    const next = contexts.bindings.find(row => row.taskId === binding.taskId)
    if (canonical(next) !== canonical(binding) || canonical(contextClosure(previous.contexts, binding)) !== canonical(contextClosure(contexts, next)))
      fail('EXECUTED_CONTEXT_BINDING_IMMUTABLE')
  }
}

/** Serial prototype using the existing task-graph core; never opens the live graph ledger. */
export class DynamicContextGraph {
  constructor({ projectRoot, storageRoot = projectRoot, directory, workflowLimits, revision, supervision, supervisionContext = 'legacy', hierarchy, storeFactory }) {
    this.workflowLimits = resolveWorkflowLimits({ ...(hierarchy?.maxGroupDepth ? { maxDepth: hierarchy.maxGroupDepth } : {}), ...workflowLimits })
    this.artifactOptions = { maxBytes: null }
    this.projectRoot = projectRoot
    this.storageRoot = storageRoot
    this.revisionEnabled = Boolean(revision)
    this.revisionPolicy = revision?.policy ? copy(revision.policy) : null
    this.supervisionEnabled = Boolean(supervision)
    this.reportScoped = supervisionContext === 'reports'
    this.owner = `owner_${randomUUID()}`
    this.store = new TrackedGraphStore({ projectRoot: storageRoot, directory, fileName: 'dynamic-context.json',
      validator: validateState, updateValidator: checkUpdate }, storeFactory)
  }
  read(inspection) {
    const state = this.store.read(inspection)
    if (state && Boolean(state.supervision) !== this.supervisionEnabled) fail('SUPERVISION_CONFIGURATION_CHANGED')
    return state
  }
  status(state = this.read()) {
    if (!state) return null
    const result = view(state.graph, this.owner)
    if (state.supervision && state.supervision.phase !== 'READY') {
      result.legalNext = []
      result.skipChoices = []
    }
    if (isHierarchical(state.graph.state.plan) && state.supervision?.hierarchy) {
      const flow = state.supervision.hierarchy, gate = { UPDATE: 'GRAPH_UPDATE', UPDATE_AUDIT: 'GRAPH_AUDIT', PAUSE_AUDIT: 'PAUSE_REVIEW', WAITING_USER: 'WAITING_USER', BLOCKAGE: 'BLOCKAGE' }[flow.stage]
      result.focusScopeId = flow.scopeId
      if (gate) for (const node of result.nodes.filter(node => node.kind === 'container')) node.gate = node.id === flow.scopeId ? gate : null
    }
    return result
  }
  core(store) { return new TransactionGraph(store, { workflowLimits: this.workflowLimits, id: prefix => prefix === 'owner' ? this.owner : `${prefix}_${randomUUID()}` }) }

  setMaxUnits(maxUnits) { this.workflowLimits = resolveWorkflowLimits({ ...this.workflowLimits, maxUnits }) }
  unitLimit(state = this.read()) {
    const current = state?.graph.state.plan.nodes.length ?? 0, configured = this.workflowLimits.maxUnits
    return { configured, current, maximum: Math.max(configured, current) }
  }
  checkUnitLimit(plan, state = null) {
    const { configured, current, maximum } = this.unitLimit(state)
    if (plan.nodes.length > maximum) fail('UNIT_LIMIT', { path: '/taskGraph/nodes', observed: plan.nodes.length, maximum, configured, current,
      reason: 'Count every unit in the graph, including the root and expanded units.' })
  }

  /** Validate both proposals before atomically committing either graph. */
  submit(input, ruleAudit) {
    const proposal = withValidation({ stage: 'dual-graph-submission', path: '/proposal' }, () => proposalSchema.parse(input))
    this.checkUnitLimit(proposal.taskGraph)
    if (proposal.taskGraph.hierarchy?.version === 2 && (proposal.taskGraph.nodes.length !== 1 || proposal.taskGraph.nodes[0].kind !== 'leaf'))
      fail('UNIT_ROOT_SEED_REQUIRED', { path: '/taskGraph/nodes', reason: 'Start with a single unexpanded root unit. Its router decides whether to execute or plan.' })
    return this.store.compareAndSwap(0, () => {
      // Read the current approval under the same database transaction or directory lock as creation.
      const approval = typeof ruleAudit === 'function' ? ruleAudit() : ruleAudit
      if (proposal.taskGraph.ruleVersion && (!approval || approval.verdict !== 'APPROVE' || approval.proposalHash !== digest(proposal)))
        fail('RULE_INDEPENDENT_AUDIT_REQUIRED')
      return this.initialSnapshot(proposal, approval)
    })
  }
  initialSnapshot(proposal, ruleAudit) {
      if (!proposal.taskGraph.hierarchy) {
      const roots = proposal.taskGraph.nodes.filter(node => node.kind === 'container')
      const topologyError = (field, correction) => fail('PROTOTYPE_REQUIRES_ONE_ROOT_WITH_LEAF_PREREQUISITES', { path: '/' + field.replaceAll('.', '/'), reason: correction, field, correction })
      if (roots.length !== 1) topologyError('taskGraph.nodes', 'Declare exactly one node with kind="container". Put every leaf directly under it using parent.')
      const [root] = roots
      if (root.parent !== undefined) topologyError('taskGraph.nodes.' + proposal.taskGraph.nodes.indexOf(root) + '.parent', 'Omit parent on the root container.')
      const unparented = proposal.taskGraph.nodes.filter(node => node.kind === 'leaf' && node.parent !== root.key).map(node => node.key)
      const containerEdges = proposal.taskGraph.edges.filter(edge => edge.from === root.key || edge.to === root.key)
      if (unparented.length || containerEdges.length) fail('PROTOTYPE_REQUIRES_ONE_ROOT_WITH_LEAF_PREREQUISITES', {
        path: '/taskGraph', reason: 'Every leaf must be directly under the single root; prerequisite edges must connect leaves.', root: root.key, leavesNeedingRootParent: unparented, edgesTouchingRoot: containerEdges,
        correction: 'Set each listed leaf parent to the root key. Express containment with parent; keep prerequisite edges between leaves only.',
      })
      }
      if (proposal.taskGraph.hierarchy?.version === 1 && proposal.taskGraph.hierarchy.maxGroupDepth > this.workflowLimits.maxDepth) fail('GROUP_DEPTH_CONFIGURATION', { path: '/taskGraph/hierarchy/maxGroupDepth', reason: 'The declared policy exceeds the configured group-depth limit.', maximum: this.workflowLimits.maxDepth })
      if (proposal.taskGraph.hierarchy && !this.supervisionEnabled) fail('HIERARCHY_REQUIRES_SUPERVISION')
      const temporary = new MemoryGraphStore()
      this.core(temporary).create({ operationId: `op_${randomUUID()}`, definition: proposal.taskGraph })
      const graph = temporary.read(), taskIds = new Map(graph.state.plan.nodes.map(node => [node.key, node.id]))
      const contextIds = new Map(proposal.contextGraph.nodes.map(node => [node.key, `ctx_${randomUUID()}`]))
      if (contextIds.size !== proposal.contextGraph.nodes.length) fail('DUPLICATE_CONTEXT_NODE')
      const contextBody = { graphId: graph.state.plan.id, creationChecksum: graph.events[0].hash,
        nodes: proposal.contextGraph.nodes.map(node => ({ ...node, id: contextIds.get(node.key),
          parents: node.parents.map(ref => { if (!contextIds.has(ref)) fail('UNKNOWN_CONTEXT_REFERENCE', { path: '/contextGraph/nodes/' + proposal.contextGraph.nodes.indexOf(node) + '/parents/' + node.parents.indexOf(ref), item: ref, reason: 'Referenced context key is not declared.', allowed: [...contextIds.keys()] }); return contextIds.get(ref) }) })),
        bindings: proposal.contextGraph.bindings.map(row => ({ taskId: taskIds.get(row.task), instruction: row.instruction,
          contexts: row.contexts.map(ref => { if (!contextIds.has(ref)) fail('UNKNOWN_CONTEXT_REFERENCE', { path: '/contextGraph/bindings/' + proposal.contextGraph.bindings.indexOf(row) + '/contexts/' + row.contexts.indexOf(ref), item: ref, reason: 'Referenced context key is not declared.', allowed: [...contextIds.keys()] }); return contextIds.get(ref) }),
          inheritReports: row.inheritReports.map(ref => { if (!taskIds.has(ref)) fail('UNKNOWN_REPORT_TASK', { path: '/contextGraph/bindings/' + proposal.contextGraph.bindings.indexOf(row) + '/inheritReports', item: ref, reason: 'Inherited report source must be a declared predecessor leaf.', allowed: [...taskIds.keys()] }); return taskIds.get(ref) }), tools: row.tools,
          ...(row.baseline ? { baseline: row.baseline } : {}), ...(row.completion ? { completion: row.completion } : {}) })),
      }
      const contexts = { ...contextBody, version: digest(contextBody) }
      const result = seal({ schema: 1, revision: graph.revision, graph, contexts, reports: [], ...(ruleAudit ? {ruleAudit:copy(ruleAudit)} : {}),
        ...(this.supervisionEnabled && ruleAudit && proposal.taskGraph.ruleVersion === 1 && proposal.taskGraph.hierarchy ? { unitRoleVersion: 1 } : {}),
        ...(proposal.planningReport ? { planningRecord: { report: proposal.planningReport,
          taskGraphSha256: digest(proposal.taskGraph), contextGraphSha256: digest(proposal.contextGraph) } } : {}),
        ...(this.supervisionEnabled ? { supervision: { phase: 'READY', outcomes: [] } } : {}) })
      validateState(result)
      return result
  }
  mutate(expectedRevision, operation, data, report) {
    return this.store.compareAndSwap(expectedRevision, previous => {
      if (!previous) fail('CONTEXT_GRAPH_NOT_SUBMITTED')
      if (Boolean(previous.supervision) !== this.supervisionEnabled) fail('SUPERVISION_CONFIGURATION_CHANGED')
      if (operation === 'begin' && previous.supervision) {
        if (previous.supervision.phase !== 'READY') fail('SUPERVISION_SCHEDULING_BLOCKED')
        const next = legalNext(previous.graph.state)[data.choice]
        if (next && previous.unitRoleVersion && (previous.supervision.routedUnit?.taskId !== next.id
          || previous.supervision.routedUnit.revision !== previous.revision)) fail('UNIT_ROUTE_REQUIRED')
        if (next) this.checkInputs(previous, next.id)
      }
      const temporary = new MemoryGraphStore(previous.graph)
      this.core(temporary)[operation]({ ...data, expectedRevision, operationId: `op_${randomUUID()}` })
      const graph = temporary.read()
      const next = { ...previous, schema: 1, revision: graph.revision, graph, contexts: previous.contexts,
        reports: report ? [...previous.reports, reportSchema.parse(report)] : previous.reports }
      if (operation === 'begin' && previous.supervision?.routedUnit) {
        const { routedUnit, ...supervision } = previous.supervision
        next.supervision = supervision
      }
      return seal(next)
    })
  }
  reviewHierarchy({ state, scopeId, inputHash, runId, kind, report }) {
    return this.store.compareAndSwap(state.revision, previous => {
      if (previous.checksum !== state.checksum || previous.supervision?.phase !== 'HIERARCHY' || previous.supervision.roleRunId !== runId) fail('HIERARCHY_STALE_GATE')
      const temporary = new MemoryGraphStore(previous.graph)
      this.core(temporary).reviewScope({ expectedRevision: state.revision, operationId: `op_${randomUUID()}`, scopeId, inputHash, runId, kind, report })
      const graph = temporary.read()
      return seal({ ...previous, graph, revision: graph.revision, supervision: { phase: 'HIERARCHY', outcomes: previous.supervision.outcomes } })
    })
  }
  suspend({ expectedRevision, evidence, note, metadata }) {
    return this.store.compareAndSwap(expectedRevision, previous => {
      if (!previous?.supervision || !['READY', 'REWORK_RESULT'].includes(previous.supervision.phase)) fail('GUIDANCE_SUSPENSION_NOT_SAFE')
      const { outcomes, ...supervision } = previous.supervision, temporary = new MemoryGraphStore(previous.graph)
      this.core(temporary).suspend({ expectedRevision, operationId: `op_${randomUUID()}`, evidence, note, metadata: { ...metadata, supervision } })
      const graph = temporary.read()
      return seal({ ...previous, graph, revision: graph.revision, supervision: { phase: 'READY', outcomes } })
    })
  }
  resolveSuspension({ expectedRevision, attemptId, mode }) {
    return this.store.compareAndSwap(expectedRevision, previous => {
      if (previous?.supervision?.phase !== 'READY') fail('GUIDANCE_SUSPENSION_NOT_SAFE')
      const temporary = new MemoryGraphStore(previous.graph), held = previous.graph.state.suspended
      this.core(temporary).resolveSuspension({ expectedRevision, operationId: `op_${randomUUID()}`, attemptId, mode })
      const graph = temporary.read(), supervision = mode === 'resume' ? { ...held.metadata.supervision, outcomes: previous.supervision.outcomes } : previous.supervision
      return seal({ ...previous, graph, revision: graph.revision, supervision })
    })
  }
  begin({ expectedRevision, choice = 0 }) { return this.mutate(expectedRevision, 'begin', { choice }) }
  updateSupervision(state, supervision) {
    return this.store.compareAndSwap(state.revision, previous => {
      if (!this.supervisionEnabled || previous?.checksum !== state.checksum || !previous.supervision)
        fail('SUPERVISION_STALE_BASE')
      return seal({ ...previous, supervision })
    })
  }
  reopenReports({ expectedRevision, baseChecksum, nodeIds, decisionId, evidence }) {
    return this.store.compareAndSwap(expectedRevision, previous => {
      if (!previous || previous.checksum !== baseChecksum || !['READY', ...(isHierarchical(previous.graph.state.plan) ? ['HIERARCHY'] : [])].includes(previous.supervision?.phase)) fail('REWORK_STALE_OR_UNREVIEWED')
      evidence.forEach(ref => artifactProof(this.storageRoot, ref, undefined, this.artifactOptions))
      const ids = new Set(reworkClosure(previous.graph.state, nodeIds))
      const temporary = new MemoryGraphStore(previous.graph)
      this.core(temporary).reopen({ expectedRevision, operationId: `op_${randomUUID()}`, nodeIds, decisionId, evidence,
        note: 'Evidence-backed rework; historical reports and acceptance remain in the append-only record.' })
      const graph = temporary.read()
      return seal({ ...previous, graph, revision: graph.revision,
        ...(isHierarchical(previous.graph.state.plan) || previous.supervision?.rootReferral ? { supervision: { phase: 'READY', outcomes: previous.supervision.outcomes } } : {}),
        reports: previous.reports.filter(report => !ids.has(report.taskId)),
        reportArchive: [...previous.reportArchive ?? [], ...previous.reports.filter(report => ids.has(report.taskId))],
        ...(previous.invalidatedReports ? { invalidatedReports: previous.invalidatedReports.filter(id => !ids.has(id)) } : {}) })
    })
  }
  expandRevision(proposal) {
    const previous = this.read(), names = new Map(previous.contexts.nodes.map(node => [node.id, node.key]))
    const contextGraph = copy(proposal.contextGraph)
    contextGraph.nodes = contextGraph.nodes.map(node => {
      if (node.retain !== true) return node
      if (Object.keys(node).some(key => !['key', 'retain', 'sha256'].includes(key))) fail('REVISION_RETAIN_REFERENCE_INVALID')
      const source = previous.contexts.nodes.find(row => row.key === node.key)
      if (!source) fail('REVISION_RETAIN_REFERENCE_INVALID')
      const value = { key: source.key, content: source.content, parents: source.parents.map(id => names.get(id)),
        ...(source.mutable ? { mutable: true } : {}) }
      if (node.sha256 !== digest(value)) fail('REVISION_RETAIN_REFERENCE_INVALID')
      return value
    })
    return proposalSchema.parse({ taskGraph: proposal.taskGraph, contextGraph })
  }
  prepareRevision(proposal, { id, rootGoalAuthority } = {}) {
    const previous = this.read()
    if (!previous) fail('CONTEXT_GRAPH_NOT_SUBMITTED')
    const input = this.expandRevision(proposal)
    // A planner can echo the published wording. Retain the stored binding and
    // its identity when the proposal introduces no actual instruction change.
    const currentFacts = new Map(currentSharedContexts(previous).map(row => [row.key, row.content]))
    const originalFacts = new Map(previous.contexts.nodes.map(node => [node.key, node]))
    for (const node of input.contextGraph.nodes) {
      const original = originalFacts.get(node.key)
      if (original && node.content !== original.content && node.content === currentFacts.get(node.key)) node.content = original.content
    }
    const idsByKey = new Map(previous.graph.state.plan.nodes.map(node => [node.key, node.id]))
    const priorBindings = new Map(previous.contexts.bindings.map(row => [row.taskId, row]))
    const namesById = new Map(previous.graph.state.plan.nodes.map(node => [node.id, node.key]))
    for (const entry of input.contextGraph.bindings) {
      const old = priorBindings.get(idsByKey.get(entry.task))
      if (old && entry.instruction !== old.instruction && entry.instruction === criteriaInstruction(previous, old)) entry.instruction = old.instruction
      if (old) {
        const sources = criteriaReportSources(previous, old)
        if (sources !== old.inheritReports && canonical(entry.inheritReports) === canonical(sources.map(id => namesById.get(id))))
          entry.inheritReports = old.inheritReports.map(id => namesById.get(id))
      }
    }
    this.checkUnitLimit(input.taskGraph, previous)
    const scratch = Object.create(DynamicContextGraph.prototype)
    scratch.workflowLimits = resolveWorkflowLimits({ ...this.workflowLimits, maxUnits: this.unitLimit(previous).maximum,
      maxDepth: Math.max(this.workflowLimits.maxDepth, expansionDepth(previous.graph.state.plan)) })
    scratch.owner = this.owner
    scratch.supervisionEnabled = this.supervisionEnabled
    scratch.initialSnapshot(proposalSchema.parse(input), previous.ruleAudit) // Validate candidate shape without committing a new graph.
    const plan = revisedPlan(previous.graph, input.taskGraph, { id, rootGoalAuthority, workflowLimits: scratch.workflowLimits })
    const taskKeys = new Map(plan.nodes.map(node => [node.key, node.id]))
    const ids = new Map(input.contextGraph.nodes.map(node => {
      const old = previous.contexts.nodes.find(row => row.key === node.key)
      if (old?.mutable && node.mutable && old.content !== node.content) fail('SHARED_CONTEXT_INITIAL_VALUE_IMMUTABLE')
      return [node.key, old?.id ?? (id ? id('ctx') : `ctx_${randomUUID()}`)]
    }))
    const body = { graphId: plan.id, creationChecksum: previous.graph.events[0].hash,
      nodes: input.contextGraph.nodes.map(node => ({ ...node, id: ids.get(node.key), parents: node.parents.map(key => ids.get(key)) })),
      bindings: input.contextGraph.bindings.map(binding => ({ taskId: taskKeys.get(binding.task), instruction: binding.instruction,
        contexts: binding.contexts.map(key => ids.get(key)), inheritReports: binding.inheritReports.map(key => taskKeys.get(key)), tools: binding.tools,
        ...(binding.baseline ? { baseline: binding.baseline } : {}), ...(binding.completion ? { completion: binding.completion } : {}) })),
    }
    const contexts = { ...body, version: digest(body) }
    checkContexts(contexts, { ...previous.graph, state: { ...previous.graph.state, plan } })
    const overrides = new Map((proposal.criteriaAmendment?.bindings ?? []).filter(row => row.reportSources)
      .map(row => [row.taskId, row.reportSources.sources]))
    const effectiveBindings = contexts.bindings.map(binding => ({ ...binding,
      inheritReports: overrides.get(binding.taskId) ?? criteriaReportSources(previous, binding) }))
    if (effectiveBindings.some((binding, i) => binding.inheritReports !== contexts.bindings[i].inheritReports)) {
      const { version, ...body } = contexts
      const effective = { ...body, bindings: effectiveBindings }
      checkContexts({ ...effective, version: digest(effective) }, { ...previous.graph, state: { ...previous.graph.state, plan } })
    }
    preserveExecutedBindings(previous, contexts)
    const invalid = new Set(previous.invalidatedReports ?? [])
    for (const key of proposal.invalidateReports) {
      const id = previous.graph.state.plan.nodes.find(node => node.key === key)?.id
      if (!previous.reports.some(report => report.taskId === id)) fail('INVALIDATED_REPORT_MISSING')
      invalid.add(id)
    }
    let changed = true
    while (changed) {
      changed = false
      for (const report of previous.reports) {
        const source = [previous.contexts, ...(previous.contextHistory ?? []).map(row => row.contexts)].find(row => row.version === report.contextVersion)
        if (!invalid.has(report.taskId) && criteriaReportSources(previous, source.bindings.find(row => row.taskId === report.taskId)).some(id => invalid.has(id))) {
          invalid.add(report.taskId); changed = true
        }
      }
    }
    for (const binding of contexts.bindings) if (['PENDING', 'INACTIVE'].includes(previous.graph.state.leaves[binding.taskId]?.status ?? 'PENDING')
        && criteriaReportSources(previous, binding).some(id => invalid.has(id))) fail('INVALIDATED_REPORT_INHERITANCE')
    const invalidatedReports = [...invalid].sort()
    if (proposal.factAmendments) approvedFacts(previous, proposal.factAmendments)
    const amendment = proposal.criteriaAmendment && checkCriteriaDraft(previous, proposal.criteriaAmendment, currentPlanningRecord(previous)?.report)
    return { plan, contexts, invalidatedReports, baseChecksum: previous.checksum,
      ...(proposal.factAmendments ? { factAmendments: copy(proposal.factAmendments) } : {}),
      ...(amendment ? { criteriaAmendment: copy(amendment) } : {}),
      effect: Boolean(amendment || proposal.factAmendments) || canonical(plan) !== canonical(previous.graph.state.plan) || contexts.version !== previous.contexts.version
        || canonical(invalidatedReports) !== canonical([...(previous.invalidatedReports ?? [])].sort()) }
  }
  commitRevision({ expectedRevision, prepared, review }) {
    return this.store.compareAndSwap(expectedRevision, previous => {
      if (!previous || previous.checksum !== prepared.baseChecksum) fail('REVISION_STALE_BASE')
      this.checkUnitLimit(prepared.plan, previous)
      if (isHierarchical(previous.graph.state.plan) && (review.reviewerRunId !== previous.supervision.roleRunId
          || review.updaterRunId !== previous.supervision.hierarchy?.updaterRunId)) fail('HIERARCHY_REVISION_ROLE_MISMATCH')
      if (review.preparedHash !== digest(prepared) || review.proposalHash !== digest(review.proposal)) fail('REVISION_APPROVED_DRAFT_MISMATCH')
      if (canonical(prepared.factAmendments) !== canonical(review.proposal.factAmendments)) fail('REVISION_APPROVED_DRAFT_MISMATCH')
      if (canonical(prepared.criteriaAmendment) !== canonical(review.proposal.criteriaAmendment)) fail('REVISION_APPROVED_DRAFT_MISMATCH')
      if (prepared.criteriaAmendment) checkCriteriaDraft(previous, prepared.criteriaAmendment, currentPlanningRecord(previous)?.report, review.scopeSignal?.scopeId)
      const amendments = prepared.factAmendments && approvedFacts(previous, prepared.factAmendments)
      const temporary = new MemoryGraphStore(previous.graph)
      this.core(temporary).revise({ expectedRevision, operationId: `op_${randomUUID()}`, plan: prepared.plan, review })
      return seal({ ...previous, revision: expectedRevision + 1, graph: temporary.read(), contexts: prepared.contexts,
        ...(amendments ? { sharedContextHistory: [...previous.sharedContextHistory ?? [], ...amendments] } : {}),
        contextHistory: prepared.contexts.version === previous.contexts.version ? previous.contextHistory ?? []
          : [...previous.contextHistory ?? [], { graph: previous.graph, contexts: previous.contexts }],
        invalidatedReports: prepared.invalidatedReports,
        ...(previous.supervision ? { supervision: { phase: isHierarchical(previous.graph.state.plan) ? 'HIERARCHY' : 'READY', outcomes: previous.supervision.outcomes } } : {}) })
    })
  }
  adoptCheckpoint({ expectedRevision, attemptId, owner }) {
    const state = this.read(), active = state?.graph.state.active
    if (state?.revision !== expectedRevision || !active || active.attemptId !== attemptId || active.owner !== owner) fail('DIRECT_RESUME_STALE_OR_DIFFERENT_ATTEMPT')
    // The caller holds the process lease and has verified a quiescent journal.
    // This retains the original logical attempt; it does not replay BEGUN.
    this.owner = owner
  }
  finish({ expectedRevision, report }) {
    const state = this.read(), active = state?.graph.state.active
    if (state?.supervision) fail('SUPERVISION_RESULT_COMMIT_REQUIRED')
    if (!active || active.owner !== this.owner) fail('ACTIVE_TASK_REQUIRES_RECONCILIATION')
    if (report.taskId !== active.nodeId || report.attemptId !== active.attemptId) fail('REPORT_ACTIVE_ATTEMPT_MISMATCH')
    reportSchema.parse(report).evidence.forEach(ref => artifactProof(this.storageRoot, ref, undefined, this.artifactOptions))
    return this.mutate(expectedRevision, 'finish', { outcome: 'complete', evidence: report.evidence,
      note: 'Managed response and report committed; report semantics remain unverified.' }, report)
  }
  finishSupervised({ state, result, check }) {
    return this.store.compareAndSwap(state.revision, previous => {
      const control = previous?.supervision
      if (previous?.checksum !== state.checksum || control?.phase !== 'CHECK_RESULT'
          || control.roleRunId !== check.runId || check.submissionHash !== digest(control.pending.report))
        fail('SUPERVISION_RESULT_APPROVAL_STALE')
      const { report, authorityHash } = control.pending
      report.evidence.forEach(ref => artifactProof(this.storageRoot, ref, undefined, this.artifactOptions))
      result.artifacts.forEach(ref => artifactProof(this.projectRoot, ref, undefined, this.artifactOptions))
      if (previous.graph.state.plan.ruleVersion ? !['PASS','FAILED'].includes(result.outcome) : result.outcome==='PASS') fail('RULE_AGENT_BINARY_OUTCOME_REQUIRED')
      const complete = ['COMPLETE','PASS'].includes(result.outcome)
      const disposition = complete ? 'COMPLETED' : result.outcome === 'FAILED' ? 'FAILED' : 'UNSATISFIED'
      const temporary = new MemoryGraphStore(previous.graph)
      this.core(temporary).finish({ expectedRevision: state.revision, operationId: `op_${randomUUID()}`,
        outcome: complete ? 'complete' : 'incomplete', disposition,
        evidence: report.evidence, note: `Accepted structured disposition: ${result.outcome}.` })
      const graph = temporary.read()
      const entry = { taskId: report.taskId, attemptId: report.attemptId, contextVersion: report.contextVersion,
        revision: graph.revision, authorityHash, result, check, evidence: report.evidence }
      return seal({ ...previous, graph, revision: graph.revision,
        reports: complete ? [...previous.reports, { ...report, text: result.executionReport ? JSON.stringify({ summary: result.summary,
          results: result.executionReport.results, directories: result.executionReport.directories, limitations: result.executionReport.limitations,
          ...(acceptanceEnabled(previous) ? { verification: result.executionReport.verification ?? [], delivery: result.executionReport.delivery ?? null } : {}) }) : result.summary }] : previous.reports,
        supervision: { phase: isHierarchical(graph.state.plan) ? 'HIERARCHY' : 'CHECK_PLAN', outcomes: [...control.outcomes, entry] } })
    })
  }
  /** Trusted host attestation is enforced by the runtime before this port. */
  async reconcile({ expectedRevision, expectedAttemptId, note, evidence, precommit, authorityHash }) {
    const previous = this.read(), active = previous?.graph.state.active
    if (!active || active.attemptId !== expectedAttemptId || previous.revision !== expectedRevision) fail('DIRECT_RECONCILE_STALE_OR_DIFFERENT_ATTEMPT')
    if (previous.graph.state.plan.ruleVersion) fail('RULE_RECOVERY_REQUIRES_RECORDED_RESULT', {path:'/outcome',reason:'Resume the durable attempt or recover its verified result before settling this route.'})
    const temporary = new MemoryGraphStore(previous.graph)
    const engine = new TransactionGraph(temporary, { id: prefix => `${prefix}_reconcile_${randomUUID()}`, verifyRecovery: async () => true })
    await engine.reconcile({ expectedRevision, operationId: `op_${randomUUID()}`, outcome: 'incomplete', note, evidence })
    return this.store.compareAndSwap(expectedRevision, current => {
      precommit?.()
      if (current.checksum !== previous.checksum) fail('DIRECT_RECONCILE_STATE_CHANGED')
      const graph = temporary.read()
      const supervision = current.supervision && { phase: isHierarchical(graph.state.plan) ? 'HIERARCHY' : 'CHECK_PLAN', outcomes: [...current.supervision.outcomes, {
        taskId: active.nodeId, attemptId: active.attemptId, contextVersion: current.contexts.version,
        revision: graph.revision, authorityHash, evidence, check: null, result: { outcome: 'BLOCKED', summary: note, artifacts: [] },
      }] }
      return seal({ ...current, revision: graph.revision, graph, ...(supervision ? { supervision } : {}) })
    })
  }
  checkInputs(state, taskId, priorReports) {
    const binding = state.contexts.bindings.find(row => row.taskId === taskId)
    const graph = state.graph.state, routing = groupRouting(graph)
    const lineage = routing ? new Set([taskId, ...ancestorsOf(graph.plan, taskId).map(node => node.id)]) : null
    const sources = criteriaReportSources(state, binding).filter(id => {
      if (!routing) return true
      if (routing.branch(id) === 'NOT_SELECTED') return false
      if (graph.plan.ruleVersion) return routing.outcome(id) != null
      // An OR join can start with one accepted alternative and no report from the others.
      return graph.hierarchy.groups[id] || !graph.plan.edges.some(edge => edge.kind === 'route' && edge.from === id && lineage.has(edge.to))
    })
    const reports = sources.map(id => {
      const source = state.graph.state.plan.nodes.find(node => node.id === id)
      if (isHierarchical(state.graph.state.plan) && source?.kind === 'container') {
        const group = graph.hierarchy.groups[id]
        if (!group || !['COMPLETE','PASS','FAILED'].includes(group.outcome) && !(routing && group.outcome === 'BLOCKED')) fail('INHERITED_REPORT_NOT_COMMITTED')
        return { taskId: id, groupReport: copy(group.aliasOf ? graph.hierarchy.groups[group.aliasOf] : group),
          acceptance: group.outcome === 'FAILED' ? 'GROUP_FAILED_DISPOSITION' : group.outcome === 'BLOCKED' ? 'GROUP_BLOCKED_DISPOSITION' : 'GROUP_FINAL_ACCEPTED' }
      }
      let report = state.reports.find(row => row.taskId === id)
      const task = state.graph.state.plan.nodes.find(node => node.id === taskId), parent = state.graph.state.plan.nodes.find(node => node.id === task.parent)
      const terminalInput = isHierarchical(state.graph.state.plan) && parent.terminal === taskId && source?.parent === parent.id
      if (!report && (terminalInput || graph.plan.ruleVersion)) {
        const outcome = state.supervision.outcomes.findLast(row => row.taskId === id && row.attemptId === state.graph.state.leaves[id]?.attemptId)
        if (outcome) report = { taskId: id, attemptId: outcome.attemptId, text: JSON.stringify(outcome.result), evidence: outcome.evidence, acceptance: 'ACCEPTED_DISPOSITION_NOT_SUCCESS' }
      }
      if (!report || !terminalInput && !graph.plan.ruleVersion && state.graph.state.leaves[id].status !== 'COMPLETE') fail('INHERITED_REPORT_NOT_COMMITTED')
      report.evidence.forEach(ref => artifactProof(this.storageRoot, ref, undefined, this.artifactOptions))
      return copy(report)
    })
    if (state.supervision) {
      const inputs = new Set(sources)
      for (const row of state.supervision.outcomes) if (inputs.has(row.taskId)) {
        if (state.graph.events.some(event => event.type === 'REOPENED' && event.data.attempts.some(attempt =>
          attempt.nodeId === row.taskId && attempt.attemptId === row.attemptId))) continue
        if (this.reportScoped) {
          const inherited = reports.find(report => report.taskId === row.taskId)
          const pinned = priorReports?.find(report => report.taskId === row.taskId && report.attemptId === inherited.attemptId)?.currentArtifactChecks
          // File observations belong to the leaf's original input. Its own
          // work may have changed those files since. Keep the accepted report
          // and evidence checks above, and bind each saved observation to it.
          if (pinned !== undefined) {
            if (!Array.isArray(pinned) || pinned.length !== row.result.artifacts.length || row.result.artifacts.some((ref, i) => {
              const seen = pinned[i]
              return seen?.acceptedSha256 !== ref.sha256 || typeof seen?.ref !== 'string'
                || path.resolve(this.projectRoot, seen.ref) !== path.resolve(this.projectRoot, ref.ref)
            })) fail('DIRECT_RESUME_CONTEXT_CHANGED', { taskId: row.taskId, path: '/inheritedReports/currentArtifactChecks' })
            inherited.currentArtifactChecks = copy(pinned)
          } else inherited.currentArtifactChecks = row.result.artifacts.map(ref => artifactCurrentIdentity(this.projectRoot, ref, undefined, this.artifactOptions))
          inherited.identityQualification = 'The immutable report/trace proves the historical accepted result. Current artifact checks are file identity observations, not current semantic or directory-tree acceptance. CHANGED/MISSING never becomes a new success proof; use current files and satisfy this leaf contract. Ordinary authorized later development may change earlier deliverables without rewriting their history.'
        } else for (const ref of row.result.artifacts) artifactProof(this.projectRoot, ref, undefined, this.artifactOptions)
      }
    }
    return reports
  }

  applyUserFact({ scopeId, id, expectedRevision, content }, message, guidanceId) {
    const state = this.read()
    if (state?.graph.state.plan.hierarchy?.version !== 2 || !guidanceId || !message?.id || message.source?.kind !== 'user'
        || !message.content?.some(part => part.type === 'text' && part.text.includes(content))) fail('USER_FACT_ORIGINAL_REQUIRED')
    const change = userFact.parse({ authority: 'user-guidance', scopeId, id, revision: expectedRevision + 1, content,
      guidanceId, messageId: message.id, messageHash: digest(message) })
    const prior = state.sharedContextHistory?.find(row => row.guidanceId === guidanceId)
    if (prior) {
      if (canonical(prior) !== canonical(change)) fail('USER_FACT_RECEIPT_CHANGED')
      return state
    }
    return this.store.compareAndSwap(state.revision, previous => {
      const history = previous.sharedContextHistory ?? []
      const applied = history.find(row => row.guidanceId === guidanceId)
      if (applied) {
        if (canonical(applied) !== canonical(change)) fail('USER_FACT_RECEIPT_CHANGED')
        return previous
      }
      const binding = previous.contexts.bindings.find(row => row.taskId === scopeId)
      const node = binding && contextClosure(previous.contexts, binding).find(row => row.id === id)
      if (!node) fail('USER_FACT_OUTSIDE_UNIT')
      if (sharedContextVersions(history, node).length !== expectedRevision) fail('USER_FACT_REVISION_STALE')
      return seal({ ...previous, sharedContextHistory: [...history, change] })
    })
  }
  sharedContext(assembly, { id, revision, content, reason }, callId, segmentId) {
    const state = this.read(), active = state?.graph.state.active
    if (!active || active.attemptId !== assembly.task.attemptId || active.owner !== this.owner
        || state.supervision && !['READY', ...(acceptanceEnabled(state) ? ['REWORK_RESULT'] : [])].includes(state.supervision.phase)) fail('SHARED_CONTEXT_ACTIVE_ATTEMPT_REQUIRED')
    const binding = state.contexts.bindings.find(row => row.taskId === active.nodeId)
    const node = contextClosure(state.contexts, binding).find(row => row.id === id && (row.mutable || content === undefined
      && state.sharedContextHistory?.some(change => change.authority && change.id === id)))
    if (!node) return { status: 'UNAVAILABLE', id }
    const history = state.sharedContextHistory ?? []
    const versions = sharedContextVersions(history, node)
    if (content === undefined) {
      const selected = revision === undefined ? versions.at(-1) : versions[revision - 1]
      return selected ? { status: 'FOUND', ...selected, latestRevision: versions.length }
        : { status: 'UNKNOWN_REVISION', id, revision, latestRevision: versions.length }
    }
    if (segmentId && (!acceptanceEnabled(state) || segmentId !== state.supervision?.correction?.id)) fail('SHARED_CONTEXT_SEGMENT_SCOPE')
    const receiptId = segmentId ? segmentId + ':' + callId : callId
    const prior = history.find(row => row.attemptId === active.attemptId && row.callId === receiptId)
    if (prior) {
      if (prior.id !== id || prior.content !== content || prior.reason !== reason) fail('SHARED_CONTEXT_CALL_REUSED')
      return { status: 'APPLIED', ...prior }
    }
    const change = { id, revision: versions.length + 1, content, ...(reason === undefined ? {} : { reason }),
      taskId: active.nodeId, attemptId: active.attemptId, callId: receiptId, ...(segmentId ? { sourceCallId: callId, segmentId } : {}) }
    this.store.compareAndSwap(state.revision, previous => {
      if (previous?.checksum !== state.checksum) fail('SHARED_CONTEXT_STALE_STATE')
      return seal({ ...previous, sharedContextHistory: [...history, change] })
    })
    return { status: 'APPLIED', ...change }
  }

  /** Expand the declared closure; resumed attempts keep their original seed. */
  assemble(prior) {
    const state = this.read(), active = state?.graph.state.active
    if (!active || active.owner !== this.owner) fail('ACTIVE_TASK_REQUIRES_RECONCILIATION')
    const task = state.graph.state.plan.nodes.find(node => node.id === active.nodeId)
    const binding = state.contexts.bindings.find(row => row.taskId === task.id)
    const chosen = [], visited = new Set()
    const visit = id => {
      if (visited.has(id)) return
      const node = state.contexts.nodes.find(row => row.id === id)
      node.parents.forEach(visit); visited.add(id)
      const versions = sharedContextVersions(state.sharedContextHistory ?? [], node)
      if (node.mutable || versions.length > 1) {
        const pinned = prior && prior.contexts.find(row => row.id === id)?.revision
        if (prior && !node.mutable && pinned === undefined) { chosen.push(copy(node)); return }
        const selected = prior ? versions[pinned - 1] : versions.at(-1)
        if (!selected) fail('SHARED_CONTEXT_PIN_NOT_AVAILABLE')
        chosen.push({ ...copy(node), content: selected.content, revision: selected.revision })
      } else chosen.push(copy(node))
    }
    binding.contexts.forEach(visit)
    const reports = this.checkInputs(state, task.id, prior?.inheritedReports)
    const result = { protocol: 'dynamic-context-prototype-v1', contextVersion: state.contexts.version,
      task: { id: task.id, key: task.key, label: task.label, attemptId: active.attemptId, instruction: criteriaInstruction(state, binding) },
      contexts: chosen, inheritedReports: reports, tools: [...binding.tools], ...(binding.baseline ? { unitBaseline: copy(binding.baseline) } : {}),
      ...(state.graph.state.plan.ruleVersion ? {ruleVersion:1} : {}),
      ...(state.supervision ? { completion: binding.completion, ...(this.reportScoped ? { reportProtocol: 'report-scoped-v1' } : {}), ...(this.revisionPolicy ? { taskContract: copy(this.revisionPolicy) } : {}) } : {}),
      ...(acceptanceEnabled(state) ? { verificationPlan: copy(prior ? verificationAtStart(state, active.attemptId) : acceptancePlan(state)) } : {}),
      ...(this.revisionEnabled ? { revisionGuidance: '只有新证据推翻假设、发现遗漏依赖、上下文缺失或报告失效时才建议改图。普通错误先在当前任务内处理。执行 worker 不修改或审批双图。若发现必须修图，将证据写成项目内工件，在报告中给出路径、SHA-256、理由、受影响任务及阻塞情况，交给控制器在安全边界发起独立修订和审批。不得声称建议已获批准；报告提交不代表语义验收。' } : {}) }
    const superseded = state.graph.events.findLast(event => event.type === 'SUSPENSION_RESOLVED' && event.data.mode === 'supersede')
    const held = superseded && state.graph.events.find(event => event.type === 'SUSPENDED' && event.data.active.attemptId === superseded.data.attemptId)?.data
    if (held && (held.active.nodeId === task.id || ancestorsOf(state.graph.state.plan, task.id).some(node => node.id === held.metadata.scopeId)))
      result.interruptedWork = { attemptId: held.active.attemptId, taskId: held.active.nodeId, evidence: copy(held.evidence),
        qualification: 'Unfinished attempt preserved by user-guided replanning. Existing tool effects remain real; inspect original evidence and current files before reusing or redoing work. This is not an accepted execution report.' }
    const reopened = state.graph.events.findLast(event => event.type === 'REOPENED'
      && event.data.attempts.some(row => row.nodeId === task.id))
    if (reopened) {
      const ref = reopened.data.evidence[0], proof = artifactProof(this.storageRoot, ref, undefined, this.artifactOptions)
      const request = JSON.parse(readStored(proof.path, 'utf8'))
      artifactProof(this.storageRoot, ref, undefined, this.artifactOptions)
      if (request.roundId !== reopened.data.decisionId || request.decision?.action !== 'REWORK') fail('REWORK_REQUEST_CHANGED')
      result.reworkRequest = { previousAttempt: reopened.data.attempts.find(row => row.nodeId === task.id).attemptId,
        source: ref, findings: request.decision.report.findings,
        instruction: 'This is a new execution attempt after an evidence-backed withdrawal. Preserve the original task contract; address applicable defects, recheck affected prerequisites, and submit a fresh report. Old reports remain historical observations, not current completion proof.' }
    }
    return result
  }
}
