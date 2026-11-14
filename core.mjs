// SPDX-License-Identifier: GPL-3.0-only
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { TransactionGraph, canonical, copy, digest, validateDocument, view, revisedPlan, legalNext } from 'dsh-better-task-grapth/core'
import { FileGraphStore, MemoryGraphStore } from 'dsh-better-task-grapth/store'
import { artifactProof, artifactCurrentIdentity } from './artifacts.mjs'
import { completionSchema, reportSchema, planningReportSchema, supervisionSchema, validateSupervision, checkSupervisionUpdate } from './supervision-state.mjs'
import { TrackedGraphStore } from './graph-presence.mjs'

const key = z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/)
const text = n => z.string().min(1).max(n).refine(value => value.trim().length > 0)
const unique = values => new Set(values).size === values.length
const keys = () => z.array(key).max(32).refine(unique, 'Duplicate reference')
const toolNames = z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)).max(32).refine(unique)
export const contextText = text(131072)
const contextNode = z.object({ key, content: contextText, parents: keys().default([]), mutable: z.literal(true).optional() }).strict()
const sharedContextChange = z.object({
  id: key, revision: z.number().int().min(2), content: contextText,
  taskId: key, attemptId: key, callId: text(256), reason: text(2000).optional(),
}).strict()
const binding = z.object({ task: key, instruction: text(8000), contexts: keys(),
  inheritReports: keys().default([]), tools: toolNames.default([]), completion: completionSchema.optional() }).strict()
export const proposalSchema = z.object({
  planningReport: planningReportSchema.optional(),
  taskGraph: z.object({ title: text(512), nodes: z.array(z.object({ key,
    kind: z.enum(['container', 'leaf']), label: text(512), parent: key.optional() }).strict()).min(2).max(33),
  edges: z.array(z.object({ kind: z.literal('prerequisite'), from: key, to: key }).strict()).max(128) }).strict(),
  contextGraph: z.object({ nodes: z.array(contextNode).max(32), bindings: z.array(binding).min(1).max(32) }).strict(),
}).strict()

const normalizedContext = z.object({ graphId: key, creationChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  nodes: z.array(contextNode.extend({ id: key })).max(32),
  bindings: z.array(z.object({ taskId: key, instruction: text(8000), contexts: keys(),
    inheritReports: keys(), tools: toolNames, completion: completionSchema.optional() }).strict()).min(1).max(32),
  version: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
const stateSchema = z.object({ schema: z.literal(1), revision: z.number().int().positive(),
  graph: z.unknown(), contexts: normalizedContext, reports: z.array(reportSchema).max(32),
  sharedContextHistory: z.array(sharedContextChange).optional(),
  contextHistory: z.array(z.object({ graph: z.unknown(), contexts: normalizedContext }).strict()).optional(),
  invalidatedReports: z.array(key).refine(unique).optional(),
  supervision: supervisionSchema.optional(),
  planningRecord: z.object({ report: planningReportSchema, taskGraphSha256: z.string(), contextGraphSha256: z.string() }).strict().optional(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

export class DynamicContextError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${JSON.stringify(detail)}` : code)
    this.name = 'DynamicContextError'; this.code = code
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

function checkContexts(contexts, graph) {
  const { version, ...body } = normalizedContext.parse(contexts)
  if (digest(body) !== version || contexts.graphId !== graph.state.plan.id
      || contexts.creationChecksum !== graph.events[0].hash) fail('CONTEXT_GRAPH_VERSION_MISMATCH')
  const nodes = new Map(contexts.nodes.map(node => [node.id, node]))
  if (nodes.size !== contexts.nodes.length || !unique(contexts.nodes.map(node => node.key))) fail('DUPLICATE_CONTEXT_NODE')
  const visited = new Set(), visiting = new Set()
  const visit = id => {
    if (!nodes.has(id)) fail('UNKNOWN_CONTEXT_REFERENCE')
    if (visiting.has(id)) fail('CONTEXT_CYCLE')
    if (visited.has(id)) return
    visiting.add(id); nodes.get(id).parents.forEach(visit); visiting.delete(id); visited.add(id)
  }
  nodes.forEach(node => visit(node.id))
  const leaves = graph.state.plan.nodes.filter(node => node.kind === 'leaf')
  if (contexts.bindings.length !== leaves.length || !unique(contexts.bindings.map(row => row.taskId))) fail('EXACT_LEAF_BINDINGS_REQUIRED')
  for (const row of contexts.bindings) {
    if (!leaves.some(leaf => leaf.id === row.taskId)) fail('UNKNOWN_BOUND_TASK')
    row.contexts.forEach(id => { if (!nodes.has(id)) fail('UNKNOWN_CONTEXT_REFERENCE') })
    for (const source of row.inheritReports) {
      if (!leaves.some(leaf => leaf.id === source) || !reachable(source, row.taskId, graph.state.plan.edges)) fail('REPORT_SOURCE_MUST_BE_PREDECESSOR')
    }
  }
}

/** Validate the one durable document holding both graphs and committed reports. */
export function validateState(value) {
  const state = stateSchema.parse(value), { checksum, ...body } = state
  if (digest(body) !== checksum) fail('DYNAMIC_CONTEXT_CHECKSUM')
  validateDocument(state.graph)
  if (state.revision !== state.graph.revision) fail('GRAPH_REVISION_MISMATCH')
  checkContexts(state.contexts, state.graph)
  for (const historical of state.contextHistory ?? []) {
    validateDocument(historical.graph); checkContexts(historical.contexts, historical.graph)
  }
  const historyNodes = new Map([...(state.contextHistory ?? []).flatMap(row => row.contexts.nodes), ...state.contexts.nodes]
    .filter(node => node.mutable).map(node => [node.id, 1]))
  const historyCalls = new Set()
  for (const row of state.sharedContextHistory ?? []) {
    const call = row.attemptId + ':' + row.callId
    if ((historyNodes.get(row.id) ?? 0) + 1 !== row.revision || historyCalls.has(call))
      fail('SHARED_CONTEXT_HISTORY_INVALID')
    historyNodes.set(row.id, row.revision); historyCalls.add(call)
  }
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
      && binding.inheritReports.some(id => state.invalidatedReports?.includes(id))) fail('INVALIDATED_REPORT_INHERITANCE')
  validateSupervision(state)
  return state
}

function checkUpdate(previous, next) {
  validateState(next)
  if (canonical(previous?.sharedContextHistory) !== canonical(next.sharedContextHistory)) {
    const history = previous?.sharedContextHistory ?? []
    const changes = next.sharedContextHistory
    const active = previous?.graph.state.active
    if (!active || previous.supervision && previous.supervision.phase !== 'READY'
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
  if (canonical(next.planningRecord) !== canonical(previous.planningRecord)) fail('PLANNING_RECORD_IMMUTABLE')
  checkSupervisionUpdate(previous, next)
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
export function currentSharedContexts(state) {
  return state.contexts.nodes.filter(node => node.mutable).map(node => ({
    key: node.key, ...sharedContextVersions(state.sharedContextHistory ?? [], node).at(-1),
  }))
}
export function describeContextBindings(contexts, plan, leaves) {
  const keys = new Map(plan.nodes.map(node => [node.id, node.key]))
  return contexts.bindings.map(binding => ({ task: keys.get(binding.taskId),
    future: !leaves[binding.taskId] || ['PENDING', 'INACTIVE'].includes(leaves[binding.taskId].status),
    contextKeys: contextClosure(contexts, binding).map(node => node.key).sort(),
    inheritReports: binding.inheritReports.map(id => keys.get(id)),
  }))
}
function preserveExecutedBindings(previous, contexts) {
  for (const binding of previous.contexts.bindings) {
    if (['PENDING', 'INACTIVE'].includes(previous.graph.state.leaves[binding.taskId]?.status)) continue
    const next = contexts.bindings.find(row => row.taskId === binding.taskId)
    if (canonical(next) !== canonical(binding) || canonical(contextClosure(previous.contexts, binding)) !== canonical(contextClosure(contexts, next)))
      fail('EXECUTED_CONTEXT_BINDING_IMMUTABLE')
  }
}

/** Serial prototype using the existing task-graph core; never opens the live graph ledger. */
export class DynamicContextGraph {
  constructor({ projectRoot, storageRoot = projectRoot, directory, maxContextCharacters = 64000, maxReportCharacters = 16000, maxStateBytes, direct, revision, supervision, supervisionContext = 'legacy', storeFactory }) {
    if (maxContextCharacters !== null && (!Number.isSafeInteger(maxContextCharacters) || maxContextCharacters < 1 || maxContextCharacters > 8388608)) fail('INVALID_CONTEXT_BUDGET')
    this.maxContextCharacters = maxContextCharacters
    this.maxReportCharacters = maxReportCharacters
    this.artifactOptions = direct?.maxJournalBytes === null ? { maxBytes: null } : undefined
    this.projectRoot = projectRoot
    this.storageRoot = storageRoot
    this.revisionEnabled = Boolean(revision)
    this.revisionPolicy = revision?.policy ? copy(revision.policy) : null
    this.supervisionEnabled = Boolean(supervision)
    this.reportScoped = supervisionContext === 'reports'
    this.owner = `owner_${randomUUID()}`
    this.store = new TrackedGraphStore({ projectRoot: storageRoot, directory, fileName: 'dynamic-context.json',
      ...(maxStateBytes === undefined ? {} : { maximumBytes: maxStateBytes }), validator: validateState, updateValidator: checkUpdate }, storeFactory)
  }
  read() {
    const state = this.store.read()
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
    return result
  }
  core(store) { return new TransactionGraph(store, { id: prefix => prefix === 'owner' ? this.owner : `${prefix}_${randomUUID()}` }) }

  /** Validate both proposals before atomically committing either graph. */
  submit(input) {
    const proposal = proposalSchema.parse(input)
    return this.store.compareAndSwap(0, () => {
      const roots = proposal.taskGraph.nodes.filter(node => node.kind === 'container')
      const topologyError = (field, correction) => fail('PROTOTYPE_REQUIRES_ONE_ROOT_WITH_LEAF_PREREQUISITES', { field, correction })
      if (roots.length !== 1) topologyError('taskGraph.nodes', 'Declare exactly one node with kind="container". Put every leaf directly under it using parent.')
      const [root] = roots
      if (root.parent !== undefined) topologyError('taskGraph.nodes.' + root.key + '.parent', 'Omit parent on the root container.')
      const unparented = proposal.taskGraph.nodes.filter(node => node.kind === 'leaf' && node.parent !== root.key).map(node => node.key)
      const containerEdges = proposal.taskGraph.edges.filter(edge => edge.from === root.key || edge.to === root.key)
      if (unparented.length || containerEdges.length) fail('PROTOTYPE_REQUIRES_ONE_ROOT_WITH_LEAF_PREREQUISITES', {
        root: root.key, leavesNeedingRootParent: unparented, edgesTouchingRoot: containerEdges,
        correction: 'Set each listed leaf parent to the root key. Express containment with parent; keep prerequisite edges between leaves only.',
      })
      const temporary = new MemoryGraphStore()
      this.core(temporary).create({ operationId: `op_${randomUUID()}`, definition: proposal.taskGraph })
      const graph = temporary.read(), taskIds = new Map(graph.state.plan.nodes.map(node => [node.key, node.id]))
      const contextIds = new Map(proposal.contextGraph.nodes.map(node => [node.key, `ctx_${randomUUID()}`]))
      if (contextIds.size !== proposal.contextGraph.nodes.length) fail('DUPLICATE_CONTEXT_NODE')
      const contextBody = { graphId: graph.state.plan.id, creationChecksum: graph.events[0].hash,
        nodes: proposal.contextGraph.nodes.map(node => ({ ...node, id: contextIds.get(node.key),
          parents: node.parents.map(ref => { if (!contextIds.has(ref)) fail('UNKNOWN_CONTEXT_REFERENCE'); return contextIds.get(ref) }) })),
        bindings: proposal.contextGraph.bindings.map(row => ({ taskId: taskIds.get(row.task), instruction: row.instruction,
          contexts: row.contexts.map(ref => { if (!contextIds.has(ref)) fail('UNKNOWN_CONTEXT_REFERENCE'); return contextIds.get(ref) }),
          inheritReports: row.inheritReports.map(ref => { if (!taskIds.has(ref)) fail('UNKNOWN_REPORT_TASK'); return taskIds.get(ref) }), tools: row.tools,
          ...(row.completion ? { completion: row.completion } : {}) })),
      }
      const contexts = { ...contextBody, version: digest(contextBody) }
      const result = seal({ schema: 1, revision: graph.revision, graph, contexts, reports: [],
        ...(proposal.planningReport ? { planningRecord: { report: proposal.planningReport,
          taskGraphSha256: digest(proposal.taskGraph), contextGraphSha256: digest(proposal.contextGraph) } } : {}),
        ...(this.supervisionEnabled ? { supervision: { phase: 'READY', outcomes: [] } } : {}) })
      validateState(result)
      return result
    })
  }
  mutate(expectedRevision, operation, data, report) {
    return this.store.compareAndSwap(expectedRevision, previous => {
      if (!previous) fail('CONTEXT_GRAPH_NOT_SUBMITTED')
      if (Boolean(previous.supervision) !== this.supervisionEnabled) fail('SUPERVISION_CONFIGURATION_CHANGED')
      if (operation === 'begin' && previous.supervision) {
        if (previous.supervision.phase !== 'READY') fail('SUPERVISION_SCHEDULING_BLOCKED')
        const next = legalNext(previous.graph.state)[data.choice]
        if (next) this.checkInputs(previous, next.id)
      }
      const temporary = new MemoryGraphStore(previous.graph)
      this.core(temporary)[operation]({ ...data, expectedRevision, operationId: `op_${randomUUID()}` })
      const graph = temporary.read()
      return seal({ ...previous, schema: 1, revision: graph.revision, graph, contexts: previous.contexts,
        reports: report ? [...previous.reports, reportSchema.parse(report)] : previous.reports })
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
  prepareRevision(proposal) {
    const previous = this.read()
    if (!previous) fail('CONTEXT_GRAPH_NOT_SUBMITTED')
    const input = this.expandRevision(proposal)
    const scratch = Object.create(DynamicContextGraph.prototype)
    scratch.owner = this.owner
    scratch.supervisionEnabled = this.supervisionEnabled
    scratch.store = { compareAndSwap(_revision, build) { return build() } }
    scratch.submit(input) // Initial shape, cycle, reference and binding checks.
    const plan = revisedPlan(previous.graph, input.taskGraph)
    const taskKeys = new Map(plan.nodes.map(node => [node.key, node.id]))
    const ids = new Map(input.contextGraph.nodes.map(node => {
      const old = previous.contexts.nodes.find(row => row.key === node.key)
      if (old?.mutable && node.mutable && old.content !== node.content) fail('SHARED_CONTEXT_INITIAL_VALUE_IMMUTABLE')
      return [node.key, old?.id ?? `ctx_${randomUUID()}`]
    }))
    const body = { graphId: plan.id, creationChecksum: previous.graph.events[0].hash,
      nodes: input.contextGraph.nodes.map(node => ({ ...node, id: ids.get(node.key), parents: node.parents.map(key => ids.get(key)) })),
      bindings: input.contextGraph.bindings.map(binding => ({ taskId: taskKeys.get(binding.task), instruction: binding.instruction,
        contexts: binding.contexts.map(key => ids.get(key)), inheritReports: binding.inheritReports.map(key => taskKeys.get(key)), tools: binding.tools,
        ...(binding.completion ? { completion: binding.completion } : {}) })),
    }
    const contexts = { ...body, version: digest(body) }
    checkContexts(contexts, { ...previous.graph, state: { ...previous.graph.state, plan } })
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
        if (!invalid.has(report.taskId) && source.bindings.find(row => row.taskId === report.taskId).inheritReports.some(id => invalid.has(id))) {
          invalid.add(report.taskId); changed = true
        }
      }
    }
    for (const binding of contexts.bindings) if (['PENDING', 'INACTIVE'].includes(previous.graph.state.leaves[binding.taskId]?.status ?? 'PENDING')
        && binding.inheritReports.some(id => invalid.has(id))) fail('INVALIDATED_REPORT_INHERITANCE')
    const invalidatedReports = [...invalid].sort()
    return { plan, contexts, invalidatedReports, baseChecksum: previous.checksum,
      effect: canonical(plan) !== canonical(previous.graph.state.plan) || contexts.version !== previous.contexts.version
        || canonical(invalidatedReports) !== canonical([...(previous.invalidatedReports ?? [])].sort()) }
  }
  commitRevision({ expectedRevision, prepared, review }) {
    return this.store.compareAndSwap(expectedRevision, previous => {
      if (!previous || previous.checksum !== prepared.baseChecksum) fail('REVISION_STALE_BASE')
      if (review.preparedHash !== digest(prepared) || review.proposalHash !== digest(review.proposal)) fail('REVISION_APPROVED_DRAFT_MISMATCH')
      const temporary = new MemoryGraphStore(previous.graph)
      this.core(temporary).revise({ expectedRevision, operationId: `op_${randomUUID()}`, plan: prepared.plan, review })
      return seal({ ...previous, revision: expectedRevision + 1, graph: temporary.read(), contexts: prepared.contexts,
        contextHistory: prepared.contexts.version === previous.contexts.version ? previous.contextHistory ?? []
          : [...previous.contextHistory ?? [], { graph: previous.graph, contexts: previous.contexts }],
        invalidatedReports: prepared.invalidatedReports,
        ...(previous.supervision ? { supervision: { phase: 'READY', outcomes: previous.supervision.outcomes } } : {}) })
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
    if (this.maxReportCharacters !== null && report.text.length > this.maxReportCharacters) fail('TASK_REPORT_EMPTY_OR_OVER_BUDGET')
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
      const complete = result.outcome === 'COMPLETE'
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
          results: result.executionReport.results, directories: result.executionReport.directories, limitations: result.executionReport.limitations }) : result.summary }] : previous.reports,
        supervision: { phase: 'CHECK_PLAN', outcomes: [...control.outcomes, entry] } })
    })
  }
  /** Trusted host attestation is enforced by the runtime before this port. */
  async reconcile({ expectedRevision, expectedAttemptId, note, evidence, precommit, authorityHash }) {
    const previous = this.read(), active = previous?.graph.state.active
    if (!active || active.attemptId !== expectedAttemptId || previous.revision !== expectedRevision) fail('DIRECT_RECONCILE_STALE_OR_DIFFERENT_ATTEMPT')
    const temporary = new MemoryGraphStore(previous.graph)
    const engine = new TransactionGraph(temporary, { id: prefix => `${prefix}_reconcile_${randomUUID()}`, verifyRecovery: async () => true })
    await engine.reconcile({ expectedRevision, operationId: `op_${randomUUID()}`, outcome: 'incomplete', note, evidence })
    return this.store.compareAndSwap(expectedRevision, current => {
      precommit?.()
      if (current.checksum !== previous.checksum) fail('DIRECT_RECONCILE_STATE_CHANGED')
      const graph = temporary.read()
      const supervision = current.supervision && { phase: 'CHECK_PLAN', outcomes: [...current.supervision.outcomes, {
        taskId: active.nodeId, attemptId: active.attemptId, contextVersion: current.contexts.version,
        revision: graph.revision, authorityHash, evidence, check: null, result: { outcome: 'BLOCKED', summary: note, artifacts: [] },
      }] }
      return seal({ ...current, revision: graph.revision, graph, ...(supervision ? { supervision } : {}) })
    })
  }
  checkInputs(state, taskId) {
    const binding = state.contexts.bindings.find(row => row.taskId === taskId)
    const reports = binding.inheritReports.map(id => {
      const report = state.reports.find(row => row.taskId === id)
      if (!report || state.graph.state.leaves[id].status !== 'COMPLETE') fail('INHERITED_REPORT_NOT_COMMITTED')
      report.evidence.forEach(ref => artifactProof(this.storageRoot, ref, undefined, this.artifactOptions))
      return copy(report)
    })
    if (state.supervision) {
      const inputs = new Set(binding.inheritReports)
      for (const row of state.supervision.outcomes) if (inputs.has(row.taskId)) {
        if (this.reportScoped) {
          const inherited = reports.find(report => report.taskId === row.taskId)
          inherited.currentArtifactChecks = row.result.artifacts.map(ref => artifactCurrentIdentity(this.projectRoot, ref, undefined, this.artifactOptions))
          inherited.identityQualification = 'The immutable report/trace proves the historical accepted result. Current artifact checks are file identity observations, not current semantic or directory-tree acceptance. CHANGED/MISSING never becomes a new success proof; use current files and satisfy this leaf contract. Ordinary authorized later development may change earlier deliverables without rewriting their history.'
        } else for (const ref of row.result.artifacts) artifactProof(this.projectRoot, ref, undefined, this.artifactOptions)
      }
    }
    return reports
  }

  sharedContext(assembly, { id, revision, content, reason }, callId) {
    const state = this.read(), active = state?.graph.state.active
    if (!active || active.attemptId !== assembly.task.attemptId || active.owner !== this.owner
        || state.supervision && state.supervision.phase !== 'READY') fail('SHARED_CONTEXT_ACTIVE_ATTEMPT_REQUIRED')
    const node = boundMutableNode(state, active, id)
    if (!node) return { status: 'UNAVAILABLE', id }
    const history = state.sharedContextHistory ?? []
    const versions = sharedContextVersions(history, node)
    if (content === undefined) {
      const selected = revision === undefined ? versions.at(-1) : versions[revision - 1]
      return selected ? { status: 'FOUND', ...selected, latestRevision: versions.length }
        : { status: 'UNKNOWN_REVISION', id, revision, latestRevision: versions.length }
    }
    const prior = history.find(row => row.attemptId === active.attemptId && row.callId === callId)
    if (prior) {
      if (prior.id !== id || prior.content !== content || prior.reason !== reason) fail('SHARED_CONTEXT_CALL_REUSED')
      return { status: 'APPLIED', ...prior }
    }
    const change = { id, revision: versions.length + 1, content, ...(reason === undefined ? {} : { reason }),
      taskId: active.nodeId, attemptId: active.attemptId, callId }
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
      if (node.mutable) {
        const versions = sharedContextVersions(state.sharedContextHistory ?? [], node)
        const pinned = prior && prior.contexts.find(row => row.id === id)?.revision
        const selected = prior ? versions[pinned - 1] : versions.at(-1)
        if (!selected) fail('SHARED_CONTEXT_PIN_NOT_AVAILABLE')
        chosen.push({ ...copy(node), content: selected.content, revision: selected.revision })
      } else chosen.push(copy(node))
    }
    binding.contexts.forEach(visit)
    const reports = this.checkInputs(state, task.id)
    const result = { protocol: 'dynamic-context-prototype-v1', contextVersion: state.contexts.version,
      task: { id: task.id, key: task.key, label: task.label, attemptId: active.attemptId, instruction: binding.instruction },
      contexts: chosen, inheritedReports: reports, tools: [...binding.tools],
      ...(state.supervision ? { completion: binding.completion, ...(this.reportScoped ? { reportProtocol: 'report-scoped-v1' } : {}), ...(this.revisionPolicy ? { taskContract: copy(this.revisionPolicy) } : {}) } : {}),
      ...(this.revisionEnabled ? { revisionGuidance: '只有新证据推翻假设、发现遗漏依赖、上下文缺失或报告失效时才建议改图。普通错误先在当前任务内处理。执行 worker 不修改或审批双图。若发现必须修图，将证据写成项目内工件，在报告中给出路径、SHA-256、理由、受影响任务及阻塞情况，交给控制器在安全边界发起独立修订和审批。不得声称建议已获批准；报告提交不代表语义验收。' } : {}) }
    if (this.maxContextCharacters !== null && JSON.stringify(result).length > this.maxContextCharacters) fail('ASSEMBLED_CONTEXT_BUDGET_EXCEEDED')
    return result
  }
}
