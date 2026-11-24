// SPDX-License-Identifier: GPL-3.0-only
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { hasStored, writeStored, readStored } from './workflow-io.mjs'

import { defaultWorkflowLimits } from 'dsh-better-task-grapth/workflow-limits'

export const PRELOAD_BYTES = defaultWorkflowLimits.preloadBytes
export const DEFAULT_MATERIAL_BYTES = defaultWorkflowLimits.dynamicMaterialBytes
export const bytes = value => Buffer.byteLength(value, 'utf8')
const administrative = new Set(['protocol', 'revision', 'contextVersion', 'taskId', 'scopeId', 'inputHash', 'baselineHash',
  'contract', 'taskContract', 'task', 'instruction', 'roleInstruction', 'systemPrompt', 'userGuidance', 'originalUserGuidance',
  'originalUserTask', 'originalTask', 'runtimeSemantics', 'boundTools', 'hostAllowedTools', 'roleContracts', 'reportAccess', 'roleEvidenceAccess'])
export const executionMaterial = new Set(['contexts', 'inheritedReports', 'unitBaseline', 'reworkRequest', 'interruptedWork', 'correction', 'verificationPlan'])
export const materialLimit = config => config.workflowLimits?.dynamicMaterialBytes ?? config.dynamicContextMaxBytes ?? DEFAULT_MATERIAL_BYTES

function preview(value) {
  const first = Array.isArray(value) ? value[0] : value
  if (first == null) return ''
  const sample = typeof first === 'string' ? first : first.summary ?? first.objective ?? first.content ?? first.result?.summary ?? first.label ?? first.key
  return [...String(sample ?? Object.keys(first).slice(0, 6).join(', ')).slice(0, 200)].slice(0, 88).join('')
}

// The archived object includes exact serialized values. Ranges address those values without scanning other fields.
export function materialBundle(data, limit, fields) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const entries = Object.entries(data).filter(([key, value]) => value != null && (fields ? fields.has(key)
    : !administrative.has(key) && (typeof value === 'object' || typeof value === 'string')))
  if (!entries.length) return null
  const text = JSON.stringify(Object.fromEntries(entries)), size = bytes(text)
  if (size <= limit) return null
  let position = 1
  const cards = entries.map(([key, value]) => {
    const raw = JSON.stringify(value), start = position + JSON.stringify(key).length + 1
    position = start + raw.length + 1
    return { field: key, start, end: start + raw.length, ...(Array.isArray(value) ? { count: value.length } : {}), summary: preview(value) }
  })
  return { text, bytes: size, sha256: createHash('sha256').update(text).digest('hex'), cards }
}

export function materialView(data, bundle, reader, limit) {
  const projected = { ...data }
  for (const card of bundle.cards) delete projected[card.field]
  const access = { format: 'unit-context-material-v2', utf8Bytes: bundle.bytes, sha256: bundle.sha256,
    offsets: 'UTF-16', reader, fields: bundle.cards }
  if (bytes(JSON.stringify(access)) > limit) access.fields = bundle.cards.map(({ field, start, end }) => ({ field, start, end }))
  if (bytes(JSON.stringify(access)) > limit) { delete access.fields; access.summary = 'Top-level fields in one archived JSON object'; access.characters = bundle.text.length }
  return { ...projected, materialSummary: access }
}

export const localSourceSchema = Object.freeze({ name: 'dynamic_context_source_read',
  description: 'Page this attempt’s sealed input by archive_id and UTF-16 offset. Use the source ID supplied in materialSummary.',
  parameters: { type: 'object', additionalProperties: false, required: ['archive_id','message_index'],
    properties: { archive_id: { type: 'string' }, message_index: { type: 'integer', const: 0 }, field: { type: 'string', enum: ['content'] },
      offset: { type: 'integer', minimum: 0 }, length: { type: 'integer', minimum: 1 } } } })
export function readLocalSource(journal, assembly, args) {
  if (args.archive_id !== assembly.materialSummary?.reader.arguments.archive_id || args.message_index !== 0 || (args.field ?? 'content') !== 'content')
    return { isError: true, content: [{ type: 'text', text: 'SOURCE_OUTSIDE_CURRENT_ATTEMPT' }] }
  const value = journal.readSource(args)
  return { isError: false, value, content: [{ type: 'text', text: JSON.stringify(value) }] }
}

function sourceFile(runner, owner, sha) {
  if (!/^[a-f0-9]{64}$/.test(sha) || !/^controller$|^planner-[a-f0-9-]+$/.test(owner)) throw new Error('MATERIAL_SOURCE_INVALID')
  return path.join(runner.config.directory, 'context-material', owner, sha + '.json')
}
export function boundedSnapshot(runner, owner, data, tool, fields, limit = materialLimit(runner.config)) {
  const bundle = materialBundle(data, limit, fields)
  if (!bundle) return data
  const file = sourceFile(runner, owner, bundle.sha256)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  if (!hasStored(file)) {
    try { writeStored(file, bundle.text, { exclusive: true }) ?? fs.writeFileSync(file, bundle.text, { flag: 'wx', mode: 0o600 }) }
    catch (err) { if (err.code !== 'EEXIST') throw err }
  }
  const reader = { tool, arguments: { source: bundle.sha256, offset: 0, length: 1024 } }
  return materialView(data, bundle, reader, limit)
}
export function readSnapshot(runner, owner, { source, offset = 0, length = 4096 }) {
  const file = sourceFile(runner, owner, source)
  if (!hasStored(file)) throw new Error('MATERIAL_SOURCE_OUTSIDE_ROLE')
  const text = readStored(file, 'utf8')
  if (createHash('sha256').update(text).digest('hex') !== source) throw new Error('MATERIAL_SOURCE_CHANGED')
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length || !Number.isSafeInteger(length) || length < 1)
    throw new Error('MATERIAL_PAGE_RANGE')
  const end = Math.min(offset + length, text.length)
  return { sha256: source, offset, end, text: text.slice(offset, end), nextOffset: end < text.length ? end : null }
}
