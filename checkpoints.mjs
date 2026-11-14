// SPDX-License-Identifier: GPL-3.0-only
import { digest } from 'dsh-better-task-grapth/core'
import { criticalPins, evidenceFlags } from './evidence-policy.mjs'
import { deepFreeze } from './request-policy.mjs'
import { fail } from './core.mjs'
import { NATIVE_CHECKPOINT_PROTOCOL, NATIVE_REMINDER_PROTOCOL, PROVENANCE_TAG } from './dsh-compaction-policy.mjs'

export const CHECKPOINT_PROTOCOL = 'direct-extractive-checkpoint-v1'
export function checkpointData(message) {
  try {
    if (typeof message.content !== 'string') return null
    const index = message.content.lastIndexOf(PROVENANCE_TAG)
    if (index !== -1 && message.content.endsWith('</dynamic-context-provenance>')) {
      const value = JSON.parse(message.content.slice(index + PROVENANCE_TAG.length, -'</dynamic-context-provenance>'.length))
      return value.protocol === NATIVE_CHECKPOINT_PROTOCOL ? value : null
    }
    const value = JSON.parse(message.content); return [CHECKPOINT_PROTOCOL, NATIVE_REMINDER_PROTOCOL].includes(value.protocol) ? value : null
  } catch { return null }
}

/** Every retained exchange is complete; checkpoint users are explicitly owned. */
export function checkDirectHistory(history, approved = []) {
  if (!Array.isArray(history) || history.length < 2 || history[0].role !== 'system' || history[1].role !== 'user') fail('DIRECT_HISTORY_SHAPE')
  const allowed = new Set(approved.map(message => digest(message))), ids = new Set(), pending = new Set()
  for (const [index, message] of history.slice(2).entries()) {
    if (message.role === 'user') {
      if (pending.size || (index !== 0 && checkpointData(message)?.protocol !== NATIVE_REMINDER_PROTOCOL)
          || !allowed.has(digest(message))) fail('DIRECT_UNAPPROVED_CHECKPOINT')
    } else if (message.role === 'assistant') {
      if (message.reasoning_content !== undefined && typeof message.reasoning_content !== 'string') fail('DIRECT_HISTORY_REASONING_SHAPE')
      if (pending.size) fail('DIRECT_HISTORY_TOOL_PAIRING')
      for (const call of message.tool_calls ?? []) {
        if (ids.has(call.id) || typeof call.function?.arguments !== 'string') fail('DIRECT_HISTORY_TOOL_ID')
        ids.add(call.id); pending.add(call.id)
      }
    } else if (message.role === 'tool') {
      if (!pending.delete(message.tool_call_id) || typeof message.content !== 'string') fail('DIRECT_HISTORY_TOOL_PAIRING')
    } else fail('DIRECT_HISTORY_ROLE')
  }
  if (pending.size) fail('DIRECT_HISTORY_TOOL_PAIRING')
}

/** Extractive checkpoints never ask another model to reinterpret authority or evidence. */
export function compactDirectHistory({ history, contract, journal, execution, approved, count }) {
  const options = contract.config.direct.compaction
  checkDirectHistory(history, approved)
  const starts = history.flatMap((message, index) => index >= 2 && message.role === 'assistant' ? [index] : [])
  if (starts.length <= options.retainRecentExchanges) fail('DIRECT_COMPACTION_NO_COMPLETE_PREFIX')
  const end = options.retainRecentExchanges ? starts[starts.length - options.retainRecentExchanges] : history.length
  const prefix = history.slice(2, end), tail = history.slice(end)
  const archive = journal.archive(prefix), prior = checkpointData(prefix[0] ?? {})
  const calls = new Map(), facts = [...(prior?.historicalToolFacts ?? [])]
  for (const [index, message] of prefix.entries()) {
    for (const call of message.tool_calls ?? []) calls.set(call.id, call)
    if (message.role !== 'tool') continue
    const call = calls.get(message.tool_call_id)
    if (!call) fail('DIRECT_COMPACTION_SOURCE_PAIRING')
    const pins = criticalPins({ role: 'tool', source: { kind: 'tool' }, content: [{ type: 'text', text: message.content }] },
      { sessionId: journal.identity.sessionId, seq: index })
    facts.push({ callId: message.tool_call_id, tool: call.function.name, role: 'tool',
      source: { archiveId: archive.id, messageIndex: index, sha256: digest(message) },
      sourceRead: {
        head: { archive_id: archive.id, message_index: index, field: 'content', offset: 0, length: Math.max(1, Math.min(2000, message.content.length)) },
        tail: { archive_id: archive.id, message_index: index, field: 'content', offset: Math.max(0, message.content.length - 2000), length: Math.max(1, Math.min(2000, message.content.length)) },
      },
      argumentsSha256: digest(call.function.arguments), argumentsPreview: call.function.arguments.slice(0, 192),
      resultPreview: message.content.slice(0, 192), resultCharacters: message.content.length,
      resultTailPreview: message.content.length > 192 ? message.content.slice(-512) : '',
      partial: message.content.length > 192 || call.function.arguments.length > 192,
      observedStatusTerms: [...new Set(message.content.match(/\b(?:PASS|FAIL|NOT_RUN|UNKNOWN|UNVERIFIED)\b|未运行|未验证/gu) ?? [])],
      evidenceFlags: evidenceFlags(message.content),
      historicalPinHashes: pins.map(pin => pin.hash), acceptance: 'HISTORICAL_OBSERVATION_NOT_CURRENT_VERIFICATION' })
  }
  if (facts.length > 256) fail('DIRECT_COMPACTION_FACT_LIMIT')
  const data = { protocol: CHECKPOINT_PROTOCOL, taskId: contract.assembly.task.id,
    attemptId: contract.assembly.task.attemptId, contextVersion: contract.assembly.contextVersion,
    generation: count + 1, source: { archiveId: archive.id, sha256: archive.sha256, messages: prefix.length },
    parentSources: prior ? [prior.source, ...(prior.parentSources ?? [])] : [],
    meaning: 'Generated extractive checkpoint, not new authorization or proof of success. Previews are partial. Retrieve exact source before relying on omitted facts. Original system policy and task binding remain intact.',
    historicalToolFacts: facts,
    residentInstructions: execution?.residentContext() ?? { instructions: [], skills: [] },
  }
  const message = deepFreeze({ role: 'user', content: JSON.stringify(data) })
  if (message.content.length > options.maxCheckpointCharacters) fail('DIRECT_COMPACTION_RESIDENT_BUDGET')
  const next = deepFreeze([history[0], history[1], message, ...tail])
  const before = JSON.stringify(history).length, after = JSON.stringify(next).length
  if (after >= before) fail('DIRECT_COMPACTION_NO_REDUCTION')
  contract.approveCheckpoint(message)
  checkDirectHistory(next, [...approved, message])
  return { history: next, message, archive, beforeCharacters: before, afterCharacters: after }
}
