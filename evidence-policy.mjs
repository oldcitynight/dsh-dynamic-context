// SPDX-License-Identifier: GPL-3.0-only
// Derived from this project's context-memory/policy.mjs; pure evidence rules only.
import { createHash } from 'node:crypto'
const digest = text => createHash('sha256').update(text).digest('hex')
const textOf = message => (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
const isCheckpoint = message => message?.source?.kind === 'compact-checkpoint'
export function criticalPins(message, source) {
  if (isCheckpoint(message) || message?.role === 'assistant') return []
  const kind = message?.source?.kind
  if (message?.role === 'user' && !['user', 'legacy-generated-checkpoint'].includes(kind)) return []
  if (message?.role === 'tool' && kind !== 'tool') return []
  if (['system', 'developer'].includes(message?.role) && !['system', 'system-prompt', 'developer', 'agent-instructions'].includes(kind)) return []
  if (!['user', 'tool', 'system', 'developer'].includes(message?.role)) return []
  const text = textOf(message).replace(/```[^\n]*\n[\s\S]*?```|~~~[^\n]*\n[\s\S]*?~~~/g, '[code stored in source archive]')
  const strong = /\b(?:NOT_RUN|UNKNOWN|must(?: not)?|never|do not|forbid|read.only|not authorized|only read)\b|不得|禁止|不允许|不可|只能|必须|尚未|未运行|未验证|不代表|只读/i
  return text.split(/(?<=[。！？!?;；])\s*|(?<=\.)\s+|\r?\n/u).map(raw => raw.trim()).flatMap(raw => {
    if (!raw) return []
    const keys = []
    // Only explicit direct-human current/corrected setting declarations can
    // supersede older setting pins. No permission/grant is inferred by time.
    if (message.source?.kind === 'user' && !strong.test(raw)) {
      // Deliberately narrow grammar. Mixed setting/permission/status prose and
      // references to another project are never removed by a newer value.
      if (/^(?:(?:Current|Corrected)\s+context(?:\s+(?:window|size))?\s*(?::|=|is|to)\s*\d+|当前上下文(?:窗口|大小)?\s*(?:为|改为|设置为|[:：=])\s*\d+)[。.;；]?$/iu.test(raw)) keys.push('setting:context')
      if (/^(?:(?:Current|Corrected)\s+timeout\s*(?::|=|is|to)\s*\d+(?:ms)?|当前超时\s*(?:为|改为|设置为|[:：=])\s*\d+(?:ms|毫秒)?)[。.;；]?$/iu.test(raw)) keys.push('setting:timeout')
    }
    if (!strong.test(raw) && !keys.length) return []
    return [{ ...source, role: message.role, originKind: message.source?.kind ?? 'unknown', raw, hash: digest(raw), keys, aliases: [{ sessionId: source.sessionId, seq: source.seq }] }]
  })
}
export function evidenceFlags(text) {
  return {
    status: [...new Set(text.match(/\b(?:NOT_RUN|UNKNOWN|UNVERIFIED)\b|未运行|未验证/gu) ?? [])].sort(),
    restriction_terms: /\b(?:must(?: not)?|never|do not|forbid|read.only|not authorized|only read)\b|不得|禁止|不允许|不可|只能|必须|只读/iu.test(text),
  }
}
