// SPDX-License-Identifier: GPL-3.0-only
import { located } from 'dsh-better-task-grapth/validation'
import { bindReceipt, receiptText } from './receipt-selection.mjs'
import { dispositionExamples } from './format-examples.mjs'
export function binaryInstruction(detail = '', role = 'executor') {
  const marker = 'Choose the example that matches the observed outcome.'
  const hasExamples = detail.includes(marker)
  const original = hasExamples ? detail.slice(0, detail.indexOf(marker)) : detail
  const instructions =
    original
      .replace('A FAILED disposition additionally requires failedCallId for a recorded failed call. ', '')
      .replace(
        'FAILED requires failedCallId with the exact failed receipt ID. Use BLOCKED if an unmet condition prevents work.',
        ''
      )
      .replaceAll('BLOCKED/FAILED', 'FAILED')
      .replaceAll('受阻和已知失败可以受理为各自状态', '已证实的失败可以受理为 FAILED')
      .replace('仍然受阻时如实填写 BLOCKED', '核实未达标准时提交 FAILED 并引用对应证据')
      .replaceAll('BLOCKED', 'FAILED')
      .replaceAll('COMPLETE', 'PASS') +
    (hasExamples ? dispositionExamples(detail.includes('executionReport'), true) : '')
  if (role === 'result_check')
    return (
      instructions +
      '\nRULE_OUTCOMES_V1。被审叶提交 PASS 或 FAILED。失败可由实际失败回执或记录在案的未达验收标准支持。BLOCK 由调度器推导。本验收角色按上文的 verdict 格式返回受理意见。'
    )
  return (
    instructions +
    '\nRULE_OUTCOMES_V1。叶结果只提交 PASS 或 FAILED。PASS 引用验收依据。FAILED 提交真实失败调用的 failedCallId，或在 executionReport.tests 中给出 FAIL、未达标准、期望与实际及真实已执行回执的 callId 和原文 quote。工具回执 outcome=RETURNED 时，即使结果不合格或输出包含 exit code，也省略顶层 failedCallId，只在 tests 的 FAIL 项引用该回执。已有草稿含此字段时用 rewrite_report 的 remove 操作删除它，再提交当前 revision。工作受外界中断时保留恢复点。BLOCK 只能由调度器推导。'
  )
}
export function checkOutcome(version, result, source) {
  const facts = Array.isArray(source) ? { tools: source } : source
  const tools = facts.tools
  if (!version) {
    if (result.outcome === 'PASS')
      throw located('RULE_VERSION_REQUIRED', { path: '/outcome', reason: 'This recorded workflow uses COMPLETE.' })
    return
  }
  if (!['PASS', 'FAILED'].includes(result.outcome))
    throw located('RULE_AGENT_BINARY_OUTCOME_REQUIRED', {
      path: '/outcome',
      reason: 'Submit PASS or FAILED. BLOCK is computed by the scheduler.'
    })
  if (result.outcome !== 'FAILED') return
  if (result.failedCallId) {
    const call = tools.find(t => t.callId === result.failedCallId)
    if (call?.outcome === 'FAILED') return
    throw located('RULE_FAILED_EVIDENCE_REQUIRED', {
      path: '/failedCallId', observed: call?.outcome ?? 'unknown call ID',
      reason: 'This ID must identify a host FAILED tool receipt. For a measured mismatch from a RETURNED tool, remove /failedCallId and cite its exact callId and output quote in a FAIL test.',
      repair: { op: 'remove', path: '/failedCallId' }
    })
  }
  if (
    result.executionReport?.tests?.some((test) => {
      if (test.status !== 'FAIL' || !test.criterion?.trim() || !test.expected?.trim() || !test.observed?.trim())
        return false
      const binding = test.evidence && bindReceipt(test.evidence, facts)
      const callId = binding?.callId ?? test.callId,
        quote = binding?.quote ?? test.quote
      if (!quote?.trim()) return false
      const matches = tools.filter(
        (t) => t.callId === callId && t.outcome !== 'NOT_RUN' && (!binding || t.receiptScope === binding.receiptScope)
      )
      return matches.length === 1 && receiptText(matches[0].content)?.includes(quote)
    })
  )
    return
  throw located('RULE_FAILED_EVIDENCE_REQUIRED', {
    path: '/executionReport/tests',
    reason: 'Cite an actual failed call or a failed criterion with an exact quote from an executed check. If this unit has no declared work tools and no check can be executed, the program can pause for a plan review.'
  })
}
