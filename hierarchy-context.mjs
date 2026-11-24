import { currentPlanningRecord } from './acceptance-protocol.mjs'
import { suspensionSource } from './suspension.mjs'
import { acceptanceEnabled, acceptancePlan, scopedCurrentFacts } from './acceptance-protocol.mjs'
// SPDX-License-Identifier: GPL-3.0-only
import { canonical, copy, digest } from 'dsh-better-task-grapth/core'
import { childrenOf, descendantsOf, aliasScopes, scopeSignature, groupRouting, childUnitResult } from 'dsh-better-task-grapth/hierarchy'
import { located, validationBoundary } from 'dsh-better-task-grapth/validation'
import { z } from 'zod'
import { blockageCatalog, sourceValue } from './blockage-evidence.mjs'
import { currentSharedContexts, proposalSchema, unitNodeSchema } from './core.mjs'
import { planDefinition } from './revision.mjs'
import { contextDefinition } from './revision-runtime.mjs'
import { bindLayerRules } from './rule-editor.mjs'
import { scopeProposalSchema } from './hierarchy-protocol.mjs'
import { verifyReference } from './blockage-protocol.mjs'
import { unitBindingTools } from './role-policy.mjs'

export { auditReportInput } from './role-input-index.mjs'

export function terminalExecutionUnit(plan, scopeId) {
  let node = plan.nodes.find(node => node.id === scopeId)
  while (node?.kind === 'container') node = plan.nodes.find(child => child.id === node.terminal)
  return node
}
export function effectiveScope(state, scopeId) {
  return state.graph.state.hierarchy.groups[scopeId]?.aliasOf ?? scopeId
}
export function finalAuditMandate(state, scopeId) {
  const plan = state.graph.state.plan, root = plan.nodes.find(node => node.parent === null), scope = plan.nodes.find(node => node.id === scopeId)
  const isRoot = root.id === scopeId || effectiveScope(state, root.id) === scopeId || aliasScopes(plan, scopeId).some(node => node.id === root.id)
  return { level: isRoot ? 'graph' : 'group', groupGoal: { scopeId, label: scope.label, acceptance: scope.acceptance },
    ...(isRoot ? { plannedOverallGoal: { title: plan.title, acceptance: root.acceptance,
      planningUnderstanding: currentPlanningRecord(state)?.report.understanding ?? null },
    originalUserRequirements: 'contract.objective and contract.requirements; planning records never replace or narrow these',
    reusesSingleGroup: scopeId !== root.id } : {}) }
}
export function scopedBlueprint(state, scopeId) {
  const plan = state.graph.state.plan, definition = planDefinition(plan), contexts = contextDefinition(state)
  const scope = plan.nodes.find(node => node.id === scopeId), children = childrenOf(plan, scopeId)
  const tasks = new Set([...(plan.hierarchy.version === 2 ? [scope.key] : []), ...children.filter(node => plan.hierarchy.version === 2 || node.kind === 'leaf').map(node => node.key)])
  const bindings = contexts.bindings.filter(row => tasks.has(row.task)), selected = new Set()
  const visit = key => { if (selected.has(key)) return; selected.add(key); contexts.nodes.find(row => row.key === key)?.parents.forEach(visit) }
  bindings.flatMap(row => row.contexts).forEach(visit)
  return { scope: definition.nodes.find(node => node.key === scope.key), hierarchy: copy(plan.hierarchy), ...(plan.ruleVersion ? {ruleVersion:plan.ruleVersion} : {}),
    nodes: children.map(node => node.kind === 'leaf' ? definition.nodes.find(row => row.key === node.key)
      : { key: node.key, label: node.label, acceptance: node.acceptance, retainSubtree: true, ...(node.rules ? {rules:copy(node.rules)} : {}) }),
    edges: definition.edges.filter(edge => children.some(node => node.key === edge.from)),
    contextGraph: { nodes: contexts.nodes.filter(node => selected.has(node.key)), bindings },
    contextReuseIndex: contexts.nodes.filter(node => selected.has(node.key) || node.mutable).map(node => ({ key: node.key, sha256: digest(node), mutable: node.mutable === true })),
  }
}
export function hierarchyContext(runner, state, scopeId, { final = false, signal } = {}) {
  const plan = state.graph.state.plan, scope = plan.nodes.find(node => node.id === scopeId)
  const descendants = descendantsOf(plan, scopeId), allowed = new Set([scopeId, ...descendants.map(node => node.id)])
  const catalog = blockageCatalog(runner, state, signal)
  catalog.delete('blueprint')
  if (!final) for (const [key, value] of catalog) if (value.taskId && !allowed.has(value.taskId)) catalog.delete(key)
  const blueprint = scopedBlueprint(state, scopeId)
  const visibleUnits = [scopeId, ...descendants.filter(node => plan.hierarchy.version === 2 || node.kind === 'leaf').map(node => node.id)]
  const scopedFacts = scopedCurrentFacts(state, visibleUnits)
  if (plan.hierarchy.version === 2 && !final) {
    const ids = new Set(scopedFacts.map(node => node.id))
    catalog.set('shared', { kind: 'shared', load: () => ({
      current: copy(scopedFacts), history: copy((state.sharedContextHistory ?? []).filter(row => ids.has(row.id))),
    }) })
  }
  const effectiveFacts = new Map(scopedFacts.filter(node => node.revision > 1).map(node => [node.key, node.content]))
  for (const node of blueprint.contextGraph.nodes) {
    if (effectiveFacts.has(node.key)) node.content = effectiveFacts.get(node.key)
  }
  const held = state.graph.state.suspended
  if (held) {
    if (allowed.has(held.active.nodeId)) catalog.set('interrupted-work', { kind: 'trace', taskId: held.active.nodeId, load: () => suspensionSource(runner, held, signal) })
    catalog.set('user-guidance', { kind: 'report', load: () => copy(held.metadata.userMessage) })
  }
  catalog.set('scope', { kind: 'blueprint', load: () => copy(blueprint) })
  for (const node of plan.nodes.filter(node => node.kind === 'container' && (final || allowed.has(node.id)))) {
    const report = state.graph.state.hierarchy.groups[node.id]
    if (report) catalog.set('group:' + node.id, { kind: 'report', taskId: node.id,
      load: () => copy({ taskId: node.id, result: report.aliasOf ? state.graph.state.hierarchy.groups[report.aliasOf] : report }) })
  }
  const routing = groupRouting(state.graph.state)
  const reports = (final && scope.kind === 'leaf' ? [scope] : childrenOf(plan, scopeId)).map(node => {
    if (routing?.branch(node.id) === 'NOT_SELECTED') {
      const source = 'route:' + node.id
      catalog.set(source, { kind: 'route', taskId: node.id, load: () => childUnitResult(state.graph.state, node, routing) })
      return sourceValue(catalog, source)
    }
    const leaf = state.graph.state.leaves[node.id], source = node.kind === 'container' ? 'group:' + node.id : 'report:' + leaf?.attemptId
    return catalog.has(source) ? sourceValue(catalog, source) : { taskId: node.id, key: node.key, status: leaf?.status ?? 'PENDING_GROUP', report: null }
  })
  const input = { protocol: state.graph.state.plan.hierarchy.version === 2 ? 'unit-terminal-v2' : 'hierarchical-terminal-v1', revision: state.revision, contextVersion: state.contexts.version,
    scopeId, inputHash: scopeSignature(state.graph.state, scopeId), ...(routing ? { groupRoutes: plan.edges.filter(edge => edge.kind === 'route' && (edge.from === scopeId || plan.nodes.find(node => node.id === edge.from)?.parent === scopeId)) } : {}), contract: runner.config.revision.policy,
    acceptance: scope.acceptance ?? state.contexts.bindings.find(row => row.taskId === scopeId)?.baseline?.acceptanceCriteria,
    ...(plan.hierarchy.version === 2 ? { unitBaseline: state.contexts.bindings.find(row => row.taskId === scopeId).baseline } : {}), aliasContracts: aliasScopes(plan, scopeId).map(node => ({ scopeId: node.id, acceptance: node.acceptance })),
    blueprint: sourceValue(catalog, 'scope'), reports,
    planningRecord: currentPlanningRecord(state)?.report ?? null,
    ...(acceptanceEnabled(state) ? { verificationPlan: acceptancePlan(state),
      currentSharedFacts: scopedCurrentFacts(state, visibleUnits).filter(node => node.mutable || node.revision > 1),
      blueprintQualification: 'The scoped blueprint presents effective shared facts. For edits, retain existing nodes using the supplied immutable contextReuseIndex hashes. Earlier versions and initial planning records remain historical evidence.',
      publicEvidence: reports.flatMap(row => { const result = row.value?.result; return result ? [{ source: row.source, taskId: row.value.taskId,
        verification: result.executionReport?.verification ?? result.verification ?? [],
        deliveries: result.executionReport?.delivery?.items ?? result.deliveries ?? [],
        limitations: result.executionReport?.limitations ?? result.audit?.limitations ?? [] }] : [] }),
    } : {}),
    updateHistory: state.graph.events.filter(event => event.type === 'REVISED' && event.data.review.scopeSignal?.scopeId === scopeId)
      .map(event => ({ revision: event.seq, modifications: event.data.review.proposal.modifications, reviewerRunId: event.data.review.reviewerRunId })),
    ...(held ? { unfinishedWork: { taskId: held.active.nodeId, attemptId: held.active.attemptId, evidence: held.evidence, source: 'interrupted-work', qualification: 'Suspended unfinished work, not a completion or accepted report. Preserve actual tool effects and inspect evidence before deciding reuse.' }, guidanceEvidence: sourceValue(catalog, 'user-guidance') } : {}),
    terminalExecutionUnit: terminalExecutionUnit(plan, scopeId),
    availableSources: [...catalog].filter(([, row]) => row.kind !== 'blueprint').map(([source, row]) => ({ source, kind: row.kind, taskId: row.taskId })),
    ...(final ? { ...(plan.hierarchy.version === 2 ? { rootOutcome: routing.outcome(scopeId) } : {}), sharedContexts: currentSharedContexts(state), acceptedRoot: copy(state.graph.state.hierarchy.groups[scopeId] ?? state.supervision.outcomes.findLast(row => row.taskId === scopeId) ?? null) } : {}),
  }
  return { input: JSON.parse(JSON.stringify(input)), catalog }
}
const same = (a, b) => canonical(a ?? null) === canonical(b ?? null)
const retainedGroup = z.object({ key: z.string(), retainSubtree: z.literal(true), rules:unitNodeSchema.shape.rules, label: z.string().min(1).optional(), acceptance: z.string().min(1).optional() }).strict()
const retainedContext = z.object({ key: z.string(), retain: z.literal(true), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
const keyedChanges = (before, after, key, prefix) => [...new Set([...before, ...after].map(key))].flatMap(id => {
  const prior = before.find(row => key(row) === id), next = after.find(row => key(row) === id)
  return same(prior, next) ? [] : [{ path: prefix + '/' + id, before: prior ?? null, after: next ?? null }]
})
export function prepareScopeProposal(runner, state, scopeId, value, catalog) {
  let proposal = scopeProposalSchema.parse(value)
  if (proposal.action !== 'REVISE') return { proposal }
  const parse = (schema, value, path) => validationBoundary({ stage: 'scoped-revision', path }, () => schema.parse(value))
  // Validate shape before traversing parent/binding arrays. Missing fields must
  // produce their precise JSON location, never an incidental TypeError.
  proposal = { ...proposal,
    nodes: proposal.nodes.map((node, i) => parse(node.retainSubtree ? retainedGroup : proposalSchema.shape.taskGraph.shape.nodes.element, node, `/nodes/${i}`)),
    edges: proposal.edges.map((edge, i) => parse(proposalSchema.shape.taskGraph.shape.edges.element, edge, `/edges/${i}`)),
    contextGraph: {
      nodes: proposal.contextGraph.nodes.map((node, i) => parse(node.retain ? retainedContext : proposalSchema.shape.contextGraph.shape.nodes.element, node, `/contextGraph/nodes/${i}`)),
      bindings: proposal.contextGraph.bindings.map((binding, i) => parse(proposalSchema.shape.contextGraph.shape.bindings.element, binding, `/contextGraph/bindings/${i}`)),
    },
  }
  const plan = state.graph.state.plan, scope = plan.nodes.find(node => node.id === scopeId)
  if (plan.hierarchy.version === 2) bindLayerRules(runner, state, scopeId, proposal)
  const before = planDefinition(plan), contexts = contextDefinition(state), children = childrenOf(plan, scopeId)
  const affected = new Set(descendantsOf(plan, scopeId).map(node => node.key))
  const original = new Map(before.nodes.map(node => [node.key, node]))
  const keep = new Set(), candidateNodes = [], candidateEdges = copy(proposal.edges), opaque = new Set()
  const reject = (path, reason) => { throw located('SCOPED_REVISION_BOUNDARY', { path, reason, scope: scope.key }) }
  for (const [index, node] of proposal.nodes.entries()) {
    const at = '/nodes/' + index
    if (keep.has(node.key)) reject(at + '/key', 'Each node key occurs once.')
    if (node.retainSubtree) {
      if (Object.keys(node).some(key => !['key', 'retainSubtree', 'label', 'acceptance', 'rules'].includes(key))) reject(at, 'A retained group exposes its label, acceptance and entry rules at this layer.')
      const child = children.find(child => child.key === node.key && child.kind === 'container')
      if (!child) reject(at + '/key', 'Only an existing direct child group can retain its subtree.')
      const subtree = [child, ...descendantsOf(plan, child.id)]
      const keys = new Set(subtree.map(row => row.key)); subtree.forEach(row => { keep.add(row.key); opaque.add(row.key) })
      candidateNodes.push(...subtree.map(row => ({ ...copy(original.get(row.key)), ...(row.id === child.id ? {
        ...(node.rules === undefined ? {} : {rules:copy(node.rules)}), ...(node.label === undefined ? {} : { label: node.label }), ...(node.acceptance === undefined ? {} : { acceptance: node.acceptance }),
      } : {}) })))
      candidateEdges.push(...before.edges.filter(edge => keys.has(edge.from) && keys.has(edge.to)))
    } else {
      const prior = plan.nodes.find(row => row.key === node.key)
      if (prior && (prior.parent !== scopeId || prior.kind === 'container')) reject(at, 'Existing groups are opaque retainSubtree references; only direct leaf tasks can be edited at this layer.')
      if (!prior && node.key === scope.key) reject(at + '/key', 'Do not include the scope itself in nodes.')
      keep.add(node.key); candidateNodes.push(copy(node))
    }
  }
  const candidateKeys = new Set(candidateNodes.map(node => node.key))
  for (const [index, node] of candidateNodes.entries()) if (node.parent !== scope.key && !candidateKeys.has(node.parent))
    reject('/nodes/' + index + '/parent', 'New subtrees must stay under this scope.')
  for (const [index, edge] of proposal.edges.entries()) {
    const from = candidateNodes.find(node => node.key === edge.from), to = candidateNodes.find(node => node.key === edge.to)
    if (!from || !to || from.parent !== to.parent || opaque.has(from.key) && from.parent !== scope.key)
      reject('/edges/' + index, 'Only current-layer edges or edges within entirely new subtrees may be submitted.')
  }
  const units = plan.hierarchy.version === 2
  if (units && candidateNodes.some(node => !opaque.has(node.key) && (node.parent !== scope.key || node.kind !== 'leaf')))
    reject('/nodes', 'Plan only direct unexpanded units. Each child decides whether to expand through its own router.')
  const replaceBindings = new Set([...affected].filter(key => !opaque.has(key)))
  for (const node of candidateNodes) if (node.kind === 'leaf' && !opaque.has(node.key)) replaceBindings.add(node.key)
  for (const [index, binding] of proposal.contextGraph.bindings.entries()) if (!replaceBindings.has(binding.task))
    reject('/contextGraph/bindings/' + index + '/task', 'Only direct leaf or new-subtree bindings belong to this edit.')
  const scopeBinding = contexts.bindings.find(row => row.task === scope.key)
  const futureContext = new Map(contexts.nodes.map(node => [node.key, copy(node)]))
  const protectedContexts = new Set()
  const visit = key => { if (protectedContexts.has(key)) return; protectedContexts.add(key); futureContext.get(key)?.parents.forEach(visit) }
  contexts.bindings.filter(binding => !replaceBindings.has(binding.task)).flatMap(row => row.contexts).forEach(visit)
  const contextKeys = new Set()
  for (const [index, node] of proposal.contextGraph.nodes.entries()) {
    if (contextKeys.has(node.key)) reject('/contextGraph/nodes/' + index + '/key', 'Context keys must be unique.')
    contextKeys.add(node.key)
    if (node.retain) {
      if (Object.keys(node).some(key => !['key', 'retain', 'sha256'].includes(key)) || digest(futureContext.get(node.key)) !== node.sha256)
        reject('/contextGraph/nodes/' + index, 'Retain references must use the current context hash.')
      continue
    }
    if (protectedContexts.has(node.key) && !same(node, futureContext.get(node.key)))
      reject('/contextGraph/nodes/' + index, 'This context is also bound outside the editing scope. Add a local node instead.')
    futureContext.set(node.key, copy(node))
  }
  const permitted = new Set(contexts.nodes.filter(node => node.mutable).map(node => node.key))
  const permit = key => { if (permitted.has(key)) return; permitted.add(key); contexts.nodes.find(row => row.key === key)?.parents.forEach(permit) }
  contexts.bindings.filter(binding => replaceBindings.has(binding.task)).flatMap(binding => binding.contexts).forEach(permit)
  if (units) scopeBinding.contexts.forEach(permit)
  for (const [index, binding] of proposal.contextGraph.bindings.entries()) {
    const seen = new Set(), inspect = key => {
      if (seen.has(key)) return
      seen.add(key)
      if (contexts.nodes.some(node => node.key === key) && !permitted.has(key)) reject(`/contextGraph/bindings/${index}/contexts`,
        'An existing private context from another scope cannot be imported into this binding, including through context parents. Use the public group report or shared facts.')
      futureContext.get(key)?.parents.forEach(inspect)
    }
    binding.contexts.forEach(inspect)
  }
  const full = { taskGraph: { ...before, nodes: [...before.nodes.filter(node => !affected.has(node.key)).map(node => node.key === scope.key ? { ...node, ...(units && scope.kind === 'leaf' ? { kind: 'container', acceptance: scopeBinding.baseline.objective } : {}), terminal: proposal.terminal } : node), ...candidateNodes],
    edges: [...before.edges.filter(edge => !affected.has(edge.from) && !affected.has(edge.to)), ...candidateEdges] },
    contextGraph: { nodes: [...futureContext.values()], bindings: [...contexts.bindings.filter(binding => !replaceBindings.has(binding.task)), ...proposal.contextGraph.bindings] }, invalidateReports: [] }
  if (proposal.baseline) {
    if (!units) reject('/baseline', 'A unit baseline requires workflow version 2.')
    full.contextGraph.bindings = full.contextGraph.bindings.map(row => row.task === scope.key ? { ...row, baseline: proposal.baseline } : row)
  }
  runner.graph.checkUnitLimit(full.taskGraph, state)
  // Node ordering is not a semantic modification and should not perturb IDs,
  // history checks or no-change detection.
  full.taskGraph.nodes.sort((a, b) => {
    const ai = before.nodes.findIndex(row => row.key === a.key), bi = before.nodes.findIndex(row => row.key === b.key)
    return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi) || a.key.localeCompare(b.key)
  })
  full.taskGraph.edges.sort((a, b) => {
    const ai = before.edges.findIndex(row => same(row, a)), bi = before.edges.findIndex(row => same(row, b))
    return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi) || canonical(a).localeCompare(canonical(b))
  })
  const changes = [
    ...keyedChanges(before.nodes.filter(node => node.key !== scope.key), full.taskGraph.nodes.filter(node => node.key !== scope.key), node => node.key, '/taskGraph/nodes'),
    ...(original.get(scope.key).terminal !== proposal.terminal ? [{ path: '/taskGraph/terminal', before: original.get(scope.key).terminal ?? null, after: proposal.terminal }] : []),
    ...keyedChanges(before.edges, full.taskGraph.edges, edge => edge.from + '~' + edge.to + (edge.kind === 'route' ? '~' + edge.outcome : ''), '/taskGraph/edges'),
    ...keyedChanges(contexts.nodes, full.contextGraph.nodes, node => node.key, '/contextGraph/nodes'),
    ...keyedChanges(contexts.bindings, full.contextGraph.bindings, row => row.task, '/contextGraph/bindings'),
  ]
  const declared = proposal.modifications.map(row => row.path), paths = changes.map(row => row.path)
  if (!paths.length || new Set(declared).size !== declared.length || !same([...paths].sort(), [...declared].sort()))
    throw located('SCOPED_MODIFICATION_REPORT_INCOMPLETE', { path: '/modifications', reason: 'Explain exactly every semantic modification, with no unreported or nonexistent change.', requiredPaths: paths, declaredPaths: declared })
  proposal.modifications.forEach((row, i) => row.evidence.forEach((ref, j) => verifyReference(ref, catalog, `/modifications/${i}/evidence/${j}`)))
  const allowedTools = unitBindingTools(runner)
  for (const [index, row] of full.contextGraph.bindings.entries()) if (row.tools.some(name => !allowedTools.includes(name)
    || !runner.config.direct.runtime && !runner.config.direct.agentlessTools.includes(name)))
    reject('/contextGraph/bindings/' + index + '/tools', 'Context cannot grant host tool permissions.')
  let ordinal = 0
  const prepared = runner.graph.prepareRevision(full, { id: prefix => `${prefix}_${digest({ scopeId, revision: state.revision, proposal, prefix, ordinal: ++ordinal }).slice(0, 40)}` })
  const closure = (contextGraph, bindings) => {
    const keys = new Set(), visit = key => { if (keys.has(key)) return; keys.add(key); contextGraph.nodes.find(row => row.key === key)?.parents.forEach(visit) }
    bindings.flatMap(binding => binding.contexts).forEach(visit)
    return { bindings: copy(bindings), nodes: contextGraph.nodes.filter(node => keys.has(node.key)) }
  }
  return { proposal, full, prepared, changes, contextUse: {
    before: closure(contexts, contexts.bindings.filter(binding => replaceBindings.has(binding.task))),
    after: closure(full.contextGraph, full.contextGraph.bindings.filter(binding => replaceBindings.has(binding.task))),
  } }
}
