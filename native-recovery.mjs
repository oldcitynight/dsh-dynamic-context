// SPDX-License-Identifier: GPL-3.0-only
import { createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, Session, KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { assertReleasedV4Relationships } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { digest } from 'dsh-better-task-grapth/core'

export const INTERRUPTION_NOTICE = '执行意外中断。以下是保存下来的工具记录；缺少最终回执的调用效果未知，未开始的调用没有执行。不要把中断视为成功，也不要直接重放已执行或效果未知的写操作；先检查当前成果，再决定下一步。'

// The first direct-runtime implementation wrote its system message just before
// step/start. Repair the inherited copy only; the original log remains evidence.
export function normalizeLegacyStepOrder(events) {
  const rows = structuredClone(events)
  let changed = false
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row.type !== 'system/message') continue
    const stepIndex = rows.findIndex(e => e.type === 'step/start' && e.data.turn === row.data.turn && e.data.step === row.data.step)
    if (stepIndex > i) { const [step] = rows.splice(stepIndex, 1); rows.splice(i, 0, step); changed = true; i++ }
  }
  if (!changed) return rows
  const seqs = new Map(rows.map((row, index) => [row.seq, index]))
  return rows.map((row, index) => ({ ...row, seq: index,
    ...(row.sourceEventSeqs ? { sourceEventSeqs: row.sourceEventSeqs.map(seq => seqs.get(seq)) } : {}) }))
}

/** Close only missing protocol pairs, without executing any tool or inventing success. */
export function recoverNativeToolPairs(session) {
  const events = session.snapshotEvents(), recovered = []
  const calls = new Map(events.filter(e => e.type === 'tool/call').map(e => [e.data.callId, e]))
  const results = new Set(events.filter(e => e.type === 'tool/result').map(e => e.data.message.source.callId))
  for (const event of events.filter(e => e.type === 'assistant/message')) {
    for (const call of event.data.message.content.filter(c => c.type === 'tool-call')) {
      if (results.has(call.id)) continue
      const prior = calls.get(call.id)
      const outcome = prior ? 'UNKNOWN' : 'NOT_EXECUTED'
      const logged = prior ?? session.append('tool/call', { turn: event.data.turn, step: event.data.step,
        callId: call.id, name: call.name, arguments: call.arguments })
      session.append('tool/result', { turn: event.data.turn, step: event.data.step,
        message: createToolResultMessage({ callId: call.id, isError: true,
          content: [{ type: 'text', text: `${INTERRUPTION_NOTICE}\ncallId=${call.id}; outcome=${outcome}; host recovery receipt, not a tool success.` }] }) },
        { surfaceOp: 'append', sourceEventSeqs: [logged.seq] })
      recovered.push({ callId: call.id, outcome }); results.add(call.id)
    }
  }
  if (recovered.length) appendPluginRecord(session, 'plugin:dynamic-context/interruption-v1', { recovered })
  return recovered
}

/** Repair only the known old final-abort ordering defect in an inherited copy.
 * The immutable original remains evidence. Unrelated corruption is not repaired.
 */
export function repairPrematureNativeClose(native) {
  let failure
  try { assertReleasedV4Relationships(native, KNOWN_SESSION_EVENT_TYPES) } catch (error) { failure = error }
  if (!failure || !/^step\/end leaves unresolved tool call /.test(failure.message)) throw Error('DIRECT_LEGACY_CLOSE_DEFECT_NOT_PROVEN')
  const { events, header, inheritedEventCount = 0 } = native, cut = events.length - 2
  const step = events[cut], turn = events[cut + 1]
  if (cut < inheritedEventCount || step?.type !== 'step/end' || turn?.type !== 'turn/end'
      || step.data.turn !== turn.data.turn || turn.data.reason?.kind !== 'aborted') throw Error('DIRECT_LEGACY_CLOSE_SHAPE_UNSUPPORTED')
  const originalChecksum = digest(events)
  const session = Session.create(header.id, events.slice(0, cut), header, inheritedEventCount)
  const recovered = recoverNativeToolPairs(session)
  if (!recovered.length) throw Error('DIRECT_LEGACY_CLOSE_RECEIPT_MISSING')
  session.append('step/end', step.data)
  session.append('turn/end', turn.data)
  appendPluginRecord(session, 'plugin:dynamic-context/legacy-close-repair-v1', {
    originalSessionId: header.id, originalChecksum, removedTailSeqs: [step.seq, turn.seq], recovered,
    originalModified: false, reason: 'Missing interruption receipts inserted before the inherited final abort.' })
  const repaired = { ...native, events: session.snapshotEvents(), inheritedEventCount }
  assertReleasedV4Relationships(repaired, KNOWN_SESSION_EVENT_TYPES)
  return { native: repaired, recovered, originalChecksum }
}
