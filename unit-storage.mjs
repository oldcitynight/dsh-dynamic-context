// SPDX-License-Identifier: GPL-3.0-only
import { storedUnitPlan, replayUnitPlan } from 'dsh-better-task-grapth/core'

// The physical snapshot has one record per unit. Keep the original event
// payloads and digest domain for verifiable replay of previously issued receipts.
const format = 'units-v2'
const invalid = () => { throw new Error('INVALID_UNIT_STORAGE') }
function renameId(row, from, to) {
  if (!Object.hasOwn(row, from) || Object.hasOwn(row, to)) invalid()
  const { [from]: id, ...fields } = row
  return { ...fields, [to]: id }
}

function encodeGraph(graph) {
  const { leaves, hierarchy, plan, ...state } = graph.state
  const { groups, ...layer } = hierarchy
  const units = Object.fromEntries(plan.nodes.map(({ id }) => [id, {
    ...(Object.hasOwn(leaves, id) ? { execution: leaves[id] } : {}),
    ...(Object.hasOwn(groups, id) ? { audit: groups[id] } : {}),
  }]))
  return { ...graph, state: { ...state, plan: storedUnitPlan(plan), hierarchy: layer, units } }
}
function decodeGraph(graph) {
  const { units, hierarchy, plan, ...state } = graph.state
  if (!units || Object.hasOwn(state, 'leaves') || Object.hasOwn(hierarchy, 'groups') ||
      Object.keys(units).length !== plan.nodes.length) invalid()
  const leaves = {}, groups = {}
  if (!Object.hasOwn(plan.hierarchy, 'maxDepth')) invalid()
  const projectedPlan = replayUnitPlan(plan)
  for (const node of projectedPlan.nodes) {
    if (!Object.hasOwn(units, node.id)) invalid()
    const record = units[node.id]
    if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).some(key => !['audit', 'execution'].includes(key))) invalid()
    if (Object.hasOwn(record, 'execution')) leaves[node.id] = record.execution
    if (Object.hasOwn(record, 'audit')) groups[node.id] = record.audit
  }
  return { ...graph, state: { ...state, plan: projectedPlan, hierarchy: { ...hierarchy, groups }, leaves } }
}
function transform(snapshot, encode) {
  const graph = encode ? encodeGraph : decodeGraph
  const change = row => encode ? renameId(row, 'taskId', 'unitId') : renameId(row, 'unitId', 'taskId')
  const contexts = source => ({ ...source, bindings: source.bindings.map(change) })
  return { ...snapshot, graph: graph(snapshot.graph), contexts: contexts(snapshot.contexts),
    ...(snapshot.contextHistory ? { contextHistory: snapshot.contextHistory.map(row => ({
      ...row, graph: graph(row.graph), contexts: contexts(row.contexts),
    })) } : {}),
    ...(snapshot.supervision ? { supervision: { ...snapshot.supervision, outcomes: snapshot.supervision.outcomes.map(change) } } : {}),
    reports: snapshot.reports.map(change),
  }
}
export const unitSnapshotCodec = {
  encode(snapshot) {
    return snapshot?.graph?.state?.plan?.hierarchy?.version === 2 ? { ...transform(snapshot, true), storageFormat: format } : snapshot
  },
  decode(snapshot) {
    if (!snapshot || !Object.hasOwn(snapshot, 'storageFormat')) return snapshot
    const { storageFormat, ...value } = snapshot
    if (storageFormat !== format || value.graph?.state?.plan?.hierarchy?.version !== 2) invalid()
    return transform(value, false)
  },
}
export const unitWitnessCodec = {
  encode(value) { return value?.committed ? { ...value, committed: unitSnapshotCodec.encode(value.committed) } : value },
  decode(value) { return value?.committed ? { ...value, committed: unitSnapshotCodec.decode(value.committed) } : value },
}
