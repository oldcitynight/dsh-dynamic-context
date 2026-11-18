import { acceptanceEnabled } from './acceptance-protocol.mjs'
// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { digest } from 'dsh-better-task-grapth/core'
import { diagnostic, located, parseModelJSON } from 'dsh-better-task-grapth/validation'
import { artifactProof } from './artifacts.mjs'
import { currentSharedContexts, fail } from './core.mjs'
import { BLOCKAGE_TOOLS, lookupPointer } from './blockage-protocol.mjs'

export function saveBlockage(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  // Hash the representation actually written to JSON, including omission of
  // optional undefined fields, so a valid journal remains valid after reload.
  const stored = JSON.parse(JSON.stringify(value))
  const temporary = file + '.' + randomUUID() + '.tmp', body = { value: stored, checksum: digest(stored) }
  const fd = fs.openSync(temporary, 'wx', 0o600)
  try { fs.writeFileSync(fd, JSON.stringify(body)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  fs.renameSync(temporary, file)
  const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir) } finally { fs.closeSync(dir) }
}
export function readBlockage(file) {
  if (!fs.existsSync(file)) return null
  const { value, checksum } = JSON.parse(fs.readFileSync(file, 'utf8'))
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
export function blockageCatalog(runner, state, signal) {
  const catalog = new Map()
  const add = (id, kind, value, taskId) => catalog.set(id, { kind, taskId, load: () => structuredClone(value) })
  add('blueprint', 'blueprint', { graph: state.graph, contexts: state.contexts })
  add('shared', 'shared', { current: currentSharedContexts(state), history: state.sharedContextHistory ?? [] })
  for (const row of state.supervision.outcomes) {
    const revoked = state.graph.events.filter(event => event.type === 'REOPENED'
      && event.data.attempts.some(a => a.nodeId === row.taskId && a.attemptId === row.attemptId))
      .map(event => ({ decisionId: event.data.decisionId, revision: event.seq }))
    add('report:' + row.attemptId, 'report', { taskId: row.taskId, attemptId: row.attemptId,
      result: row.result, revision: row.revision, contextVersion: row.contextVersion,
      qualification: 'Historical accepted disposition, not current goal acceptance.', revoked }, row.taskId)
    const references = [...row.evidence], visited = new Set()
    for (let index = 0; index < references.length; index++) {
      const ref = references[index]
      if (visited.has(ref.sha256)) fail('BLOCKAGE_TRACE_CHAIN_CYCLE')
      visited.add(ref.sha256)
      if (acceptanceEnabled(state)) {
        const proof = artifactProof(runner.graph.storageRoot, ref, signal, runner.graph.artifactOptions)
        const trace = JSON.parse(fs.readFileSync(proof.path, 'utf8'))
        artifactProof(runner.graph.storageRoot, ref, signal, runner.graph.artifactOptions)
        if (trace.previousReport) {
          if (trace.previousReport.taskId !== row.taskId || trace.previousReport.attemptId !== row.attemptId) fail('BLOCKAGE_TRACE_SCOPE_MISMATCH')
          references.push(...trace.previousReport.evidence)
        }
      }
      catalog.set(`trace:${row.attemptId}:${index}`, { kind: 'trace', taskId: row.taskId, load() {
        signal?.throwIfAborted()
        const proof = artifactProof(runner.graph.storageRoot, ref, signal, runner.graph.artifactOptions)
        const trace = JSON.parse(fs.readFileSync(proof.path, 'utf8'))
        artifactProof(runner.graph.storageRoot, ref, signal, runner.graph.artifactOptions)
        if (trace.assembly?.task.id !== row.taskId || trace.assembly?.task.attemptId !== row.attemptId)
          fail('BLOCKAGE_TRACE_SCOPE_MISMATCH')
        return trace
      } })
    }
  }
  registerGroupObservations(runner, state, catalog, signal)
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
  const tools = [wire(BLOCKAGE_TOOLS.list, 'List admitted report, archived workspace observation, private trace and shared-context source IDs. Example: {}.',
    { type: 'object', properties: {}, additionalProperties: false }),
  wire(BLOCKAGE_TOOLS.report, 'Read an admitted task report, including revoked attempts, or a frozen workspace observation from an accepted group audit. The latter reads the archived receipt, not the current file, and grants no filesystem capability.' + instructions
    + 'Leaf reports use /result/executionReport; group audit findings and limitations are under /result/audit. Examples: {"source":"report:attempt_example","path":"/result"}; {"source":"workspace:revision_group_audit_example:1","path":"/text"}. Use actual IDs from the source index.', pageParameters),
  wire(BLOCKAGE_TOOLS.trace, 'Read a registered private execution record; arbitrary paths and other workflows are unavailable.' + instructions + 'Example: {"source":"trace:attempt_example:0","path":"/events","start":0,"end":4000}.', pageParameters),
  wire(BLOCKAGE_TOOLS.shared, 'Read current shared facts or historical revisions.' + instructions + 'Example: {"source":"shared","path":"/current"}; history: {"source":"shared","path":"/history"}.', pageParameters)]
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
      if (tool.function.name === BLOCKAGE_TOOLS.list) {
        z.object({}).strict().parse(args)
        value = { sources: [...catalog].map(([source, row]) => ({ source, kind: row.kind, taskId: row.taskId })) }
      } else {
        const page = pageSchema.parse(args), source = catalog.get(page.source)
        const kind = tool.function.name === BLOCKAGE_TOOLS.report ? 'report' : tool.function.name === BLOCKAGE_TOOLS.trace ? 'trace'
          : tool.function.name === BLOCKAGE_TOOLS.shared ? 'shared' : null
        if (!kind || source?.kind !== kind && !(kind === 'report' && source?.kind === 'workspace')) throw located('BLOCKAGE_SOURCE_SCOPE_MISMATCH', {
          path: '/source', reason: 'Use the corresponding source ID from this role source index; no file paths or cross-workflow IDs.', observed: page.source,
          allowedKinds: kind === 'report' ? ['report', 'workspace'] : kind ? [kind] : [], actualKind: source?.kind ?? 'not-in-scope',
        })
        const whole = sourceValue(catalog, page.source), field = lookupPointer(whole.value, page.path)
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
