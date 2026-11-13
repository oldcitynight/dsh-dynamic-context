// SPDX-License-Identifier: GPL-3.0-only
import { fail } from './core.mjs'

export const thinkingEnabled = direct => direct.api === 'deepseek' && direct.thinking?.type !== 'disabled'
export function apiParameters(direct) {
  return direct.api === 'deepseek' ? { thinking: direct.thinking ?? { type: 'enabled' },
    ...(direct.reasoningEffort ? { reasoning_effort: direct.reasoningEffort } : {}) } : {}
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
