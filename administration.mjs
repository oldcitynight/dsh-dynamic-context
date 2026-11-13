// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs'
import { supervisionAuthority } from './supervision-runtime.mjs'
import path from 'node:path'
import { digest } from 'dsh-bettertaskgraphs/core'
import { artifactProof } from 'dsh-bettertaskgraphs/host'
import { DirectJournal, acquireDirectLease } from './durable-store.mjs'
import { fail } from './core.mjs'

async function exclusive(runner, action, signal) {
  if (runner.closed || runner.busy || runner.config.transport !== 'direct' || !runner.config.direct.durable) fail('DIRECT_ADMIN_REQUIRES_IDLE_DURABLE_RUNNER')
  signal?.throwIfAborted()
  runner.busy = true
  const control = new AbortController()
  let drained, lease, timer
  runner.drained = new Promise(resolve => { drained = resolve })
  runner.current = { dispose: async () => control.abort(new Error('DYNAMIC_CONTEXT_RUNNER_CLOSED')) }
  const abort = () => control.abort(signal.reason)
  signal?.addEventListener('abort', abort, { once: true })
  try {
    lease = await acquireDirectLease(runner.config.directory)
    if (runner.config.timeoutMs !== null) timer = setTimeout(() => control.abort(new Error('DIRECT_ADMIN_TIMEOUT')), runner.config.timeoutMs)
    control.signal.throwIfAborted()
    return await action(control.signal)
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort)
    await lease?.release(); runner.current = null; runner.busy = false; drained()
  }
}

function journalFor(runner, state, active) {
  return DirectJournal.open(path.join(runner.config.directory, active.attemptId), {
    taskId: active.nodeId, attemptId: active.attemptId, contextVersion: state.contexts.version,
    owner: active.owner, graphRevision: state.revision,
  }, { maxBytes: runner.config.direct.maxJournalBytes })
}
const authority = (runner, agent) => {
  if (!agent) return null // Direct program API is a trusted host port.
  if (runner.ctx.agents.get(agent.id) !== agent || runner.ctx.get('sessions')?.get(agent.session.id) !== agent.session) fail('DIRECT_RECONCILE_CONTROLLER_CHANGED')
  const root = fs.realpathSync(runner.config.projectRoot), cwd = fs.realpathSync(runner.ctx.get('workingDirectory')?.get(agent.session) ?? agent.session.header.cwd)
  const relative = path.relative(root, cwd)
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) fail('DIRECT_RECONCILE_CONTROLLER_OUTSIDE_PROJECT')
  const sandbox = runner.ctx.get('sandboxPolicy')?.resolve({ session: agent.session })
  const goal = runner.ctx.get('goals')?.get(agent)
  const plan = runner.ctx.get('runtimeQuality')?.planActive(agent)
    ?? runner.ctx.get('agentPresets')?.serviceFor(agent, 'planMode')?.loggedActive(agent.session)
    ?? agent.ctx.get('planMode')?.loggedActive(agent.session)
  return digest({ cwd, originalCwd: agent.session.header.cwd,
    sandbox: sandbox ? { mode: sandbox.mode, workspaceRoot: sandbox.workspaceRoot } : null,
    approval: runner.ctx.get('approval')?.effectivePolicy(agent.session) ?? null, plan: Boolean(plan),
    goal: goal ? { id: goal.id, revision: goal.revision, phase: goal.phase } : null,
    messages: agent.session.deriveMessages().filter(message => ['user', 'developer', 'system'].includes(message.role)) })
}

/** Close UNKNOWN as UNSATISFIED, never fabricate a successful tool result or retry. */
export async function reconcileActive(runner, { expectedRevision, expectedAttemptId, checkpointChecksum, note, signal, sourceAgent } = {}) {
  const verifier = runner.reconciliationVerifier
  if (!verifier || typeof note !== 'string' || !note.trim() || note.length > 1000) fail('DIRECT_TRUSTED_RECONCILIATION_REQUIRED')
  return exclusive(runner, async lifecycle => {
    const state = runner.graph.read(), active = state?.graph.state.active
    if (state?.revision !== expectedRevision || active?.attemptId !== expectedAttemptId) fail('DIRECT_RECONCILE_STALE_OR_DIFFERENT_ATTEMPT')
    if (state.supervision && state.supervision.phase !== 'READY') fail('SUPERVISION_SCHEDULING_BLOCKED')
    const journal = journalFor(runner, state, active), head = journal.latest()
    if (!head || checkpointChecksum !== head.checksum) fail('DIRECT_RESUME_CHECKPOINT_CHANGED')
    const owner = authority(runner, sourceAgent)
    let abort
    let attestation
    try {
      const cancelled = new Promise((_, reject) => { abort = () => reject(lifecycle.reason); lifecycle.addEventListener('abort', abort, { once: true }); if (lifecycle.aborted) abort() })
      attestation = await Promise.race([verifier.verify(Object.freeze({ taskId: active.nodeId, attemptId: active.attemptId,
        expectedRevision, checkpointChecksum, phase: head.phase, outcome: 'incomplete', disposition: 'UNSATISFIED',
        note, sourceAgent, signal: lifecycle })), cancelled])
    } finally { lifecycle.removeEventListener('abort', abort) }
    lifecycle.throwIfAborted()
    if (runner.reconciliationVerifier !== verifier || attestation?.confirmedQuiescent !== true || attestation?.closeUnverified !== true
        || !Array.isArray(attestation.evidence) || !attestation.evidence.length || attestation.evidence.length > 4) fail('DIRECT_RECONCILIATION_NOT_ATTESTED')
    if (runner.graph.read().checksum !== state.checksum || journal.latest().checksum !== head.checksum || authority(runner, sourceAgent) !== owner) fail('DIRECT_RECONCILE_STATE_CHANGED')
    for (const reference of attestation.evidence) {
      if (reference.kind !== 'artifact') fail('DIRECT_RECONCILIATION_ARTIFACT_REQUIRED')
      artifactProof(runner.config.storageRoot ?? runner.config.projectRoot, reference, lifecycle, runner.graph.artifactOptions)
    }
    const evidence = structuredClone(attestation.evidence)
    const pending = journal.append('RECONCILE_PENDING', { checkpointChecksum, verifierVersion: verifier.version, evidence, disposition: 'UNSATISFIED' })
    const result = await runner.graph.reconcile({ expectedRevision, expectedAttemptId, note, evidence,
      ...(state.supervision ? { authorityHash: supervisionAuthority(runner, sourceAgent) } : {}), precommit: () => {
      lifecycle.throwIfAborted()
      if (runner.reconciliationVerifier !== verifier || journal.latest().checksum !== pending.checksum || authority(runner, sourceAgent) !== owner) fail('DIRECT_RECONCILE_STATE_CHANGED')
      for (const reference of evidence) artifactProof(runner.config.storageRoot ?? runner.config.projectRoot, reference, lifecycle, runner.graph.artifactOptions)
    } })
    journal.append('RECONCILED', { graphRevision: result.revision, graphChecksum: result.graph.checksum,
      disposition: 'UNSATISFIED', originalEffects: 'NOT_RECLASSIFIED', verifierVersion: verifier.version, evidence })
    runner.publish('reconciled')
    return { revision: result.revision, disposition: 'UNSATISFIED', semanticAcceptance: 'NOT_EVALUATED', goalReached: false }
  }, signal)
}

/** Remove only unreferenced interrupted-write leftovers, never committed history. */
export async function collectOrphans(runner, { expectedRevision, planChecksum, signal } = {}) {
  return exclusive(runner, async lifecycle => {
    const state = runner.graph.read()
    if (state?.revision !== expectedRevision) fail('DIRECT_MAINTENANCE_STALE_REVISION')
    if (state.graph.state.active) fail('DIRECT_MAINTENANCE_ACTIVE_ATTEMPT')
    const attempts = Object.entries(state.graph.state.leaves).filter(([, leaf]) => leaf.attemptId).map(([nodeId, leaf]) => ({ nodeId, attemptId: leaf.attemptId }))
    const references = [...state.reports.flatMap(report => report.evidence),
      ...state.graph.events.flatMap(event => Array.isArray(event.data.evidence) ? event.data.evidence : [])]
      .filter(reference => reference.kind === 'artifact').map(reference => ({ ...reference,
        ref: path.resolve(runner.config.storageRoot ?? runner.config.projectRoot, reference.ref) }))
    const files = []
    for (const item of attempts) {
      lifecycle.throwIfAborted()
      const journal = DirectJournal.open(path.join(runner.config.directory, item.attemptId), { taskId: item.nodeId, attemptId: item.attemptId, contextVersion: state.contexts.version })
      files.push(...journal.orphans(references))
    }
    const plan = { expectedRevision, stateChecksum: state.checksum, files }
    const checksum = digest(plan)
    if (planChecksum === undefined) return { ...plan, planChecksum: checksum, dryRun: true, bytes: files.reduce((sum, row) => sum + row.bytes, 0) }
    if (planChecksum !== checksum || runner.graph.read().checksum !== state.checksum) fail('DIRECT_MAINTENANCE_PLAN_CHANGED')
    for (const file of files) {
      lifecycle.throwIfAborted()
      const info = fs.lstatSync(file.ref)
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.ino !== file.ino || info.size !== file.bytes || info.mtimeMs !== file.mtimeMs) fail('DIRECT_MAINTENANCE_FILE_CHANGED')
      fs.unlinkSync(file.ref)
    }
    runner.publish('maintenance-completed')
    return { planChecksum: checksum, dryRun: false, removed: files.length, bytes: files.reduce((sum, row) => sum + row.bytes, 0) }
  }, signal)
}
