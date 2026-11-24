// SPDX-License-Identifier: GPL-3.0-only
// Text-only adaptation of DSH's MIT compaction-basic and tool-result-pruner.
// Native prompt/policy attribution: DSH-COMPACTION-LICENSE.txt.
import { estimateMessage, estimateToolsTokens } from '@deepseek-ai/dsh-token-meter/estimate'
import { digest } from 'dsh-better-task-grapth/core'
import { deepFreeze, wireTools, activeTaskBinding } from './request-policy.mjs'
import { checkDirectHistory, checkpointData } from './checkpoints.mjs'
import { apiParameters } from './api-protocol.mjs'
import { fail } from './core.mjs'
import { imageTokens, imageWindowPayload, IMAGE_TOOL, IMAGE_WINDOW, IMAGE_READ_INSTRUCTION } from './image-content.mjs'
import { COMPACTION_INSTRUCTION, CHECKPOINT_PREAMBLE, SUMMARY_OPEN_TAG, SUMMARY_CLOSE_TAG,
  NATIVE_CHECKPOINT_PROTOCOL, NATIVE_REMINDER_PROTOCOL, PROVENANCE_TAG, nativeCompactSpec, SUMMARY_MAX_TOKENS } from './dsh-compaction-policy.mjs'

export function nativeMessageEstimate(message) {
  const content = []
  if (message.content) content.push({ type: 'text', text: message.content })
  if (message.reasoning_content) content.push({ type: 'reasoning', text: message.reasoning_content })
  for (const call of message.tool_calls ?? []) content.push({ type: 'tool-call', name: call.function.name, arguments: call.function.arguments })
  return estimateMessage({ role: message.role, content }) + imageTokens(message)
}

// Keep the billed prefix at its observed cost. Only the new suffix is still
// unpriced. Images entering the window can also add text markers inside the
// old prefix. Charge for those markers without subtracting displaced images.
function anchoredUpperTokens(history, visible, prefixLength, promptTokens) {
  if (prefixLength === history.length) return promptTokens
  const suffix = visible.slice(prefixLength)
  let extra = Buffer.byteLength(JSON.stringify(suffix)) + suffix.reduce((sum, row) => sum + imageTokens(row), 0)
  if (history.slice(prefixLength).some(row => row.images?.length) && visible !== history) {
    const previous = imageWindowPayload({ messages: history.slice(0, prefixLength) }).messages
    for (let i = 0; i < prefixLength; i++) {
      if (history[i].images?.length && previous[i].content !== visible[i].content)
        extra += Buffer.byteLength(JSON.stringify(visible[i].content.slice((history[i].content ?? '').length)))
    }
  }
  return promptTokens + extra
}

/** Reuse provider usage only while the whole priced prefix and tools are intact. */
export function nativePressure(history, schemas, requests = []) {
  const visible = imageWindowPayload({ messages: history }).messages
  const nodes = visible.map(nativeMessageEstimate)
  const heuristic = nodes.reduce((a, b) => a + b, 0) + estimateToolsTokens({ tools: schemas })
  const currentToolsHash = digest(wireTools(schemas))
  let checkedTaskReceipt = false
  for (const request of [...requests].reverse()) {
    if (request.purpose === 'compaction' || request.status !== 'COMPLETE' || !Number.isSafeInteger(request.usage?.prompt_tokens) || request.usage.prompt_tokens < 0) continue
    // The latest task may already be on disk after auxiliary summaries. Older
    // disk-only receipts need no prefix rehash on every step of a long task.
    if (checkedTaskReceipt && !request.payload) continue
    checkedTaskReceipt = true
    const normalized = request.normalizedHistory
    if (!request.payload && !(request.savedPayload && Number.isSafeInteger(normalized?.length)
        && typeof normalized.sha256 === 'string' && typeof normalized.toolsSha256 === 'string')) continue
    const prefixLength = normalized?.length ?? request.payload.messages.length
    const prefixHash = request.normalizedHistory?.sha256 ?? digest(request.payload.messages)
    const toolsHash = request.normalizedHistory?.toolsSha256 ?? digest(request.payload.tools ?? [])
    if (!Number.isSafeInteger(prefixLength) || prefixLength < 2 || prefixLength > history.length || toolsHash !== currentToolsHash) continue
    if (digest(history.slice(0, prefixLength)) !== prefixHash) continue
    const assistant = history[prefixLength]
    const hasAssistant = request.responseMessageSha256 && assistant?.role === 'assistant' && digest(assistant) === request.responseMessageSha256
    const end = prefixLength + (hasAssistant ? 1 : 0)
    const usageTokens = request.usage.prompt_tokens + (hasAssistant ? request.usage.completion_tokens ?? 0 : 0)
    const base = nodes.slice(0, end).reduce((a, b) => a + b, 0) + estimateToolsTokens({ tools: schemas })
    return { tokens: Math.max(heuristic, usageTokens + nodes.slice(end).reduce((a, b) => a + b, 0)),
      heuristicTokens: heuristic, nodes, method: 'dsh-heuristic-with-usage-anchor', anchorBodySha256: request.bodySha256,
      anchorApplied: usageTokens >= base,
      // The projection also changes the read_image tool description even
      // when the priced prefix itself contains no image.
      ...(normalized?.imageWindow === IMAGE_WINDOW || (!schemas.some(tool => tool.name === IMAGE_TOOL)
        && !history.slice(0, prefixLength).some(row => row.images?.length))
        ? { anchoredUpperTokens: anchoredUpperTokens(history, visible, prefixLength, request.usage.prompt_tokens) } : {}) }
  }
  return { tokens: heuristic, heuristicTokens: heuristic, nodes, method: 'dsh-heuristic', anchorApplied: false }
}

export const PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n'
const sharedTools = new Set(['dynamic_context_shared_read', 'dynamic_context_shared_update'])
function sharedHistory(history) {
  const retained = new Set(), calls = new Set()
  for (const message of history) {
    // Preserve an entire assistant/tool batch, including signed replay state.
    if (message.role === 'assistant' && message.tool_calls?.some(call => sharedTools.has(call.function.name))) {
      retained.add(message); message.tool_calls.forEach(call => calls.add(call.id))
    } else if (message.role === 'tool' && calls.has(message.tool_call_id)) retained.add(message)
  }
  return retained
}
export function pruneNativeTools(history) {
  let changed = 0
  const protectedShared = sharedHistory(history)
  const next = history.map(message => {
    if (message.role !== 'tool' || protectedShared.has(message) || [...message.content].length <= 8192) return message
    const points = [...message.content]; changed++
    return { ...message, content: points.slice(0, 4096).join('') + PRUNE_MARKER + points.slice(-1024).join('') }
  })
  return { history: deepFreeze(next), changed }
}

/** The host's immutable task message is additionally pinned in the direct route. */
export function nativePrefixEnd(history, nodes, retainTokens) {
  let sum = 0, end = history.length
  for (let i = history.length - 1; i >= 0; i--) { sum += nodes[i]; end = i; if (sum >= retainTokens) break }
  while (end > 2 && history[end]?.role === 'tool') end--
  return end > 2 ? end : null
}

// A checkpoint or reminder alone contains no new work to summarize. If the
// retention target leaves only these or protected shared exchanges, consume
// complete work exchanges while retaining the most recent one when possible.
function workPrefixEnd(history, preferred, previousEnd = 2) {
  const shared = sharedHistory(history)
  const starts = []
  for (let i = previousEnd; i < history.length; i++) {
    if (history[i].role === 'assistant' && !shared.has(history[i])) starts.push(i)
  }
  if (!starts.length) return null
  if (starts[0] < preferred) return preferred
  return starts.length > 1 ? starts.at(-1) : history.length
}

export function nativeSummaryPayload(config, schemas, prefix, instruction = COMPACTION_INSTRUCTION, imageTools = false, allowImageTools = true, imageInstruction = IMAGE_READ_INSTRUCTION) {
  const summarySchemas = imageTools ? schemas.filter(t => allowImageTools && t.name === 'read_image') : schemas
  return deepFreeze({ ...config.direct.generation, ...apiParameters(config.direct), model: config.model,
    messages: [...prefix, { role: 'user', content: instruction + (imageTools && summarySchemas.length ? '\n' + imageInstruction : '') }],
    ...(summarySchemas.length ? { tools: wireTools(summarySchemas) } : {}), max_tokens: SUMMARY_MAX_TOKENS,
    stream: true, stream_options: { include_usage: true } })
}

/** Repeat only the already-authorized task at the recent edge, never a new instruction from the model. */
export function reanchorNativeTask(history, contract, source, generation) {
  const data = { protocol: NATIVE_REMINDER_PROTOCOL, taskId: contract.assembly.task.id,
    attemptId: contract.assembly.task.attemptId, contextVersion: contract.assembly.contextVersion,
    source, generation, bindingSha256: digest(contract.assembly), taskContract: activeTaskBinding(contract.assembly),
    meaning: 'Resume the CURRENT active task stated here. Retained exchanges above are historical evidence; repeated tool-call patterns do not request more calls. Follow the original system policy and task permissions. Before acting or reporting, validate exact identifiers, required ordering and the requested output structure against the current task and available source evidence. Recompute required ordering instead of copying summary formatting. This reminder repeats the pinned task; it grants no new permission and proves no completion.' }
  const reminder = deepFreeze({ role: 'user', content: JSON.stringify(data) })
  contract.approveCheckpoint(reminder)
  const result = deepFreeze([...history.filter(m => checkpointData(m)?.protocol !== NATIVE_REMINDER_PROTOCOL), reminder])
  checkDirectHistory(result, contract.checkpoints)
  return result
}

/** A thinking-only stop has a billable response but no summary. Retry the identical
 * send once per source span, including a follow-up after a completed image read. */
export function summarySendWithRetry(send) {
  let retried = false
  return async payload => {
    let result = await send(payload)
    while (result.finish === 'stop' && !result.message?.tool_calls?.length && !result.text?.trim()
        && (result.reasoning ?? result.message?.reasoning_content)?.trim()) {
      if (retried) fail('COMPACTION_THINKING_ONLY_RETRY_EXHAUSTED', { path: '/response/content',
        reason: 'The compression returned thinking without summary text on both attempts. Both responses and their usage are preserved.' })
      retried = true
      result = await send(payload, { summaryRetry: { reason: 'THINKING_ONLY', previousResponseId: result.responseId ?? null } })
    }
    return result
  }
}

// A summary may quote the tokens that delimit earlier checkpoints. Keep the
// quotation as text while only the host can write checkpoint markup.
function escapeSummaryFraming(text) {
  const tags = [SUMMARY_OPEN_TAG, SUMMARY_CLOSE_TAG]
  for (const tag of tags) text = text.replaceAll(tag, tag.replace('<', '&lt;').replace('>', '&gt;'))
  return text
}

/** No tool execution occurs in this auxiliary path. Every call goes through the host ledger. */
export async function compactNativeHistory({ history, contract, journal, execution, count, requests = [], summarize, onEvent = () => {}, force = false, measureTokens, recoveryWire }) {
  if (!journal) fail('DIRECT_NATIVE_COMPACTION_REQUIRES_DURABILITY')
  checkDirectHistory(history, contract.checkpoints)
  // Direct requests always carry this explicit cap. Never allow a separate
  // reservation override to contradict the actual request envelope.
  const spec = nativeCompactSpec(contract.config.direct.compaction.contextWindow, contract.config.maxOutputTokens)
  const pressure = async value => {
    const result = nativePressure(value, contract.schemas, requests)
    if (measureTokens) {
      result.capacityEstimateTokens = await measureTokens({ messages: value, tools: wireTools(contract.schemas), model: contract.config.model }, result)
      result.tokens = Math.max(result.tokens, result.capacityEstimateTokens)
    }
    return result
  }
  let measurement = await pressure(history)
  const actions = [], beforeCharacters = JSON.stringify(history).length
  const wireBytes = recoveryWire ? await recoveryWire.measure({ messages: history, tools: wireTools(contract.schemas) }) : null
  const wirePressure = wireBytes !== null && wireBytes > recoveryWire.maxBytes
  force ||= wirePressure
  if (!force && measurement.tokens < spec.thresholdTokens) return { history, count, actions, measurement, spec }
  onEvent('compaction/pressure', { ...measurement, nodes: undefined, spec,
    ...(wirePressure ? { wire: { beforeBytes: wireBytes, maxBytes: recoveryWire.maxBytes, reason: recoveryWire.reason ?? 'REPEATED_SOCKET_INTERRUPTION' } } : {}) })
  const pruned = pruneNativeTools(history)
  if (pruned.changed) {
    const archive = journal.archive(history.slice(2))
    history = pruned.history
    checkDirectHistory(history, contract.checkpoints)
    actions.push({ kind: 'tool-result-prune', archive, changed: pruned.changed })
    onEvent('compaction/pruned', actions.at(-1))
    measurement = await pressure(history)
  }
  const attempts = force ? 1 : spec.attempts
  let previousEnd = 2
  let recompressedPrior = false
  for (let attempt = 0; (force || measurement.tokens >= spec.thresholdTokens) && attempt < attempts; attempt++) {
    if (history.length <= 2) fail('DIRECT_NATIVE_COMPACTION_NO_COMPLETE_PREFIX')
    const preferred = nativePrefixEnd(history, measurement.nodes, force ? 0 : spec.retainTokens) ?? history.length
    // A single checkpoint larger than the whole retention budget can itself
    // relieve genuine pressure, without paging or removing recent exchanges.
    const oversizedPrior = !recompressedPrior && previousEnd === 2 && preferred === 3
      && checkpointData(history[2])?.protocol === NATIVE_CHECKPOINT_PROTOCOL && measurement.nodes[2] >= spec.retainTokens
    const end = oversizedPrior ? preferred : workPrefixEnd(history, preferred, previousEnd)
    if (end === null) fail('DIRECT_NATIVE_COMPACTION_FIXED_INPUT_EXCEEDS_WINDOW', {
      reason: 'No fresh, unprotected work exchange is available to compress.', inputTokens: measurement.tokens, thresholdTokens: spec.thresholdTokens })
    if (oversizedPrior) recompressedPrior = true
    const prefix = history.slice(0, end), removed = history.slice(2, end)
    const protectedShared = [...sharedHistory(removed)]
    checkDirectHistory(prefix, contract.checkpoints)
    const archive = journal.archive(removed), prior = checkpointData(removed[0] ?? {})
    // Map large history into independently admitted, complete conversation
    // spans, then combine their checkpoints. The two fixed messages are never
    // shortened, and no summary request can itself overflow the native window.
    const pieces = [], spans = []
    const fits = async payload => (!measureTokens || await measureTokens(payload) + SUMMARY_MAX_TOKENS <= spec.contextWindow)
      && (!recoveryWire || await recoveryWire.measure(payload) <= recoveryWire.maxBytes)
    for (let start = 2; start < prefix.length;) {
      const ends = []
      for (let i = start + 1; i <= prefix.length; i++) if (prefix[i]?.role !== 'tool') ends.push(i)
      const make = end => nativeSummaryPayload(contract.config, contract.schemas, [prefix[0], prefix[1], ...prefix.slice(start, end)], contract.assembly.compactionPrompt?.content, contract.assembly.imageTools, contract.assembly.compactionImageTools, contract.assembly.compactionImagePrompt?.content)
      let end = prefix.length
      if ((measureTokens || recoveryWire) && !await fits(make(end))) {
        let low = 0, high = ends.length - 1, found = -1
        while (low <= high) {
          const middle = Math.floor((low + high) / 2)
          if (await fits(make(ends[middle]))) { found = middle; low = middle + 1 }
          else high = middle - 1
        }
        if (found < 0) {
          const bytes = recoveryWire && await recoveryWire.measure(make(ends[0]))
          if (recoveryWire && bytes > recoveryWire.maxBytes)
            fail('DIRECT_IMAGE_RECOVERY_BYTE_LIMIT', { purpose: 'compaction', bytes, maxBytes: recoveryWire.maxBytes,
              reason: 'Protected input and the smallest complete exchange exceed the recovery byte limit.' })
          fail('DIRECT_NATIVE_COMPACTION_FIXED_INPUT_EXCEEDS_WINDOW', {
            reason: 'The protected system/task/context messages plus one complete history span do not fit. They cannot be summarized or silently truncated.' })
        }
        end = ends[found]
      }
      const payload = make(end)
      contract.checkDirectCompaction(payload, payload.messages.slice(0, -1))
      const completed = await summarize(payload)
      if (completed.finish !== 'stop' || completed.message?.tool_calls?.length || !completed.text?.trim()) fail('DIRECT_NATIVE_SUMMARY_INVALID')
      if (completed.text.includes(PROVENANCE_TAG) || completed.text.includes('</dynamic-context-provenance>')) fail('DIRECT_NATIVE_SUMMARY_FRAME_COLLISION')
      const text = escapeSummaryFraming(completed.text)
      if (text !== completed.text) onEvent('compaction/summary-framing-escaped', {
        responseId: completed.responseId, originalSha256: digest(completed.text), summarySha256: digest(text),
      })
      pieces.push(text)
      spans.push({ start: start - 2, end: end - 2, responseId: completed.responseId, summarySha256: digest(text) })
      start = end
    }
    const completed = { text: pieces.join('\n\n'), responseId: spans.at(-1)?.responseId }
    const data = { protocol: NATIVE_CHECKPOINT_PROTOCOL, taskId: contract.assembly.task.id,
      attemptId: contract.assembly.task.attemptId, contextVersion: contract.assembly.contextVersion, generation: count + 1,
      source: { archiveId: archive.id, sha256: archive.sha256, messages: removed.length },
      parentSources: [...(prior ? [prior.source, ...(prior.parentSources ?? [])] : []),
        ...actions.filter(action => action.kind === 'tool-result-prune').map(action => ({ archiveId: action.archive.id, sha256: action.archive.sha256 }))],
      summarySha256: digest(completed.text), policy: 'DSH-0.2.1-rc.5-native-defaults',
      meaning: 'Model-generated historical context, not new authorization or evidence of success. Original system policy and task binding remain authoritative. Recheck source and current state before relying on a summarized claim.',
      residentInstructions: execution?.residentContext() ?? { instructions: [], skills: [] } }
    const message = deepFreeze({ role: 'user', content: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}${completed.text}${SUMMARY_CLOSE_TAG}\n\n${PROVENANCE_TAG}${JSON.stringify(data)}</dynamic-context-provenance>` })
    const next = deepFreeze([history[0], history[1], message, ...protectedShared, ...history.slice(end)])
    const nextMeasurement = nativePressure(next, contract.schemas)
    if (nextMeasurement.heuristicTokens >= measurement.heuristicTokens) {
      const detail = { sourceMessages: removed.length, beforeHeuristicTokens: measurement.heuristicTokens,
        afterHeuristicTokens: nextMeasurement.heuristicTokens, inputTokens: measurement.tokens, thresholdTokens: spec.thresholdTokens }
      onEvent('compaction/no-reduction', detail)
      if (attempt + 1 >= attempts || workPrefixEnd(history, preferred, end) === null) fail('DIRECT_NATIVE_COMPACTION_NO_REDUCTION', detail)
      previousEnd = end
      continue
    }
    previousEnd = 2
    contract.approveCheckpoint(message)
    checkDirectHistory(next, contract.checkpoints)
    const afterPressure = await pressure(next)
    actions.push({ kind: 'llm-summary', generation: ++count, archive, sourceMessages: removed.length,
      beforeTokens: measurement.tokens, afterTokens: afterPressure.tokens, beforeHeuristicTokens: measurement.heuristicTokens,
      afterHeuristicTokens: nextMeasurement.heuristicTokens, responseId: completed.responseId,
      summarySha256: data.summarySha256, spans })
    history = next; measurement = afterPressure
    onEvent('compaction/summarized', actions.at(-1))
  }
  if (actions.some(action => action.kind === 'llm-summary')) {
    const checkpoint = checkpointData(history[2])
    history = reanchorNativeTask(history, contract, checkpoint.source, count)
    measurement = await pressure(history)
    onEvent('compaction/task-reanchored', { generation: count, bindingSha256: digest(contract.assembly) })
  }
  if (!force && measurement.tokens >= spec.thresholdTokens) fail('DIRECT_NATIVE_COMPACTION_PRESSURE_UNRESOLVED')
  return { history, count, actions, measurement, spec, beforeCharacters, afterCharacters: JSON.stringify(history).length }
}
