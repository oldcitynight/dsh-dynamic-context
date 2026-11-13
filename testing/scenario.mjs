export function proposal() {
  return { taskGraph: { title: 'Dynamic context serial prototype', nodes: [
    { key: 'root', kind: 'container', label: 'Synthetic workflow' },
    ...['a', 'b', 'c'].map(task => ({ key: task, kind: 'leaf', label: `Task ${task.toUpperCase()}`, parent: 'root' })),
  ], edges: [{ kind: 'prerequisite', from: 'a', to: 'b' }, { kind: 'prerequisite', from: 'b', to: 'c' }] },
  contextGraph: { nodes: [
    { key: 'common', content: 'COMMON_CONTEXT_LITERAL_{{unchanged}}', parents: [] },
    { key: 'a_private', content: 'A_CONTEXT_PRIVATE_ONLY_A', parents: ['common'] },
    { key: 'b_private', content: 'B_CONTEXT_PRIVATE_ONLY_B', parents: ['common'] },
    { key: 'c_private', content: 'C_CONTEXT_PRIVATE_ONLY_C', parents: [] },
    { key: 'unused', content: 'UNUSED_CONTEXT_MUST_NOT_LEAK', parents: [] },
  ], bindings: [
    { task: 'a', instruction: 'Read fixture A and return a report.', contexts: ['common', 'a_private'], inheritReports: [], tools: ['fixture_read_a'] },
    { task: 'b', instruction: 'Use the declared A report, read fixture B, and return a report.', contexts: ['b_private'], inheritReports: ['a'], tools: ['fixture_read_b'] },
    { task: 'c', instruction: 'Return a report using only C context.', contexts: ['c_private'], inheritReports: [], tools: [] },
  ] } }
}

export function scenarioResponse({ payload }) {
  const all = JSON.stringify(payload.messages)
  if (all.includes('A_CONTEXT_PRIVATE_ONLY_A')) return payload.messages.some(row => row.role === 'tool')
    ? { text: 'A_REPORT_DECLARED_FOR_INHERITANCE' } : { tools: [{ name: 'fixture_read_a' }] }
  if (all.includes('B_CONTEXT_PRIVATE_ONLY_B')) return payload.messages.some(row => row.role === 'tool')
    ? { text: 'B_REPORT_NOT_INHERITED_BY_C' } : { tools: [{ name: 'fixture_read_b' }] }
  if (all.includes('C_CONTEXT_PRIVATE_ONLY_C')) return { text: 'C_REPORT_COMPLETE' }
  throw new Error('SCRIPTED_BACKEND_DID_NOT_RECEIVE_ACTIVE_CONTEXT')
}
