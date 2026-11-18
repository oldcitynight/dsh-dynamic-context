// SPDX-License-Identifier: GPL-3.0-only
// Generated from client.source.mjs for the native argsRaw tool interface.
// Upstream utility license: DSH-VALUES-LICENSE.txt.
window.__ModuleLoader__.load({id:"dsh-dynamic-context",factory(require){

// SPDX-License-Identifier: GPL-3.0-only
const PERFORMANCE_EVENT = 'plugin:dsh-dynamic-context/performance-v1'
const PERFORMANCE_KEY = 'dynamicContextPerformance'
const zeroUsage = () => ({ uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
const zeroStats = () => ({ turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 })
const nonnegative = value => Number.isFinite(value) && value >= 0
function normalizeUsage(value, native = false) {
  if (!value) return null
  const input = native ? value.inputTokens : value.prompt_tokens, output = native ? value.outputTokens : value.completion_tokens
  const read = native ? value.cacheReadTokens ?? 0 : value.prompt_cache_hit_tokens ?? value.prompt_tokens_details?.cached_tokens ?? 0
  const write = native ? value.cacheWriteTokens ?? 0 : value.prompt_tokens_details?.cache_write_tokens ?? 0
  const uncached = native ? input : input - read - write
  if (![uncached, output, read, write].every(nonnegative)) return null
  return { uncachedInputTokens: uncached, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: write }
}
function performanceView(samples) {
  const usage = zeroUsage(), stats = zeroStats(), groups = new Set()
  let latest, missingUsage = 0, requests = 0, running = 0
  for (const sample of Object.values(samples)) {
    if (sample.kind === 'tool') { stats.toolMs += sample.toolMs ?? 0; continue }
    if (sample.kind === 'aggregate') {
      for (const key of Object.keys(usage)) usage[key] += sample.usage?.[key] ?? 0
      for (const key of Object.keys(stats)) stats[key] += sample.stats?.[key] ?? 0
      requests += sample.requests ?? 0; missingUsage += sample.missingUsage ?? 0
      continue
    }
    if (!latest || sample.startedAt > latest.startedAt || sample.startedAt === latest.startedAt && sample.order > latest.order) latest = sample
    if (sample.kind === 'native-anchor') continue
    requests++; if (sample.state === 'running') running++
    if (sample.usage) for (const key of Object.keys(usage)) usage[key] += sample.usage[key]
    else if (sample.state !== 'running') missingUsage++
    if (sample.state === 'running') continue
    stats.steps++; if (sample.countsTurn !== false) groups.add(sample.group)
    if (nonnegative(sample.endedAt) && nonnegative(sample.startedAt)) {
      stats.llmMs += Math.max(0, sample.endedAt - sample.startedAt)
      if (nonnegative(sample.firstTokenAt) && sample.firstTokenAt >= sample.startedAt) {
        stats.ttftMs += sample.firstTokenAt - sample.startedAt; stats.ttftSteps++
        if (sample.usage && sample.endedAt > sample.firstTokenAt) {
          stats.decodeMs += sample.endedAt - sample.firstTokenAt; stats.decodeTokens += sample.usage.outputTokens
        }
      }
    }
  }
  stats.turns += groups.size
  const input = latest?.usage ? latest.usage.uncachedInputTokens + latest.usage.cacheReadTokens + latest.usage.cacheWriteTokens : latest?.inputTokens
  return { usage, stats, requests, running, missingUsage, current: latest ? {
    native: latest.kind === 'native-anchor', source: latest.source, startedAt: latest.startedAt,
    pressure: { ...(nonnegative(input) ? { pressureTokens: input, projectedTokens: input } : {}),
      ...(latest.contextWindow > 0 ? { contextWindow: latest.contextWindow } : {}) },
    ...(latest.breakdown ? { breakdown: latest.breakdown } : {}),
  } : null }
}
function performanceProjection(key, native, extra) {
  if (!extra) return native
  if (key === 'sessionStats' || key === 'tokenUsage') {
    const added = key === 'sessionStats' ? extra.stats : extra.usage
    return Object.fromEntries(Object.entries(added).map(([field, value]) => [field, (native?.[field] ?? 0) + value]))
  }
  if (extra.current && !extra.current.native) {
    if (key === 'contextPressure') return extra.current.pressure
    if (key === 'contextBreakdown') return extra.current.breakdown
  }
  return native
}

// SPDX-License-Identifier: GPL-3.0-only

function structuredLabel(text) {
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
function structuredParts(text) {
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
function installNativePresentation(ctx, React, primitives) {
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
  scope_plan: '本层计划复查', scope_update: '本层蓝图更新', scope_audit: '修改审计',
  scope_blockage: '分层阻塞处理', scope_pause: '中断审核', task_reporter: '任务报告',
  guidance_intake: '用户引导识别', guidance_router: '用户引导分派',
  progress_reporter: '阶段执行报告',
}
const leafStages = new Set(['EXECUTING', 'result_check', 'result_repair', 'result_work', 'compaction'])
function foldMetadata(workflowId, row) {
  return { workflowId, taskId: row.taskId, taskLabel: row.taskLabel,
    sessionId: row.sessionId, step: row.step, stage: row.stage, kind: row.kind, state: row.state }
}
function completedIndex(value, sessionId, previous) {
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
function foldPlan(entries, nodes, completed, { steps = true } = {}) {
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
function foldStats(parts) {
  return parts.reduce((s, p) => {
    s.rawEntries += p.entries.length
    s.defaultEntries += p.type === 'native' ? p.entries.length : 1
    if (p.type !== 'native') { s.headers++; s.hiddenEntries += p.entries.length }
    if (p.type === 'leaf') s.leafSections++
    if (p.type === 'steps') s.stepSections++
    return s
  }, { rawEntries: 0, defaultEntries: 0, hiddenEntries: 0, headers: 0, leafSections: 0, stepSections: 0 })
}

function completedLeafFlow(ctx, React, primitives, Base) {
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

// SPDX-License-Identifier: GPL-3.0-only
const preferenceFields = [
  { key: 'permissionMode', label: '执行权限', hint: '继承主会话；选定的上限不会扩大主会话授权。', choices: [['configured', '按配置'], ['auto', '继承'], ['read-only', '只读'], ['workspace-write', '工作区'], ['danger-full-access', '完整访问']] },
  { key: 'approvalPolicy', label: '工具批准', hint: '主会话的批准策略始终生效。', choices: [['configured', '按配置'], ['auto', '继承'], ['ask', '可询问'], ['never', '不询问']] },
  { key: 'reasoningEffort', label: '推理强度', hint: '自动继承主会话；明确强度仅适用于 DeepSeek 接口。', choices: [['configured', '按配置'], ['auto', '继承'], ['off', '关闭'], ['low', '低'], ['high', '高'], ['max', '最高']] },
  { key: 'maxGroupDepth', label: '组嵌套层数', hint: '0 沿用配置文件；1–16 层，包含根层，不含叶任务。', min: 0, max: 16 },
  { key: 'contextWindow', label: '上下文窗口（token）', hint: '0 沿用配置文件；131072–1048576。同步原生压缩阈值，不改变模型实际容量。', min: 131072, max: 1048576, zero: true },
  { key: 'maxRequestsPerTask', label: '每角色额外请求次数上限', min: 1, max: 256, limit: true },
  { key: 'timeoutMs', label: '每角色额外超时（毫秒）', min: 10, max: 1800000, limit: true },
  { key: 'maxContextCharacters', label: '请求上下文字符上限', min: 1, max: 8388608, limit: true },
  { key: 'maxReportCharacters', label: '报告字符上限', min: 1, max: 8388608, limit: true },
  { key: 'maxToolOutputCharacters', label: '工具输出字符上限', min: 256, max: 8388608, limit: true },
]
// Reuse the native staged form and conflict detection over one nested section.
function preferenceScope(scope) {
  return { subscribe: listener => scope.subscribe(listener),
    getSnapshot() { const snapshot = scope.getSnapshot(); return { ...snapshot,
      value: snapshot.value?.preferences, base: snapshot.base?.preferences, user: snapshot.user?.preferences } },
    mutate: (ops, revision) => scope.mutate(ops.map(op => ({ ...op, path: ['preferences', ...op.path] })), revision) }
}
function installPreferenceSettings(ctx, React, primitives) {
  const { SettingsForm, SettingsFormModel, SettingsValueField, SegmentedControl, Button, settingsNumberField, settingsTextField } = primitives
  if (!ctx.inject || !SettingsFormModel) return
  ctx.inject(['configForms', 'locale'], scoped => {
    const ns = 'dsh-dynamic-context', locale = 'settings.dynamicContext', h = React.createElement
    const description = '仅影响之后新启用的完整任务图；已有任务保留其设置。主会话权限修改会实时生效。'
    scoped.effect(() => scoped.locale.register(locale, { zh: { title: '动态上下文', description }, en: { title: 'Dynamic context', description } }))
    const specs = preferenceFields.map(field => {
      const original = field.choices ? settingsTextField(field.key) : settingsNumberField(field.key)
      return { ...original, parse(text) {
        const value = original.parse(text)
        if (value?.kind !== 'set') return value
        if (field.choices) return field.choices.some(([key]) => key === value.value) ? value : undefined
        const n = value.value
        return Number.isInteger(n) && (field.limit && [-1, 0].includes(n) || field.zero && n === 0 || n >= field.min && n <= field.max) ? value : undefined
      } }
    })
    const form = new SettingsFormModel(preferenceScope(scoped.configForms.get(ns)), specs)
    const store = form.bind(() => ({ ...form.shell(), fields: Object.fromEntries(preferenceFields.map(field => [field.key, form.field(field.key)])) }))
    scoped.effect(() => () => form.dispose())
    function Card(props) {
      const state = props.useDynamicContextSettings(snapshot => snapshot)
      if (props.view === 'summary') return description
      return h(SettingsForm, { state, labels: { unavailable: '插件尚未加载。', readOnly: '当前部署不允许修改设置。', saveFailed: '保存未通过，请检查字段或重新加载最新设置。', save: '保存', saving: '保存中…' },
        onSave: props.save, onDiscard: props.discard },
      ...preferenceFields.map(field => {
        const value = state.fields[field.key], id = 'dynamic-context-setting-' + field.key
        if (field.choices) return h('div', { key: field.key, style: { marginBottom: 20 } },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 } },
            h('span', null, field.label), value.overridden ? h(Button, { size: 'small', variant: 'ghost', disabled: !state.writable, onClick: () => props.resetField(field.key) }, '恢复默认') : null),
          h(SegmentedControl, { id, value: value.text, label: field.label, disabled: !state.writable,
            options: field.choices.map(([value, label]) => ({ value, label })), onChange: text => props.edit(field.key, text) }),
          h('p', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, field.hint))
        return h(SettingsValueField, { key: field.key, id, ...value, label: field.label,
          hint: field.hint ?? '-1 沿用配置文件，0 不额外限制；原生单次请求控制仍然有效。', numeric: true,
          overriddenLabel: '已覆盖', resetLabel: '恢复默认', invalidLabel: '请输入说明范围内的整数。', disabled: !state.writable,
          onEdit: text => props.edit(field.key, text), onReset: () => props.resetField(field.key) })
      }))
    }
    scoped.effect(() => scoped.configForms.whileServed([ns], () => scoped.slots.inject('plugins.item', () => scoped.slots.register({
      name: 'plugins.item', id: ns, order: 55, label: () => scoped.locale.bind(locale)('title'), locale,
      inject: () => ({ hooks: { dynamicContextSettings: store }, ...form.actions() }),
    }, Card))))
  })
}

// SPDX-License-Identifier: GPL-3.0-only
// Project log-only observations into existing DSH Chat node kinds. Native Chat
// owns Markdown, reasoning disclosures, tool cards, terminal output and settings.
const DISPLAY_EVENT = 'plugin:dsh-dynamic-context/execution-display-v1'
const stages = { PREPLANNING: '预规划', EXECUTING: '叶执行', result_check: '结果验收', result_repair: '报告补正', result_work: '成果返工',
  plan_check: '计划复查', updater: '图更新', reviewer: '修改审计', compaction: '上下文压缩',
  blockage: '阻塞处理', blockage_audit: '中断审核', group_audit: '组级终审', scope_plan: '本层计划复查', scope_update: '本层蓝图更新',
  scope_audit: '修改审计', scope_blockage: '分层阻塞处理', scope_pause: '中断审核', task_reporter: '任务报告', progress_reporter: '阶段执行报告', guidance_intake: '用户引导识别', guidance_router: '用户引导分派' }
const escapeMarkdown = text => String(text).replace(/[\\`*_{}\[\]()#+.!<>]/g, '\\$&')
function executionChatDefinition() {
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
          time: Date.parse(row.at), subCalls: [] }
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
function createExecutionClient(React, primitives) {
  const chat = executionChatDefinition()
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
    if (React && primitives) installNativePresentation(ctx, React, primitives)
    if (React && primitives) installPreferenceSettings(ctx, React, primitives)
  } }
}

return createExecutionClient(require("react"), require("@deepseek-ai/dsh-client-ui-primitives"));
}});
