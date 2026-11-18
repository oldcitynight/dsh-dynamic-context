// SPDX-License-Identifier: GPL-3.0-only
// Read-only import of known old receipts. Missing historical timings stay absent.
import fs from 'node:fs'
import path from 'node:path'
import { lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm'
import { apply as registerNativeStats } from '@deepseek-ai/dsh-session-stats'
import { PERFORMANCE_EVENT, PERFORMANCE_KEY, normalizeUsage, zeroUsage } from './performance-common.mjs'
import { performanceSample } from './performance-state.mjs'
let nativeStats
registerNativeStats({ sessionProjections: { register: definition => { nativeStats = definition } } })

export function historicalNativeTotals(events) {
  let state = nativeStats.init(), last = null, usage = zeroUsage()
  const attempts = new Set()
  let retries = 0
  for (const event of events) {
    state = nativeStats.apply(state, event)
    if (event.type === 'llm/retry-started') { last = null; retries++ }
    if (!['assistant/attempt', 'assistant/message'].includes(event.type)) continue
    const id = event.data.turn + ':' + event.data.step + ':' + retries
    attempts.add(id)
    const sample = normalizeUsage(event.data.usage ?? lastAssistantStreamChunk(event.data.stream, 'usage')?.usage, true)
    if (!sample) continue
    for (const key of Object.keys(usage)) usage[key] += sample[key] - (last?.id === id ? last.usage[key] : 0)
    last = { id, usage: sample }
  }
  return { kind: 'aggregate', stats: nativeStats.wire.view(state), usage, requests: attempts.size }
}
export async function importWorkflowPerformance(runner, cutoff = Date.now()) {
  const monitor = runner.ctx.get('dynamicContextPerformance'), owner = runner.controller?.session
  if (!monitor || !owner) return
  const initial = owner.snapshotEvents().find(event => event.type === PERFORMANCE_EVENT)
  cutoff = Math.min(cutoff, initial?.time ?? cutoff)
  const publish = sample => {
    const state = runner.ctx.sessionProjections.stateOf(owner, PERFORMANCE_KEY)
    if (performanceSample(state, sample.id)) return
    monitor.publish([owner, ...monitor.ancestors(owner)], { ...sample, revision: 1, imported: true })
  }
  const prefix = runner.workflowId + ':', directory = runner.config.directory
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^attempt_[\w-]+$/.test(entry.name)) continue
    const file = path.join(directory, entry.name, 'trace.json')
    if (!fs.existsSync(file) || fs.statSync(file).mtimeMs >= cutoff) continue
    const trace = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const request of trace.requests ?? []) {
      if (['PREPARED', 'NOT_SENT'].includes(request.status)) continue
      const group = 'direct:' + (trace.assembly?.task.attemptId ?? entry.name) + (trace.executionSegment ? ':' + trace.executionSegment : '')
      publish({ id: prefix + group + ':model:' + request.ordinal, kind: 'request', group,
        source: request.purpose === 'compaction' ? 'compaction' : trace.executionSegment ? 'result_work' : 'EXECUTING', startedAt: 0,
        state: request.status === 'COMPLETE' ? 'complete' : 'interrupted', usage: normalizeUsage(request.usage ?? request.transportReceipt?.usage),
        timing: 'NOT_RECORDED' })
    }
    const calls = new Map()
    for (const event of trace.events ?? []) {
      if (event.type === 'tool/call') calls.set(event.data.callId, event.time)
      if (['tool/result', 'tool/deferred'].includes(event.type) && calls.has(event.data.callId)) {
        publish({ id: 'tool:direct:' + (trace.assembly?.task.attemptId ?? entry.name) + (trace.executionSegment ? ':' + trace.executionSegment : '') + ':' + event.data.callId, kind: 'tool', toolMs: Math.max(0, event.time - calls.get(event.data.callId)) })
        calls.delete(event.data.callId)
      }
    }
  }
  const revisions = path.join(directory, 'revisions')
  if (fs.existsSync(revisions)) for (const entry of fs.readdirSync(revisions, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = path.join(revisions, entry.name, 'role.json')
    if (!fs.existsSync(file) || fs.statSync(file).mtimeMs >= cutoff) continue
    const role = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const call of role.calls ?? []) {
      if (['PREPARED', 'NOT_SENT'].includes(call.phase)) continue
      const group = 'role:' + (role.runId ?? entry.name)
      publish({ id: prefix + group + ':' + call.sequence, kind: 'request', group,
        source: call.purpose === 'compaction' ? 'compaction' : role.role, startedAt: 0,
        state: call.response ? 'complete' : 'interrupted', usage: normalizeUsage(call.response?.usage ?? call.transportReceipt?.usage), timing: 'NOT_RECORDED' })
    }
  }
  const planner = runner.interaction?.orchestrator.record(runner.controller)?.plannerSessionId
  if (planner) {
    let handle
    try {
      handle = await runner.ctx.get('sessionPersistence').open(planner, 'read')
      if (handle.header.parentSession !== owner.id) throw Error('PERFORMANCE_HISTORY_PARENT_MISMATCH')
      const events = (await handle.read()).events.filter(event => event.time < cutoff)
      if (events.length) publish({ id: 'historical-native:' + planner, ...historicalNativeTotals(events) })
    } finally { await handle?.close() }
  }
}
