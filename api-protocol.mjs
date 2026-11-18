// SPDX-License-Identifier: GPL-3.0-only
import { fail } from './core.mjs'
import { digest } from 'dsh-better-task-grapth/core'

export const directProtocol = direct => direct.protocol && direct.protocol !== 'auto' ? direct.protocol
  : direct.api === 'deepseek' ? 'messages' : 'chat-completions'
export const thinkingEnabled = direct => direct.api === 'deepseek' && direct.thinking?.type !== 'disabled' && direct.reasoningEffort !== 'off'
export function apiParameters(direct) {
  return direct.api === 'deepseek' ? { thinking: { type: thinkingEnabled(direct) ? 'enabled' : 'disabled' },
    ...(thinkingEnabled(direct) && direct.reasoningEffort && direct.reasoningEffort !== 'auto' ? { reasoning_effort: direct.reasoningEffort } : {}) } : {}
}

/** Use the admitted conversation route, never an obsolete Agent creation option. */
export async function mainReasoningEffort(ctx, sourceAgent, signal, fallback, preparedConfig) {
  const header = preparedConfig ? { config: preparedConfig } : sourceAgent?.session.requestHeader?.()
  const route = header?.config ?? sourceAgent?.options ?? fallback
  let effort = route?.reasoningEffort
  if (effort === 'auto' || header?.adapterDefaults?.reasoningEffort) effort = undefined
  if (effort === undefined && route?.provider && route?.model && ctx?.llm?.resolveModelInfo) {
    try {
      const info = await ctx.llm.resolveModelInfo(route.provider, route.model, signal)
      effort = info.reasoning?.defaultEffort
    } catch (error) {
      signal?.throwIfAborted()
      // A standalone direct endpoint need not have a native adapter or catalog
      // entry. Its API defaults remain valid; a real conversation route must
      // still resolve successfully instead of silently losing its settings.
      if (sourceAgent || !['NO_ADAPTER', 'UNKNOWN_MODEL'].includes(error.code)) throw error
    }
  }
  return effort
}

export async function planningReasoningEffort(ctx, config, sourceAgent, signal, preparedConfig) {
  if (config.direct?.thinking?.type === 'disabled') return 'off'
  const policy = config.direct?.reasoningEffort ?? 'auto'
  return policy === 'auto' ? mainReasoningEffort(ctx, sourceAgent, signal, undefined, preparedConfig) : policy
}

/** Freeze one execution/role's effective setting, including its compactions.
 * A resumed operation reuses that receipt so already-recorded calls remain
 * byte-identical; a new operation reads the conversation's current setting.
 */
export async function resolveReasoningPolicy({ config, ctx, sourceAgent, signal, previous }) {
  if (config.direct?.api !== 'deepseek') return { config }
  const direct = config.direct, configured = direct.reasoningEffort ?? 'auto'
  const policyHash = digest({ configured, thinking: direct.thinking?.type ?? null, protocol: directProtocol(direct) })
  let receipt = previous
  if (receipt) {
    if (receipt.version !== 1 || receipt.policyHash !== policyHash
        || !['enabled', 'disabled'].includes(receipt.effective?.thinking?.type)
        || receipt.effective.reasoningEffort !== undefined && !['off', 'low', 'high', 'max'].includes(receipt.effective.reasoningEffort))
      fail('REASONING_POLICY_RECEIPT_CHANGED', { path: '/reasoningPolicy', reason: 'The resumed operation must retain its validated reasoning policy snapshot.' })
  } else {
    let effort = direct.thinking?.type === 'disabled' ? 'off' : configured === 'auto'
      ? await mainReasoningEffort(ctx, sourceAgent, signal, { provider: config.provider, model: config.model }) : configured
    // The native DeepSeek Messages adapter explicitly defaults to high.
    if (effort === undefined && directProtocol(direct) === 'messages') effort = 'high'
    if (effort !== undefined && !['off', 'low', 'high', 'max'].includes(effort)) fail('INHERITED_REASONING_EFFORT_UNSUPPORTED', {
      path: '/direct/reasoningEffort', observed: effort, allowed: ['off', 'low', 'high', 'max'],
      reason: 'The main conversation effort is not supported by the DeepSeek direct route; choose a supported value or an explicit override. No request was sent.' })
    receipt = { version: 1, policyHash, configured, source: direct.thinking?.type === 'disabled' || configured !== 'auto' ? 'plugin-override'
      : sourceAgent ? 'main-conversation' : 'provider-default', sourceSessionId: sourceAgent?.session.id ?? null,
      effective: { thinking: { type: effort === 'off' ? 'disabled' : 'enabled' }, ...(effort === undefined ? {} : { reasoningEffort: effort }) } }
  }
  const resolved = { ...direct, ...receipt.effective }
  if (receipt.effective.reasoningEffort === undefined) delete resolved.reasoningEffort
  return { config: { ...config, direct: resolved }, receipt: structuredClone(receipt) }
}
export function checkUsage(usage) {
  if (usage == null) return null
  if (typeof usage !== 'object' || Array.isArray(usage)) fail('DIRECT_INVALID_USAGE')
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens'])
    if (usage[key] !== undefined && (!Number.isSafeInteger(usage[key]) || usage[key] < 0)) fail('DIRECT_INVALID_USAGE')
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  if (reasoning !== undefined && (!Number.isSafeInteger(reasoning) || reasoning < 0)) fail('DIRECT_INVALID_USAGE')
  return structuredClone(usage)
}

export async function measureInput(meter, payload, signal, maximum) {
  if (!meter) { if (maximum !== undefined) fail('DIRECT_INPUT_METER_REQUIRED'); return null }
  let abort
  try {
    const cancelled = new Promise((_, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
    })
    const result = await Promise.race([meter.measure(payload, signal), cancelled])
    signal.throwIfAborted()
    if (!result || !Number.isSafeInteger(result.tokens) || result.tokens < 0 || !['exact', 'estimate'].includes(result.method)) fail('DIRECT_INPUT_MEASUREMENT_INVALID')
    if (maximum !== undefined && (result.method !== 'exact' || result.tokens > maximum)) fail(result.method === 'exact' ? 'DIRECT_INPUT_TOKEN_LIMIT' : 'DIRECT_EXACT_INPUT_MEASUREMENT_REQUIRED')
    return { tokens: result.tokens, method: result.method, meterVersion: meter.version }
  } finally { signal.removeEventListener('abort', abort) }
}
