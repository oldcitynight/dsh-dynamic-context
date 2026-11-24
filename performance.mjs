// SPDX-License-Identifier: GPL-3.0-only
// Supplemental request observations are ignorable log records, never model input.
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { PERFORMANCE_EVENT, PERFORMANCE_KEY, normalizeUsage } from './performance-common.mjs'
import { performanceTreeSchema, initialPerformanceState, advancePerformanceState, performanceSamples } from './performance-state.mjs'
import { roleInputTokens } from './role-context.mjs'

export const performanceDefinition = {
  // Only the disposable projection cache changes version. Old event logs and
  // workflow checkpoints keep their original schema and are never rewritten.
  key: PERFORMANCE_KEY, stateVersion: 2, stateSchema: z.object({ samples: performanceTreeSchema, groups: performanceTreeSchema, view: z.any() }),
  init: initialPerformanceState,
  apply(state, event) {
    if (event.type !== PERFORMANCE_EVENT || !event.ignorable || event.data?.version !== 1) return state
    const sample = event.data.sample
    if (!sample || typeof sample.id !== 'string' || !Number.isSafeInteger(sample.revision)) return state
    return advancePerformanceState(state, sample, event.seq)
  },
  wire: { viewSchema: z.any(), view: state => state.view },
}
const inert = { delta() {}, progress() {}, end() {} }
export class RequestPerformance {
  constructor(ctx) { this.ctx = ctx; this.toolCalls = new Map(); this.windows = new Map(); this.warned = false }
  safe(fn) {
    try { return fn() } catch { if (!this.warned) { this.warned = true; this.ctx.logger?.warn?.('REQUEST_PERFORMANCE_OBSERVATION_FAILED') } }
  }
  ancestors(session) {
    const result = [], seen = new Set([session.id])
    while (session.header?.origin === 'subagent' && session.header.parentSession) {
      session = this.ctx.sessions.get(session.header.parentSession)
      if (!session || seen.has(session.id)) break
      seen.add(session.id); result.push(session)
    }
    return result
  }
  publish(sessions, sample) {
    for (const session of sessions) this.safe(() => {
      if (this.ctx.sessions.get(session.id) !== session) return
      appendPluginRecord(session, PERFORMANCE_EVENT, { version: 1, sample: structuredClone(sample) })
      void this.ctx.sessions.flush(session).catch(() => {})
    })
  }
  begin(session, id, meta = {}) {
    if (!session) return inert
    const targets = [session, ...this.ancestors(session)]
    const sample = { id, kind: 'request', group: meta.group ?? id, source: meta.source ?? 'direct',
      startedAt: meta.startedAt ?? Date.now(), revision: 0, state: 'running',
      ...(meta.inputTokens === undefined ? {} : { inputTokens: meta.inputTokens }),
      ...(meta.sessionId ? { sessionId: meta.sessionId } : {}), countsTurn: meta.countsTurn !== false,
      ...(meta.contextWindow ? { contextWindow: meta.contextWindow } : {}),
      ...(meta.breakdown ? { breakdown: meta.breakdown } : {}) }
    const publish = () => { sample.revision++; this.publish(targets, sample) }
    publish()
    let ended = false
    return {
      window: value => {
        if (Number.isSafeInteger(value) && value > 0 && !sample.contextWindow) { sample.contextWindow = value; publish() }
      },
      delta: delta => {
        if (!ended && sample.firstTokenAt === undefined && (delta.text || delta.reasoning || delta.tools?.length)) sample.firstTokenAt = Date.now()
      },
      progress: ({ usage } = {}) => {
        const normalized = normalizeUsage(usage, meta.native)
        if (!ended && normalized && JSON.stringify(sample.usage) !== JSON.stringify(normalized)) { sample.usage = normalized; publish() }
      },
      end: (state, usage) => {
        if (ended) return
        ended = true; sample.endedAt = Date.now(); sample.state = state
        sample.usage = normalizeUsage(usage, meta.native) ?? sample.usage ?? null
        publish()
      },
    }
  }
  routeWindow(session, provider, model) {
    if (!session || !provider || !model) return
    for (const current of [session, ...this.ancestors(session)]) {
      const route = current.requestContext?.() ?? current.snapshotEvents().findLast(row => row.type === 'request/context')?.data
      if (route?.provider === provider && route.model === model && route.contextWindow > 0) return route.contextWindow
    }
  }
  attachWindow(observation, provider, model) {
    if (!observation || !this.ctx.llm?.resolveModelInfo || !provider || !model) return
    const key = JSON.stringify([provider, model])
    if (!this.windows.has(key)) {
      if (this.windows.size >= 128) this.windows.delete(this.windows.keys().next().value)
      const resolution = Promise.resolve().then(() => this.ctx.llm.resolveModelInfo(provider, model))
        .then(info => info?.context?.contextWindow, () => undefined)
      this.windows.set(key, resolution)
    }
    void this.windows.get(key).then(value => this.safe(() => observation.window?.(value)))
  }
  direct(owner, id, { payload, inputMeasurement, config, ...meta }) {
    return this.safe(() => {
    const contextWindow = config.direct.compaction?.contextWindow ?? this.routeWindow(owner?.session, config.provider, config.model)
    const observation = this.begin(owner?.session, id, { ...meta,
      inputTokens: inputMeasurement?.tokens ?? roleInputTokens(payload),
      contextWindow,
      breakdown: { systemTokens: roleInputTokens({ messages: payload.messages.filter(row => row.role === 'system') }),
        toolsTokens: roleInputTokens({ messages: [], tools: payload.tools }),
        messageTokens: roleInputTokens({ messages: payload.messages.filter(row => row.role !== 'system') }) },
    })
    if (!contextWindow) this.attachWindow(observation, config.provider, config.model)
    return observation
    }) ?? inert
  }
  tool(owner, prefix, type, data, time = Date.now()) {
    if (!owner?.session || !['tool/call', 'tool/result', 'tool/deferred'].includes(type)) return
    const id = 'tool:' + prefix + ':' + data.callId
    if (type === 'tool/call') this.toolCalls.set(id, time)
    else if (this.toolCalls.has(id)) {
      this.publish([owner.session, ...this.ancestors(owner.session)], { id, kind: 'tool', revision: 1,
        toolMs: Math.max(0, time - this.toolCalls.get(id)) })
      this.toolCalls.delete(id)
    }
  }
  recover(session) {
    const state = this.ctx.sessionProjections.stateOf(session, PERFORMANCE_KEY)
    for (const sample of performanceSamples(state)) if (sample.kind === 'request' && sample.state === 'running') {
      const { endedAt, firstOrder, ...known } = sample
      this.publish([session], { ...known, revision: sample.revision + 1, state: 'interrupted', interruption: 'PROCESS_RESTART_TIME_UNKNOWN' })
    }
  }
  install() {
    const monitor = this, ctx = this.ctx
    ctx.sessionProjections.register(performanceDefinition)
    ctx.on('llm/adapters-updated', () => this.windows.clear())
    ctx.on('session/created', session => monitor.safe(() => monitor.recover(session)))
    for (const session of ctx.sessions.list()) monitor.safe(() => monitor.recover(session))
    // Main native requests already contribute to native projections. Auxiliary
    // requests and child requests do not: observe them once, at the LLM seam.
    ctx.on('llm/stream', async function* (request, next) {
      const observations = monitor.safe(() => {
      const session = ctx.sessions.get(request.sessionId)
      if (!session) return []
      const parents = monitor.ancestors(session), id = 'native:' + randomUUID(), startedAt = Date.now()
      const turn = session.snapshotEvents().findLast(row => row.type === 'turn/start')?.data.turn ?? 0
      const pressure = ctx.sessionProjections.snapshot(session).values.contextPressure
      const nativeLoop = isAgentLoopRequest(request)
      const contextWindow = (nativeLoop ? pressure?.contextWindow : undefined) ?? monitor.routeWindow(session, request.provider, request.model)
      const inputTokens = nativeLoop ? pressure?.projectedTokens ?? pressure?.pressureTokens : roleInputTokens({ messages: request.messages ?? [], tools: request.tools })
      const targets = nativeLoop ? parents : [session, ...parents]
      if (nativeLoop) monitor.publish([session], { id, revision: 1, kind: 'native-anchor', source: 'native', startedAt })
      return targets.map(target => {
        // begin normally traverses ancestry; use just this target to avoid
        // counting a grandchild twice in an ancestor.
        const local = Object.create(monitor); local.ancestors = () => []
        const observation = local.begin(target, id, { native: true, startedAt, sessionId: session.id, source: request.purpose ?? (nativeLoop ? 'subagent' : 'auxiliary'),
          group: session.id + ':' + turn, countsTurn: target !== session, contextWindow, inputTokens })
        if (!contextWindow) monitor.attachWindow(observation, request.provider, request.model)
        return observation
      })
      }) ?? []
      let usage, finish
      try {
        for await (const chunk of next()) {
          if (chunk.type === 'usage') { usage = chunk.usage; observations.forEach(row => monitor.safe(() => row.progress({ usage }))) }
          if (chunk.type === 'finish') finish = chunk.reason
          const delta = { text: chunk.type === 'text-delta' ? chunk.text : '', reasoning: chunk.type === 'reasoning-delta' ? chunk.text : '',
            tools: chunk.type === 'tool-call-delta' ? [chunk] : [] }
          observations.forEach(row => monitor.safe(() => row.delta(delta))); yield chunk
        }
      } finally { observations.forEach(row => monitor.safe(() => row.end(finish && !['error', 'aborted'].includes(finish.kind ?? finish) ? 'complete' : 'interrupted', usage))) }
    })
    ctx.on('session/event', (session, event) => monitor.safe(() => {
      const parents = monitor.ancestors(session)
      if (!parents.length) return
      const key = session.id + ':' + (event.data?.callId ?? event.data?.message?.source?.callId)
      if (event.type === 'tool/call') monitor.toolCalls.set(key, event.time)
      if (event.type === 'tool/result' && monitor.toolCalls.has(key)) {
        monitor.publish(parents, { id: 'tool:' + key, revision: 1, kind: 'tool', toolMs: Math.max(0, event.time - monitor.toolCalls.get(key)) })
        monitor.toolCalls.delete(key)
      }
    }))
  }
}
