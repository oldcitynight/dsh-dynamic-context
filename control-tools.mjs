// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { proposalSchema, fail } from './core.mjs'
import { jointProposalExample, jsonExample } from './format-examples.mjs'

// A task-only proposal is validated by the base graph grammar, including its
// route/case edges. Complete joint proposals still use proposalSchema.
export const interactiveProposalSchema = proposalSchema.partial().extend({ taskGraph: z.record(z.string(), z.unknown()).optional() })

const checksumExample = 'ed1a545bb85e55816bbf9566b028b2a0bc456b88f49f6f266c0401048824194b'
const artifactExample = { kind: 'artifact', ref: 'deliverable/result.txt', sha256: checksumExample }

function submissionDescription(config, interactive) {
  const extractive = config.direct.compaction && config.direct.compaction.strategy !== 'dsh-native'
  const sample = jointProposalExample(extractive ? ['dynamic_context_source_read'] : [])
  const allowed = config.direct.runtime ? config.allowedTools : config.direct.agentlessTools
  return [
    'Atomically submit the task graph and context graph. The linked graph uses exactly one root container with no parent. All leaves declare parent equal to that root key. Every edge is {kind:"prerequisite",from:"prerequisite_leaf",to:"dependent_leaf"}; both endpoints are leaves. Use parent to express containment.',
    'Bind every leaf exactly once. Place execution instructions in contextGraph.bindings[].instruction. Use context node keys in contexts and predecessor leaf keys in inheritReports. Inheritance requires a prerequisite path from that predecessor. Empty arrays are valid when no context, reports or tools are needed.',
    'planningReport.acceptanceStrategy is a string. A supervised leaf needs completion {kind:"report"} or {kind:"artifact",path:"project-relative/file"}. Report-scoped supervision requires planningReport.',
    `Leaf tool allowlist for this workflow: ${JSON.stringify(allowed)}. Controller tool visibility and leaf tool authorization are separate. Context data cannot extend the allowlist. Mark shared facts mutable:true and bind the shared read/update tools when permitted.`,
    extractive && 'Extractive compaction requires dynamic_context_source_read in every leaf binding.',
    'Adapt the example to the current task. On validation failure, correct the identified fields and keep the valid dependencies. Use the revision workflow for structural changes after commit.',
    jsonExample('Complete joint proposal', { proposal: sample }),
    interactive && jsonExample('Task-only proposal for the standalone fallback', { proposal: { taskGraph: sample.taskGraph } }),
  ].filter(Boolean).join('\n')
}

/** Controller-only entry points; execution workers never receive these tools. */
export function registerControlTools(ctx, runner, { submit } = {}) {
  const disposers = []
  const { $schema, ...proposal } = z.toJSONSchema(submit ? interactiveProposalSchema : proposalSchema)
  const valueSpec = (schema, required = false) => {
    const { required: requiredKeys, properties, items } = schema
    // The shipped DSH author DSL supports structural types and enums. Zod
    // remains the authoritative validator for lengths, references and bounds.
    return { type: schema.type, ...(schema.enum || schema.const !== undefined ? { enum: schema.enum ?? [schema.const] } : {}),
      ...(schema.description ? { description: schema.description } : {}),
      ...(schema.additionalProperties !== undefined ? { additionalProperties: typeof schema.additionalProperties === 'boolean' ? schema.additionalProperties : true } : {}),
      ...(required ? { required: true } : {}),
      ...(properties ? { properties: Object.fromEntries(Object.entries(properties).map(([name, value]) => [name, valueSpec(value, requiredKeys?.includes(name))])) } : {}),
      ...(items ? { items: valueSpec(items) } : {}) }
  }
  const integer = { type: 'integer', description: 'The latest committed revision, at least 1.' }
  const authorize = exec => {
    const agent = exec.agent
    if (!agent || ctx.agents.get(agent.id) !== agent || agent === runner.current?.agent) fail('DYNAMIC_CONTEXT_CONTROLLER_REQUIRED')
    runner.assertController(agent)
    const cwd = agent.session.header.cwd
    if (!cwd) fail('DYNAMIC_CONTEXT_CONTROLLER_OUTSIDE_PROJECT')
    const relative = path.relative(fs.realpathSync(runner.config.projectRoot), fs.realpathSync(cwd))
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) fail('DYNAMIC_CONTEXT_CONTROLLER_OUTSIDE_PROJECT')
    return agent
  }
  const register = (name, description, parameters, execute, read = false, nativeControls = false) => disposers.push(ctx.tools.register(defineTool({ name, description, parameters,
    ...(read ? { projectPlanCapability: 'read_or_protocol' } : {}),
    ...(nativeControls || runner.config.timeoutMs === null ? {} : { timeoutMs: runner.config.timeoutMs + 5000 }),
    output: { schema: { type: 'object', properties: {}, additionalProperties: true }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    execute: async (args, exec) => { const agent = authorize(exec); return execute(args, exec, agent) },
  })))
  register('dynamic_context_status', 'Read the direct workflow revision, task choices and execution state. Goal acceptance is independent.\n' + jsonExample('Read status', {}),
    {}, async () => runner.status(), true)
  if (submit) register('dynamic_context_recover_graphs', 'Inspect missing-graph provenance and ask the user before restoring the exact committed snapshot. Restoration preserves active attempts and leaves execution paused.\n' + jsonExample('Inspect the missing graph', {}),
    {}, async (_args, exec) => runner.interaction.recover(runner, exec), true, true)
  if (runner.config.revision && !runner.config.supervision) register('dynamic_context_revise',
    'Request evidence-driven joint graph revision at an idle task boundary. A fresh updater and independent reviewer run serially. Structure, frozen requirements, permissions, report validity and exact revision are checked before atomic commit. Supply actual artifact evidence with its SHA-256 and the current revision. Goal acceptance is independent.\n'
      + jsonExample('Request revision from a concrete finding', { expectedRevision: 3, reason: 'The check revealed a missing prerequisite.', evidence: [artifactExample] }),
    { expectedRevision: { ...integer, required: true }, reason: { type: 'string', required: true },
      evidence: { type: 'array', required: true, items: { type: 'object', properties: {
        kind: { type: 'string', required: true, enum: ['artifact'] }, ref: { type: 'string', required: true },
        sha256: { type: 'string', required: true },
      }, additionalProperties: false } } },
    async (args, exec, sourceAgent) => runner.revise({ ...args, sourceAgent, signal: exec.signal }), false, true)
  if (runner.config.supervision) register('dynamic_context_continue_supervision',
    'Continue the exact pending supervision checkpoint shown by status. Report repair uses the same attempt and recorded evidence. Unknown role requests require trusted reconciliation. Replace the sample revision and checksum with the current ones.\n'
      + jsonExample('Continue a pending supervision role', { expectedRevision: 3, checkpointChecksum: checksumExample }),
    { expectedRevision: { ...integer, required: true }, checkpointChecksum: { type: 'string', required: true } },
    async (args, exec, sourceAgent) => runner.continueSupervision({ ...args, sourceAgent, signal: exec.signal }), false, true)
  register('dynamic_context_submit', submissionDescription(runner.config, Boolean(submit)),
    { proposal: valueSpec(proposal, true) }, async ({ proposal }, exec, sourceAgent) => {
      if (submit) return submit(proposal, exec)
      const state = runner.submit(proposal, { sourceAgent })
      if (!await ctx.sessions.flush(sourceAgent.session)) fail('DYNAMIC_CONTEXT_GRAPH_RECEIPT_NOT_DURABLE')
      return { revision: state.revision, contextVersion: state.contexts.version, status: runner.status() }
    })
  register('dynamic_context_run_next', 'Run one ready leaf using its committed context and tool binding. Use the current revision and displayed choice. Failed or uncertain attempts remain ACTIVE and require reconciliation. Goal acceptance is independent.\n'
    + jsonExample('Run the first ready choice', { expectedRevision: 1, choice: 0 }),
    { expectedRevision: { ...integer, required: true }, choice: { type: 'integer', description: 'Zero-based ready choice index.' },
      pauseAfterRequests: { type: 'integer', description: 'With durability enabled, request a safe pause after this many additional model requests.' } },
    async ({ expectedRevision, choice, pauseAfterRequests }, exec, sourceAgent) => {
      const result = await runner.runNext({ expectedRevision, choice, pauseAfterRequests, signal: exec.signal, sourceAgent })
      return { revision: result.revision, ...(result.paused ? { paused: true, checkpoint: result.checkpoint } : { report: result.report }),
        ...(result.supervision ? { supervisionResult: result.status, outcome: result.outcome, plan: result.plan } : {}), status: runner.status() }
    }, false, runner.config.supervision)
  if (runner.config.direct.durable) {
    register('dynamic_context_pause', 'Request a pause after the current complete exchange. Use the latest revision of the active attempt.\n'
      + jsonExample('Request a safe pause', { expectedRevision: 2 }),
      { expectedRevision: { ...integer, required: true } }, async args => runner.pauseActive(args), true)
    register('dynamic_context_resume', 'Resume the exact quiescent checkpoint shown by status. Use its revision and checksum. MODEL_PENDING, TOOL_PENDING and unknown outcomes require reconciliation.\n'
      + jsonExample('Resume a recorded checkpoint', { expectedRevision: 2, checkpointChecksum: checksumExample }),
      { expectedRevision: { ...integer, required: true }, checkpointChecksum: { type: 'string', required: true }, pauseAfterRequests: { type: 'integer' } },
      async ({ expectedRevision, checkpointChecksum, pauseAfterRequests }, exec, sourceAgent) => {
        const result = await runner.resumeActive({ expectedRevision, checkpointChecksum, pauseAfterRequests, signal: exec.signal, sourceAgent })
        return { revision: result.revision, ...(result.paused ? { paused: true, checkpoint: result.checkpoint } : { report: result.report }),
          ...(result.supervision ? { supervisionResult: result.status, outcome: result.outcome, plan: result.plan } : {}), status: runner.status() }
      }, false, runner.config.supervision)
    register('dynamic_context_reconcile', 'Request host/operator reconciliation of an interrupted attempt as UNSATISFIED. Copy the revision, attempt ID and checkpoint checksum from status. A trusted host verifier must confirm quiescence and supply evidence.\n'
      + jsonExample('Request reconciliation of an interrupted attempt', { expectedRevision: 2, expectedAttemptId: 'attempt_example', checkpointChecksum: checksumExample, note: 'The connection ended while this attempt was active.' }),
      { expectedRevision: { ...integer, required: true }, expectedAttemptId: { type: 'string', required: true }, checkpointChecksum: { type: 'string', required: true }, note: { type: 'string', required: true } },
      async (args, exec, sourceAgent) => runner.reconcileActive({ ...args, signal: exec.signal, sourceAgent }))
    register('dynamic_context_maintenance', 'Preview unreferenced interrupted-write leftovers. Use the returned planChecksum to apply that exact plan when idle. Copy the actual revision and checksum.\n'
      + jsonExample('Preview maintenance', { expectedRevision: 3 }) + '\n'
      + jsonExample('Apply the returned plan', { expectedRevision: 3, planChecksum: checksumExample }),
      { expectedRevision: { ...integer, required: true }, planChecksum: { type: 'string' } }, async (args, exec, sourceAgent) => runner.collectOrphans({ ...args, signal: exec.signal, sourceAgent }))
  }
  return () => { for (const dispose of disposers.splice(0).reverse()) dispose() }
}
