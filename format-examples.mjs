// SPDX-License-Identifier: GPL-3.0-only
import { digest } from 'dsh-better-task-grapth/core'

export function jsonExample(label, value) {
  return `${label}\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``
}

const taskGraph = {
  title: 'Inspect and deliver',
  nodes: [
    { key: 'root', kind: 'container', label: 'Project' },
    { key: 'inspect', kind: 'leaf', label: 'Inspect inputs', parent: 'root' },
    { key: 'deliver', kind: 'leaf', label: 'Deliver results', parent: 'root' },
  ],
  edges: [{ kind: 'prerequisite', from: 'inspect', to: 'deliver' }],
}

export function jointProposalExample(tools = []) {
  return {
    planningReport: {
      understanding: 'Inspect the supplied input and report the result.',
      assumptions: ['The supplied input is the authorized source.'],
      design: 'Inspect first, then deliver from its report.',
      acceptanceStrategy: 'Verify each leaf against its declared result.',
    },
    taskGraph: structuredClone(taskGraph),
    contextGraph: {
      nodes: [{ key: 'input', content: 'The input record says the fixture is ready.', parents: [] }],
      bindings: [
        { task: 'inspect', instruction: 'Report the status in the input.', contexts: ['input'], inheritReports: [], tools, completion: { kind: 'report' } },
        { task: 'deliver', instruction: 'Report the result using the inspection report.', contexts: [], inheritReports: ['inspect'], tools, completion: { kind: 'report' } },
      ],
    },
  }
}

const artifact = { kind: 'artifact', ref: 'deliverable/result.txt',
  sha256: 'ed1a545bb85e55816bbf9566b028b2a0bc456b88f49f6f266c0401048824194b' }
const complete = { outcome: 'COMPLETE', summary: 'Delivered the checked result.', artifacts: [artifact] }
const blocked = { outcome: 'BLOCKED', summary: 'The required input is unavailable.', artifacts: [] }
const failed = { outcome: 'FAILED', summary: 'The recorded fixture check failed.', artifacts: [], failedCallId: 'call_fixture_fail' }

export function dispositionExamples(reportScoped) {
  const tests = {
    pass: { id: 'fixture_check', criterion: 'Check the delivered result', status: 'PASS',
      expected: 'fixture check passed', observed: 'fixture check passed', callId: 'call_fixture_pass', quote: 'fixture check passed' },
    notRun: { id: 'fixture_check', criterion: 'Check the input fixture', status: 'NOT_RUN',
      expected: 'The fixture is available', observed: 'The input was unavailable' },
    fail: { id: 'fixture_check', criterion: 'Check the generated result', status: 'FAIL',
      expected: 'fixture check passed', observed: 'fixture check failed', callId: 'call_fixture_fail', quote: 'fixture check failed' },
  }
  const examples = reportScoped ? [
    { ...complete, executionReport: {
      workHistory: ['Created and checked the result file.'],
      results: [{ criterion: 'Deliver a checked file', result: 'The result file meets the fixture check.', artifactRefs: [artifact.ref], testIds: ['fixture_check'] }],
      directories: [{ path: 'deliverable', subdirectories: [], files: [{ path: artifact.ref, sha256: artifact.sha256 }] }],
      tests: [tests.pass], limitations: [],
    } },
    { ...blocked, executionReport: {
      workHistory: ['Checked whether the required input was available.'],
      results: [{ criterion: 'Check the input', result: 'The check is blocked by missing input.', artifactRefs: [], testIds: ['fixture_check'] }],
      directories: [], tests: [tests.notRun], limitations: ['The required input must be provided.'],
    } },
    { ...failed, executionReport: {
      workHistory: ['Ran the fixture check and recorded its failure.'],
      results: [{ criterion: 'Check the generated result', result: 'The recorded check failed.', artifactRefs: [], testIds: ['fixture_check'] }],
      directories: [], tests: [tests.fail], limitations: ['The criterion remains unmet.'],
    } },
  ] : [complete, blocked, failed]
  return ['Choose the example that matches the observed outcome. Replace illustrative paths, hashes, call IDs and output quotes with recorded evidence.',
    ...examples.map(example => jsonExample(example.outcome, example))].join('\n')
}

export const resultReviewExamples = [
  jsonExample('ACCEPT', { verdict: 'ACCEPT', reason: 'The verified file and the cited check satisfy the leaf criterion.' }),
  jsonExample('RETURN', { verdict: 'RETURN', reason: 'The report claims a passed fixture check but omits the actual tool call ID and output quote.' }),
].join('\n')

export const planReviewExamples = [
  jsonExample('CURRENT', { verdict: 'CURRENT' }),
  jsonExample('REVIEW_REQUIRED', { verdict: 'REVIEW_REQUIRED' }),
].join('\n')

export const revisionReviewExamples = [
  jsonExample('APPROVE', { verdict: 'APPROVE', reason: 'The clarified delivery instruction addresses the cited criterion and preserves the inspection report handoff.', violations: [] }),
  jsonExample('REJECT', { verdict: 'REJECT', reason: 'The pending delivery leaf lost its input report.', violations: ['The changed deliver binding drops the required inspection report.'] }),
  jsonExample('NEEDS_USER', { verdict: 'NEEDS_USER', reason: 'The proposed change requires access outside the authorized scope.', violations: ['The needed source is outside the current project authorization.'] }),
].join('\n')

export function revisionProposalExamples(linked, withReport) {
  const proposal = jointProposalExample()
  const revised = {
    disposition: 'REVISE', trigger: 'CONTEXT_GAP',
    reason: 'Use the newly established criterion for the pending delivery.', evidenceIds: ['fact_0'],
    taskGraph: proposal.taskGraph, contextGraph: linked ? proposal.contextGraph : null,
    coverage: [{ requirement: 'delivery', tasks: ['deliver'] }], retirements: [], invalidateReports: [],
  }
  if (linked) {
    revised.contextGraph.bindings[1].instruction = 'Report whether the inspection confirms the fixture is ready, and cite that check.'
    revised.contextGraph.nodes = revised.contextGraph.nodes.map(node => ({ key: node.key, retain: true, sha256: digest(node) }))
  } else {
    revised.taskGraph.nodes[2].label = 'Deliver a result checked against the fixture readiness criterion'
  }
  const unchanged = { disposition: 'NO_CHANGE', trigger: 'NONE', reason: 'The current graph already covers the recorded result.',
    evidenceIds: [], taskGraph: null, contextGraph: null, coverage: [], retirements: [], invalidateReports: [] }
  const needsUser = { ...unchanged, disposition: 'NEEDS_USER', trigger: 'USER_CHANGE', reason: 'A required input needs explicit user authorization.' }
  if (withReport) {
    revised.modificationReport = { summary: 'Clarify one pending leaf.', changes: [{
      path: linked ? '/contextGraph/bindings/deliver/instruction' : '/taskGraph/nodes/deliver',
      why: 'The new criterion is needed to verify the pending result.',
      evidence: [{ factId: 'fact_0', pointer: '/summary', quote: 'Delivery requires a reported fixture readiness check.' }],
    }] }
    unchanged.modificationReport = { summary: 'Keep the current graphs.', changes: [] }
    needsUser.modificationReport = { summary: 'Await authorization.', changes: [] }
  }
  return [jsonExample('REVISE when one pending leaf needs a change. Use the actual snapshot keys and context hashes.', revised),
    jsonExample('NO_CHANGE', unchanged), jsonExample('NEEDS_USER', needsUser)].join('\n')
}
