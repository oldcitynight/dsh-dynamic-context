// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { proposalSchema, fail } from './core.mjs'

// A task-only proposal is validated by the base graph grammar, including its
// route/case edges. Complete joint proposals still use proposalSchema.
export const interactiveProposalSchema = proposalSchema.partial().extend({ taskGraph: z.record(z.string(), z.unknown()).optional() })

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
  register('dynamic_context_status', 'Read the direct workflow revision, task choices and execution state. Task completion records report submission, not Goal acceptance.',
    {}, async () => runner.status(), true)
  if (submit) register('dynamic_context_recover_graphs', 'Inspect missing-graph provenance and ask the user before restoring the exact committed snapshot. Previously present graphs must not be treated as never created. Restoration preserves active attempts and never resumes execution.',
    {}, async (_args, exec) => runner.interaction.recover(runner, exec), true, true)
  if (runner.config.revision && !runner.config.supervision) register('dynamic_context_revise',
    'Request evidence-driven joint graph revision at an idle task boundary. A fresh updater and independent reviewer run serially. Structure, frozen requirements, permissions, report validity and exact revision are checked before atomic commit. Supply artifact evidence with its SHA-256; never edit the ledger directly. The review does not establish Goal acceptance.',
    { expectedRevision: { ...integer, required: true }, reason: { type: 'string', required: true },
      evidence: { type: 'array', required: true, items: { type: 'object', properties: {
        kind: { type: 'string', required: true, enum: ['artifact'] }, ref: { type: 'string', required: true },
        sha256: { type: 'string', required: true },
      }, additionalProperties: false } } },
    async (args, exec, sourceAgent) => runner.revise({ ...args, sourceAgent, signal: exec.signal }), false, true)
  if (runner.config.supervision) register('dynamic_context_continue_supervision',
    'Continue the exact pending supervision checkpoint. Report repair uses the same attempt and recorded evidence. Unknown role requests require trusted reconciliation.',
    { expectedRevision: { ...integer, required: true }, checkpointChecksum: { type: 'string', required: true } },
    async (args, exec, sourceAgent) => runner.continueSupervision({ ...args, sourceAgent, signal: exec.signal }), false, true)
  register('dynamic_context_submit', 'Atomically submit one task graph and its context graph. Bind every leaf to explicit context nodes, prerequisite reports and a subset of host-authorized tools. Mark shared facts mutable: true; bind dynamic_context_shared_read and dynamic_context_shared_update where authorized. Context data cannot grant permissions. Structural changes use the separate revision workflow if configured.'
    + (runner.config.direct.compaction && runner.config.direct.compaction.strategy !== 'dsh-native' ? ' Extractive compaction is enabled: every leaf must explicitly bind dynamic_context_source_read.' : ''),
    { proposal: valueSpec(proposal, true) }, async ({ proposal }, exec, sourceAgent) => {
      if (submit) return submit(proposal, exec)
      const state = runner.submit(proposal, { sourceAgent })
      if (!await ctx.sessions.flush(sourceAgent.session)) fail('DYNAMIC_CONTEXT_GRAPH_RECEIPT_NOT_DURABLE')
      return { revision: state.revision, contextVersion: state.contexts.version, status: runner.status() }
    })
  register('dynamic_context_run_next', 'Run one ready leaf through the direct channel using its committed context and tool binding. Read the latest revision first. Failed or uncertain attempts remain ACTIVE and must never be blindly replayed. This call does not complete a Goal.',
    { expectedRevision: { ...integer, required: true }, choice: { type: 'integer', description: 'Zero-based ready choice index.' },
      pauseAfterRequests: { type: 'integer', description: 'With durability enabled, request a safe pause after this many additional model requests.' } },
    async ({ expectedRevision, choice, pauseAfterRequests }, exec, sourceAgent) => {
      const result = await runner.runNext({ expectedRevision, choice, pauseAfterRequests, signal: exec.signal, sourceAgent })
      return { revision: result.revision, ...(result.paused ? { paused: true, checkpoint: result.checkpoint } : { report: result.report }),
        ...(result.supervision ? { supervisionResult: result.status, outcome: result.outcome, plan: result.plan } : {}), status: runner.status() }
    }, false, runner.config.supervision)
  if (runner.config.direct.durable) {
    register('dynamic_context_pause', 'Request a pause after the currently running complete exchange. This does not interrupt or replay a tool and does not complete the task.',
      { expectedRevision: { ...integer, required: true } }, async args => runner.pauseActive(args), true)
    register('dynamic_context_resume', 'Resume only the exact quiescent checkpoint shown by status. Requires the current graph revision and checkpoint checksum. MODEL_PENDING, TOOL_PENDING and unknown outcomes are blocked; completed effects are never replayed.',
      { expectedRevision: { ...integer, required: true }, checkpointChecksum: { type: 'string', required: true }, pauseAfterRequests: { type: 'integer' } },
      async ({ expectedRevision, checkpointChecksum, pauseAfterRequests }, exec, sourceAgent) => {
        const result = await runner.resumeActive({ expectedRevision, checkpointChecksum, pauseAfterRequests, signal: exec.signal, sourceAgent })
        return { revision: result.revision, ...(result.paused ? { paused: true, checkpoint: result.checkpoint } : { report: result.report }),
          ...(result.supervision ? { supervisionResult: result.status, outcome: result.outcome, plan: result.plan } : {}), status: runner.status() }
      }, false, runner.config.supervision)
    register('dynamic_context_reconcile', 'Request host/operator reconciliation of an interrupted attempt as UNSATISFIED. A trusted host verifier must confirm quiescence and supply artifact receipts; this tool cannot self-approve, replay work, or claim success.',
      { expectedRevision: { ...integer, required: true }, expectedAttemptId: { type: 'string', required: true }, checkpointChecksum: { type: 'string', required: true }, note: { type: 'string', required: true } },
      async (args, exec, sourceAgent) => runner.reconcileActive({ ...args, signal: exec.signal, sourceAgent }))
    register('dynamic_context_maintenance', 'Preview unreferenced interrupted-write leftovers only. With the exact preview planChecksum, delete only those leftovers when no task is active. All committed checkpoints, source archives and report evidence are retained.',
      { expectedRevision: { ...integer, required: true }, planChecksum: { type: 'string' } }, async (args, exec, sourceAgent) => runner.collectOrphans({ ...args, signal: exec.signal, sourceAgent }))
  }
  return () => { for (const dispose of disposers.splice(0).reverse()) dispose() }
}
