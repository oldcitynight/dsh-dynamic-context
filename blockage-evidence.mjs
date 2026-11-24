import { criteriaInstruction, criteriaReportSources } from './acceptance-protocol.mjs'
import { acceptanceEnabled } from './acceptance-protocol.mjs'
import { readStored,writeStored,hasStored,statStored } from './workflow-io.mjs'
// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { digest } from 'dsh-better-task-grapth/core'
import { diagnostic, located, parseModelJSON } from 'dsh-better-task-grapth/validation'
import { artifactProof } from './artifacts.mjs'
import { currentSharedContexts, fail } from './core.mjs'
import { BLOCKAGE_TOOLS, decisionHistoryRoles, lookupPointer } from './blockage-protocol.mjs'
import { readRoleRecord, roleRecordValue } from './revision-runtime.mjs'
import { revisionCheckSchema } from './review-feedback.mjs'
import { scopeAuditSchema, groupAuditSchema, binaryGroupAuditSchema, scopeProposalSchema, runtimeScopeProposalSchema } from './hierarchy-protocol.mjs'
import { unitRouteSchema } from './unit-roles.mjs'
import { scopedBlueprint } from './hierarchy-context.mjs'

export function saveBlockage(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  // Hash the representation actually written to JSON, including omission of
  // optional undefined fields, so a valid journal remains valid after reload.
  const stored = JSON.parse(JSON.stringify(value))
  const temporary = file + '.' + randomUUID() + '.tmp', body = { value: stored, checksum: digest(stored) }
  if(writeStored(file,JSON.stringify(body)))return
  const fd = fs.openSync(temporary, 'wx', 0o600)
  try { fs.writeFileSync(fd, JSON.stringify(body)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  fs.renameSync(temporary, file)
  const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir) } finally { fs.closeSync(dir) }
}
export function readBlockage(file) {
  if (!hasStored(file)) return null
  const { value, checksum } = JSON.parse(readStored(file, 'utf8'))
  if (digest(value) !== checksum) fail('BLOCKAGE_JOURNAL_CHANGED')
  return value
}
// Accepted group reports can cite their own frozen workspace observations.
// Expose those exact receipts, never reopen the historical filesystem paths.
// taskId keeps the existing hierarchy filter responsible for scope admission.
export function registerGroupObservations(runner, state, catalog, signal) {
  for (const [taskId, group] of Object.entries(state.graph.state.hierarchy?.groups ?? {})) {
    if (group.aliasOf || !/^revision_group_audit_[a-z0-9_-]+$/.test(group.runId ?? '')) continue
    const admitted = new Map((group.workspaceInspection?.observations ?? []).map(row => [row.source, row]))
    // The observation index keeps the latest read per path. A report may also
    // cite an earlier page/read of that same unchanged file; retain its exact
    // committed reference without admitting every uncited private tool result.
    const collect = value => {
      if (!value || typeof value !== 'object') return
      if (typeof value.source === 'string' && /^[a-f0-9]{64}$/.test(value.sha256 ?? '')) {
        const prior = admitted.get(value.source)
        if (prior && prior.sourceSha256 !== value.sha256) throw located('BLOCKAGE_ARCHIVED_OBSERVATION_CHANGED', {
          path: '/source', observed: value.source, reason: 'The accepted audit contains inconsistent identities for this observation.' })
        admitted.set(value.source, { source: value.source, sourceSha256: value.sha256 })
      }
      Object.values(value).forEach(collect)
    }
    collect(group.audit)
    for (const observation of admitted.values()) {
      const prefix = `workspace:${group.runId}:`, source = observation.source
      if (typeof source !== 'string' || !source.startsWith(prefix) || !/^[1-9][0-9]*$/.test(source.slice(prefix.length))) continue
      const file = path.join(runner.config.directory, 'revisions', group.runId, 'workspace-tool-results', source.slice(prefix.length) + '.json')
      catalog.set(source, { kind: 'workspace', taskId, load() {
        signal?.throwIfAborted()
        const stored = readBlockage(file), value = stored?.value
        if (!value || value.source !== source || value.sourceSha256 !== observation.sourceSha256
            || digest(value.value) !== observation.sourceSha256)
          throw located('BLOCKAGE_ARCHIVED_OBSERVATION_CHANGED', { path: '/source', observed: source,
            reason: 'The accepted group observation receipt is missing or differs from its committed identity. Historical evidence cannot be replaced by a new filesystem read.' })
        return structuredClone(value.value)
      } })
    }
  }
}
// A global investigation admits all attempts but opens an archive only when its owner or a
// correction is requested. A resumed role can resolve a deep reference without relying on
// the order of tool calls made by the previous process.
class GlobalCatalog extends Map {
  constructor(diagnosis) { super(); this.diagnosis = diagnosis; this.attempts = new Map() }
  get(id) {
    if (typeof id === 'string' && !this.has(id)) {
      const trace = /^trace:([^:]+):(0|[1-9][0-9]*)$/.exec(id)
      if (trace) this.attempts.get(trace[1])?.discover(Number(trace[2]))
      if (id.startsWith('workspace:')) this.workspaceIndex?.()
      if (id.startsWith('history:')) this.historyIndex?.()
    }
    return super.get(id)
  }
}
const historicRole = /^revision_([a-z_]+)_[a-f0-9-]{36}$/
function registerDecisionHistory(catalog, runner, state, signal) {
  const directory = path.join(runner.config.directory, 'revisions')
  const committed = new Map()
  for (const event of state.graph.events) if (event.type === 'REVISED') {
    const review = event.data.review
    for (const id of [review.updaterRunId, review.reviewerRunId, review.blockageSignal?.runId, review.scopeSignal?.blockageRunId, ...(review.scopeSignal?.baselineReviews ?? []).map(row => row.runId)])
      if (id) committed.set(id, event.seq)
  }
  for (const entry of fs.existsSync(directory) ? fs.readdirSync(directory, { withFileTypes: true }) : []) {
    const match = historicRole.exec(entry.name)
    if (!entry.isDirectory() || !match || !decisionHistoryRoles.has(match[1])) continue
    const runId = entry.name, role = match[1], file = path.join(directory, runId, 'role.json')
    const stat = statStored(file, { throwIfNoEntry: false })
    if (!stat?.isFile()) continue
    let cached
    catalog.set('history:' + runId, { kind: 'history', role, updated: stat.mtimeMs, load() {
      signal?.throwIfAborted()
      if (cached) return cached
      const record = readRoleRecord(runner, runId)
      if (!record || record.role !== role || !['COMPLETE','INVALID_RESPONSE','ABANDONED_UNVERIFIED','REJECTED'].includes(record.phase))
        throw located('BLOCKAGE_HISTORY_NOT_FINAL', { path: '/source', reason: 'This role has no finalized historical judgment.', observed: record?.phase })
      const input = JSON.parse(record.payload.messages[1].content)
      const revision = record.graphAnchor?.revision ?? input.revision ?? input.snapshot?.revision ?? input.situation?.revision ?? null
      const contextVersion = input.contextVersion ?? input.situation?.contextVersion
      if (revision > state.revision || record.graphAnchor && state.graph.events[revision - 1]?.hash !== record.graphAnchor.hash
          || contextVersion && contextVersion !== state.contexts.version && !(state.contextHistory ?? []).some(row => row.contexts.version === contextVersion))
        throw located('BLOCKAGE_HISTORY_OUTSIDE_CHECKPOINT', { path: '/source', reason: 'This judgment belongs to a later revision or another graph history.', observed: revision })
      let result = record.phase === 'COMPLETE' ? roleRecordValue(record) : null
      if (result && digest(result) !== record.resultHash) {
        // Old raw-JSON verdicts sometimes omitted defaults supplied by the original validator.
        // Accept only a reconstructed value that exactly matches the receipt.
        const schemas = { unit_router: [unitRouteSchema], baseline_audit: [scopeAuditSchema], reviewer: [revisionCheckSchema], blockage_audit: [revisionCheckSchema], scope_pause: [scopeAuditSchema],
          unit_audit: [binaryGroupAuditSchema], unit_plan_audit: [scopeAuditSchema], unit_planner: [runtimeScopeProposalSchema],
          scope_audit: [scopeAuditSchema], group_audit: [groupAuditSchema], scope_update: [scopeProposalSchema, runtimeScopeProposalSchema] }
        const match = (schemas[role] ?? []).map(schema => schema.safeParse(result)).find(row => row.success && digest(row.data) === record.resultHash)
        if (!match) fail('BLOCKAGE_HISTORY_RESULT_CHANGED')
        result = match.data
      }
      cached = { runId, role, phase: record.phase, revision,
        historyBinding: record.graphAnchor ? 'GRAPH_EVENT' : committed.has(runId) ? 'GRAPH_COMMIT' : 'LEGACY_WORKFLOW_RECEIPT',
        scopeId: result?.scopeId ?? input.scopeId ?? null, decision: result?.action ?? result?.disposition ?? result?.verdict ?? null,
        reason: result?.reason ?? result?.report?.summary ?? result?.modificationReport?.summary ?? null, record: result,
        ...(record.validationFeedback || record.error ? { diagnostic: record.validationFeedback ?? record.error } : {}),
        graphCommitRevision: committed.get(runId) ?? null }
      return cached
    } })
  }
  delete catalog.historyIndex
}
function registerLazyTraces(catalog, runner, row, signal, followCorrections) {
  const refs = [], known = new Set()
  let scanned = 0
  function add(ref) {
    if (known.has(ref.sha256)) fail('BLOCKAGE_TRACE_CHAIN_CYCLE')
    known.add(ref.sha256)
    const index = refs.length
    refs.push(ref)
    catalog.set(`trace:${row.attemptId}:${index}`, { kind: 'trace', taskId: row.taskId, load: () => read(index) })
  }
  function read(index) {
    signal?.throwIfAborted()
    const ref = refs[index], proof = artifactProof(runner.graph.storageRoot, ref, signal, runner.graph.artifactOptions)
    const bytes = readStored(proof.path)
    if (createHash('sha256').update(bytes).digest('hex') !== ref.sha256) fail('ARTIFACT_CHANGED_OR_HASH_MISMATCH')
    const trace = JSON.parse(bytes)
    if (trace.assembly?.task?.id !== row.taskId || trace.assembly.task.attemptId !== row.attemptId) fail('BLOCKAGE_TRACE_SCOPE_MISMATCH')
    return trace
  }
  function discover(index) {
    while (followCorrections && refs.length <= index && scanned < refs.length) {
      const previous = read(scanned).previousReport
      if (previous) {
        if (previous.taskId !== row.taskId || previous.attemptId !== row.attemptId) fail('BLOCKAGE_TRACE_SCOPE_MISMATCH')
        previous.evidence.forEach(add)
      }
      scanned++
    }
  }
  row.evidence.forEach(add)
  catalog.attempts.set(row.attemptId, { taskId: row.taskId, discover })
}
export function blockageCatalog(runner, state, signal, diagnosis) {
  const catalog = diagnosis ? new GlobalCatalog(diagnosis) : new Map()
  const add = (id, kind, value, taskId) => catalog.set(id, { kind, taskId, load: () => structuredClone(value) })
  if (!diagnosis) add('blueprint', 'blueprint', { graph: state.graph, contexts: { ...state.contexts, bindings: state.contexts.bindings.map(row => ({ ...row, instruction: criteriaInstruction(state, row), inheritReports: criteriaReportSources(state, row) })) } })
  catalog.set('shared', { kind: 'shared', load: () => ({ current: currentSharedContexts(state), history: structuredClone(state.sharedContextHistory ?? []) }) })
  const reopened = new Map()
  for (const event of state.graph.events) if (event.type === 'REOPENED') for (const attempt of event.data.attempts) {
    const key = attempt.nodeId + ':' + attempt.attemptId
    if (!reopened.has(key)) reopened.set(key, [])
    reopened.get(key).push({ decisionId: event.data.decisionId, revision: event.seq })
  }
  for (const row of state.supervision.outcomes) {
    const revoked = reopened.get(row.taskId + ':' + row.attemptId) ?? []
    add('report:' + row.attemptId, 'report', { taskId: row.taskId, attemptId: row.attemptId,
      result: row.result, revision: row.revision, contextVersion: row.contextVersion,
      qualification: 'Historical accepted disposition, not current goal acceptance.', revoked }, row.taskId)
    if (diagnosis) {
      registerLazyTraces(catalog, runner, row, signal, acceptanceEnabled(state))
      continue
    }
    const references = [...row.evidence], visited = new Set()
    for (let index = 0; index < references.length; index++) {
      const ref = references[index]
      if (visited.has(ref.sha256)) fail('BLOCKAGE_TRACE_CHAIN_CYCLE')
      visited.add(ref.sha256)
      if (acceptanceEnabled(state)) {
        const proof = artifactProof(runner.graph.storageRoot, ref, signal, runner.graph.artifactOptions)
        const trace = JSON.parse(readStored(proof.path, 'utf8'))
        artifactProof(runner.graph.storageRoot, ref, signal, runner.graph.artifactOptions)
        if (trace.previousReport) {
          if (trace.previousReport.taskId !== row.taskId || trace.previousReport.attemptId !== row.attemptId) fail('BLOCKAGE_TRACE_SCOPE_MISMATCH')
          references.push(...trace.previousReport.evidence)
        }
      }
      catalog.set(`trace:${row.attemptId}:${index}`, { kind: 'trace', taskId: row.taskId, load() {
        signal?.throwIfAborted()
        const proof = artifactProof(runner.graph.storageRoot, ref, signal, runner.graph.artifactOptions)
        const trace = JSON.parse(readStored(proof.path, 'utf8'))
        artifactProof(runner.graph.storageRoot, ref, signal, runner.graph.artifactOptions)
        if (trace.assembly?.task.id !== row.taskId || trace.assembly?.task.attemptId !== row.attemptId)
          fail('BLOCKAGE_TRACE_SCOPE_MISMATCH')
        return trace
      } })
    }
  }
  if (diagnosis) {
    catalog.historyIndex = () => registerDecisionHistory(catalog, runner, state, signal)
    for (const node of diagnosis.groups) {
      catalog.set('topology:' + node.id, { kind: 'topology', taskId: node.id, load: () => diagnosis.topology(node.id) })
      catalog.set('context-topology:' + node.id, { kind: 'topology', taskId: node.id, load() {
        const { scope, contextGraph } = scopedBlueprint(state, node.id)
        return { scope, contextVersion: state.contexts.version, contextGraph }
      } })
      const group = state.graph.state.hierarchy?.groups[node.id]
      if (group) add('group:' + node.id, 'report', { taskId: node.id, result: group.aliasOf ? state.graph.state.hierarchy.groups[group.aliasOf] : group }, node.id)
    }
    catalog.workspaceIndex = () => {
      registerGroupObservations(runner, state, catalog, signal)
      delete catalog.workspaceIndex
    }
  } else registerGroupObservations(runner, state, catalog, signal)
  return catalog
}
export function sourceValue(catalog, id) {
  const source = catalog.get(id)
  if (!source) throw located('BLOCKAGE_EVIDENCE_SOURCE_UNKNOWN', { path: '/source', reason: 'Choose an ID from this workflow source index.', observed: id })
  const value = source.load()
  return { source: id, sha256: digest(value), hashFormat: 'canonical-json-object', value }
}
export function blockageInput(runner, state, situation, catalog) {
  return { protocol: 'blockage-handler-v1', baseChecksum: state.checksum, contract: runner.config.revision.policy,
    situation, taskGraph: state.graph, contextGraph: state.contexts,
    affectedReports: [...catalog].filter(([,s]) => s.kind === 'report' && situation.related.includes(s.taskId))
      .map(([id]) => sourceValue(catalog, id)),
    availableSources: [...catalog].map(([source, row]) => ({ source, kind: row.kind, ...(row.taskId ? { taskId: row.taskId } : {}) })),
    qualification: 'Frozen at the no-ready-leaf boundary. Hashes identify source bytes; they do not establish semantic truth. Private traces are available only through the scoped read tools.' }
}
const pageSchema = z.object({ source: z.string().min(1), path: z.string().default(''),
  start: z.number().int().min(0).default(0), end: z.number().int().positive().optional() }).strict()
const wire = (name, description, parameters) => ({ type: 'function', function: { name, description, parameters } })
const pageParameters = { type: 'object', properties: { source: { type: 'string' }, path: { type: 'string' },
  start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 1 } }, required: ['source'], additionalProperties: false }
const instructions = ' Read only within this frozen workflow. sourceSha256 hashes the complete canonical JSON source, not the page. Cite source + sourceSha256 + JSON Pointer + exact quote. Text pages use UTF-16 offsets; follow next to read the rest. '
export function blockageTools(catalog, directory, signal) {
  let ordinal = 0
  const global = catalog.diagnosis
  const listSchema = z.object({ taskId: z.string().optional(), corrections: z.boolean().optional(), kind: z.enum(['report','trace','shared','workspace','topology']).optional(),
    start: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(64).default(32) }).strict()
  const listProperties = global ? { taskId: { type: 'string' }, corrections: { type: 'boolean' }, kind: { type: 'string', enum: ['report','trace','shared','workspace','topology'] },
    start: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 64 } } : {}
  const tools = [wire(BLOCKAGE_TOOLS.list, global
    ? 'Page through sources in this workflow. Filter by taskId from the topology, including historic attempts. Use corrections:true with taskId to discover older correction traces, kind:workspace for archived observations. Follow next. Example: {"taskId":"node_actual","kind":"trace"}.'
    : 'List admitted report, archived workspace observation, private trace and shared-context source IDs. Example: {}.',
    { type: 'object', properties: listProperties, additionalProperties: false }),
  wire(BLOCKAGE_TOOLS.report, 'Read an admitted task report, including revoked attempts, or a frozen workspace observation from an accepted group audit. The latter reads the archived receipt, not the current file, and grants no filesystem capability.' + instructions
    + 'Leaf reports use /result/executionReport; group audit findings and limitations are under /result/audit. Examples: {"source":"report:attempt_example","path":"/result"}; {"source":"workspace:revision_group_audit_example:1","path":"/text"}. Use actual IDs from the source index.', pageParameters),
  wire(BLOCKAGE_TOOLS.trace, 'Read a registered private execution record; arbitrary paths and other workflows are unavailable.' + instructions + 'Example: {"source":"trace:attempt_example:0","path":"/events","start":0,"end":4000}.', pageParameters),
  wire(BLOCKAGE_TOOLS.shared, 'Read current shared facts or historical revisions.' + instructions + 'Example: {"source":"shared","path":"/current"}; history: {"source":"shared","path":"/history"}.', pageParameters)]
  if (global) tools.push(wire(BLOCKAGE_TOOLS.topology, 'Read the root topology with {}, or one group with {"scopeId":"group_key_or_id"}. The task view exposes children, statuses, parent, terminal and unmet dependencies. Use view:context for the planned context nodes and bindings of that group, including pending leaves. Group IDs are local to this workflow.' + instructions,
    { type: 'object', properties: { scopeId: { type: 'string' }, view: { type:'string', enum:['task','context'] }, path: pageParameters.properties.path, start: pageParameters.properties.start, end: pageParameters.properties.end }, additionalProperties: false }))
  if (global) tools.push(wire(BLOCKAGE_TOOLS.history, 'List past blockage, planning, updater and audit roles newest first with {} or {"role":"scope_update","start":0,"limit":16}. Read one result with {"source":"history:revision_…","path":"/record"}. graphCommitRevision identifies an applied change; an absent historical reason remains null. ' + instructions,
    { type: 'object', properties: { ...pageParameters.properties, role: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 64 } }, additionalProperties: false }))
  return { tools, execute(tool) {
    signal?.throwIfAborted()
    const identity = { ordinal: ++ordinal, name: tool.function.name, id: tool.id, arguments: tool.function.arguments }
    const file = path.join(directory, 'blockage-tool-results', ordinal + '.json'), stored = readBlockage(file)
    if (stored) {
      if (digest(stored.identity) !== digest(identity)) fail('BLOCKAGE_TOOL_RECEIPT_CHANGED')
      return stored.value
    }
    let value
    try {
      const args = parseModelJSON(tool.function.arguments).value
      const history = global && tool.function.name === BLOCKAGE_TOOLS.history
      if (history && args.source === undefined) {
        const q = listSchema.pick({ start: true, limit: true }).extend({ role: z.string().optional() }).strict().parse(args)
        catalog.historyIndex?.()
        const sources = [...catalog].filter(([id, row]) => row.kind === 'history' && id !== 'history:' + path.basename(directory) && (!q.role || row.role === q.role))
          .map(([source, row]) => ({ source, role: row.role, updated: row.updated }))
          .sort((a, b) => b.updated - a.updated || a.source.localeCompare(b.source))
        value = { sources: sources.slice(q.start, q.start + q.limit), total: sources.length, next: q.start + q.limit < sources.length ? q.start + q.limit : null }
      } else if (global && tool.function.name === BLOCKAGE_TOOLS.list) {
        const q = listSchema.parse(args)
        if (q.corrections && !q.taskId) throw located('BLOCKAGE_TASK_ID_REQUIRED', { path: '/taskId', reason: 'Select a task before expanding its correction archives.' })
        if (q.corrections) for (const attempt of catalog.attempts.values()) if (attempt.taskId === q.taskId) attempt.discover(Infinity)
        if (q.kind === 'workspace') catalog.workspaceIndex?.()
        const sources = [...catalog].filter(([, row]) => row.kind !== 'blueprint' && row.kind !== 'history' && (!q.taskId || row.taskId === q.taskId) && (!q.kind || row.kind === q.kind))
          .map(([source,row]) => ({ source, kind: row.kind, taskId: row.taskId })).sort((a,b) => a.source.localeCompare(b.source))
        value = { sources: sources.slice(q.start, q.start + q.limit), total: sources.length, next: q.start + q.limit < sources.length ? q.start + q.limit : null }
      } else if (tool.function.name === BLOCKAGE_TOOLS.list) {
        z.object({}).strict().parse(args)
        value = { sources: [...catalog].map(([source, row]) => ({ source, kind: row.kind, taskId: row.taskId })) }
      } else {
        let parameters = args
        const topology = global && tool.function.name === BLOCKAGE_TOOLS.topology
        if (topology) {
          const { scopeId, view, ...page } = pageSchema.omit({ source: true }).extend({ scopeId: z.string().optional(), view: z.enum(['task','context']).default('task') }).strict().parse(args)
          const scope = scopeId === undefined ? global.rootId : global.groups.find(node => node.id === scopeId || node.key === scopeId)?.id
          if (!scope) throw located('BLOCKAGE_TOPOLOGY_SCOPE_UNKNOWN', { path: '/scopeId', reason: 'Choose a group ID or key in this workflow; omit for root.', observed: scopeId })
          parameters = { ...page, source: (view === 'context' ? 'context-topology:' : 'topology:') + scope }
        }
        const page = pageSchema.parse(parameters), source = catalog.get(page.source)
        const kind = topology ? 'topology' : history ? 'history' : tool.function.name === BLOCKAGE_TOOLS.report ? 'report' : tool.function.name === BLOCKAGE_TOOLS.trace ? 'trace'
          : tool.function.name === BLOCKAGE_TOOLS.shared ? 'shared' : null
        if (!kind || source?.kind !== kind && !(kind === 'report' && source?.kind === 'workspace')) throw located('BLOCKAGE_SOURCE_SCOPE_MISMATCH', {
          path: '/source', reason: 'Use the corresponding source ID from this role source index; no file paths or cross-workflow IDs.', observed: page.source,
          allowedKinds: kind === 'report' ? ['report', 'workspace'] : kind ? [kind] : [], actualKind: source?.kind ?? 'not-in-scope',
        })
        const whole = sourceValue(catalog, page.source), field = lookupPointer(page.path && source.structuredText ? JSON.parse(whole.value) : whole.value, page.path)
        const text = typeof field === 'string' ? field : JSON.stringify(field)
        let end = Math.min(page.end ?? page.start + 16000, page.start + 16000, text.length)
        const split = n => n > 0 && n < text.length && /[\uD800-\uDBFF]/.test(text[n-1]) && /[\uDC00-\uDFFF]/.test(text[n])
        if (page.start > text.length || split(page.start) || page.end !== undefined && page.end <= page.start)
          throw located('BLOCKAGE_PAGE_RANGE_INVALID', { path: '/start', reason: 'Use offsets within the selected field with end greater than start.', characters: text.length })
        if (split(end)) end--
        if (end === page.start && end < text.length) throw located('BLOCKAGE_PAGE_RANGE_INVALID', { path: '/end', reason: 'Request a full Unicode character; the selected end splits a surrogate pair.' })
        value = { source: whole.source, sourceSha256: whole.sha256, hashFormat: whole.hashFormat,
          path: page.path, start: page.start, end, characters: text.length, next: end < text.length ? end : null, text: text.slice(page.start, end) }
      }
    } catch (error) { if (signal?.aborted) throw error; value = { error: error.code ?? error.name, diagnostic: diagnostic(error, { stage: 'blockage-read' }) } }
    saveBlockage(file, { identity, value }); return value
  } }
}
