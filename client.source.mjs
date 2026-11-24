// SPDX-License-Identifier: GPL-3.0-only
// Project log-only observations into existing DSH Chat node kinds. Native Chat
// owns Markdown, reasoning disclosures, tool cards, terminal output and settings.
import { installNativePresentation, foldMetadata } from './client-enhancements.mjs'
import { installPreferenceSettings } from './settings-client.mjs'
import { dynamicToolNames } from './tool-display-names.mjs'
export const DISPLAY_EVENT = 'plugin:dsh-dynamic-context/execution-display-v1'
const stages = { PREPLANNING: '预规划', EXECUTING: '叶执行', result_check: '结果验收', result_repair: '报告补正', result_work: '成果返工',
  plan_check: '计划复查', updater: '图更新', reviewer: '修改审计', compaction: '上下文压缩',
  blockage: '阻塞处理', blockage_audit: '中断审核', group_audit: '组级终审', unit_planner: '单元规划', unit_rebaseline: '单元重基线', unit_plan_audit: '规划审计', unit_audit: '单元终审', scope_plan: '本层计划复查', scope_update: '本层蓝图更新',
  scope_audit: '修改审计', scope_blockage: '分层阻塞处理', scope_pause: '中断审核', task_reporter: '任务报告', progress_reporter: '阶段执行报告', unit_router: '单元路由', baseline_audit: '基线审计', guidance_intake: '用户引导识别', guidance_router: '用户引导分派' }
const escapeMarkdown = text => String(text).replace(/[\\`*_{}\[\]()#+.!<>]/g, '\\$&')
export function executionChatDefinition(PartialArguments) {
  const start = match => ({ row: match.event.data.row, text: match.event.data.text,
    workflowId: match.event.data.workflowId, native: match.event.data.native, missingPrefix: match.event.data.offset > 0, seq: match.event.seq })
  return {
    kind: 'dynamic-context-execution', target: 'chat',
    match: event => event.type === DISPLAY_EVENT && event.data?.version === 1 && typeof event.data.row?.id === 'string'
      ? { id: event.data.workflowId + ':' + event.data.row.id, role: 'start' } : null,
    start: (_context, match) => start(match),
    update: (context, match) => {
      const data = match.event.data, previous = context.state
      if (data.row.revision <= previous.row.revision) return previous
      if (data.reset) return { ...start(match), seq: previous.seq }
      return { ...previous, row: data.row, native: data.native ?? previous.native,
        missingPrefix: previous.missingPrefix || data.offset !== previous.row.bytes,
        text: previous.text + data.text }
    },
    buildViewNode: context => {
      const { row, text, native, missingPrefix, seq } = context.state
      if (row.kind === 'tool_input') return null
      const dynamicContextFold = foldMetadata(context.state.workflowId, row)
      const location = context.start?.location ?? { kind: 'session' }, turn = location.turn?.turn ?? 0
      const base = { key: context.key, id: context.id, target: 'chat', anchorSeq: seq,
        location, visibility: 'visible', groupTree: 'turn' }
      if (row.kind === 'tool' && native) {
        const head = { callId: native.callId ?? row.id, name: native.name ?? row.title, turn, step: row.step,
          time: Date.parse(row.at), subCalls: [], args: PartialArguments.fromText(native.argsRaw ?? '{}') }
        const root = row.state === 'running' ? { ...head, phase: 'start', argsRaw: native.argsRaw ?? '{}' }
          : { ...head, kind: 'tool-result', seq, call: { name: head.name, argsRaw: native.argsRaw ?? '{}' },
            callTime: Date.parse(row.at), content: native.content ?? [{ type: 'text', text: '执行中断；没有最终工具回执，不能视为成功。' }],
            ...(native.meta === undefined ? {} : { meta: native.meta }),
            isError: native.isError || row.state === 'error' || row.state === 'interrupted', ...(native.error ? { error: native.error } : {}) }
        return { ...base, kind: 'tool-call', data: { root, dynamicContextFold } }
      }
      const label = `后台执行 · ${stages[row.stage] ?? row.stage}${row.taskLabel ? ' · ' + row.taskLabel : ''} · 第 ${row.step} 步`
      const body = row.kind === 'model' ? `_${escapeMarkdown(label)}_`
        : (missingPrefix ? '〔当前历史窗口中的输出片段〕\n' : '') + text
      return { ...base, kind: 'assistant-step', data: { dynamicContextFold, turn, step: row.step, time: Date.parse(row.at),
        status: row.state === 'running' ? 'running' : row.state === 'interrupted' ? 'interrupted' : 'settled',
        // Presentation metadata only: keep the summary's original Markdown and
        // classify from the recorded request purpose, never from generated prose.
        ...(row.stage === 'compaction' && row.kind === 'message' ? { dynamicContextOutput: {
          kind: 'compaction', title: '上下文压缩结果' + ({ running: '（生成中）', interrupted: '（已中断）', error: '（失败）' }[row.state] ?? '')
            + ` · 第 ${row.step} 步`,
        } } : {}),
        blocks: [{ kind: row.kind === 'reasoning' ? 'reasoning' : 'text', text: body }] } }
    },
  }
}
export function createExecutionClient(PartialArguments, React, primitives) {
  const chat = executionChatDefinition(PartialArguments)
  // The native tool card's Inspect action navigates to its Trajectory entry.
  // Supply that same observed result to the native view, without a second UI.
  const trajectory = { ...chat, kind: 'dynamic-context-execution-tool', target: 'trajectory',
    match: event => event.data?.row?.kind === 'tool' ? chat.match(event) : null,
    buildViewNode: context => {
      const node = chat.buildViewNode(context)
      return node?.kind === 'tool-call' ? { ...node, target: 'trajectory', kind: context.kind,
        data: { kind: 'tool', root: node.data.root } } : null
    } }
  return { inject: ['uiConversation', 'slots'], apply(ctx) {
    ctx.uiConversation.events.register(chat); ctx.uiConversation.events.register(trajectory)
    ctx.inject(['transactionGraphToolDisplay', 'locale'], scoped => {
      scoped.transactionGraphToolDisplay.register(scoped, 'dynamicContext.tools', dynamicToolNames)
    })
    if (React && primitives) installNativePresentation(ctx, React, primitives)
    if (React && primitives) installPreferenceSettings(ctx, React, primitives)
  } }
}
