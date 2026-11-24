// SPDX-License-Identifier: GPL-3.0-only
import { readStored, hasStored } from './workflow-io.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { digest } from 'dsh-better-task-grapth/core'
import { located } from 'dsh-better-task-grapth/validation'
import { blockageCatalog, blockageTools, sourceValue } from './blockage-evidence.mjs'
import { verifyReference } from './blockage-protocol.mjs'
import { currentSharedContexts } from './core.mjs'
import { directRevisionRole } from './revision-runtime.mjs'

const text = z.string().trim().min(1)
const evidence = z.array(z.object({ source: text, sha256: text, path: z.string(), quote: text }).strict()).min(1)
const item = z.object({ nodeId: text, summary: text, evidence }).strict()
export const progressReportSchema = z.object({ kind: z.literal('interim'), summary: text,
  completed: z.array(item), inProgress: z.array(item), blocked: z.array(item), remaining: z.array(item),
  verification: z.array(z.object({ summary: text, evidence }).strict()), limitations: z.array(text) }).strict()
export const PROGRESS_REPORT_PROMPT = `DYNAMIC_CONTEXT_PROGRESS_REPORTER_V1
你是途中总体执行报告者。用户是在询问现状，不是在宣告完成或要求改图。只根据本次冻结快照总结：已验收成果、正在推进且尚未验收的成果、阻塞/失败、剩余工作、已经运行的验证及尚未验证的限制。默认只展开根层的直接子项；只有单组时下钻该组，私有细节可经只读证据工具核实。不得执行工作、改图、验收、重写历史报告、估造完成比例或把模型自述当作测试通过。
按冻结时刻逐一归类 displayScope 中的节点，同一个 nodeId 在 completed、inProgress、blocked、remaining 四栏中只出现一次。用 snapshot 的 topLevelNodes、taskGraph.active 和当前阻断原因确定现态，再用报告或轨迹补充已做的事。completed 只列 COMPLETE。inProgress 列当前实际正在执行的节点；合法重开并已执行的节点按本次活动尝试归类。blocked 列本次受阻、失败未恢复或必须等外部介入才能继续的节点；已有部分产出写在这条 blocked 摘要内。remaining 列尚未开始、正常等待依赖或排队的工作。全图暂停本身不会把每个排队节点都变成受阻；历史尝试的停顿也不能覆盖当前执行。已跳过的分支如需说明，在限制中交代。提交前按 nodeId 核对四栏与当前快照。
每项附实际 source/sha256/path/quote。引用 snapshot 中的现态与 reports/trace 中的实际结果，区分已确认、合理推断和未知。kind 必须为 interim；此报告不设置任何完成状态。用户未要求停工时，报告完成后程序继续之前的工作；原本暂停则保持暂停。
标准模板：{"kind":"interim","summary":"目前完成的阶段和当前工作重点","completed":[],"inProgress":[{"nodeId":"实际节点ID","summary":"该叶已有部分结果，尚未验收","evidence":[{"source":"snapshot","sha256":"实际摘要","path":"/taskGraph/active/nodeId","quote":"实际节点ID"}]}],"blocked":[],"remaining":[],"verification":[],"limitations":["尚未完成最终审查"]}。`

export async function runProgressReport(runner, { runId, sourceAgent, signal }) {
  const state = runner.graph.read(), status = runner.status()
  const catalog = blockageCatalog(runner, state.supervision ? state : { ...state, supervision: { outcomes: [] } }, signal)
  for (const report of state.reports) if (!catalog.has('report:' + report.attemptId)) catalog.set('report:' + report.attemptId,
    { kind: 'report', taskId: report.taskId, load: () => structuredClone(report) })
  for (const [nodeId, report] of Object.entries(state.graph.state.hierarchy?.groups ?? {})) catalog.set('group:' + nodeId,
    { kind: 'report', taskId: nodeId, load: () => structuredClone(report) })
  let scope = state.graph.state.plan.nodes.find(node => node.parent === null)
  for (;;) {
    const children = state.graph.state.plan.nodes.filter(node => node.parent === scope.id)
    if (children.length !== 1 || children[0].kind !== 'container') break
    scope = children[0]
  }
  const topIds = new Set(state.graph.state.plan.nodes.filter(node => node.parent === scope.id).map(node => node.id))
  const taskGraph = structuredClone(status.taskGraph)
  if (taskGraph.active) delete taskGraph.active.recoveryRequired
  const snapshot = { revision: state.revision, contextVersion: state.contexts.version, taskGraph,
    supervision: state.supervision ? { phase: state.supervision.phase, hierarchy: state.supervision.hierarchy ?? null } : null,
    displayScope: scope.id, topLevelNodes: status.taskGraph.nodes.filter(node => topIds.has(node.id)),
    qualification: 'Current workflow state at a safe tool boundary; incomplete work is not acceptance.' }
  catalog.set('snapshot', { kind: 'snapshot', load: () => structuredClone(snapshot) })
  const activeDirectory = runner.activeRunDirectory(state)
  if (activeDirectory && hasStored(path.join(activeDirectory, 'trace.json'))) {
    const trace = JSON.parse(readStored(path.join(activeDirectory, 'trace.json'), 'utf8'))
    catalog.set('active-trace', { kind: 'trace', taskId: state.graph.state.active.nodeId, load: () => structuredClone(trace) })
  }
  const input = { protocol: 'interim-progress-report-v1', snapshot: sourceValue(catalog, 'snapshot'),
    contract: runner.config.revision?.policy ?? null, sharedContexts: currentSharedContexts(state),
    reports: [...catalog].filter(([, row]) => row.kind === 'report' && topIds.has(row.taskId)).map(([id]) => sourceValue(catalog, id)),
    availableSources: [...catalog].map(([source, row]) => ({ source, kind: row.kind, ...(row.taskId ? { taskId: row.taskId } : {}) })) }
  const report = await directRevisionRole(runner, { role: 'progress_reporter', runId, sourceAgent, signal,
    messages: [{ role: 'system', content: PROGRESS_REPORT_PROMPT }, { role: 'user', content: JSON.stringify(input) }],
    readOnlyTools: blockageTools(catalog, path.join(runner.config.directory, 'revisions', runId), signal), validateOutput: true,
    validateResult: value => {
      const report = progressReportSchema.parse(value)
      for (const section of ['completed', 'inProgress', 'blocked', 'remaining']) for (const [i, row] of report[section].entries()) {
        const node = status.taskGraph.nodes.find(node => node.id === row.nodeId)
        if (!node || section === 'completed' && node.status !== 'COMPLETE') throw located('PROGRESS_STATUS_MISMATCH',
          { path: `/${section}/${i}/nodeId`, item: row.nodeId, reason: 'Use actual nodes; only currently COMPLETE nodes belong in completed.' })
        row.evidence.forEach((ref, j) => verifyReference(ref, catalog, `/${section}/${i}/evidence/${j}`))
      }
      report.verification.forEach((row, i) => row.evidence.forEach((ref, j) => verifyReference(ref, catalog, `/verification/${i}/evidence/${j}`)))
      return report
    } })
  if (runner.graph.read().checksum !== state.checksum) throw located('PROGRESS_SNAPSHOT_CHANGED', { path: '/snapshot', reason: 'The workflow changed during the report; take a fresh snapshot.' })
  const labels = { completed: '已验收成果', inProgress: '进行中', blocked: '受阻事项', remaining: '剩余工作', verification: '验证情况' }
  const body = ['阶段执行报告', report.summary, ...Object.entries(labels).filter(([key]) => report[key].length)
    .map(([key, label]) => label + '\n' + report[key].map(row => '- ' + row.summary).join('\n')),
    ...(report.limitations.length ? ['限制与未知\n' + report.limitations.map(value => '- ' + value).join('\n')] : []),
    '这是中间状态报告，不代表整个任务已经完成。'].join('\n\n')
  runner.output?.publishText({ stage: 'progress_reporter', step: 0 }, '阶段执行报告', body, 'progress-report:' + runId)
  return { runId, report, snapshotHash: digest(snapshot), graphUnchanged: true }
}
