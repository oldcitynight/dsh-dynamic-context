// SPDX-License-Identifier: GPL-3.0-only
export const PERFORMANCE_EVENT = 'plugin:dsh-dynamic-context/performance-v1'
export const PERFORMANCE_KEY = 'dynamicContextPerformance'
export const zeroUsage = () => ({ uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
export const zeroStats = () => ({ turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 })
const nonnegative = value => Number.isFinite(value) && value >= 0
export function normalizeUsage(value, native = false) {
  if (!value) return null
  const input = native ? value.inputTokens : value.prompt_tokens, output = native ? value.outputTokens : value.completion_tokens
  const read = native ? value.cacheReadTokens ?? 0 : value.prompt_cache_hit_tokens ?? value.prompt_tokens_details?.cached_tokens ?? 0
  const write = native ? value.cacheWriteTokens ?? 0 : value.prompt_tokens_details?.cache_write_tokens ?? 0
  const uncached = native ? input : input - read - write
  if (![uncached, output, read, write].every(nonnegative)) return null
  return { uncachedInputTokens: uncached, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: write }
}
export function performanceView(samples) {
  const usage = zeroUsage(), stats = zeroStats(), groups = new Set()
  let latest, missingUsage = 0, requests = 0, running = 0
  for (const sample of Object.values(samples)) {
    if (sample.kind === 'tool') { stats.toolMs += sample.toolMs ?? 0; continue }
    if (sample.kind === 'aggregate') {
      for (const key of Object.keys(usage)) usage[key] += sample.usage?.[key] ?? 0
      for (const key of Object.keys(stats)) stats[key] += sample.stats?.[key] ?? 0
      requests += sample.requests ?? 0; missingUsage += sample.missingUsage ?? 0
      continue
    }
    if (!latest || sample.startedAt > latest.startedAt || sample.startedAt === latest.startedAt && sample.order > latest.order) latest = sample
    if (sample.kind === 'native-anchor') continue
    requests++; if (sample.state === 'running') running++
    if (sample.usage) for (const key of Object.keys(usage)) usage[key] += sample.usage[key]
    else if (sample.state !== 'running') missingUsage++
    if (sample.state === 'running') continue
    stats.steps++; if (sample.countsTurn !== false) groups.add(sample.group)
    if (nonnegative(sample.endedAt) && nonnegative(sample.startedAt)) {
      stats.llmMs += Math.max(0, sample.endedAt - sample.startedAt)
      if (nonnegative(sample.firstTokenAt) && sample.firstTokenAt >= sample.startedAt) {
        stats.ttftMs += sample.firstTokenAt - sample.startedAt; stats.ttftSteps++
        if (sample.usage && sample.endedAt > sample.firstTokenAt) {
          stats.decodeMs += sample.endedAt - sample.firstTokenAt; stats.decodeTokens += sample.usage.outputTokens
        }
      }
    }
  }
  stats.turns += groups.size
  const input = latest?.usage ? latest.usage.uncachedInputTokens + latest.usage.cacheReadTokens + latest.usage.cacheWriteTokens : latest?.inputTokens
  return { usage, stats, requests, running, missingUsage, current: latest ? {
    native: latest.kind === 'native-anchor', source: latest.source, startedAt: latest.startedAt,
    pressure: { ...(nonnegative(input) ? { pressureTokens: input, projectedTokens: input } : {}),
      ...(latest.contextWindow > 0 ? { contextWindow: latest.contextWindow } : {}) },
    ...(latest.breakdown ? { breakdown: latest.breakdown } : {}),
  } : null }
}
export function performanceProjection(key, native, extra) {
  if (!extra) return native
  if (key === 'sessionStats' || key === 'tokenUsage') {
    const added = key === 'sessionStats' ? extra.stats : extra.usage
    return Object.fromEntries(Object.entries(added).map(([field, value]) => [field, (native?.[field] ?? 0) + value]))
  }
  if (extra.current && !extra.current.native) {
    if (key === 'contextPressure') return extra.current.pressure
    if (key === 'contextBreakdown') return extra.current.breakdown
  }
  return native
}
