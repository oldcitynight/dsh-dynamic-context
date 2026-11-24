// SPDX-License-Identifier: GPL-3.0-only
export function unitBinding(key) {
  const baseline = { conditions: ['Fixture source exists.'], objective: key + ' objective', executionCriteria: ['Inspect the input.'],
    acceptanceCriteria: ['Produce an evidenced result.'], facts: ['Source provided by the fixture.'] }
  return { task: key, baseline, instruction: 'Inspect the input and report the result.', contexts: ['shared'], inheritReports: [], tools: [], completion: { kind: 'report' } }
}
export function unitSeed() {
  return { planningReport: { understanding: 'Verify the result.', assumptions: [], design: 'Route the root.', acceptanceStrategy: 'Independent audit.' },
    taskGraph: { title: 'Verify the result', hierarchy: { version: 2, maxGroupDepth: 3 }, ruleVersion: 1,
      nodes: [{ key: 'root', label: 'Root', kind: 'leaf' }], edges: [] },
    contextGraph: { nodes: [{ key: 'shared', content: 'initial value', mutable: true, parents: [] }], bindings: [unitBinding('root')] } }
}
export function enterPlan(input, keys) {
  const scope = input.blueprint.value.scope
  const ref = { source: 'scope', sha256: input.blueprint.sha256, path: '/scope/key', quote: scope.key }
  const terminal = keys.at(-1)
  return { action: 'REVISE', terminal, nodes: keys.map(key => ({ key, parent: scope.key, label: key, kind: 'leaf' })), edges: [],
    contextGraph: { nodes: [], bindings: keys.map(unitBinding) }, modifications: ['/taskGraph/terminal',
      ...keys.flatMap(key => ['/taskGraph/nodes/' + key, '/contextGraph/bindings/' + key])].map(path => ({ path, reason: 'Implement the unit objective.', evidence: [ref] })) }
}

export function rootTask(tools = [], instruction) {
  const proposal = unitSeed()
  proposal.contextGraph.bindings[0].tools = tools
  if (instruction) proposal.contextGraph.bindings[0].instruction = instruction
  return proposal
}

export function unitReport(summary, outcome = 'PASS') {
  return { outcome, summary, artifacts: [], executionReport: {
    workHistory: ['Inspected the scoped fixture.'],
    results: [{ criterion: 'Inspect the input.', result: summary, artifactRefs: [], testIds: [] }],
    directories: [], tests: [], limitations: ['Fixture evidence only.'],
  } }
}

export function reviewRoot(payload) {
  if (!payload.response_format) return
  const prompt = payload.messages[0].content, result = value => ({ text: JSON.stringify(value) })
  if (prompt.includes('RULE_BLUEPRINT_AUDIT_V1')) return result({ verdict: 'APPROVE', reason: 'The single root is consistent.' })
  if (prompt.includes('DYNAMIC_CONTEXT_UNIT_ROUTER_V1')) return result({ action: 'EXECUTE', reason: 'The root can be executed directly.' })
  if (prompt.includes('受理当前叶') || prompt.includes('你是当前叶处置请求的验收者'))
    return result({ verdict: 'ACCEPT', reason: 'The submitted result matches the recorded evidence.', issues: [] })
  if (prompt.includes('DYNAMIC_CONTEXT_TASK_REPORTER_V1')) {
    const report = JSON.parse(payload.messages[1].content).reports[0]
    return result({ title: 'Delivery', summary: report.value.result.summary, achievements: ['Root executed.'],
      limitations: [], verification: ['Independent check recorded.'], nextSteps: [],
      evidence: [{ source: report.source, sha256: report.sha256, path: '/result/summary', quote: report.value.result.summary }] })
  }
}

/** Supply routine v2 decisions for native lifecycle tests that drive another role explicitly. */
export function unitBackend(respond, { supervise = false, plan } = {}) {
  return async request => {
    const { payload } = request, system = payload.messages[0]?.content ?? ''
    const resultOf = value => ({ text: JSON.stringify(value) })
    if (plan && payload.response_format) {
      const input = JSON.parse(payload.messages[1].content)
      if (system.includes('DYNAMIC_CONTEXT_UNIT_ROUTER_V1') && input.unit.key === 'root')
        return resultOf({ action: 'PLAN', reason: 'This fixture exercises sibling units.' })
      if (system.includes('DYNAMIC_CONTEXT_SCOPE_UPDATE_V1') && !input.blueprint.value.nodes.length) {
        if (plan.rules && !payload.messages.some(row => row.role === 'tool'))
          return { tools: [{ name: 'dynamic_context_set_rule_tree', arguments: { target: plan.keys.at(-1), expected_revision: 0, rules: plan.rules } }] }
        const proposal = enterPlan(input, plan.keys)
        for (const binding of proposal.contextGraph.bindings) Object.assign(binding, plan.bindings?.[binding.task])
        return resultOf(proposal)
      }
      if (system.includes('DYNAMIC_CONTEXT_SCOPE_AUDIT_V1')) return resultOf({ verdict: 'APPROVE', reason: 'Checked the scoped plan.', issues: [] })
      if (system.includes('DYNAMIC_CONTEXT_GROUP_FINAL_V1')) return resultOf({ action: 'PASS', summary: 'Reviewed the layer.', limitations: [],
        children: input.reports.map(row => ({ nodeId: row.value.taskId, conclusion: 'SATISFIED', reason: 'Verified the submitted report.',
          evidence: [{ source: row.source, sha256: row.sha256, path: '/result/summary', quote: row.value.result.summary }] })) })
      if (!supervise && system.includes('DYNAMIC_CONTEXT_SCOPE_PLAN_V1')) return resultOf({ verdict: 'CURRENT' })
    }
    const check = system.includes('受理当前叶') || system.includes('你是当前叶处置请求的验收者')
    if (!supervise || !check) {
      const boilerplate = reviewRoot(payload)
      if (boilerplate) return boilerplate
    }
    const result = await respond(request)
    if (!supervise && !payload.response_format && system.includes('<direct_host_facts>') && result?.text && !result.tools) {
      let parsed
      try { parsed = JSON.parse(result.text) } catch {}
      if (!parsed) return { ...result, text: JSON.stringify(unitReport(result.text)) }
    }
    return result
  }
}
