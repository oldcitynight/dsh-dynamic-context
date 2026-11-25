// SPDX-License-Identifier: GPL-3.0-only
import { createReportDraft, REPORT_GENERATE, REPORT_READ, REPORT_EDIT, REPORT_SUBMIT } from './report-draft.mjs'
import { binaryInstruction, checkOutcome } from './rule-protocol.mjs'
import { dispositionSchema } from './supervision-state.mjs'
import { inspectExecutionReport, EXECUTION_REPORT_INSTRUCTION, LEGACY_DISPOSITION_INSTRUCTION } from './report-evidence.mjs'
import { digest } from 'dsh-better-task-grapth/core'
import { located } from 'dsh-better-task-grapth/validation'
export const EXECUTION_REPORT_TOOLS = [REPORT_GENERATE, REPORT_READ, REPORT_EDIT, REPORT_SUBMIT]
export function executionReportDraft(runner, trace, signal, persist, preceding = []) {
  const old = trace.reportDraft, original = '{}'
  const draft = createReportDraft(original, { generate: true, replayReceipts: old?.receipts, validateResult: raw => {
    const result = dispositionSchema.parse(raw), calls = new Map(trace.events.filter(row => row.type === 'tool/call').map(row => [row.data.callId, row.data]))
    const tools = [...preceding, ...trace.events.filter(row => ['tool/result', 'tool/deferred'].includes(row.type)).map(({ type, data }) => ({
      callId: data.callId, name: data.name, arguments: calls.get(data.callId)?.arguments, content: data.content,
      outcome: type === 'tool/deferred' ? 'NOT_RUN' : data.isError ? 'FAILED' : 'RETURNED',
    }))]
    if (trace.assembly.reportProtocol === 'report-scoped-v1') inspectExecutionReport(runner, result, { tools }, signal)
    checkOutcome(trace.assembly.ruleVersion,result,tools)
    if (!trace.assembly.ruleVersion && result.outcome === 'FAILED' && !tools.some(row => row.callId === result.failedCallId && row.outcome === 'FAILED'))
      throw located('SUPERVISION_FAILED_RECEIPT_REQUIRED', { path: '/failedCallId', reason: 'Cite a real failed tool call from this attempt.' })
    return result
  } })
  const reopens = trace.reportDraftReopens ?? [], receipts = old?.receipts ?? []
  let nextReopen = 0
  const changedReopen = () => { throw located('DIRECT_REPORT_DRAFT_CHANGED', { path: '/reportDraftReopens', reason: 'The saved guidance boundary does not match the submitted declaration receipt.' }) }
  const replayReopen = index => {
    const marker = reopens[nextReopen]
    if (!marker || marker.receiptCount !== index) return
    if (draft.result() === undefined || marker.snapshotHash !== digest(draft.snapshot()) || marker.resultHash !== digest(draft.result())
        || typeof marker.guidanceHash !== 'string' || !/^[a-f0-9]{64}$/.test(marker.guidanceHash)) changedReopen()
    draft.reopen(); nextReopen++
  }
  // Only declaration tools and recorded host reopen boundaries are replayed,
  // never work tools, new validation, or filesystem effects.
  for (const [index, row] of receipts.entries()) { replayReopen(index); draft.execute(row.name, row.rawArguments) }
  replayReopen(receipts.length)
  if (nextReopen !== reopens.length) changedReopen()
  if (old && digest(draft.snapshot()) !== digest(old)) throw located('DIRECT_REPORT_DRAFT_CHANGED', { path: '/reportDraft', reason: 'Saved report tool receipts do not reconstruct the stored draft.' })
  const definitions = draft.tools.map(({ function: spec }) => ({ ...JSON.parse(JSON.stringify(spec)),
    description: spec.description + (spec.name === REPORT_GENERATE ? '\nThis execution role uses the following exact report template (wrap the object in report):\n' + (trace.assembly.ruleVersion ? binaryInstruction(trace.assembly.reportProtocol === 'report-scoped-v1' ? EXECUTION_REPORT_INSTRUCTION : LEGACY_DISPOSITION_INSTRUCTION) : trace.assembly.reportProtocol === 'report-scoped-v1' ? EXECUTION_REPORT_INSTRUCTION : LEGACY_DISPOSITION_INSTRUCTION) : ''),
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute(args) { const value = draft.execute(spec.name, JSON.stringify(args)); trace.reportDraft = draft.snapshot(); persist(); return value },
  }))
  return { ...draft, definitions, needsPlanReview() {
    const { assembly } = trace
    return Boolean(assembly.unitBaseline && assembly.ruleVersion &&
      runner.graph.read().contexts.bindings.find(binding => binding.taskId === assembly.task.id)?.tools.length === 0 &&
      draft.snapshot().receipts.at(-1)?.result.error === 'RULE_FAILED_EVIDENCE_REQUIRED')
  }, reopenForGuidance(guidance) {
    if (draft.result() === undefined) return null
    const snapshot = draft.snapshot(), marker = { receiptCount: snapshot.receipts.length, snapshotHash: digest(snapshot),
      resultHash: digest(draft.result()), guidanceHash: digest(guidance) }
    trace.reportDraftReopens ??= []; trace.reportDraftReopens.push(marker)
    draft.reopen(); trace.reportDraft = draft.snapshot(); delete trace.structuredSubmission; persist()
    return { ...marker, revision: snapshot.revision, instruction: 'The declaration is awaiting reconsideration under new user guidance. Read or rewrite selected fields, then submit again. Prior work effects and receipts remain unchanged.' }
  } }
}
export function isToolReportTrace(trace, reportText) {
  const receipt = trace.structuredSubmission, request = trace.requests.at(-1)
  reportText ??= receipt?.reportText
  if (typeof reportText !== 'string' || !receipt || receipt.resultHash !== digest(reportText) || request?.finish !== 'tool_calls') return false
  const response = trace.events.findLast(row => row.type === 'assistant/response')?.data
  const call = response?.message.tool_calls?.[0]
  if (response?.message.tool_calls?.length !== 1 || ![REPORT_GENERATE, REPORT_SUBMIT].includes(call?.function.name) || call.id !== receipt.callId
    || digest(response.message) !== request.responseMessageSha256 || receipt.draftHash !== digest(trace.reportDraft)) return false
  const result = trace.events.find(row => row.type === 'tool/result' && row.data.callId === call.id)
  const last = trace.reportDraft?.receipts?.at(-1)
  return Boolean(result && !result.data.isError && last?.name === call.function.name && last.result.submitted && last.result.resultHash === digest(JSON.parse(reportText)))
}
