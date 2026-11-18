// SPDX-License-Identifier: GPL-3.0-only
// Immutable, JSON-serializable projection indexes. Updating one observation
// copies a balanced search path, never the whole session's observation table.
import { z } from 'zod'
import { performanceView } from './performance-common.mjs'

export const performanceTreeSchema = z.lazy(() => z.object({
  key: z.string(), value: z.any(), left: performanceTreeSchema, right: performanceTreeSchema,
  height: z.number().int().positive(), latest: z.tuple([z.number(), z.number(), z.string()]).nullable(),
}).nullable())
const height = tree => tree?.height ?? 0
const newer = (a, b) => !a ? b : !b ? a : b[0] > a[0] || b[0] === a[0] && b[1] > a[1] ? b : a
function node(key, value, left = null, right = null) {
  const candidate = value && typeof value === 'object' && !['tool', 'aggregate'].includes(value.kind)
    && Number.isFinite(value.startedAt) ? [value.startedAt, value.order, key] : null
  return { key, value, left, right, height: Math.max(height(left), height(right)) + 1,
    latest: newer(newer(left?.latest, candidate), right?.latest) ?? null }
}
function rotateLeft(tree) {
  const right = tree.right
  return node(right.key, right.value, node(tree.key, tree.value, tree.left, right.left), right.right)
}
function rotateRight(tree) {
  const left = tree.left
  return node(left.key, left.value, left.left, node(tree.key, tree.value, left.right, tree.right))
}
function set(tree, key, value) {
  if (!tree) return node(key, value)
  let next = key === tree.key ? node(key, value, tree.left, tree.right)
    : key < tree.key ? node(tree.key, tree.value, set(tree.left, key, value), tree.right)
      : node(tree.key, tree.value, tree.left, set(tree.right, key, value))
  const balance = height(next.left) - height(next.right)
  if (balance > 1) {
    if (height(next.left.left) < height(next.left.right)) next = node(next.key, next.value, rotateLeft(next.left), next.right)
    return rotateRight(next)
  }
  if (balance < -1) {
    if (height(next.right.right) < height(next.right.left)) next = node(next.key, next.value, next.left, rotateRight(next.right))
    return rotateLeft(next)
  }
  return next
}
function get(tree, key) {
  while (tree) {
    if (key === tree.key) return tree.value
    tree = key < tree.key ? tree.left : tree.right
  }
}
function* values(tree) {
  if (!tree) return
  yield* values(tree.left); yield tree.value; yield* values(tree.right)
}
export const performanceSample = (state, id) => get(state?.samples, id)
export function performanceSamples(state) {
  // Recovery runs once, and retains the original observation insertion order.
  return [...values(state.samples)].sort((a, b) => a.firstOrder - b.firstOrder)
}
export const initialPerformanceState = () => ({ samples: null, groups: null, view: performanceView({}) })
const completedGroup = sample => sample && !['tool', 'aggregate', 'native-anchor'].includes(sample.kind)
  && sample.state !== 'running' && sample.countsTurn !== false
  ? JSON.stringify([typeof sample.group, sample.group]) : null

export function advancePerformanceState(state, sample, order) {
  const previous = performanceSample(state, sample.id)
  if (previous?.revision >= sample.revision) return state
  const next = { ...sample, order, firstOrder: previous?.firstOrder ?? order }
  const samples = set(state.samples, sample.id, next)
  // The reference fold is still used for individual contributions. This keeps
  // usage buckets, missing timings, interrupted calls and aggregates identical.
  const before = performanceView(previous ? { value: previous } : {})
  const after = performanceView({ value: next })
  const view = { ...state.view, usage: { ...state.view.usage }, stats: { ...state.view.stats } }
  for (const key of Object.keys(view.usage)) view.usage[key] += after.usage[key] - before.usage[key]
  for (const key of Object.keys(view.stats)) if (key !== 'turns') view.stats[key] += after.stats[key] - before.stats[key]
  for (const key of ['requests', 'running', 'missingUsage']) view[key] += after[key] - before[key]
  view.stats.turns += (next.kind === 'aggregate' ? after.stats.turns : 0)
    - (previous?.kind === 'aggregate' ? before.stats.turns : 0)
  let groups = state.groups
  const oldGroup = completedGroup(previous), newGroup = completedGroup(next)
  if (oldGroup !== newGroup) {
    if (oldGroup !== null) {
      const count = get(groups, oldGroup) - 1
      groups = set(groups, oldGroup, count)
      if (count === 0) view.stats.turns--
    }
    if (newGroup !== null) {
      const count = get(groups, newGroup) ?? 0
      groups = set(groups, newGroup, count + 1)
      if (count === 0) view.stats.turns++
    }
  }
  const latest = samples.latest ? get(samples, samples.latest[2]) : null
  view.current = latest ? performanceView({ value: latest }).current : null
  return { samples, groups, view }
}
