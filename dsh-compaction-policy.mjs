// SPDX-License-Identifier: MIT
// Copyright (c) 2026 DeepSeek. Copied from DSH 0.2.1-rc.5 summarizer.ts.
// See DSH-COMPACTION-LICENSE.txt. Keep instruction and framing byte-identical.
export const SUMMARY_OPEN_TAG = '<compacted-summary>'
export const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/**
 * The summarization directive, delivered as the FINAL user message after the
 * replayed conversation rather than as a distinct summarizer system prompt.
 * Keeping the conversation's own system prompt, tools, and message prefix in
 * front of it makes the auxiliary call a genuine prefix of the last routed
 * request, so the provider's KV cache is reused instead of invalidated.
 */
export const COMPACTION_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
].join('\n')

/** Framing that makes the replacement user message established context. */
export const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'


export const NATIVE_CHECKPOINT_PROTOCOL = "direct-dsh-native-checkpoint-v1"
export const NATIVE_REMINDER_PROTOCOL = "direct-dsh-native-task-reminder-v1"
export const PROVENANCE_TAG = "<dynamic-context-provenance>"
export const SUMMARY_MAX_TOKENS = 65536

export function nativeCompactSpec(contextWindow, reservedCompletionTokens) {
  const pressure = contextWindow - reservedCompletionTokens - 65536
  const thresholdTokens = Math.floor(Math.min(contextWindow * .8, pressure))
  const retainTokens = Math.floor((contextWindow - reservedCompletionTokens) * .16)
  if (!Number.isSafeInteger(contextWindow) || !Number.isSafeInteger(reservedCompletionTokens) || reservedCompletionTokens < 0 || retainTokens < 0 || retainTokens >= thresholdTokens) throw new Error("DIRECT_NATIVE_COMPACTION_INVALID_CAPACITY")
  return Object.freeze({ contextWindow, reservedCompletionTokens, thresholdTokens, retainTokens, maxTokens: SUMMARY_MAX_TOKENS, attempts: 2 })
}
