// SPDX-License-Identifier: GPL-3.0-only
import { digest } from 'dsh-better-task-grapth/core'
import { DIRECTORY_HASH_SCHEME, directoryDigest } from './directory-evidence.mjs'

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

export function jointProposalExample(tools = [], { shared = false } = {}) {
  const proposal = {
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
  if (shared) {
    proposal.contextGraph.nodes.push({ key: 'shared_fact', mutable: true,
      content: 'The inspection result has not yet been recorded.', parents: [] })
    const [inspect, deliver] = proposal.contextGraph.bindings
    inspect.contexts.push('shared_fact')
    inspect.tools = [...new Set([...tools, 'dynamic_context_shared_read', 'dynamic_context_shared_update'])]
    inspect.instruction = 'Inspect the input, record the observed result in shared_fact using its actual assembled ID, and report the result.'
    deliver.contexts.push('shared_fact')
    deliver.tools = [...new Set([...tools, 'dynamic_context_shared_read'])]
    deliver.instruction = 'Use the bound shared_fact and inspection report to report the result; read a historical revision by its actual ID if needed.'
  }
  return proposal
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
      directories: [{ path: 'deliverable', hashScheme: DIRECTORY_HASH_SCHEME, sha256: directoryDigest([
        { path: '', kind: 'directory', mode: 0o755 }, { path: 'result.txt', kind: 'file', mode: 0o644, sha256: artifact.sha256 },
      ]) }],
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
  if (reportScoped) examples.push({ ...complete, executionReport: { ...examples[0].executionReport,
    directories: [{ path: 'deliverable', subdirectories: [], files: [{ path: artifact.ref, sha256: artifact.sha256 }] }] } })
  return ['Choose the example that matches the observed outcome. Replace illustrative paths, hashes, call IDs and output quotes with recorded evidence.',
    ...examples.map((example, index) => jsonExample(index === 3 ? 'COMPLETE with a legacy recursive manifest when the snapshot tool is unavailable' : example.outcome, example))].join('\n')
}

export const resultReviewExamples = [
  jsonExample('ACCEPT', { verdict: 'ACCEPT', reason: 'The verified file and the cited check satisfy the leaf criterion.', issues: [] }),
  jsonExample('RETURN', { verdict: 'RETURN', reason: 'The report omits the actual tool call ID and output quote.', issues: [{ path: '/submission/executionReport/tests/0', item: 'fixture_check', reason: 'PASS lacks the exact executed receipt and quote.', expected: 'Recorded callId and verbatim output quote.', observed: 'Both are absent.' }] }),
].join('\n')
export const legacyResultReviewExamples = [
  jsonExample('ACCEPT', { verdict: 'ACCEPT', reason: 'The verified local result satisfies this leaf criterion.', issues: [] }),
  jsonExample('RETURN', { verdict: 'RETURN', reason: 'This artifact-completion leaf has no result file reference.', issues: [{ path: '/submission/artifacts', item: 'required result file', reason: 'The leaf requires a file artifact, but the submission declares none.', expected: 'A project-relative artifact ref and its supported SHA-256.', observed: 'Empty artifacts array.' }] }),
].join('\n')

export const planReviewExamples = [
  jsonExample('CURRENT', { verdict: 'CURRENT' }),
  jsonExample('REVIEW_REQUIRED', { verdict: 'REVIEW_REQUIRED' }),
].join('\n')

const reviewExamples = scoped => ['Every REJECT or NEEDS_USER must include issues with path, item and reason, and optionally expected/observed. Use a real JSON Pointer into this role input; for an absent field point to its existing parent. APPROVE uses issues: []. '
  + (scoped ? 'This report-scoped input has changes, modificationReport, evidence and affectedContexts; it has no proposal field. Locate the actual changed item, for example /changes/0.' : 'Locate the actual submitted item under /proposal.'),
  jsonExample('APPROVE', { verdict: 'APPROVE', reason: 'The clarified delivery instruction addresses the cited criterion and preserves the inspection report handoff.', violations: [], issues: [] }),
  jsonExample('REJECT', { verdict: 'REJECT', reason: 'The pending delivery leaf lost its input report.', violations: ['The changed deliver binding drops the required inspection report.'], issues: [{ path: scoped ? '/changes/0' : '/proposal/contextGraph/bindings/1/inheritReports', item: 'deliver: inheritReports', reason: 'Required inspection report handoff was removed.' }] }),
  jsonExample('NEEDS_USER', { verdict: 'NEEDS_USER', reason: 'The proposed change requires access outside the authorized scope.', violations: ['The needed source is outside the current project authorization.'], issues: [{ path: '/contract', item: 'source access', reason: 'The required source exceeds current authorization; user approval is needed.' }] }),
].join('\n')
export const revisionReviewExamples = reviewExamples(false)
export const scopedRevisionReviewExamples = reviewExamples(true)

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
