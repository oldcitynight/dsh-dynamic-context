// SPDX-License-Identifier: GPL-3.0-only
import { randomUUID } from 'node:crypto'
import { canonical, digest, GraphError, normalizePlan } from 'dsh-better-task-grapth/core'
import { diagnostic, parseModelJSON } from 'dsh-better-task-grapth/validation'
import { terminalRuleIssue } from 'dsh-better-task-grapth/hierarchy'
import { FileGraphStore } from 'dsh-better-task-grapth/store'
import {
  expression,
  validateRows,
  inspectRules,
  atoms,
  describe,
  graphWitnesses,
  ruleError
} from 'dsh-better-task-grapth/rules'

const filename = 'planning-rules.json'
const key = /^[a-z][a-z0-9_-]{0,79}$/
const absent = () => ({ revision: 0, targets: [] })
const blank = (target) => ({ target, revision: 0, status: 'editing', rows: [] })
const fail = (code, reason, extra) => ruleError(code, '/rules', reason, extra)
function checkDocument(d) {
  const { checksum, ...body } = d
  if (checksum !== digest(body) || !Number.isSafeInteger(d.revision) || !Array.isArray(d.targets))
    fail('RULE_DRAFT_CORRUPT', 'Rule draft identity or contents changed.')
}

// One versioned document per workflow. The file backend uses its existing locked
// atomic replacement; SQLite binds the generation check and content write in one transaction.
export class RuleDrafts {
  constructor(runner, layer) {
    this.runner = runner
    this.layer = layer
    this.filename = layer ? 'unit-rules-' + digest(layer).slice(0, 48) + '.json' : filename
    this.db = runner.storage?.db
    if (!this.db)
      this.files = new FileGraphStore({
        projectRoot: runner.config.storageRoot ?? runner.config.projectRoot,
        directory: runner.config.directory,
        fileName: this.filename,
        validator: checkDocument,
        updateValidator: (old, next) => {
          if (next.revision !== (old?.revision ?? 0) + 1) fail('RULE_DRAFT_STALE', 'Read the current rule draft.')
        }
      })
  }
  read() {
    if (!this.db) return this.files.read() ?? absent()
    const info = this.db.info(this.filename)
    if (!info) return absent()
    const d = JSON.parse(this.db.range(info))
    checkDocument(d)
    return d
  }
  update(fn) {
    const run = () => {
      const old = this.read(),
        d = structuredClone(old),
        result = fn(d)
      delete d.checksum
      const { checksum, ...previous } = old
      if (canonical(d) === canonical(previous)) return result
      d.revision++
      d.checksum = digest(d)
      const beforeWrite = () => {
        const state = this.runner.graph.read()
        const flow = state?.supervision?.hierarchy
        if (this.layer ? state?.revision !== this.layer.revision || flow?.scopeId !== this.layer.scopeId || flow?.stage !== 'UPDATE'
          || this.layer.runId && flow.ruleDraftRunId !== this.layer.runId : Boolean(state))
          fail('RULE_GRAPH_ALREADY_COMMITTED', 'The workflow was committed before this draft write.')
        return d
      }
      if (this.db) this.db.put(this.filename, JSON.stringify(beforeWrite()))
      else this.files.compareAndSwap(old.revision, beforeWrite)
      return result
    }
    return this.db ? this.db.transaction(run) : run()
  }
  edit(tool, args, callId) {
    if (tool === 'read_rules') return this.editIn(this.read(), tool, args, callId)
    return this.update(doc => this.editIn(doc, tool, args, callId))
  }
  editIn(doc, tool, args, callId) {
    if (typeof args.target !== 'string' || !key.test(args.target)) fail('RULE_TARGET', 'Supply a stable node key.')
    if (tool === 'read_rules')
      return output(
        doc.targets.find((t) => t.target === args.target) ?? blank(args.target),
        args.format ?? 'both'
      )
    const index = doc.targets.findIndex(t => t.target === args.target)
    // A rejected operation can still be recorded without retaining tentative edits.
    const target = index === -1 ? blank(args.target) : structuredClone(doc.targets[index])
    const hash = callId && digest({ tool, args })
    if (callId && target.last?.id === callId) {
      if (target.last.hash !== hash) fail('RULE_CALL_CHANGED', 'The same call ID has different arguments.')
      return target.last.result
    }
    if (args.expected_revision !== target.revision)
      fail('RULE_DRAFT_STALE', 'Use the current node draft revision.', { current: target.revision })
    const result = editTarget(target, tool, args, doc, this.runner.graph?.workflowLimits ?? this.runner.config.workflowLimits)
    if (index < 0) doc.targets.push(target)
    else doc.targets[index] = target
    delete doc.approval
    delete doc.audit
    if (callId) target.last = { id: callId, hash, result }
    return result
  }
  executeLayer(call, ordinal, execute) {
    const key = digest(ordinal ?? call.id), requestHash = digest(call)
    return this.update(doc => {
      const receipt = doc.receipts?.[key]
      if (receipt) {
        if (receipt.requestHash !== requestHash) fail('RULE_CALL_CHANGED', 'The recorded layer-tool call has different arguments or identity.')
        return receipt.result
      }
      const result = execute(doc)
      doc.receipts ??= {}
      doc.receipts[key] = { requestHash, result }
      return result
    })
  }
  bind(proposal) {
    const doc = this.read()
    if (!doc.targets.length && !proposal.taskGraph?.ruleVersion) return proposal
    const graph = structuredClone(proposal.taskGraph)
    if (!graph?.hierarchy || !proposal.contextGraph)
      fail('RULE_JOINT_PLAN_REQUIRED', 'Submit both graphs and the hierarchy.')
    graph.ruleVersion = 1
    for (const target of doc.targets) {
      const node = graph.nodes.find((n) => n.key === target.target)
      if (!node && target.status === 'confirmed' && !target.rows.length) continue
      if (!node || target.status !== 'confirmed')
        fail('RULE_DRAFT_NOT_CONFIRMED', 'Confirm or remove the outstanding target.', { target: target.target })
      if (node.rules && canonical(node.rules) !== canonical(target.rows))
        fail('RULE_SUBMISSION_CHANGED', 'Inline rules differ from the confirmed draft.', { target: target.target })
      node.rules = structuredClone(target.rows)
    }
    normalizePlan(graph, { workflowLimits: this.runner.graph?.workflowLimits ?? this.runner.config.workflowLimits })
    for (const node of graph.nodes)
      if (node.rules?.length && !doc.targets.some((t) => t.target === node.key))
        fail('RULE_CONFIRMATION_REQUIRED', 'Register and confirm the node through its rule editor.', {
          target: node.key
        })
    return { ...proposal, taskGraph: graph }
  }
}
function named(parts, root) {
  if (!parts || typeof parts !== 'object' || Array.isArray(parts)) fail('RULE_PARTS', 'Provide named expressions.')
  const using = new Set(),
    used = new Set()
  const expand = (e) => {
    if (typeof e === 'string') {
      if (!Object.hasOwn(parts, e) || using.has(e))
        fail('RULE_PART_REFERENCE', 'Unknown or circular named part.', { part: e })
      using.add(e)
      used.add(e)
      const value = expand(parts[e])
      using.delete(e)
      return value
    }
    if (e && Object.keys(e).length === 1 && Object.hasOwn(e, 'not')) return { not: expand(e.not) }
    if (e && Object.keys(e).length === 1 && (Array.isArray(e.all) || Array.isArray(e.any))) {
      const k = e.all ? 'all' : 'any'
      return { [k]: e[k].map(expand) }
    }
    return e
  }
  const value = expand(root)
  if (used.size !== Object.keys(parts).length) fail('RULE_UNUSED_PART', 'Some named parts do not feed the root.')
  return expression(value)
}
function holes(expr) {
  if (expr.hole) return [expr.hole]
  if (expr.node) return []
  if (expr.not) return holes(expr.not)
  return (expr.all ?? expr.any).flatMap(holes)
}
function fill(expr, slot, replacement) {
  if (expr.hole === slot) return replacement
  if (expr.node || expr.hole) return expr
  if (expr.not) return { not: fill(expr.not, slot, replacement) }
  const k = expr.all ? 'all' : 'any'
  return { [k]: expr[k].map((child) => fill(child, slot, replacement)) }
}
function output(t, format = 'both') {
  const rows = t.pending?.rows ?? t.rows
  return {
    target: t.target,
    revision: t.revision,
    status: t.status,
    ...(format === 'mnemonic' ? {} : { rules: structuredClone(rows) }),
    ...(format === 'expression'
      ? {}
      : { mnemonic: rows.length ? rows.map((r) => r.id + '：' + describe(r.when)).join('；或 ') : '没有附加前序条件' }),
    holes: rows.flatMap((r) => holes(r.when).map((slot) => ({ rule: r.id, slot }))),
    ...(t.pending
      ? {
          confirmation: t.pending.token,
          warnings: t.pending.warnings,
          mergePreview: t.pending.merged,
          mergeMnemonic: t.pending.merged.map((r) => r.id + '：' + describe(r.when)).join('；或 ')
        }
      : {}),
    ...(t.witness ? { witness: t.witness, preflight: t.preflight } : {})
  }
}
function precheck(target, rows, doc, layout, workflowLimits) {
  const insight = inspectRules(rows)
  if (!layout) return { witness: insight.witness, preflight: 'local; full topology checked at joint submission' }
  const taskGraph = structuredClone(layout)
  for (const n of taskGraph.nodes) {
    const saved = doc.targets.find((t) => t.target === n.key)
    if (n.key === target) n.rules = rows
    else if (saved) n.rules = saved.rows
  }
  if (!taskGraph.nodes.some((n) => n.key === target)) fail('RULE_UNKNOWN_TARGET', 'Layout does not contain the target.')
  const plan = normalizePlan({ ...taskGraph, ruleVersion: 1 }, { workflowLimits })
  return { witness: graphWitnesses(plan)[target], preflight: 'graph' }
}
function editTarget(t, tool, a, doc, workflowLimits) {
  if (tool === 'manage_rules' && a.action === 'reopen') {
    if (t.pending) t.rows = t.pending.rows
    delete t.pending
    delete t.witness
    t.status = 'editing'
    t.revision++
    return output(t)
  }
  if (t.status === 'confirmed') fail('RULE_REOPEN_REQUIRED', 'Reopen this node before editing.')
  if (t.pending && !(tool === 'manage_rules' && ['keep', 'merge', 'cancel'].includes(a.action)))
    fail('RULE_CONFIRM_WARNING', 'Resolve or reopen the staged candidate.')
  let rows = structuredClone(t.rows),
    confirm = false,
    accepted = false,
    layout = a.layout
  if (tool === 'manage_rules') {
    if (a.action === 'confirm') confirm = true
    else if (['keep', 'merge', 'cancel'].includes(a.action)) {
      if (!t.pending || a.confirmation !== t.pending.token)
        fail('RULE_CONFIRMATION_STALE', 'Use the current warning receipt.')
      if (a.action !== 'cancel') {
        rows = a.action === 'merge' ? t.pending.merged : t.pending.rows
        confirm = t.pending.confirm
        accepted = true
        layout ??= t.pending.layout
      }
      delete t.pending
    } else fail('RULE_ACTION', 'Choose confirm, reopen, keep, merge or cancel.')
  } else if (tool === 'set_rule_tree') {
    rows = validateRows(a.rules)
    confirm = true
  } else {
    if (typeof a.id !== 'string' || !key.test(a.id)) fail('RULE_ID', 'Supply a stable rule ID.')
    const i = rows.findIndex((r) => r.id === a.id)
    if (a.action === 'delete') {
      if (i < 0) fail('RULE_ID', 'No such rule.')
      rows.splice(i, 1)
    } else {
      let value =
        tool === 'set_named_rule' ? named(a.parts, a.root) : expression(a.when, { holes: tool === 'edit_rule_part' })
      if (a.slot) {
        if (tool !== 'edit_rule_part' || i < 0 || !holes(rows[i].when).includes(a.slot))
          fail('RULE_SLOT', 'Select an open slot by ID.')
        value = fill(rows[i].when, a.slot, value)
      }
      const row = { id: a.id, when: value }
      if (i < 0) rows.push(row)
      else rows[i] = row
    }
  }
  rows = validateRows(rows, { holes: !confirm })
  if (layout && (!Array.isArray(layout.nodes) || layout.nodes.some(node => !node || typeof node.key !== 'string')))
    fail('RULE_LAYOUT_INVALID', 'Omit layout to check locally, or supply a complete taskGraph with nodes containing stable key fields.')
  if (layout) {
    const target = layout.nodes.find(node => node.key === t.target)
    const scope = target && layout.nodes.find(node => node.key === target.parent)
    if (scope) {
      const issue = terminalRuleIssue(scope.key, scope.terminal, t.target, rows)
      if (issue) throw new GraphError(issue.code, issue)
    }
  }
  const incomplete = rows.some((r) => holes(r.when).length)
  const { warnings, merged } = incomplete ? { warnings: [], merged: rows } : inspectRules(rows)
  const check = confirm ? precheck(t.target, rows, doc, layout, workflowLimits) : null
  t.revision++
  if (warnings.length && !accepted && t.ack !== digest(rows) && a.action !== 'cancel') {
    t.pending = {
      rows,
      merged,
      warnings,
      confirm,
      ...(layout ? { layout } : {}),
      token: digest({ target: t.target, revision: t.revision, rows })
    }
    t.status = 'needs_confirmation'
  } else {
    t.rows = rows
    t.status = confirm ? 'confirmed' : 'editing'
    if (accepted) t.ack = digest(rows)
    if (check) Object.assign(t, check)
  }
  return output(t)
}

export function ruleSummary(plan) {
  if (!plan.ruleVersion) return {}
  const labels = Object.fromEntries(plan.nodes.map((node) => [node.key, node.label]))
  return {
    ruleSummary: plan.nodes.map((node) => ({
      target: node.key,
      mnemonic: node.rules?.length
        ? node.rules.map((row) => row.id + '：' + describe(row.when, labels)).join('；或 ')
        : '没有附加前序条件'
    }))
  }
}

export const ruleTools = {
  dynamic_context_set_rule_tree: 'set_rule_tree',
  dynamic_context_set_rule: 'set_rule',
  dynamic_context_set_named_rule: 'set_named_rule',
  dynamic_context_edit_rule_part: 'edit_rule_part',
  dynamic_context_read_rules: 'read_rules',
  dynamic_context_manage_rules: 'manage_rules'
}
export const RULE_GUIDE =
  '新建分层工作流使用 taskGraph.ruleVersion=1 和 edges:[]。每个节点的入口规则最外层为 OR。all 为与、any 为或、not 为一元非，三者可嵌套。写作 {"not":{"node":"check","in":["PASS"]}}，前序未结算时取反仍等待。叶和组均可引用同层普通单元的 PASS/FAILED/BLOCK。直属终点可以有前序，禁止在同层规则的任何位置引用终点。无规则没有额外等待。Agent 只提交 PASS/FAILED，BLOCK 由程序推导。逐字映射触发条件：实测失败只写 in:["FAILED"]；用户明确允许失败或路线受阻才写 in:["FAILED","BLOCK"]；三态均允许表示须等前序结算。提交前用未结、PASS、FAILED、BLOCK 各代入一次，检查不会额外放行。能把握整节点用 set_rule_tree，一条明确入口用 set_rule，嵌套易混用 set_named_rule，尚有空位用 edit_rule_part。工具名均以 dynamic_context_ 开头。read_rules 可随时读其他目标的规则或中文助记。单条或分片写完用 manage_rules confirm。需要警告确认时按回执选择 keep/merge，重开用 reopen。首次写 expected_revision:0，以后使用目标自己的回执 revision。整树写入返回 confirmed 就已确认；只有 editing 状态才需要 confirm。一般调用省略 layout，由联合提交校验拓扑。可选 layout 必须是完整 taskGraph，nodes 为节点对象数组，每项至少含 key、kind、label；只知道同层名称时省略。整图独立审计批准后才可执行。'
  + '\n工具返回 confirmed 后，按本角色当前的报告模板结束或继续交付蓝图。结束时优先调用 dynamic_context_generate_report 提交模板要求的对象。直接返回 JSON 时，整条回复仅含该对象。助记、真值试算和工具回执留在工作记录中。'
export const RULE_HIERARCHY_GUIDE =
  '每个 container 用 terminal 指定一个直属终点，用 acceptance 写明该组的目标与验收依据。maxGroupDepth=3 只计算容器。parent 表示包含。规则只引用同层节点的 key，跨层依赖引用公开的组，在 inheritReports 中列出需要的前序报告。组入口满足后才派发其叶任务。每层的直属终点优先级最低，同层其他叶或组还有可执行工作时先选它们，只剩终点可执行时才派发终点叶或进入终点组。终点没有同层后继，后续工作可在父层引用本组的审计结果。终点可达并且直属子项都已结算时，独立终审提交组 PASS 或 FAILED。终点路线关闭可令整组 BLOCK。任务图需和 contextGraph、planningReport 一起提交。'
const demo = { node: 'check', in: ['FAILED', 'BLOCK'] }
export function registerRuleTools(register, runner, layerDrafts) {
  const obj = { type: 'object', additionalProperties: true },
    str = { type: 'string' },
    num = { type: 'integer' }
  for (const [name, tool] of Object.entries(ruleTools)) {
    const props = { target: { ...str, required: true } }
    if (tool !== 'read_rules') props.expected_revision = { ...num, required: true }
    let example
    if (tool === 'set_rule_tree') {
      Object.assign(props, { rules: { type: 'array', items: obj, required: true }, layout: obj })
      example = { rules: [{ id: 'fallback', when: demo }] }
    }
    if (tool === 'set_rule' || tool === 'edit_rule_part' || tool === 'set_named_rule') {
      Object.assign(props, { id: { ...str, required: true }, action: { ...str, enum: ['put', 'delete'] }, layout: obj })
      if (tool === 'set_named_rule') {
        Object.assign(props, { parts: obj, root: obj })
        example = { id: 'r1', parts: { source: demo }, root: { all: ['source'] } }
      } else {
        props.when = obj
        example = { id: 'r1', when: demo }
      }
      if (tool === 'edit_rule_part') {
        props.slot = str
        example = { id: 'r1', when: { all: [demo, { hole: 'second' }] } }
      }
    }
    if (tool === 'manage_rules') {
      Object.assign(props, {
        action: { ...str, required: true, enum: ['confirm', 'reopen', 'keep', 'merge', 'cancel'] },
        confirmation: str,
        layout: obj
      })
      example = { action: 'confirm' }
    }
    if (tool === 'read_rules') {
      props.format = { ...str, enum: ['expression', 'mnemonic', 'both'] }
      example = { format: 'mnemonic' }
    }
    const guide = {
      set_rule_tree: '一次提交整个目标的所有入口，局部预检及冲突检查后确认。rules:[] 表示无附加条件。',
      set_rule: '按 id 新增或替换一条 all/any/not 或结果集合的标准 JSON 规则，action:delete 删除。',
      set_named_rule: '按名称定义 parts，由 root 的 all/any/not 组合引用，提交一条完整规则。',
      edit_rule_part: '分片写一条规则，留 {hole:"slot"}。填入时同时给 slot 和 when；省略 slot 可替换整个表达式。',
      read_rules: '只读任意目标当前规则，包含草稿、待填位置、中文助记及确认状态。',
      manage_rules:
        'confirm 确认或 reopen 重开节点；警告回执需 confirmation，keep 保留，merge 等价合并，cancel 撤回。可带 layout 做图级预检。'
    }[tool]
    const sample = { target: 'repair', ...(tool === 'read_rules' ? {} : { expected_revision: 0 }), ...example }
    register(
      name,
      guide + (tool === 'read_rules' ? '' : ' 通常省略 layout。仅有完整 taskGraph 才传 layout，nodes 必须是节点对象数组。同层规则禁止引用终点。整树工具返回 confirmed 即完成。') + '\nExample\n```json\n' + JSON.stringify(sample) + '\n```',
      props,
      (args, exec) => {
        if (tool !== 'read_rules') runner.admitWorkflowRelease()
        const state = runner.graph.read()
        if (layerDrafts) {
          const existing = state.graph.state.plan.nodes.find(node => node.key === args.target)
          if (existing && existing.parent !== layerDrafts.layer.scopeId) fail('RULE_TARGET_OUTSIDE_LAYER', 'Select a direct child of the current unit.')
          const doc = exec.draft ?? layerDrafts.read()
          if (tool === 'read_rules' && existing && !doc.targets.some(row => row.target === existing.key))
            return output({ target: existing.key, revision: 0, status: 'committed', rows: existing.rules ?? [] }, args.format)
          if (exec.draft) return layerDrafts.editIn(doc, tool, args)
          return layerDrafts.edit(tool, args, exec.callId)
        }
        if (state) {
          if (tool !== 'read_rules')
            fail('RULE_GRAPH_ALREADY_COMMITTED', 'Use reviewed graph revision for a committed workflow.')
          const node = state.graph.state.plan.nodes.find((n) => n.key === args.target)
          if (!node) fail('RULE_UNKNOWN_TARGET', 'The committed plan has no node with this key.')
          if (!state.graph.state.plan.ruleVersion)
            fail('RULE_VERSION_REQUIRED', 'This plan uses historical edge routing.')
          return output(
            { target: args.target, revision: state.revision, status: 'committed', rows: node.rules ?? [] },
            args.format
          )
        }
        return draftsFor(runner).edit(tool, args, exec.callId)
      },
      true
    )
  }
}
const editableErrors = new Set([
  'RULE_ACTION', 'RULE_CONFIRMATION_STALE', 'RULE_CONFIRM_WARNING', 'RULE_CONTRADICTION', 'RULE_CYCLE',
  'RULE_DRAFT_STALE', 'RULE_DUPLICATE_HOLE', 'RULE_EXPRESSION', 'RULE_ID', 'RULE_LAYOUT_INVALID', 'RULE_LIST',
  'RULE_NODE_UNREACHABLE', 'RULE_OUTCOME_SET', 'RULE_PARTS', 'RULE_PART_REFERENCE', 'RULE_PREFLIGHT_UNRESOLVED',
  'RULE_REOPEN_REQUIRED', 'RULE_ROUTE_UNREACHABLE', 'RULE_SLOT', 'RULE_TARGET', 'RULE_TARGET_OUTSIDE_LAYER',
  'RULE_UNKNOWN_TARGET', 'RULE_UNUSED_PART', 'TERMINAL_AS_PREDECESSOR',
])
function scopeDrafts(runner, state, scopeId) {
  const runId = state.supervision?.hierarchy?.ruleDraftRunId
  return new RuleDrafts(runner, { scopeId, revision: state.revision, ...(runId ? { runId } : {}) })
}
export function layerRuleTools(runner, state, scopeId) {
  const drafts = scopeDrafts(runner, state, scopeId), definitions = new Map(), tools = []
  registerRuleTools((name, description, props, execute) => {
    const required = Object.keys(props).filter(key => props[key].required)
    const properties = Object.fromEntries(Object.entries(props).map(([key, { required, ...spec }]) => [key, spec]))
    tools.push({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } })
    definitions.set(name, execute)
  }, runner, drafts)
  return { tools, execute(call, ordinal) {
    const execute = draft => {
      try {
        const args = parseModelJSON(call.function.arguments, { path: '/tool_calls/function/arguments' }).value
        if (!args || typeof args !== 'object' || Array.isArray(args)) fail('RULE_ARGUMENTS', 'Supply an object with the rule tool arguments.')
        return definitions.get(call.function.name)(args, { callId: call.id, draft })
      } catch (error) {
        if (!editableErrors.has(error.code) && error.code !== 'RULE_ARGUMENTS' && !error.code?.startsWith('MODEL_JSON_')) throw error
        return { error: error.code, diagnostic: diagnostic(error, { tool: call.function.name }) }
      }
    }
    return drafts.layer.runId ? drafts.executeLayer(call, ordinal, execute) : execute()
  } }
}
export function bindLayerRules(runner, state, scopeId, proposal) {
  const { targets } = scopeDrafts(runner, state, scopeId).read()
  for (const target of targets) {
    const node = proposal.nodes.find(node => node.key === target.target)
    if (!node && target.status === 'confirmed' && !target.rows.length) continue
    if (!node || target.status !== 'confirmed') fail('RULE_DRAFT_NOT_CONFIRMED', 'Confirm or clear every edited rule.', { target: target.target })
    if (node.rules && canonical(node.rules) !== canonical(target.rows)) fail('RULE_SUBMISSION_CHANGED', 'The proposal differs from the confirmed draft.')
    node.rules = structuredClone(target.rows)
  }
  for (const node of proposal.nodes) {
    const previous = state.graph.state.plan.nodes.find(row => row.key === node.key)
    if (node.rules !== undefined && canonical(node.rules) !== canonical(previous?.rules ?? []) && !targets.some(t => t.target === node.key))
      fail('RULE_CONFIRMATION_REQUIRED', 'Confirm changed rules with the layer editor.', { target: node.key })
  }
  return proposal
}
export function draftsFor(runner) {
  return (runner.ruleDrafts ??= new RuleDrafts(runner))
}
export function auditRunId() {
  return 'revision_reviewer_' + randomUUID()
}
