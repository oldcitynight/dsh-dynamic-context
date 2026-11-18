// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { digest } from 'dsh-better-task-grapth/core'
import { located } from 'dsh-better-task-grapth/validation'
import { artifactProof } from './artifacts.mjs'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
export function activeOriginRevision(state) {
  const active = state.graph.state.active
  return state.graph.events.find(row => row.type === 'BEGUN' && row.data.attemptId === active?.attemptId)?.seq ?? state.revision
}
export function suspendForGuidance(runner, guidance, job) {
  const state = runner.graph.read(), active = state.graph.state.active
  if (!active || !['READY', 'REWORK_RESULT'].includes(state.supervision?.phase) || !runner.checkpointStatus()?.resumablePhase) throw located('GUIDANCE_SUSPENSION_NOT_SAFE', { path: '/active', reason: 'A durable tool boundary with a known result is required before suspending the current attempt.' })
  const source = path.join(runner.activeRunDirectory(state), 'trace.json'), bytes = fs.readFileSync(source)
  const folder = path.join(runner.config.directory, 'suspensions'); fs.mkdirSync(folder, { recursive: true, mode: 0o700 })
  const file = path.join(folder, randomUUID() + '.json'); fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 })
  const evidence = { kind: 'artifact', ref: file, sha256: sha(bytes) }
  runner.graph.adoptCheckpoint({ expectedRevision: state.revision, attemptId: active.attemptId, owner: active.owner })
  runner.graph.suspend({ expectedRevision: state.revision, evidence: [evidence], note: 'User guidance suspended unfinished work before blueprint revision.',
    metadata: { contextVersion: state.contexts.version, contextHash: digest(state.contexts), scopeId: job.scopeId,
      guidanceId: guidance.id, userMessage: guidance.message, checkpoint: runner.checkpointStatus().checksum } })
  return runner.graph.read()
}
export function suspensionSource(runner, held, signal) {
  const ref = held.evidence[0], proof = artifactProof(runner.graph.storageRoot, ref, signal, runner.graph.artifactOptions)
  const trace = JSON.parse(fs.readFileSync(proof.path, 'utf8')); artifactProof(runner.graph.storageRoot, ref, signal, runner.graph.artifactOptions)
  return trace
}
export function resolveGuidanceSuspension(runner) {
  const state = runner.graph.read(), held = state.graph.state.suspended
  if (!held || state.supervision.phase !== 'READY') return null
  const id = held.active.nodeId, node = state.graph.state.plan.nodes.find(row => row.id === id)
  const same = digest(node ?? null) === digest(held.node) && digest(state.graph.state.plan.edges.filter(row => row.to === id)) === digest(held.incoming)
    && held.metadata.contextVersion === state.contexts.version && held.metadata.contextHash === digest(state.contexts)
  const mode = same ? 'resume' : 'supersede'
  runner.graph.resolveSuspension({ expectedRevision: state.revision, attemptId: held.active.attemptId, mode })
  runner.publish('guidance-suspension-' + mode)
  return { mode, held }
}
