// SPDX-License-Identifier: GPL-3.0-only
import { PERFORMANCE_KEY, performanceProjection } from './performance-common.mjs'

export function structuredLabel(text) {
  const raw = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1').trim()
  let value
  try { value = JSON.parse(raw) } catch {
    return /^(?:\{\s*"|\[\s*(?:\{|\[|"|\d|true|false|null))/.test(raw) ? 'JSON 数据（生成中或格式待修正）' : null
  }
  if (!value || typeof value !== 'object') return null
  if (value.action === 'COMPLETE' && value.children) return '组级终审报告 · JSON'
  if (value.modifications && value.action === 'REVISE') return '分层蓝图修改报告 · JSON'
  if (value.title && value.achievements && value.verification) return '任务总结报告 · JSON'
  if (value.action === 'PAUSE') return '中断申请报告 · JSON'
  if (value.action === 'REWORK') return '返工申请报告 · JSON'
  if (value.executionReport || value.workHistory && value.results) return '执行报告 · JSON'
  if (value.taskGraph && value.contextGraph || value.proposal?.taskGraph) return '任务图与上下文图 · JSON'
  if (value.taskGraph || value.plan?.nodes) return '任务图 · JSON'
  if (value.contextGraph) return '上下文图 · JSON'
  if (value.changeReport || value.changes) return '图修改报告 · JSON'
  if (value.verdict) return '验收或复查结果 · JSON'
  if (value.outcome) return '执行处置报告 · JSON'
  if (value.edits) return '局部修改请求 · JSON'
  return '结构化数据 · JSON'
}
export function structuredParts(text) {
  const full = structuredLabel(text)
  if (full) return [{ text, label: full }]
  const result = [], pattern = /```json\s*\n[\s\S]*?\n```/gi
  let offset = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > offset) result.push({ text: text.slice(offset, match.index) })
    result.push({ text: match[0], label: structuredLabel(match[0]) ?? 'JSON 数据（格式待修正）' })
    offset = match.index + match[0].length
  }
  if (offset < text.length) result.push({ text: text.slice(offset) })
  return result
}
export function installNativePresentation(ctx, React, primitives) {
  const { createElement: h, useMemo } = React
  function withStatistics(Base) {
    return function StatisticsSource(props) {
      const nativeProjection = props.useProjection
      const useProjection = useMemo(() => (key, selector = value => value) => {
        const native = nativeProjection(key)
        const extra = nativeProjection(PERFORMANCE_KEY)
        const value = useMemo(() => performanceProjection(key, native, extra), [key, native, extra])
        return selector(value)
      }, [nativeProjection])
      return h(Base, { ...props, useProjection })
    }
  }
  function StructuredContent({ Base, props, block, label }) {
    const { expanded, toggle } = props.useDisclosure()
    const raw = block.text.trim()
    const fence = '`'.repeat(Math.max(3, ...[...raw.matchAll(/`+/g)].map(match => match[0].length + 1)))
    const text = /^```(?:json)?\s*\n/.test(raw) ? raw : fence + 'json\n' + block.text + '\n' + fence
    return h('div', { 'data-structured-content': label }, h(primitives.DisclosureRow, {
      title: label, open: expanded, expandable: true, expandOnRowClick: true, onToggle: toggle,
      children: expanded ? h(Base, { ...props, node: { ...props.node, data: { ...props.node.data, blocks: [{ ...block, text }] } } }) : undefined,
    }))
  }
  function CompactionContent({ Base, props, title }) {
    // Native disclosure state starts closed and retains the user's choice while
    // streaming. The native assistant still owns Markdown, copy and timestamps.
    const { expanded, toggle } = props.useDisclosure()
    return h('div', { 'data-context-compaction': 'result' }, h(primitives.DisclosureRow, {
      title, open: expanded, expandable: true, expandOnRowClick: true, onToggle: toggle,
      children: expanded ? h(Base, props) : undefined,
    }))
  }
  function withStructuredContent(Base) {
    return function StructuredAssistant(props) {
      const output = props.node.data.dynamicContextOutput
      if (output?.kind === 'compaction' && props.groupPart !== 'reasoning')
        return h(CompactionContent, { Base, props, title: output.title })
      const parts = props.node.data.blocks.flatMap(block => block.kind === 'text'
        ? structuredParts(block.text).map(part => ({ block: { ...block, text: part.text }, label: part.label })) : [{ block }])
      if (!parts.some(part => part.label) || props.groupPart === 'reasoning') return h(Base, props)
      return h(React.Fragment, null, ...parts.map((part, index) => part.label
        ? h(StructuredContent, { key: index, Base, props, ...part })
        : h(Base, { ...props, key: index, node: { ...props.node, data: { ...props.node.data, blocks: [part.block] } } })))
    }
  }
  const wrapped = new WeakMap()
  ctx.provide('dynamicContextPresentation', {
    component(slotKey, entry) {
      const statistics = slotKey === 'conversation.composer.bar' || slotKey === 'conversation.composer.dock' && ['activity', 'usage'].includes(entry.options.id)
      const structured = slotKey === 'conversation.chat.node' && entry.options.key === 'assistant-step'
      const flow = slotKey === 'conversation.chat.flow'
      if (!statistics && !structured && !flow) return entry.component
      if (!wrapped.has(entry)) wrapped.set(entry, flow ? completedLeafFlow(ctx, React, primitives, entry.component) : statistics ? withStatistics(entry.component) : withStructuredContent(entry.component))
      return wrapped.get(entry)
    },
  })
}

// Completed-leaf and role-step display folding; never edits persisted events.
const foldStages = {
  PREPLANNING: '预规划', EXECUTING: '执行', result_check: '结果验收',
  result_repair: '报告补正', result_work: '成果返工', plan_check: '计划复查',
  updater: '图更新', reviewer: '修改审计', compaction: '上下文压缩',
  blockage: '阻塞处理', blockage_audit: '中断审核', group_audit: '组级终审',
  unit_planner: '单元规划', unit_rebaseline: '单元重基线', unit_plan_audit: '规划审计', unit_audit: '单元终审', scope_plan: '本层计划复查', scope_update: '本层蓝图更新', scope_audit: '修改审计',
  scope_blockage: '分层阻塞处理', scope_pause: '中断审核', task_reporter: '任务报告',
  unit_router: '单元路由', baseline_audit: '基线审计', guidance_intake: '用户引导识别', guidance_router: '用户引导分派',
  progress_reporter: '阶段执行报告',
}
const leafStages = new Set(['EXECUTING', 'result_check', 'result_repair', 'result_work', 'compaction'])
export function foldMetadata(workflowId, row) {
  return { workflowId, taskId: row.taskId, taskLabel: row.taskLabel,
    sessionId: row.sessionId, step: row.step, stage: row.stage, kind: row.kind, state: row.state }
}
export function completedIndex(value, sessionId, previous) {
  const workflowId = value?.execution?.workflowId, graph = value?.graph
  if (value?.sessionId !== sessionId || value.status !== 'ready' || typeof workflowId !== 'string'
    || !Array.isArray(graph?.nodes) || !Number.isSafeInteger(graph.revision)
    || previous?.workflowId === workflowId && graph.revision < previous.revision) return null
  const leaves = new Map(graph.nodes.filter(n => n.kind === 'leaf' && n.status === 'COMPLETE'
    && !n.blocked && n.id !== graph.active?.nodeId).map(n => [n.id, n.label]))
  const signature = JSON.stringify([workflowId, graph.revision, [...leaves]])
  return previous?.signature === signature ? previous : { sessionId, workflowId, revision: graph.revision, leaves, signature }
}
const runKey = m => JSON.stringify([m.workflowId, m.taskId ?? null, m.stage, m.sessionId ?? null])
const stepKey = m => runKey(m) + ':' + m.step
const metaOf = (entry, nodes) => entry.kind === 'node' ? nodes.get(entry.key)?.data?.dynamicContextFold : null
const known = m => m && typeof m.workflowId === 'string' && foldStages[m.stage] && Number.isSafeInteger(m.step)
function count(entries, nodes) {
  const steps = new Set(), rows = new Set(); let errors = 0
  for (const e of entries) { const m = metaOf(e, nodes); rows.add(e.key); if (known(m)) steps.add(stepKey(m)); if (m?.state === 'error' || m?.state === 'interrupted') errors++ }
  return { steps: steps.size, rows: rows.size, errors }
}
// Preserve contiguous order. User messages, native groups and unrelated roles
// are hard boundaries; they can never be swallowed by a neighbouring leaf.
export function foldPlan(entries, nodes, completed, { steps = true } = {}) {
  const latest = new Map()
  for (const e of entries) { const m = metaOf(e, nodes); if (known(m)) latest.set(runKey(m), m.step) }
  function phasePlan(list) {
    const parts = []
    for (const e of list) {
      const m = metaOf(e, nodes)
      const key = steps && known(m) && m.state === 'complete' && m.step !== latest.get(runKey(m)) ? runKey(m) : null
      const last = parts.at(-1)
      if (key && last?.type === 'steps' && last.run === key) last.entries.push(e)
      else if (key) parts.push({ type: 'steps', key: 'steps:' + e.key, run: key, title: foldStages[m.stage], taskLabel: m.taskLabel, entries: [e] })
      else if (last?.type === 'native') last.entries.push(e)
      else parts.push({ type: 'native', key: 'native:' + e.key, entries: [e] })
    }
    for (const p of parts) if (p.type === 'steps') Object.assign(p, count(p.entries, nodes))
    return parts
  }
  const outer = []
  for (const e of entries) {
    const m = metaOf(e, nodes)
    const key = known(m) && m.state !== 'running' && leafStages.has(m.stage)
      && m.workflowId === completed?.workflowId && completed.leaves.has(m.taskId) ? m.taskId : null
    const last = outer.at(-1)
    if (key && last?.type === 'leaf' && last.taskId === key) last.entries.push(e)
    else if (key) outer.push({ type: 'leaf', key: 'leaf:' + e.key, taskId: key,
      title: completed.leaves.get(key) || m.taskLabel || key, entries: [e] })
    else if (last?.type === 'unfolded') last.entries.push(e)
    else outer.push({ type: 'unfolded', entries: [e] })
  }
  return outer.flatMap(p => p.type === 'leaf'
    ? [{ ...p, ...count(p.entries, nodes), children: phasePlan(p.entries) }]
    : phasePlan(p.entries))
}
export function foldStats(parts) {
  return parts.reduce((s, p) => {
    s.rawEntries += p.entries.length
    s.defaultEntries += p.type === 'native' ? p.entries.length : 1
    if (p.type !== 'native') { s.headers++; s.hiddenEntries += p.entries.length }
    if (p.type === 'leaf') s.leafSections++
    if (p.type === 'steps') s.stepSections++
    return s
  }, { rawEntries: 0, defaultEntries: 0, hiddenEntries: 0, headers: 0, leafSections: 0, stepSections: 0 })
}

export function completedLeafFlow(ctx, React, primitives, Base) {
  const { createElement: h, useEffect, useMemo, useRef, useState } = React
  const empty = []
  // Keep the original ChatFlow for every native row, Markdown block and tool.
  // Only the final segment owns pending-input placement and the running footer.
  function Section({ part, props, quiet }) {
    const [open, setOpen] = useState(false)
    const title = part.type === 'leaf' ? `已完成叶任务 · ${part.title}`
      : `${part.title}${part.taskLabel ? ' · ' + part.taskLabel : ''} · 已结束的内部步骤`
    const detail = `${part.steps} 步 · ${part.rows} 条${part.errors ? ` · 含 ${part.errors} 条异常记录` : ''}`
    return h('section', { 'data-completed-fold': part.type, 'data-fold-key': part.key,
      'data-fold-open': String(open), 'data-fold-count': part.entries.length,
      style: { margin: '8px 0', border: '1px solid var(--border-color, #ffffff20)', borderRadius: 8, padding: '6px 10px' } },
      h(primitives.DisclosureRow, { title: title + ' · ' + detail, open, expandable: true,
        expandOnRowClick: true, onToggle: () => setOpen(v => !v),
        children: open ? h('div', { style: { padding: '4px 0' } },
          part.type === 'leaf' ? renderParts(part.children, props, quiet, false)
            : h(Base, { ...props, ...quiet, entries: part.entries })) : undefined }))
  }
  function renderParts(parts, props, quiet, owner) {
    const children = parts.map((p, i) => p.type === 'native'
      ? h(Base, { ...props, ...(!owner || i !== parts.length - 1 ? quiet : {}), key: p.key, entries: p.entries })
      : h(Section, { key: p.key, part: p, props, quiet }))
    if (owner && parts.at(-1)?.type !== 'native') children.push(h(Base, { ...props, key: 'flow-tail', entries: empty }))
    return children
  }
  return function CompletedLeafFlow(props) {
    const sessionId = props.sessionId
    const nodes = props.useChat(s => s.nodes)
    const [status, setStatus] = useState(null)
    const previous = useRef(null)
    const hasRecordedRows = useMemo(() => props.entries.some(e => known(metaOf(e, nodes))), [props.entries, nodes])
    useEffect(() => {
      previous.current = null
      if (!hasRecordedRows || !sessionId) return
      let cancelled = false, timer; const controller = new AbortController()
      async function refresh() {
        let index = null
        try {
          const api = ctx.get('remote.transactionGraphView')
          const result = await api?.status({ sessionId }, AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]))
          if (cancelled) return
          index = result?.ok ? completedIndex(result.value, sessionId, previous.current) : null
        } catch { if (cancelled) return }
        if (index) previous.current = index
        setStatus(s => s?.sessionId === sessionId && s.index === index ? s : { sessionId, index })
        if (!cancelled) timer = setTimeout(refresh, 2500)
      }
      void refresh()
      return () => { cancelled = true; controller.abort(); clearTimeout(timer) }
    }, [sessionId, hasRecordedRows])
    const quiet = useMemo(() => ({ pendingInputs: empty,
      useSession: selector => props.useSession(s => selector({ ...s, running: false })) }), [props.useSession])
    const index = status?.sessionId === sessionId ? status.index : null
    const parts = useMemo(() => foldPlan(props.entries, nodes, index), [props.entries, nodes, index])
    if (hasRecordedRows && sessionId && status?.sessionId !== sessionId)
      return h('p', { role: 'status' }, '正在整理已完成任务的显示…')
    return h(React.Fragment, null, ...renderParts(parts, props, quiet, true))
  }
}
