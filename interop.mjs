// SPDX-License-Identifier: GPL-3.0-only
import { z } from 'zod'
import { symbols } from '@deepseek-ai/cordis'
import { WORKFLOW_CONTRACT } from 'dsh-better-task-grapth/interop'
import { EXTENSION_CONTRACT } from 'dsh-better-task-grapth/extensions'
import { digest } from 'dsh-better-task-grapth/core'
import { proposalSchema } from './core.mjs'
import { ruleSummary } from './rule-editor.mjs'
import { prepareRuleSubmission } from './rule-audit.mjs'
import { interactiveProposalSchema } from './control-tools.mjs'

export function requireTaskGraph(ctx, expected) {
  const service = ctx.get('transactionGraph')
  const identity = value => value?.[symbols.original] ?? value
  if (!service || expected && identity(service) !== identity(expected) || service.host?.closed || service.workflows?.closed
      || service.workflowContract !== WORKFLOW_CONTRACT || service.extensionContract !== EXTENSION_CONTRACT
      || typeof service.registerWorkflowProvider !== 'function' || typeof service.registerSessionPolicy !== 'function'
      || typeof service.createExtensionStore !== 'function' || typeof service.inspectGraphPresence !== 'function')
    throw new Error('DYNAMIC_CONTEXT_REQUIRES_ACTIVE_TASK_GRAPH')
  return service
}

const revision = z.number().int().positive()
const pause = z.number().int().positive().optional()
const requests = {
  status: z.object({}).strict(),
  submit: z.object({ proposal: proposalSchema }).strict(),
  revise: z.object({ expectedRevision: revision, reason: z.string().min(1),
    evidence: z.array(z.object({ kind: z.literal('artifact'), ref: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1) }).strict(),
  continue_supervision: z.object({ expectedRevision: revision, checkpointChecksum: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  run_next: z.object({ expectedRevision: revision, choice: z.number().int().nonnegative().optional(), pauseAfterRequests: pause }).strict(),
  pause: z.object({ expectedRevision: revision }).strict(),
  resume: z.object({ expectedRevision: revision, checkpointChecksum: z.string().regex(/^[a-f0-9]{64}$/), pauseAfterRequests: pause }).strict(),
  reconcile: z.object({ expectedRevision: revision, expectedAttemptId: z.string().min(1).max(80), checkpointChecksum: z.string().regex(/^[a-f0-9]{64}$/), note: z.string().min(1).max(1000) }).strict(),
  maintenance: z.object({ expectedRevision: revision, planChecksum: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict(),
}

function linkedGraphView(runner, { state, graphPresence }) {
  if (graphPresence.recoveryRequired) throw new Error('GRAPH_RECOVERY_REQUIRED')
  if (!state) return null
  const display = runner.graph.status(state)
  return { display: { ...display, skipChoices: [] }, plan: state.graph.state.plan }
}

/** Bind one joint ledger to the task-graph plugin; never mirror its transitions. */
export function workflowAdapter(runner) {
  const durable = runner.config.transport === 'direct' && runner.config.direct.durable
  const readGraph = readScope => {
    const shared = readScope?.get(runner)
    if (shared) return shared
    const snapshot = runner.graphSnapshot({ reconcilePrepared: false })
    readScope?.set(runner, snapshot)
    return snapshot
  }
  return {
    contract: WORKFLOW_CONTRACT, version: 1, kind: 'dynamic-context',
    workflowId: runner.config.interop.workflowId ?? `workflow_${digest(runner.config.directory).slice(0, 40)}`,
    projectRoot: runner.config.projectRoot,
    operations: ['status', 'submit', 'run_next',
      ...(runner.config.supervision ? ['continue_supervision'] : runner.config.revision ? ['revise'] : []),
      ...(durable ? ['pause', 'resume', 'reconcile', 'maintenance'] : [])],
    authorize: agent => !runner.closed && agent !== runner.current?.agent
      && (runner.config.interaction.mode === 'host' || runner.controller === agent),
    ...(runner.config.interaction.mode === 'interactive' ? { readGraphView: readScope => linkedGraphView(runner, readGraph(readScope)),
      readExecutionView: readScope => {
        const { orchestrator, lifecycle } = runner.interaction ?? {}
        const active = orchestrator ?? (lifecycle?.record(runner.controller)?.toolErrorBlock ? lifecycle : null)
        return active?.executionView(runner.controller, () => readGraph(readScope)) ?? null
      },
      readExecutionOutput: async request => {
        await runner.output.importHistory(runner)
        if (request.itemId) return runner.output.body(request)
        const page = runner.output.read(request)
        if (!page.items.length) return page
        let labels = new Map()
        try { labels = new Map((runner.graph.read()?.graph.state.plan.nodes ?? []).map(node => [node.id, node.label])) } catch {}
        return { ...page, items: page.items.map(row => ({ ...row, taskLabel: labels.get(row.taskId) ?? null })) }
      },
      controlExecution: (action, { agent, signal }) => (runner.interaction.orchestrator ?? runner.interaction.lifecycle).fromView(agent, action, signal),
    } : {}),
    subscribe: callback => runner.subscribe(callback),
    read() {
      const { graphPresence, state } = runner.graphSnapshot()
      if (graphPresence.recoveryRequired) return { graph: null, graphPresence, recoveryRequired: true, execution: { busy: runner.busy, legalNext: [] }, semanticAcceptance: 'NOT_EVALUATED' }
      return { revision: state?.revision ?? 0, graph: state?.graph ?? null, contextVersion: state?.contexts.version ?? null,
        reports: (state?.reports ?? []).map(({ taskId, attemptId, sessionId, acceptance, evidence, contextVersion }) => ({ taskId, attemptId, sessionId, acceptance, evidence, contextVersion,
          validity: state.invalidatedReports?.includes(taskId) ? 'INVALIDATED' : 'UNVERIFIED' })),
        invalidatedReports: state?.invalidatedReports ?? [],
        execution: { busy: runner.busy, closed: runner.closed, continuation: durable ? runner.checkpointStatus(state) : null,
          revisionRecovery: runner.revisionRecovery(),
          ...(runner.config.supervision ? { supervision: runner.supervisionStatus(state), legalNext: runner.graph.status(state)?.legalNext ?? [] } : {}),
        },
        semanticAcceptance: 'NOT_EVALUATED' }
    },
    async execute(operation, request, { agent, signal }) {
      runner.assertController(agent)
      if (operation === 'submit' && runner.interaction) {
        const args = z.object({ proposal: interactiveProposalSchema }).strict().parse(request)
        return runner.interaction.submit(runner, await prepareRuleSubmission(runner, args.proposal, agent, signal), { agent, signal })
      }
      const args = requests[operation].parse(request)
      if (operation === 'status') return runner.status()
      if (operation === 'revise') return runner.revise({ ...args, sourceAgent: agent, signal })
      if (operation === 'continue_supervision') return runner.continueSupervision({ ...args, sourceAgent: agent, signal })
      if (operation === 'submit') {
        const result = runner.submit(await prepareRuleSubmission(runner, args.proposal, agent, signal), { sourceAgent: agent })
        if (!await runner.ctx.sessions.flush(agent.session)) throw new Error('DYNAMIC_CONTEXT_GRAPH_RECEIPT_NOT_DURABLE')
        return { revision: result.revision, contextVersion: result.contexts.version, ...ruleSummary(result.graph.state.plan) }
      }
      if (operation === 'pause') return runner.pauseActive(args)
      if (operation === 'reconcile') return runner.reconcileActive({ ...args, sourceAgent: agent, signal })
      if (operation === 'maintenance') return runner.collectOrphans({ ...args, signal, sourceAgent: agent })
      const result = await runner[operation === 'resume' ? 'resumeActive' : 'runNext']({ ...args, sourceAgent: agent, signal })
      return { revision: result.revision, ...(result.paused ? { paused: true, checkpoint: result.checkpoint } : { report: result.report }),
        ...(result.supervision ? { supervision: result.supervision, status: result.status, outcome: result.outcome, plan: result.plan } : {}),
      }
    },
  }
}

export function connectTaskGraph(ctx, runner) {
  const service = requireTaskGraph(ctx, runner.taskGraph)
  return service.registerWorkflowProvider(workflowAdapter(runner))
}
