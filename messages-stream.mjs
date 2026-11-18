// SPDX-License-Identifier: GPL-3.0-only
import { fail } from './core.mjs'
import { isContextWindowExceededError } from '@deepseek-ai/dsh-llm'

/** Strict Messages SSE decoding with the same terminal and replay semantics as
 * native DSH. The result stays in the executor's private history representation.
 */
export async function readMessages(response, { signal, model, direct, maxResponseBytes, onProgress, onDelta }) {
  const blocks = new Map(), counts = {}, decoder = new TextDecoder('utf-8', { fatal: true })
  let started = false, done = false, finish = null, responseId = null, bytes = 0, buffer = '', text = '', reasoning = '', usage = null
  const invalid = detail => fail('DIRECT_MESSAGES_INVALID_STREAM', { reason: detail })
  const string = value => typeof value === 'string' ? value : invalid('Expected a string')
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : invalid('Expected an object')
  const updateUsage = raw => {
    object(raw)
    for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
      if (raw[key] === undefined) continue
      if (!Number.isSafeInteger(raw[key]) || raw[key] < 0) invalid('Invalid usage field ' + key)
      counts[key] = raw[key]
    }
    const hit = counts.cache_read_input_tokens ?? 0, miss = (counts.input_tokens ?? 0) + (counts.cache_creation_input_tokens ?? 0)
    // Messages input_tokens excludes cache reads and writes; OpenAI-compatible
    // prompt_tokens includes both. Never bill a cached token twice.
    usage = { prompt_tokens: miss + hit, completion_tokens: counts.output_tokens ?? 0,
      total_tokens: miss + hit + (counts.output_tokens ?? 0), prompt_cache_hit_tokens: hit, prompt_cache_miss_tokens: miss }
  }
  const emit = delta => { try { onDelta?.(delta) } catch {} }
  const progress = () => onProgress?.({ responseId, usage, finish,
    outputBytes: Buffer.byteLength(text) + Buffer.byteLength(reasoning) + [...blocks.values()].reduce((n, b) =>
      n + (b.type === 'tool_use' ? Buffer.byteLength(b.name) + Buffer.byteLength(b.json || JSON.stringify(b.input)) + 16 : 0), 0) })
  const consume = frame => {
    const lines = frame.split('\n'), data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    if (!data) return
    if (done) fail('DIRECT_DATA_AFTER_DONE')
    let event
    try { event = JSON.parse(data) } catch { fail('DIRECT_INVALID_SSE_JSON') }
    object(event)
    const name = lines.find(line => line.startsWith('event:'))?.slice(6).trim()
    if (typeof event.type !== 'string' || name && name !== event.type) invalid('Event type mismatch')
    if (event.type === 'error') {
      const error = object(event.error), message = String(error.message ?? '').slice(0, 4096)
      const overflow = isContextWindowExceededError(`${error.type ?? ''} ${error.code ?? ''} ${message}`)
      const code = overflow ? 'DIRECT_CONTEXT_LENGTH_EXCEEDED' : 'DIRECT_BACKEND_ERROR'
      throw Object.assign(Error(code), { code, providerError: { type: error.type, code: error.code, message } })
    }
    if (event.type === 'ping') return
    if (event.type === 'message_start') {
      if (started) invalid('Duplicate message_start')
      const message = object(event.message)
      responseId = string(message.id)
      if (!responseId || responseId.length > 1024) invalid('Invalid response ID')
      if (message.role !== 'assistant') fail('DIRECT_INVALID_RESPONSE_ROLE')
      if (message.model !== model && !direct.responseModelAliases?.includes(message.model)) fail('DIRECT_RESPONSE_MODEL_MISMATCH')
      if (!Array.isArray(message.content) || message.content.length) invalid('Initial content must be empty')
      updateUsage(message.usage); started = true; progress(); return
    }
    if (!started) invalid('Event precedes message_start')
    if (event.type.startsWith('content_block_')) {
      if (!Number.isSafeInteger(event.index) || event.index < 0) invalid('Invalid block index')
      let block = blocks.get(event.index)
      if (event.type === 'content_block_start') {
        if (block || finish !== null) invalid('Repeated or late block')
        const value = object(event.content_block)
        if (!['text', 'thinking', 'tool_use'].includes(value.type)) invalid('Unsupported block type')
        block = { type: value.type, closed: false }
        if (value.type === 'text') { block.text = string(value.text); text += block.text; emit({ text: block.text, reasoning: '', tools: [] }) }
        if (value.type === 'thinking') {
          block.thinking = string(value.thinking); reasoning += block.thinking
          if (value.signature !== undefined) block.signature = string(value.signature)
          emit({ text: '', reasoning: block.thinking, tools: [] })
        }
        if (value.type === 'tool_use') {
          block.id = string(value.id); block.name = string(value.name); block.input = object(value.input); block.json = ''
          block.toolIndex = [...blocks.values()].filter(row => row.type === 'tool_use').length
          if (!block.id || block.id.length > 128 || !/^[a-zA-Z0-9_-]{1,128}$/.test(block.name)
              || [...blocks.values()].some(row => row.id === block.id)
              || maxResponseBytes !== null && block.toolIndex >= 16) fail('DIRECT_INVALID_TOOL_CALL')
          emit({ text: '', reasoning: '', tools: [{ index: block.toolIndex, id: block.id, type: 'function', function: { name: block.name, arguments: '' } }] })
        }
        blocks.set(event.index, block)
      } else {
        if (!block || block.closed || finish !== null) invalid('Delta or stop without an open block')
        if (event.type === 'content_block_stop') block.closed = true
        else if (event.type === 'content_block_delta') {
          const delta = object(event.delta)
          if (delta.type === 'text_delta' && block.type === 'text') {
            const part = string(delta.text); block.text += part; text += part; emit({ text: part, reasoning: '', tools: [] })
          } else if (delta.type === 'thinking_delta' && block.type === 'thinking') {
            const part = string(delta.thinking); block.thinking += part; reasoning += part; emit({ text: '', reasoning: part, tools: [] })
          } else if (delta.type === 'signature_delta' && block.type === 'thinking') block.signature = (block.signature ?? '') + string(delta.signature)
          else if (delta.type === 'input_json_delta' && block.type === 'tool_use') {
            const part = string(delta.partial_json); block.json += part
            if (maxResponseBytes !== null && block.json.length > 32768) fail('DIRECT_TOOL_FRAGMENT_LIMIT')
            emit({ text: '', reasoning: '', tools: [{ index: block.toolIndex, id: block.id, function: { arguments: part } }] })
          } else invalid('Delta does not match its block type')
        } else invalid('Unknown content event')
      }
    } else if (event.type === 'message_delta') {
      const delta = object(event.delta)
      if (delta.stop_reason != null) {
        if (finish !== null) fail('DIRECT_DUPLICATE_FINISH')
        if ([...blocks.values()].some(block => !block.closed)) invalid('Finish before block settlement')
        finish = { end_turn: 'stop', stop_sequence: 'stop', tool_use: 'tool_calls', max_tokens: 'length' }[delta.stop_reason]
        if (!finish) invalid('Unsupported stop reason')
      }
      if (event.usage) updateUsage(event.usage)
    } else if (event.type === 'message_stop') {
      if (finish === null || [...blocks.values()].some(block => !block.closed)) invalid('Unsettled message_stop')
      done = true
    } else invalid('Unsupported event type')
    progress()
  }
  const reader = response.body.getReader()
  let timer
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    for (;;) {
      signal.throwIfAborted()
      const pending = reader.read()
      const part = direct.streamIdleTimeoutMs === undefined ? await pending : await Promise.race([pending,
        new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(Error('DIRECT_STREAM_IDLE_TIMEOUT'), { code: 'DIRECT_STREAM_IDLE_TIMEOUT' })), direct.streamIdleTimeoutMs) })])
      clearTimeout(timer); signal.throwIfAborted()
      if (part.done) break
      bytes += part.value.length
      if (maxResponseBytes !== null && bytes > maxResponseBytes) fail('DIRECT_RESPONSE_BYTE_LIMIT')
      buffer += decoder.decode(part.value, { stream: true })
      // Normalize only complete CRLF pairs; an SSE chunk can split between them.
      buffer = buffer.replace(/\r\n/g, '\n')
      let boundary
      while ((boundary = buffer.indexOf('\n\n')) !== -1) { consume(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2) }
    }
    buffer += decoder.decode()
    if (buffer.trim()) consume(buffer)
    if (!done || finish === null) fail('DIRECT_INCOMPLETE_SSE')
    if (!['stop', 'tool_calls'].includes(finish)) fail('DIRECT_REPORT_DID_NOT_STOP_NORMALLY')
    if (!blocks.size) fail('DIRECT_MESSAGES_EMPTY_RESPONSE')
    const toolCalls = [...blocks.values()].filter(block => block.type === 'tool_use').map(block => ({ id: block.id, type: 'function',
      function: { name: block.name, arguments: block.json || JSON.stringify(block.input) } }))
    if ((finish === 'tool_calls') !== Boolean(toolCalls.length)) fail('DIRECT_TOOL_FINISH_MISMATCH')
    const replay = [...blocks.values()].map(({ closed, json, toolIndex, ...block }) => block)
    return { message: { role: 'assistant', content: text || null, reasoning_content: reasoning,
      messagesReplay: { version: 1, blocks: replay }, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      text, reasoning, usage, providerUsage: { protocol: 'messages', ...counts }, finish, responseId, responseBytes: bytes }
  } catch (error) {
    error.directReceipt = { responseId, usage, providerUsage: { protocol: 'messages', ...counts }, responseBytes: bytes, finish, terminated: done, reasoningCharacters: reasoning.length }
    throw error
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {}); reader.releaseLock()
  }
}
