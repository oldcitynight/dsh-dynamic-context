// SPDX-License-Identifier: GPL-3.0-only
import { Session } from '@deepseek-ai/dsh-session'
import { digest } from 'dsh-better-task-grapth/core'
import { guidanceInputVariants } from './guidance-state.mjs'

// Generated observations are not new authorization. Real instructions and
// unrecognized sources remain pinned; policy, cwd and Goal are pinned separately.
const observations = new Set(['runtime-context', 'time-context', 'dynamic-context', 'tool-registry'])
export const authorityInputs = session => session.deriveMessages().filter(message =>
  ['user', 'developer', 'system'].includes(message.role) && !observations.has(message.source?.kind))
export const legacyInputs = session => session.deriveMessages().filter(message => ['user', 'developer', 'system'].includes(message.role))

// Native persistence materializes delegationDepth=0 on reload even when the
// original root header omitted it. Normalize that default, not task authority.
export function authorityHeader(header) {
  const result = { ...header }
  if (result.delegationDepth === 0) delete result.delegationDepth
  return result
}

/** Read-only compatibility proof for checkpoints written before source filtering.
 * Accept only an exact historical digest whose retained instructions still equal
 * the current ones. This never resets a fence or accepts changed human input.
 */
export function matchesHistoricalAuthority(session, expected, current, hash) {
  if (hash(current) === expected) return true
  for (const input of guidanceInputVariants(session, current.input ?? [])) if (hash({ ...current, input }) === expected) return true
  const events = session.snapshotEvents(), retained = digest(authorityInputs(session))
  for (let count = events.length; count >= 0; count--) {
    const prefix = Session.create(session.id, events.slice(0, count), session.header, Math.min(session.inheritedEventCount ?? 0, count))
    if (digest(authorityInputs(prefix)) !== retained) continue
    const candidate = { ...current, input: legacyInputs(prefix) }
    if (hash(candidate) === expected) return true
    if (candidate.header && hash({ ...candidate, header: authorityHeader(candidate.header) }) === expected) return true
    if (candidate.header?.delegationDepth === undefined &&
        hash({ ...candidate, header: { ...candidate.header, delegationDepth: 0 } }) === expected) return true
  }
  return false
}

export function inputDigestMatches(session, expected) {
  return matchesHistoricalAuthority(session, expected, { input: authorityInputs(session) }, value => digest(value.input))
}
