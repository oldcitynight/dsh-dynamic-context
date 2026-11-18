// SPDX-License-Identifier: GPL-3.0-only
import { z } from 'zod'
import { digest } from 'dsh-better-task-grapth/core'
import { parseModelJSON, located, diagnostic } from 'dsh-better-task-grapth/validation'
export const RECEIPT_TOOL = 'dynamic_context_select_receipt'
export const receiptText = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.map(row => typeof row?.text === 'string' ? row.text : JSON.stringify(row)).join('\n') : JSON.stringify(content)
export function receiptCatalog(facts) {
  return facts.tools.filter(row => row.outcome !== 'NOT_RUN').map(row => {
    const text = receiptText(row.content), sourceSha256 = digest(text)
    return { ...row, text, sourceSha256, id: 'receipt_' + digest({ scope: row.receiptScope ?? facts.trace?.sha256,
      callId: row.callId, sourceSha256, name: row.name }) }
  })
}
const listSchema = z.object({ query: z.string().optional(), offset: z.number().int().nonnegative().default(0) }).strict()
const selectSchema = z.object({ id: z.string(), sourceSha256: z.string(), start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict()
const schema = z.union([listSchema, selectSchema])
export const receiptTool = { type: 'function', function: { name: RECEIPT_TOOL,
  description: 'Find immutable receipts supplied to this report repair, then select an exact UTF-16 span. List template {"query":"test","offset":0}. Selection template {"id":"receipt_actual","sourceSha256":"actual hash","start":0,"end":20}. List returns 20 indexed previews and nextOffset; search includes full text. Selection returns evidence to set on executionReport.tests[i].evidence with the report rewrite tool. The host resolves callId and quote; do not retype them. No work execution, foreign attempts, filesystem reads or approval.',
  parameters: z.toJSONSchema(schema, { target: 'draft-7' }) } }
export function bindReceipt(binding, facts, at = '/evidence') {
  const rows = receiptCatalog(facts).filter(row => row.id === binding.id)
  if (rows.length !== 1 || rows[0].sourceSha256 !== binding.sourceSha256) throw located('RECEIPT_BINDING_SOURCE', {
    path: at + '/id', reason: 'Select a unique source in this attempt chain with its exact hash. Cross-task, ambiguous or changed sources are not accepted.' })
  const row = rows[0], { start, end } = binding
  const splits = n => n > 0 && n < row.text.length && /[\uD800-\uDBFF]/.test(row.text[n - 1]) && /[\uDC00-\uDFFF]/.test(row.text[n])
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > row.text.length || splits(start) || splits(end))
    throw located('RECEIPT_BINDING_RANGE', { path: at, reason: 'Use a nonempty UTF-16 range inside the source, without splitting surrogate pairs.', characters: row.text.length })
  return { callId: row.callId, quote: row.text.slice(start, end), sourceSha256: row.sourceSha256, start, end, receiptScope: row.receiptScope }
}
export function createReceiptSelector(facts) {
  facts = structuredClone(facts)
  return { tools: [receiptTool], execute(raw) {
    try {
      const args = schema.parse(parseModelJSON(raw).value)
      if ('id' in args) return { evidence: args, resolved: bindReceipt(args, facts), qualification: 'Exact recorded observation, not semantic approval or proof that omitted output is irrelevant.' }
      const rows = receiptCatalog(facts).filter(row => !args.query || [row.callId, row.name, row.text].some(value => value.includes(args.query)))
      return { total: rows.length, nextOffset: args.offset + 20 < rows.length ? args.offset + 20 : null,
        receipts: rows.slice(args.offset, args.offset + 20).map(row => ({ id: row.id, callId: row.callId, name: row.name, sourceSha256: row.sourceSha256,
          characters: row.text.length, preview: row.text.slice(0, 400), matchStart: args.query ? row.text.indexOf(args.query) : 0 })) }
    } catch (error) { return { error: error.code ?? 'RECEIPT_SELECTION_INVALID', diagnostic: diagnostic(error, { stage: RECEIPT_TOOL }) } }
  } }
}
