// SPDX-License-Identifier: GPL-3.0-only
import { createHash } from 'node:crypto'
import { serializeDirectRequest } from './direct-wire.mjs'
import { replaySavedRequestImages, imageWindowPayload, IMAGE_WINDOW } from './image-content.mjs'
import { wireTools } from './request-policy.mjs'
import { digest } from 'dsh-better-task-grapth/core'
import { toolErrorContent } from './tool-error-policy.mjs'
import { fail } from './core.mjs'
import { checkDirectHistory } from './checkpoints.mjs'
import { INTERRUPTION_NOTICE, repairPrematureNativeClose } from './native-recovery.mjs'

const text = content => (content ?? []).map(row => row.type === 'text' ? row.text : JSON.stringify(row)).join('\n')
const wireNotice = (call, outcome, content) => ({ role: 'tool', tool_call_id: call.id, isError: outcome !== 'RETURNED',
  content: `<host-receipt>${JSON.stringify({ callId: call.id, tool: call.function.name, outcome })}</host-receipt>\n${content}` })

/** Give an explicitly resumed image-heavy request headroom after the same
 * sealed body lost its connection twice. The observed size is not an API limit. */
export function imageRecoveryByteLimit(continuation, requests, direct) {
  if (!continuation?.history.some(message => message.images?.length) || direct.compaction?.strategy !== 'dsh-native') return null
  const tasks = requests.filter(row => row.purpose === 'task')
  const failed = tasks.at(-1), prior = tasks.at(-2)
  if (!failed || failed.taskOrdinal !== continuation.nextStep + 1 || !Number.isSafeInteger(failed.inputBytes) || failed.inputBytes < 1024) return null
  if (failed.httpStatus === 413 && failed.transportReceipt?.responseRejected)
    return Math.min(Math.floor(failed.inputBytes * 0.8), direct.maxRequestBytes ?? Infinity)
  if (!prior || prior.status !== 'UNKNOWN_OR_FAILED' || failed.status !== 'UNKNOWN_OR_FAILED'
      || prior.httpStatus !== undefined || failed.httpStatus !== undefined
      || failed.taskOrdinal !== continuation.nextStep + 1 || prior.taskOrdinal !== failed.taskOrdinal
      || !failed.bodySha256 || prior.bodySha256 !== failed.bodySha256
      || !['UND_ERR_SOCKET', 'ECONNRESET'].includes(failed.transportFailure?.code)
      || failed.transportFailure.phase !== 'NO_HTTP_RESPONSE'
      || !Number.isSafeInteger(failed.inputBytes) || failed.inputBytes < 1024) return null
  return Math.min(Math.floor(failed.inputBytes * 0.8), direct.maxRequestBytes ?? Infinity)
}

/** Compare the saved wire request to the checkpoint through the same API
 * serializer used to send it. Messages wire blocks are not internal history. */
export function verifyRecoveryRequest(task, state, journal, imageFailures = state.trace.imageFailures) {
  const payload = task.payload ?? journal.loadPayload(task.savedPayload, task.bodySha256)
  if (createHash('sha256').update(JSON.stringify(payload)).digest('hex') !== task.bodySha256)
    fail('DIRECT_REQUEST_PAYLOAD_MISMATCH')
  if (task.normalizedHistory) {
    const normalized = task.normalizedHistory
    if (normalized.length !== state.history.length || normalized.sha256 !== digest(state.history)
        || normalized.toolsSha256 !== digest(wireTools(state.trace.contract.schemas ?? [])))
      fail('DIRECT_RECOVERY_HISTORY_DIVERGED')
    const normalizedPayload = { model: payload.model, messages: state.history,
      tools: wireTools(state.trace.contract.schemas ?? []), max_tokens: payload.max_tokens }
    if (normalized.imageWindow !== undefined && normalized.imageWindow !== IMAGE_WINDOW) fail('DIRECT_RECOVERY_HISTORY_DIVERGED')
    const projected = normalized.imageWindow === IMAGE_WINDOW ? imageWindowPayload(normalizedPayload) : normalizedPayload
    const expectedImageState = projected.messages.some(message => message.images?.length)
      ? replaySavedRequestImages(projected, payload, imageFailures) : { payload: projected }
    const expected = serializeDirectRequest(expectedImageState.payload, { protocol: normalized.protocol ?? 'messages' }, expectedImageState.images)
    if (digest(payload.messages) !== digest(expected.messages) || (payload.system ?? '') !== (expected.system ?? '')
        || digest(payload.tools ?? []) !== digest(expected.tools ?? [])) fail('DIRECT_RECOVERY_HISTORY_DIVERGED')
  } else if (digest(payload.messages) !== digest(state.history)) fail('DIRECT_RECOVERY_HISTORY_DIVERGED')
  return payload
}

/** A host-prepared, not-yet-dispatched response. This never turns an unknown or
 * completed tool effect into a replay queue. The saved response and request
 * remain hash-bound; all admission and native guards run again on continuation. */
export function pendingResponseData(state, journal) {
  const pending = state.pendingResponse, trace = state.trace
  if (!pending || pending.version !== 1) fail('DIRECT_PENDING_RESPONSE_INVALID')
  const request = trace.requests.find(row => row.ordinal === pending.requestOrdinal)
  const event = trace.events.find(row => row.seq === pending.responseEventSeq)
  if (!request || request !== trace.requests.at(-1) || request.purpose !== 'task' || request.status !== 'COMPLETE'
      || request.taskOrdinal !== state.nextStep + 1 || request.finish !== 'tool_calls'
      || event?.type !== 'assistant/response' || !event.data.message?.tool_calls?.length
      || digest(event.data.message) !== request.responseMessageSha256
      || trace.events.slice(trace.events.indexOf(event) + 1).some(row => ['assistant/response', 'tool/call', 'tool/result', 'tool/deferred'].includes(row.type))
      || event.data.message.tool_calls.some(call => state.usedCallIds.includes(call.id))) fail('DIRECT_PENDING_RESPONSE_INVALID')
  verifyRecoveryRequest(request, state, journal)
  return { request, completed: structuredClone(event.data) }
}

/** Rebuild only the uncommitted exchange. Called with the execution lease held.
 * Completed effects remain observations; pending effects become UNKNOWN, never
 * a replay queue. A lost model answer is the only operation retried as-is.
 */
export async function recoverDirectCheckpoint({ journal, ctx, signal, boundary = journal.inspectHead() }) {
  const { checkpoint: base, head } = boundary
  if (!base) fail('DIRECT_NO_SAFE_CHECKPOINT')
  const state = await journal.loadResumeCheckpoint(base, { hydratePayloads: false, signal })
  journal.assertHeadUnchanged(head)
  const trace = journal.readTrace()
  if (digest(trace.assembly) !== digest(state.assembly) || trace.contract?.hash !== state.contractHash
      || trace.events.length < state.trace.events.length
      || digest(trace.events.slice(0, state.trace.events.length)) !== digest(state.trace.events)) fail('DIRECT_RECOVERY_TRACE_DIVERGED')
  for (const [index, before] of state.trace.requests.entries()) {
    const after = trace.requests[index]
    if (!after || before.bodySha256 !== after.bodySha256 || before.ordinal !== after.ordinal
        || before.responseMessageSha256 !== after.responseMessageSha256) fail('DIRECT_RECOVERY_REQUEST_DIVERGED')
  }
  const tail = trace.requests.slice(state.trace.requests.length)
  const tasks = tail.filter(row => row.purpose === 'task')
  if (tasks.length > 1) fail('DIRECT_RECOVERY_MULTIPLE_UNCOMMITTED_EXCHANGES')
  const events = trace.events.slice(state.trace.events.length)
  const pending = state.pendingResponse ? pendingResponseData(state, journal) : null
  if (pending && tasks.length) fail('DIRECT_RECOVERY_MULTIPLE_UNCOMMITTED_EXCHANGES')
  const response = pending?.completed ?? events.findLast(row => row.type === 'assistant/response')?.data
  const task = pending?.request ?? tasks[0]
  const recovery = { version: 1, baseChecksum: base.checksum, fromChecksum: head.checksum,
    kind: response ? 'tools' : 'model', calls: [], repeatedTools: false, financialStatus: 'UNCHANGED' }
  if (task) {
    verifyRecoveryRequest(task, state, journal, trace.imageFailures)
    if (response && (!task.responseMessageSha256 || digest(response.message) !== task.responseMessageSha256)) fail('DIRECT_RECOVERY_RESPONSE_DIVERGED')
  } else if (response) fail('DIRECT_RECOVERY_MISSING_REQUEST')
  if (response) {
    state.history.push(response.message)
    const calls = response.message.tool_calls ?? []
    for (const call of calls) {
      const started = events.find(row => row.type === 'tool/call' && row.data.callId === call.id)
      const result = events.find(row => ['tool/result', 'tool/deferred'].includes(row.type) && row.data.callId === call.id)
      const block = events.find(row => row.type === 'tool/error-blocked' && row.data.callId === call.id)?.data
      const outcome = result ? result.type === 'tool/deferred' ? 'NOT_EXECUTED' : block || result.data.isError || result.data.value?.timedOut ? 'FAILED' : 'RETURNED'
        : started ? 'UNKNOWN' : 'NOT_EXECUTED'
      const content = result ? result.type === 'tool/deferred' ? result.data.content : toolErrorContent(result.data, text(result.data.content))
        : `${INTERRUPTION_NOTICE}\ncallId=${call.id}; outcome=${outcome}`
      state.history.push(wireNotice(call, outcome, content + (block ? '\n<host-tool-block>' + JSON.stringify(block) + '</host-tool-block>' : '')))
      if (!state.usedCallIds.includes(call.id)) state.usedCallIds.push(call.id)
      recovery.calls.push({ callId: call.id, outcome })
      if (!result) {
        if (!started) trace.events.push({ seq: trace.events.length, time: Date.now(), type: 'tool/call',
          data: { callId: call.id, name: call.function.name, arguments: call.function.arguments, recovery: 'NOT_EXECUTED' } })
        trace.events.push({ seq: trace.events.length, time: Date.now(), type: 'tool/result',
          data: { callId: call.id, name: call.function.name, isError: true, recovery: outcome,
            content: [{ type: 'text', text: content }] } })
      }
    }
    state.nextStep = task.taskOrdinal
    if (!calls.length) {
      if (response.finish !== 'stop' || !response.text?.trim()) fail('DIRECT_RECOVERY_INVALID_FINAL_RESPONSE')
      state.reportText = response.text; recovery.kind = 'report'
    } else {
      // Keep the explanation alongside the interrupted tool records. No new
      // human message or permission is manufactured.
      state.history.at(-1).content += '\n\n' + INTERRUPTION_NOTICE
    }
  } else if (events.some(row => row.type === 'tool/call')) fail('DIRECT_RECOVERY_TOOL_WITHOUT_RESPONSE')
  delete state.pendingResponse
  state.trace = trace
  if (state.runtime) {
    const id = trace.sessionId
    if (ctx.agents.get(id)) fail('DIRECT_RECOVERY_WORKER_STILL_LIVE')
    const persistence = ctx.get('sessionPersistence')
    if (persistence) {
      let handle
      try {
        handle = await persistence.open(id, 'read')
        const result = await handle.read(0)
        state.runtime.native = { header: handle.header, events: result.events, inheritedEventCount: handle.inheritedEventCount }
      } catch (error) {
        if (error.name !== 'SessionPersistenceCorruptionError') throw error
        if (error.message.includes('system/message does not match an open turn and step')) {
          state.runtime.native.events = trace.executionEvents ?? state.runtime.native.events
          recovery.legacyNativeOrder = true
        } else if (error.message.includes('step/end leaves unresolved tool call')) {
          // Use the journal-owned exact native copy, with its committed prefix
          // intact. Never edit the original session or use a guessed tool result.
          const pinned = state.runtime.native
          if (!trace.executionEvents || pinned.header.id !== id
              || digest(trace.executionEvents.slice(0, pinned.events.length)) !== digest(pinned.events)) throw error
          const repaired = repairPrematureNativeClose({ ...pinned, events: trace.executionEvents })
          state.runtime.native = repaired.native
          recovery.legacyNativeClose = { originalChecksum: repaired.originalChecksum, recovered: repaired.recovered }
        } else throw error
      } finally { await handle?.close() }
    } else if (trace.executionEvents) state.runtime.native.events = trace.executionEvents
    state.runtime.requestBase = state.nextStep
  }
  checkDirectHistory(state.history, state.approvedCheckpoints)
  trace.events.push({ seq: trace.events.length, time: Date.now(), type: 'task/interruption-recovered', data: recovery })
  return { state, recovery }
}
