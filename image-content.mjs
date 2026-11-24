// SPDX-License-Identifier: GPL-3.0-only
// History keeps durable native attachment references. Encoded image bytes are
// materialized only at the HTTP boundary, never flattened into JSON prose.
import { resolveRequestImageTarget, deepSeekImageTokens } from '@deepseek-ai/dsh-llm-deepseek'
import { fail } from './core.mjs'
import { setTimeout as delay } from 'node:timers/promises'
export const IMAGE_TOOL = 'read_image'
export const IMAGE_READ_INSTRUCTION = 'read_image is a read-only visual evidence tool. Use file_path inside the current workspace. An image attachment allows visual inspection; a filename, hash, OCR result or text-only placeholder does not. Report an explicit capability error as a limitation, never as successful visual inspection.'
export const IMAGE_BATCH_LIMIT = 5
export const IMAGE_WINDOW = 10
export const IMAGE_WINDOW_GUIDE = 'Choose images independently for the current task. Request at most 5 images in one model turn (one read_image call per file). The image window holds the 10 most recent image occurrences in this context. As new images enter a full window, the oldest leave it. Keep relevant observations in text. To inspect an older image again, call read_image again with its file_path.'
export const imageBatchNotice = { error: 'READ_IMAGE_BATCH_LIMIT', executed: false, diagnostic: { path: '/tool_calls', reason: 'NOT_EXECUTED: this turn already requested 5 images. In a later turn request still-needed files with fresh call IDs.' } }
export function excessImageCalls(calls) {
  return new Set(calls.filter(tool => tool.function.name === IMAGE_TOOL).slice(IMAGE_BATCH_LIMIT).map(tool => tool.id))
}
export function describeImageTool(tool) {
  if (tool.name !== IMAGE_TOOL || tool.description?.includes(IMAGE_WINDOW_GUIDE)) return tool
  return { ...tool, description: [tool.description, IMAGE_WINDOW_GUIDE].filter(Boolean).join('\n') }
}

/** Project only the outbound request. Keep the complete ordered references and tool receipts in history. */
export function imageWindowPayload(payload) {
  let excess = payload.messages.reduce((sum, message) => sum + (message.images?.length ?? 0), -IMAGE_WINDOW)
  const messages = excess <= 0 ? payload.messages : payload.messages.map(message => {
    if (excess <= 0 || !message.images?.length) return message
    const removed = Math.min(excess, message.images.length)
    excess -= removed
    const { images, ...rest } = message
    const remaining = images.slice(removed)
    const marker = '[Image window: ' + images.slice(0, removed).map(ref => ref.attachmentId).join(', ') + ' left the 10-image window. Re-read the original file_path to inspect it again.]'
    return { ...rest, content: [message.content, marker].filter(Boolean).join('\n'), ...(remaining.length ? { images: remaining } : {}) }
  })
  const tools = payload.tools?.some(entry => entry.function?.name === IMAGE_TOOL && !entry.function.description?.includes(IMAGE_WINDOW_GUIDE))
    ? payload.tools.map(entry => entry.function?.name === IMAGE_TOOL ? { ...entry, function: describeImageTool(entry.function) } : entry) : payload.tools
  return messages === payload.messages && tools === payload.tools ? payload : { ...payload, messages, ...(tools ? { tools } : {}) }
}

export function nativeLeafImageAvailable(ctx, config) {
  return config.transport === 'direct' && config.direct?.runtime?.modules.includes('filesystem') && Boolean(ctx.get('attachments'))
}
export function unitAllowedTools(ctx, config) {
  return nativeLeafImageAvailable(ctx, config) && !config.allowedTools.includes(IMAGE_TOOL)
    ? [...config.allowedTools, IMAGE_TOOL]
    : config.allowedTools
}
export function imageReference(ref) {
  if (!ref || !/^sha256:[a-f0-9]{64}$/.test(ref.attachmentId ?? '') || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(ref.mediaType)
      || !['bytes', 'width', 'height'].every(key => Number.isSafeInteger(ref[key]) && ref[key] > 0)) fail('DIRECT_IMAGE_REFERENCE_INVALID')
  return structuredClone(ref)
}
export function splitImageContent(blocks) {
  if (!Array.isArray(blocks) || blocks.some(b => !['text', 'image'].includes(b.type))) fail('REQUEST_NON_TEXT_CONTENT_UNSUPPORTED')
  return { content: blocks.filter(b => b.type === 'text').map(b => { if (typeof b.text !== 'string') fail('REQUEST_NON_TEXT_CONTENT_UNSUPPORTED'); return b.text }).join(''),
    images: blocks.filter(b => b.type === 'image').map(b => imageReference(b.attachment)) }
}
export async function imageRoute(ctx, config, signal) {
  signal?.throwIfAborted()
  const attachments = ctx?.get?.('attachments')
  if (!attachments) fail('IMAGE_ATTACHMENT_SERVICE_UNAVAILABLE', { path: '/file_path', reason: 'The host attachment service is not mounted. No image was inspected.' })
  const llm = ctx?.get?.('llm') ?? ctx?.llm
  if (!llm?.resolveModelInfo) fail('IMAGE_MODEL_CAPABILITY_UNAVAILABLE', { reason: 'The exact model route must declare image input.' })
  const info = await llm.resolveModelInfo(config.provider, config.model, signal)
  if (!info.inputModalities?.includes('image')) fail('IMAGE_MODEL_INPUT_UNSUPPORTED', { model: config.model, reason: 'This model route does not declare image input. No image was inspected.' })
  return { attachments, info }
}
async function requestImage(ref, route, signal, retries) {
  for (let retry = 0; ; retry++) {
    signal?.throwIfAborted()
    try {
      const { attachments, info } = await route()
      const version = await attachments.readImageRequest(ref, resolveRequestImageTarget(info, ref), signal)
      signal?.throwIfAborted()
      if (!version.data?.byteLength || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(version.mediaType)) fail('DIRECT_IMAGE_BYTES_INVALID')
      return { type: 'image', source: { type: 'base64', media_type: version.mediaType, data: Buffer.from(version.data).toString('base64') } }
    } catch (error) {
      signal?.throwIfAborted()
      if (retry === retries) throw error
      await delay(25 * (2 ** retry), undefined, { signal })
    }
  }
}

function wireImage(block) {
  if (block.type === 'image' && block.source?.type === 'base64' && block.source.data) return block
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(block.image_url?.url ?? '')
  return match ? { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } } : undefined
}

function replayImages(wire) {
  const results = new Map()
  const userImages = []
  for (const row of wire?.messages ?? []) {
    if (!Array.isArray(row.content)) continue
    if (row.role === 'tool') {
      results.set(row.tool_call_id, row.content.map(wireImage).filter(Boolean))
    } else if (row.role === 'user') {
      for (const block of row.content) {
        if (block.type === 'tool_result') results.set(block.tool_use_id, block.content.map(wireImage).filter(Boolean))
        else {
          const image = wireImage(block)
          if (image) userImages.push(image)
        }
      }
    }
  }
  return { results, userImages }
}

const failureKey = (message, ref) => JSON.stringify([message.tool_call_id, ref.attachmentId])
function withImageFailures(message, refs, rejected) {
  if (!rejected.length) return message
  const { images: _images, ...original } = message
  return { ...original, content: JSON.stringify(rejected.length === 1 ? rejected[0].value : { errors: rejected.map(row => row.value) }),
    isError: true, ...(refs.length ? { images: refs } : {}) }
}

/** Reconstruct already sealed wire images without opening live files or a provider route. */
export function replaySavedRequestImages(payload, wire, imageFailures) {
  const { results, userImages } = replayImages(wire)
  const images = new Map(), failures = new Map(imageFailures)
  let nextUserImage = 0
  const messages = payload.messages.map(message => {
    if (!message.images?.length) return message
    const toolResult = message.role === 'tool'
    const stored = toolResult ? results.get(message.tool_call_id) : userImages
    let index = toolResult ? 0 : nextUserImage
    const refs = [], rejected = []
    for (const ref of message.images.map(imageReference)) {
      const failure = toolResult && failures.get(failureKey(message, ref))
      if (failure) { rejected.push({ value: failure }); continue }
      const block = stored?.[index++]
      if (!block) fail('DIRECT_RECOVERY_HISTORY_DIVERGED', { reason: 'The saved request is missing a corresponding image block.' })
      images.set(ref.attachmentId, block)
      refs.push(ref)
    }
    if (!toolResult) nextUserImage = index
    return withImageFailures(message, refs, rejected)
  })
  return { payload: { ...payload, messages }, images }
}

export async function materializeImages(payload, ctx, config, signal, { failures = new Map(), onFailure, replay } = {}) {
  const images = new Map()
  if (!payload.messages.some(row => row.images?.length)) return { payload, images }
  const calls = new Map(payload.messages.flatMap(row => row.tool_calls ?? []).map(call => [call.id, call.function.name]))
  const recorded = replayImages(replay?.payload).results, replayFailures = new Map(replay?.imageFailures)
  let resolvedRoute
  const route = async () => resolvedRoute ??= await imageRoute(ctx, config, signal)
  const messages = []
  for (const message of payload.messages) {
    if (!message.images?.length) { messages.push(message); continue }
    const readImage = message.role === 'tool' && calls.get(message.tool_call_id) === IMAGE_TOOL
    const stored = readImage ? recorded.get(message.tool_call_id) : undefined
    const refs = [], rejected = []
    let storedIndex = 0
    for (const raw of message.images) {
      const ref = imageReference(raw)
      const key = failureKey(message, ref)
      const savedFailure = readImage && (replay ? replayFailures : failures).get(key)
      if (savedFailure) { rejected.push({ key, value: savedFailure }); continue }
      try {
        const savedImage = stored?.[storedIndex++]
        if (savedImage) images.set(ref.attachmentId, savedImage)
        if (!images.has(ref.attachmentId)) images.set(ref.attachmentId, await requestImage(ref, route, signal, readImage && !replay ? 3 : 0))
        refs.push(raw)
      } catch (error) {
        signal?.throwIfAborted()
        if (!readImage || replay) throw error
        const value = { error: typeof error?.code === 'string' ? error.code : 'READ_IMAGE_ATTACHMENT_UNAVAILABLE',
          diagnostic: { stage: 'image-request-preparation', path: '/file_path', reason: 'The stored image could not be prepared for the model after three retries. The image was not inspected. Read it again with a new tool call if visual evidence is still required.' },
          attachmentId: ref.attachmentId, attempts: 4, retries: 3 }
        failures.set(key, value)
        rejected.push({ key, value })
      }
    }
    if (!rejected.length) { messages.push(message); continue }
    for (const { key, value } of rejected) onFailure?.(message.tool_call_id, value, key)
    messages.push(withImageFailures(message, refs, rejected))
  }
  return { payload: { ...payload, messages }, images }
}
export function imageBlocks(message, images) {
  return (message.images ?? []).map(raw => {
    const ref = imageReference(raw), block = images?.get(ref.attachmentId)
    if (!block) fail('DIRECT_IMAGE_NOT_MATERIALIZED')
    return structuredClone(block)
  })
}
export function roleImageResult(name, value, structuredToolErrors = false) {
  const image = name === IMAGE_TOOL && !value.error && value.value?.image
  return { content: JSON.stringify(value), ...((name === IMAGE_TOOL || structuredToolErrors) && value.error ? { isError: true } : {}),
    ...(image ? { images: [imageReference(image)] } : {}) }
}
export const imageTokens = message => (message.images ?? []).reduce((sum, ref) => sum + deepSeekImageTokens(ref.width, ref.height), 0)
export function imageWireByteBound(payload) {
  // Image bytes are encoded media, not text tokens. Native pixel pricing is
  // included separately by rolePressureTokens/nativeMessageEstimate.
  return Buffer.byteLength(JSON.stringify(payload, function (key, value) {
    if (key === 'data' && this.type === 'base64' && this.media_type?.startsWith('image/')) return ''
    return key === 'url' && typeof value === 'string' && value.startsWith('data:image/') ? value.slice(0, value.indexOf(',') + 1) : value
  }))
}
export async function finishImageInspection(payload, first, call, execute, beforeTool, limitBatch = () => true) {
  let completed = first, current = payload
  while (completed.finish === 'tool_calls' && completed.message?.tool_calls?.length) {
    const results = []
    const excess = limitBatch() ? excessImageCalls(completed.message.tool_calls) : new Set()
    for (const tool of completed.message.tool_calls) {
      beforeTool?.()
      const result = excess.has(tool.id) ? { role: 'tool', tool_call_id: tool.id, isError: true, content: JSON.stringify(imageBatchNotice) }
        : tool.function.name === IMAGE_TOOL ? await execute(tool, completed)
        : { role: 'tool', tool_call_id: tool.id, isError: true, content: JSON.stringify({ error: 'COMPACTION_TOOL_FORBIDDEN',
          reason: 'Historical summarization may inspect image evidence only. Do not execute work or modify the task.', allowed: [IMAGE_TOOL] }) }
      results.push(result)
    }
    current = { ...current, messages: [...current.messages, completed.message, ...results] }
    completed = await call(current)
  }
  return completed
}
