// SPDX-License-Identifier: GPL-3.0-only
// The direct executor retains its own assembly and exact input contract. Only
// this deterministic boundary translates that contract to the native API shape.
import { fail } from './core.mjs'
import { directProtocol } from './api-protocol.mjs'
import { imageBlocks, materializeImages, imageWindowPayload } from './image-content.mjs'

export function directEndpoint(direct) {
  if (directProtocol(direct) !== 'messages') return direct.endpoint
  const url = new URL(direct.endpoint)
  // Migrate the two documented official Chat endpoints without changing origin.
  if (url.origin === 'https://api.deepseek.com' && ['/chat/completions', '/v1/chat/completions'].includes(url.pathname))
    url.pathname = '/anthropic/v1/messages'
  if (!url.pathname.endsWith('/messages')) fail('DIRECT_MESSAGES_ENDPOINT_REQUIRED', {
    path: '/direct/endpoint', reason: 'Use a Messages endpoint ending in /messages, or select protocol: chat-completions for a legacy gateway.' })
  return url.toString()
}

export const directProtocolHeaders = (direct, purpose) => directProtocol(direct) === 'messages'
  ? { accept: 'text/event-stream', 'anthropic-version': '2023-06-01', ...(purpose === 'compaction' ? { 'x-deepseek-harness-compact': '1' } : {}) } : {}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' ? (value.length ? [{ type: 'text', text: value }] : [])
  : value == null ? [] : fail('DIRECT_MESSAGES_TEXT_REQUIRED')
function toolInput(raw) {
  // Native DSH preserves malformed historic tool calls using empty input. The
  // direct validator already rejects/repairs calls before executing any effect.
  try { const value = JSON.parse(raw); return object(value) ? value : {} } catch { return {} }
}

function assistantBlocks(message) {
  if (message.messagesReplay) {
    const replay = message.messagesReplay
    if (replay.version !== 1 || !Array.isArray(replay.blocks)) fail('DIRECT_MESSAGES_REPLAY_INVALID')
    const calls = new Map((message.tool_calls ?? []).map(call => [call.id, call]))
    const content = replay.blocks.map(block => {
      if (block.type === 'thinking' && typeof block.thinking === 'string'
          && (block.signature === undefined || typeof block.signature === 'string')) return structuredClone(block)
      if (block.type === 'text' && typeof block.text === 'string') return structuredClone(block)
      if (block.type === 'tool_use' && calls.has(block.id)) {
        const call = calls.get(block.id); calls.delete(block.id)
        if (block.name !== call.function.name) fail('DIRECT_MESSAGES_REPLAY_INVALID')
        // A host-approved syntax repair changes only the tool arguments; thinking
        // signatures and original block ordering remain provider-owned.
        return { type: 'tool_use', id: call.id, name: call.function.name, input: toolInput(call.function.arguments) }
      }
      fail('DIRECT_MESSAGES_REPLAY_INVALID')
    })
    if (calls.size || content.filter(b => b.type === 'text').map(b => b.text).join('') !== (message.content ?? '')
        || content.filter(b => b.type === 'thinking').map(b => b.thinking).join('') !== (message.reasoning_content ?? '')) fail('DIRECT_MESSAGES_REPLAY_INVALID')
    return content.filter(block => block.type !== 'text' || block.text.length)
  }
  return [...(message.reasoning_content !== undefined ? [{ type: 'thinking', thinking: message.reasoning_content }] : []),
    ...text(message.content), ...(message.tool_calls ?? []).map(call => ({ type: 'tool_use', id: call.id,
      name: call.function.name, input: toolInput(call.function.arguments) }))]
}

/** No strength-specific prose is inserted: the native adapter also adds none. */
export async function prepareDirectRequest(payload, config, ctx, signal, options) {
  const prepared = await materializeImages(options?.legacyImageHistory ? payload : imageWindowPayload(payload), ctx, config, signal, options)
  return serializeDirectRequest(prepared.payload, config.direct, prepared.images)
}
export function serializeDirectRequest(payload, direct, images) {
  if (directProtocol(direct) !== 'messages') {
    if (payload.messages.some(row => row.images?.length)) return { ...payload, messages: payload.messages.map(({ images: refs, isError, ...message }) => !refs?.length ? message : {
      ...message, content: [...text(message.content), ...imageBlocks({ images: refs }, images).map(b => ({ type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } }))] }) }
    if (!payload.messages.some(row => row.isError !== undefined)) return payload
    return { ...payload, messages: payload.messages.map(({ isError, ...message }) => message) }
  }
  const accepted = new Set(['model', 'messages', 'tools', 'max_tokens', 'stream', 'stream_options', 'thinking', 'reasoning_effort', 'temperature', 'response_format', 'tool_choice'])
  for (const key of Object.keys(payload)) if (!accepted.has(key)) fail('DIRECT_MESSAGES_FIELD_UNSUPPORTED', { path: '/' + key })
  if (payload.response_format && payload.response_format.type !== 'json_object') fail('DIRECT_MESSAGES_FORMAT_UNSUPPORTED')
  if (payload.tool_choice && payload.tool_choice !== 'none') fail('DIRECT_MESSAGES_TOOL_CHOICE_UNSUPPORTED')
  const messages = [], pending = new Set(), ids = new Set()
  let system = ''
  for (const message of payload.messages) {
    if (message.role === 'system') {
      if (messages.length || typeof message.content !== 'string') fail('DIRECT_MESSAGES_SYSTEM_POSITION_UNSUPPORTED')
      system = message.content; continue
    }
    let role, content
    if (message.role === 'assistant') {
      if (pending.size) fail('DIRECT_HISTORY_TOOL_PAIRING')
      role = 'assistant'; content = assistantBlocks(message)
      for (const call of content.filter(block => block.type === 'tool_use')) {
        if (ids.has(call.id)) fail('DIRECT_HISTORY_TOOL_ID')
        ids.add(call.id); pending.add(call.id)
      }
    } else if (message.role === 'tool') {
      if (!pending.delete(message.tool_call_id)) fail('DIRECT_HISTORY_TOOL_PAIRING')
      role = 'user'; content = [{ type: 'tool_result', tool_use_id: message.tool_call_id,
        content: [...text(message.content), ...imageBlocks(message, images)], ...(message.isError === undefined ? {} : { is_error: message.isError }) }]
    } else if (message.role === 'user') {
      if (pending.size) fail('DIRECT_HISTORY_TOOL_PAIRING')
      role = 'user'; content = [...text(message.content), ...imageBlocks(message, images)]
    } else fail('DIRECT_MESSAGES_ROLE_UNSUPPORTED')
    if (!content.length) continue
    if (messages.at(-1)?.role === role) messages.at(-1).content.push(...content)
    else messages.push({ role, content })
  }
  if (pending.size) fail('DIRECT_HISTORY_TOOL_PAIRING')
  const effort = payload.thinking?.type === 'disabled' ? 'off' : payload.reasoning_effort ?? 'high'
  if (!['off', 'low', 'high', 'max'].includes(effort)) fail('DIRECT_MESSAGES_EFFORT_UNSUPPORTED')
  return { model: payload.model, stream: true, messages, max_tokens: payload.max_tokens,
    thinking: { type: effort === 'off' ? 'disabled' : 'enabled' },
    ...(effort === 'off' ? {} : { output_config: { effort } }),
    ...(system ? { system } : {}), ...(payload.temperature === undefined ? {} : { temperature: payload.temperature }),
    ...(payload.tools === undefined ? {} : { tools: payload.tools.map(({ function: tool }) => ({
      name: tool.name, description: tool.description, input_schema: structuredClone(tool.parameters) })) }),
    ...(payload.tool_choice ? { tool_choice: { type: 'none' } } : {}) }
}
