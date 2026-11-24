// SPDX-License-Identifier: GPL-3.0-only
import { fail } from './core.mjs'
import { checkUsage, directProtocol } from './api-protocol.mjs'
import { readMessages } from './messages-stream.mjs'
import { isContextWindowExceededError, LlmError } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { fetch } from 'undici'

/** A rejection before fetch returns has no HTTP receipt. Keep its financial outcome unknown. */
export async function fetchDirectModel(request, options) {
  try {
    const response = await fetch(request.endpoint, options)
    request.httpStatus = response.status
    request.serverRequestId = response.headers.get('x-request-id')?.slice(0, 1024) ?? null
    return response
  } catch (error) {
    if (options.signal?.aborted || !(error instanceof TypeError) || error.message !== 'fetch failed') throw error
    const causes = [error.cause], seen = new Set(), codes = new Set()
    while (causes.length) {
      const cause = causes.pop()
      if (!cause || typeof cause !== 'object' || seen.has(cause)) continue
      seen.add(cause)
      if (typeof cause.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(cause.code)) codes.add(cause.code)
      if (cause.cause) causes.push(cause.cause)
      if (cause instanceof AggregateError) causes.push(...cause.errors)
    }
    const [code] = codes
    request.transportFailure = { phase: 'NO_HTTP_RESPONSE', ...(code && { code }), ...(codes.size > 1 && { codes: [...codes] }) }
    throw new LlmError(code ? 'fetch failed (' + [...codes].join(', ') + ')' : 'fetch failed', 'TRANSPORT', { cause: error })
  }
}

/** Drive DSH's retry plugin with a private event stream for this logical Direct request.
 * Parent and sibling steps have independent retry budgets. Persist the native schedule
 * before its wait and the start event before attempting another physical request. */
export function modelTransportRetry(ctx, provider, signal, persist) {
  let session
  return async (receipt, error) => {
    if (receipt.transportFailure?.phase !== 'NO_HTTP_RESPONSE' || error.code !== 'TRANSPORT' || signal.aborted) return false
    const llm = ctx.get?.('llm'), projections = ctx.get?.('sessionProjections')
    if (!projections || !llm?.listProviders?.().some(route => route.id === provider)) return false
    session ??= Session.create(randomUUID())
    if (projections.stateOf(session, 'llmRetry') === undefined) return false
    const policy = llm.providerRetryPolicy(provider)
    const { apply } = await import('@deepseek-ai/dsh-llm-retry')
    let recover, dispose
    // Use the installed scheduler, including its cancellable timer, jitter and own
    // projection. Only its two request-retry events are written to this receipt.
    apply({
      logger: ctx.logger,
      sessionProjections: { register() {}, stateOf: (_session, key) => projections.stateOf(session, key) },
      on: (_event, listener) => { recover = listener; return () => {} },
      effect: cleanup => { dispose = cleanup },
    })
    const agent = { session: { append(type, data) {
      const event = session.append(type, data)
      receipt.retryEvents ??= []
      receipt.retryEvents.push(event)
      persist()
      return event
    } } }
    try {
      const decision = await recover({ agent, turn: 1, step: receipt.logicalStep ?? receipt.taskOrdinal ?? receipt.beforeTaskOrdinal ?? 1,
        provider, failure: error.failure, retryPolicy: policy, signal }, async () => undefined)
      signal.throwIfAborted()
      return decision?.kind === 'retry'
    } finally { await dispose() }
  }
}

/** Parse bounded OpenAI/llama SSE. A partial stream is never a successful answer. */
export async function readCompletion(response, { signal, model, direct, maxResponseBytes, onProgress, onDelta }) {
  if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
    const chunks = [], reader = response.body?.getReader()
    let bytes = 0, timer, truncated = false
    try {
      while (reader) {
        signal.throwIfAborted()
        const pending = reader.read()
        const item = direct.streamIdleTimeoutMs === undefined ? await pending : await Promise.race([pending,
          new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(Error('DIRECT_STREAM_IDLE_TIMEOUT'), { code: 'DIRECT_STREAM_IDLE_TIMEOUT' })), direct.streamIdleTimeoutMs) })])
        clearTimeout(timer)
        if (item.done) break
        const remaining = 65536 - bytes
        chunks.push(Buffer.from(item.value).subarray(0, remaining)); bytes += Math.min(remaining, item.value.length)
        if (bytes >= 65536) { truncated = true; break }
      }
    } finally { clearTimeout(timer); await reader?.cancel().catch(() => {}); reader?.releaseLock() }
    const body = Buffer.concat(chunks).toString('utf8')
    let supplied
    try { supplied = JSON.parse(body).error } catch {}
    const providerError = { httpStatus: response.status, type: supplied?.type, code: supplied?.code,
      message: String(supplied?.message ?? body).slice(0, 4096), bodyTruncated: truncated || body.length > 4096 }
    const overflow = [400, 413].includes(response.status) && (supplied?.code === 'context_length_exceeded'
      || /maximum context length is \d+ tokens/i.test(providerError.message)
      || directProtocol(direct) === 'messages' && isContextWindowExceededError(`${supplied?.type ?? ''} ${supplied?.code ?? ''} ${providerError.message}`))
    const code = overflow ? 'DIRECT_CONTEXT_LENGTH_EXCEEDED' : response.ok ? 'DIRECT_EXPECTED_SSE' : `DIRECT_HTTP_STATUS_${response.status}`
    throw Object.assign(Error(code), { code, providerError,
      directReceipt: { httpStatus: response.status, responseRejected: !response.ok, terminated: false } })
  }
  if (directProtocol(direct) === 'messages') return readMessages(response, { signal, model, direct, maxResponseBytes, onProgress, onDelta })
  const decoder = new TextDecoder('utf-8', { fatal: true }), calls = new Map()
  let buffer = '', bytes = 0, done = false, finish = null, text = '', reasoning = '', usage = null, responseId = null
  try {
  const consume = frame => {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    if (!data) return
    if (done) fail('DIRECT_DATA_AFTER_DONE')
    if (data === '[DONE]') { if (finish === null) fail('DIRECT_DONE_WITHOUT_FINISH'); done = true; return }
    let event
    try { event = JSON.parse(data) } catch { fail('DIRECT_INVALID_SSE_JSON') }
    if (event.error) fail('DIRECT_BACKEND_ERROR')
    if (event.model !== undefined && event.model !== model && !direct.responseModelAliases.includes(event.model)) fail('DIRECT_RESPONSE_MODEL_MISMATCH')
    if (event.id !== undefined) {
      if (typeof event.id !== 'string' || !event.id.length || event.id.length > 1024 || responseId !== null && responseId !== event.id) fail('DIRECT_RESPONSE_ID_CHANGED')
      responseId = event.id
    }
    if (event.usage) usage = checkUsage(event.usage)
    if (!Array.isArray(event.choices)) fail('DIRECT_INVALID_CHOICES')
    if (event.choices.length > 1) fail('DIRECT_MULTIPLE_CHOICES_UNSUPPORTED')
    for (const choice of event.choices) {
      if (choice.index !== 0) fail('DIRECT_INVALID_CHOICE_INDEX')
      const delta = choice.delta ?? {}
      if (delta.role !== undefined && delta.role !== 'assistant') fail('DIRECT_INVALID_RESPONSE_ROLE')
      if (delta.function_call !== undefined) fail('DIRECT_LEGACY_FUNCTION_CALL_UNSUPPORTED')
      for (const field of ['content', 'reasoning_content', 'reasoning']) {
        if (delta[field] !== undefined && delta[field] !== null && typeof delta[field] !== 'string') fail('DIRECT_NON_TEXT_RESPONSE_UNSUPPORTED')
      }
      if (finish !== null && (delta.content || delta.reasoning_content || delta.reasoning || delta.tool_calls?.length)) fail('DIRECT_CONTENT_AFTER_FINISH')
      text += delta.content ?? ''; reasoning += delta.reasoning_content ?? delta.reasoning ?? ''
      for (const part of delta.tool_calls ?? []) {
        if (!Number.isSafeInteger(part.index) || part.index < 0 || maxResponseBytes !== null && part.index >= 16 || part.type !== undefined && part.type !== 'function') fail('DIRECT_INVALID_TOOL_FRAGMENT')
        const call = calls.get(part.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } }
        if (part.id !== undefined) {
          if (typeof part.id !== 'string' || call.id && call.id !== part.id) fail('DIRECT_TOOL_CALL_ID_CHANGED')
          call.id = part.id
        }
        if (part.function?.name !== undefined) {
          if (typeof part.function.name !== 'string') fail('DIRECT_INVALID_TOOL_NAME')
          call.function.name += part.function.name
        }
        if (part.function?.arguments !== undefined) {
          if (typeof part.function.arguments !== 'string') fail('DIRECT_INVALID_TOOL_ARGUMENTS')
          call.function.arguments += part.function.arguments
        }
        if (call.id.length > 128 || call.function.name.length > 128 || maxResponseBytes !== null && call.function.arguments.length > 32768) fail('DIRECT_TOOL_FRAGMENT_LIMIT')
        calls.set(part.index, call)
      }
      // Observation follows validation and cannot change request execution.
      try { onDelta?.({ text: delta.content ?? '', reasoning: delta.reasoning_content ?? delta.reasoning ?? '', tools: delta.tool_calls ?? [] }) } catch {}
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
        if (finish !== null) fail('DIRECT_DUPLICATE_FINISH')
        finish = choice.finish_reason
      }
    }
    onProgress?.({ responseId, usage, finish, outputBytes: Buffer.byteLength(text) + Buffer.byteLength(reasoning)
      + [...calls.values()].reduce((sum, call) => sum + Buffer.byteLength(call.function.name) + Buffer.byteLength(call.function.arguments) + 16, 0) })
  }
  const reader = response.body.getReader()
  let idleTimer
  const abortRead = () => { void reader.cancel(signal.reason).catch(() => {}) }
  signal.addEventListener('abort', abortRead, { once: true })
  try {
    for (;;) {
      signal.throwIfAborted()
      const pending = reader.read()
      const part = direct.streamIdleTimeoutMs === undefined ? await pending : await Promise.race([
        pending, new Promise((_, reject) => { idleTimer = setTimeout(() => reject(Object.assign(Error('DIRECT_STREAM_IDLE_TIMEOUT'), { code: 'DIRECT_STREAM_IDLE_TIMEOUT' })), direct.streamIdleTimeoutMs) }),
      ])
      clearTimeout(idleTimer)
      signal.throwIfAborted()
      if (part.done) break
      const chunk = part.value
      bytes += chunk.length
      if (maxResponseBytes !== null && bytes > maxResponseBytes) fail('DIRECT_RESPONSE_BYTE_LIMIT')
      buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n')
      let boundary
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        consume(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2)
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) consume(buffer)
  } finally {
    clearTimeout(idleTimer); signal.removeEventListener('abort', abortRead)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  if (!done || finish === null) fail('DIRECT_INCOMPLETE_SSE')
  if (!['stop', 'tool_calls'].includes(finish)) fail('DIRECT_REPORT_DID_NOT_STOP_NORMALLY')
  const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([index, call], i) => {
    if (index !== i || !/^[a-zA-Z0-9_-]{1,128}$/.test(call.function.name) || !call.id) fail('DIRECT_INVALID_TOOL_CALL')
    return call
  })
  if ((finish === 'tool_calls') !== (toolCalls.length > 0)) fail('DIRECT_TOOL_FINISH_MISMATCH')
  // Flash may choose an empty reasoning turn even with thinking enabled. Keep
  // an explicit empty string on replay; never invent or require nonempty text.
  return { message: { role: 'assistant', content: text || null, ...(direct.api === 'deepseek' || reasoning ? { reasoning_content: reasoning } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
    text, reasoning, usage, finish, responseId, responseBytes: bytes }
  } catch (error) {
    error.directReceipt = { responseId, usage, responseBytes: bytes, finish, terminated: done, reasoningCharacters: reasoning.length }
    throw error
  }
}
