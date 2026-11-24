// SPDX-License-Identifier: GPL-3.0-only
import path from 'node:path'
import { z } from 'zod'
import { digest } from 'dsh-better-task-grapth/core'
import { draftsFor, auditRunId } from './rule-editor.mjs'
import { proposalSchema, fail } from './core.mjs'
import { directRevisionRole } from './revision-runtime.mjs'
import { hasStored } from './workflow-io.mjs'
const decision = z.object({ verdict: z.enum(['APPROVE', 'REJECT']), reason: z.string().trim().min(1) }).strict()

export async function prepareRuleSubmission(
  runner,
  input,
  agent,
  signal,
  review = directRevisionRole,
  { legacyHierarchy = false } = {}
) {
  if (
    !legacyHierarchy &&
    runner.config.supervision &&
    input?.taskGraph?.hierarchy &&
    input.contextGraph &&
    input.taskGraph.ruleVersion === undefined
  ) {
    input = { ...input, taskGraph: { ...input.taskGraph, ruleVersion: 1 } }
  }
  if (
    !input?.taskGraph?.ruleVersion &&
    !runner.ruleDrafts &&
    !hasStored(path.join(runner.config.directory, 'planning-rules.json'))
  )
    return input
  runner.admitWorkflowRelease()
  if (runner.graph.read()) fail('RULE_GRAPH_ALREADY_COMMITTED')
  const drafts = draftsFor(runner),
    submitted = proposalSchema.parse(input)
  const proposal = proposalSchema.parse(drafts.bind(submitted)),
    hash = digest(proposal)
  if (!proposal.taskGraph.ruleVersion) return input
  const snapshot = drafts.read()
  if (snapshot.approval?.proposalHash === hash) return proposal
  const ticket = drafts.update((d) => {
    if (d.revision !== snapshot.revision) fail('RULE_DRAFT_STALE')
    if (d.audit?.hash !== hash) d.audit = { hash, runId: auditRunId() }
    return { ...d.audit }
  })
  const messages = [
    {
      role: 'system',
      content:
        'RULE_BLUEPRINT_AUDIT_V1。独立审计任务目标、双图、组终点及每个入口的 AND/OR/NOT 与等待语义，取反须保留未决状态。同层其他单元有可执行工作时先选它们，终点叶或终点组优先级最低。任何同层单元的前序规则都禁止引用终点，备选分支、取反及全部结果组合均适用。需要承接整组结果的单元应在父层引用该组。结合用户合同判断备用路线、BLOCK、FAILED 和缺省是否符合意图。' + (proposal.taskGraph.hierarchy?.version === 2 ? '本次是 v2 根基线的首次审计。此阶段提交且仅提交一个 kind:leaf 的根。即使用户要求分阶段、移交、独立验收，核对的是这些要求是否保存在根基线与用户合同中。路由者会在批准后选择 PLAN，再由本层规划者申报和独立审计子图。子项、同层规则和终点尚待该步骤创建。' : '') + '只返回 {"verdict":"APPROVE","reason":"具体依据"} 或 REJECT 与修改理由。'
    },
    { role: 'user', content: JSON.stringify({ contract: runner.config.revision?.policy ?? null, proposal }) }
  ]
  const result = decision.parse(
    await review(runner, {
      role: 'reviewer',
      runId: ticket.runId,
      messages,
      signal,
      sourceAgent: agent,
      validateResult: (raw) => decision.parse(raw)
    })
  )
  signal?.throwIfAborted()
  drafts.update((d) => {
    if (d.audit?.runId !== ticket.runId || digest(proposalSchema.parse(drafts.bind(submitted))) !== hash)
      fail('RULE_AUDIT_STALE')
    if (result.verdict === 'APPROVE') d.approval = { ...result, proposalHash: hash, runId: ticket.runId }
    else d.audit.rejection = result.reason
  })
  if (result.verdict !== 'APPROVE') fail('RULE_AUDIT_REJECTED', { path: '/taskGraph', reason: result.reason })
  return proposal
}
