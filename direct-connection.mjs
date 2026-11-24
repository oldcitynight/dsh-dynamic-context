// SPDX-License-Identifier: GPL-3.0-only
import { z } from 'zod'
import { directEndpoint } from './direct-wire.mjs'
import { thinkingEnabled } from './api-protocol.mjs'

// A connection can select a model API, never runtime permissions, tools or storage.
export const directConnection = z.object({
  endpoint: z.string().refine(value => {
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash } catch { return false }
  }, 'Explicit HTTP endpoint without credentials, query or fragment required'),
  auth: z.enum(['api-key', 'deepseek-account']).default('api-key'),
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  api: z.enum(['openai-compatible', 'deepseek']).default('openai-compatible'),
  protocol: z.enum(['auto', 'messages', 'chat-completions']).default('auto'),
  thinking: z.object({ type: z.enum(['enabled', 'disabled']) }).strict().optional(),
  reasoningEffort: z.enum(['auto', 'off', 'low', 'high', 'max']).default('auto'),
  responseModelAliases: z.array(z.string().min(1).max(128)).max(8).default([]),
  generation: z.object({ temperature: z.number().min(0).max(2).optional(), top_p: z.number().min(0).max(1).optional(),
    top_k: z.number().int().min(0).optional(), min_p: z.number().min(0).max(1).optional(),
    repeat_penalty: z.number().positive().optional(), repeat_last_n: z.number().int().min(-1).optional(),
    presence_penalty: z.number().min(-2).max(2).optional(), frequency_penalty: z.number().min(-2).max(2).optional(),
    seed: z.number().int().optional(),
  }).strict().default({}),
}).strict()

export function validateConnection(direct, ctx) {
  if (direct.auth === 'deepseek-account') {
    let official = false
    try { official = new URL(direct.endpoint).origin === 'https://api.deepseek.com' } catch {}
    if (!official || direct.api !== 'deepseek' || direct.apiKeyEnv)
      ctx.addIssue({ code: 'custom', message: 'Account authentication requires the official HTTPS DeepSeek endpoint and cannot be combined with an API Key reference' })
  }
  if (direct.api !== 'deepseek' && (direct.thinking || direct.reasoningEffort && direct.reasoningEffort !== 'auto'))
    ctx.addIssue({ code: 'custom', message: 'Thinking controls require the explicit DeepSeek protocol' })
  if (direct.protocol === 'messages' && direct.api !== 'deepseek')
    ctx.addIssue({ code: 'custom', message: 'Messages protocol requires api: deepseek' })
  if (direct.api === 'deepseek' && direct.protocol !== 'chat-completions') {
    try { directEndpoint(direct) } catch (error) {
      ctx.addIssue({ code: 'custom', path: ['endpoint'], message: error.code === 'DIRECT_MESSAGES_ENDPOINT_REQUIRED'
        ? 'Use a Messages endpoint ending in /messages, or explicitly select protocol: chat-completions for a legacy gateway.' : error.message })
    }
  }
  if (direct.api === 'deepseek' && direct.protocol !== 'chat-completions'
      && Object.keys(direct.generation).some(key => key !== 'temperature'))
    ctx.addIssue({ code: 'custom', message: 'Native Messages generation supports only temperature; other sampling fields require explicit chat-completions compatibility mode' })
  if (direct.api === 'deepseek') {
    if (Object.keys(direct.generation).some(key => !['temperature', 'top_p', 'presence_penalty', 'frequency_penalty'].includes(key)))
      ctx.addIssue({ code: 'custom', message: 'Llama-specific generation fields cannot be sent to DeepSeek' })
    if (thinkingEnabled(direct) && ['temperature', 'presence_penalty', 'frequency_penalty'].some(key => direct.generation[key] !== undefined))
      ctx.addIssue({ code: 'custom', message: 'DeepSeek thinking ignores temperature and presence/frequency penalties; remove these settings' })
  }
}
