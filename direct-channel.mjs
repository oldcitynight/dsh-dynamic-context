// SPDX-License-Identifier: GPL-3.0-only
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { fetch } from 'undici'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { canonical, digest } from 'dsh-bettertaskgraphs/core'
import { deepFreeze, taskPrompt, textContent, wireTools, toolFingerprint } from './request-policy.mjs'
import { compactDirectHistory, checkDirectHistory, checkpointData } from './checkpoints.mjs'
import { DynamicContextError, fail } from './core.mjs'
import { apiParameters, measureInput } from './api-protocol.mjs'
import { readCompletion } from './direct-http.mjs'
import { compactNativeHistory } from './native-compaction.mjs'
import { directAuthHeaders } from './direct-auth.mjs'

/** Use the pinned execution identity (or explicit agentless mode) through native policy and guards. */
function toolBridge(ctx, contract, control, record, execution, journal) {
  const agent = execution?.agent
  const owned = new AsyncLocalStorage(), disposers = []
  const reason = exec => {
    const call = owned.getStore()
    if (!call) return undefined
    const deny = message => {
      control.abort(new DynamicContextError('DIRECT_TOOL_EXECUTION_CONTRACT_MISMATCH'))
      return message
    }
    if (call.token !== undefined && call.token !== exec.token) return deny('Nested or repeated direct tool dispatch is not permitted')
    call.token ??= exec.token
    if (exec.agent !== agent || exec.parent !== undefined || exec.callId !== call.id || exec.rootCallId !== call.id
        || exec.name !== call.function.name || canonical(exec.arguments) !== canonical(call.arguments)) return deny('Direct task tool execution identity changed')
    if (ctx.tools.get(exec.name, agent) !== contract.definitions.get(exec.name)) return deny('Direct task tool definition changed')
    execution?.authorize(exec.name, exec.arguments)
    return undefined
  }
  disposers.push(ctx.tools.guard(reason))
  disposers.push(ctx.on('tools/execute', (exec, next) => {
    if (!owned.getStore()) return next()
    if (reason(exec)) fail('DIRECT_TOOL_EXECUTION_CONTRACT_MISMATCH')
    deepFreeze(exec.arguments)
    deepFreeze(exec.schema)
    // These fields are readonly in the public ToolExecution contract. Leave the
    // signal mutable because the native dispatcher fuses cancellation there.
    for (const field of ['token', 'name', 'callId', 'rootCallId', 'arguments', 'agent', 'parent', 'schema']) {
      const descriptor = Object.getOwnPropertyDescriptor(exec, field)
      Object.defineProperty(exec, field, { value: exec[field], writable: false, configurable: false, enumerable: descriptor?.enumerable ?? false })
    }
    return next()
  }))
  disposers.push(ctx.on('llm/stream', async function* (_request, next) {
    if (owned.getStore()) fail('DIRECT_TOOL_MODEL_CALL_UNSUPPORTED')
    yield* next()
  }))
  const stopChange = ctx.on('tools/change', () => control.abort(new DynamicContextError('DIRECT_TOOL_REGISTRY_CHANGED')))
  let repairDeferral
  return {
    takeRepairDeferral() { const value = repairDeferral; repairDeferral = undefined; return value },
    async execute(call, deferred) {
      control.signal.throwIfAborted()
      if (ctx.tools.get(call.function.name, agent) !== contract.definitions.get(call.function.name)) fail('DIRECT_TOOL_DEFINITION_CHANGED')
      journal?.append('TOOL_PENDING', { callId: call.id, tool: call.function.name, deferred: Boolean(deferred) })
      const input = { ...call, arguments: JSON.parse(call.function.arguments) }
      const reportContent = (content, outcome) => contract.assembly.reportProtocol === 'report-scoped-v1'
        ? '<host-receipt>' + JSON.stringify({ callId: call.id, tool: call.function.name, outcome }) + '</host-receipt>\n' + content : content
      record('tool/call', { callId: call.id, name: call.function.name, arguments: input.arguments })
      await execution?.toolCall(call)
      if (deferred) {
        const result = { content: [{ type: 'text', text: deferred }], isError: true }
        execution.toolResult(call, result)
        record('tool/deferred', { callId: call.id, name: call.function.name, execution: 'NOT_EXECUTED', content: deferred })
        return { role: 'tool', tool_call_id: call.id, content: reportContent(deferred, 'NOT_EXECUTED') }
      }
      const invoke = () => owned.run(input, () => ctx.tools.execute({ callId: ToolCallId(call.id),
        name: call.function.name, arguments: input.arguments, ...(agent ? { agent } : {}), signal: control.signal }))
      const result = await ctx.agents.withoutInitiator(() => execution?.runTool ? execution.runTool(invoke) : invoke())
      execution?.toolResult(call, result)
      record('tool/result', { callId: call.id, name: call.function.name, content: result.content,
        isError: result.isError, ...(result.error === undefined ? {} : { error: result.error }),
        ...(execution && result.value !== undefined ? { value: result.value } : {}) })
      control.signal.throwIfAborted()
      // A missing file is a definitive read observation, not an uncertain
      // effect. Let the model use that observation before creating the file.
      const nativeFilesystem = execution?.facts.modules.includes('filesystem')
      const missingRead = nativeFilesystem && call.function.name === 'read' && result.isError && result.error?.info?.code === 'FS_NOT_FOUND'
      const needsObservation = nativeFilesystem && ['write', 'edit'].includes(call.function.name) && result.isError
        && ['FS_NOT_OBSERVED', 'FS_STALE_VERSION'].includes(result.error?.info?.code)
      // The pinned native filesystem computes a literal edit before its atomic
      // write. These exact errors prove no write occurred; unknown errors do not.
      const rejectedEdit = nativeFilesystem && call.function.name === 'edit' && result.isError
        && ['FS_EDIT_NOT_FOUND', 'FS_AMBIGUOUS_EDIT'].includes(result.error?.info?.code)
      if (result.isError && !missingRead && !needsObservation && !rejectedEdit) fail('DIRECT_TOOL_EXECUTION_FAILED')
      if (missingRead) record('tool/missing-file-observed', { callId: call.id, name: 'read', code: 'FS_NOT_FOUND', effects: 'READ_ONLY', originalErrorRetained: true })
      if (needsObservation) record('tool/observation-required', { callId: call.id, name: call.function.name, code: result.error.info.code, effects: 'NOT_EXECUTED', originalErrorRetained: true })
      if (rejectedEdit) record('tool/edit-rejected-before-write', { callId: call.id, name: call.function.name, code: result.error.info.code, effects: 'NOT_EXECUTED', originalErrorRetained: true })
      if (needsObservation || rejectedEdit) repairDeferral = `NOT_EXECUTED: a preceding native file change (${call.id}, ${result.error.info.code}) was rejected before writing. Remaining calls in this batch are deferred. Read the current file and reconsider the change; do not replay successful earlier calls. Submit any still-needed operations as new calls.`
      if (!execution && (result.additionalContexts?.length || result.concludesTurn)) fail('DIRECT_TOOL_EXTRA_CONTEXT_UNSUPPORTED')
      execution?.check()
      return { role: 'tool', tool_call_id: call.id, content: reportContent(execution ? execution.projectResult(result, call.function.name) : textContent(result.content), result.isError ? 'FAILED' : 'RETURNED') }
    },
    close() { stopChange(); disposers.reverse().forEach(dispose => dispose()); owned.disable() },
  }
}

/** Own the request history, serialization and HTTP send; no DSH model-message API is invoked. */
export async function runDirect({ ctx, config, contract, trace, control, persist, execution, journal, continuation, configHash, shouldPause, meter }) {
  const direct = config.direct, history = deepFreeze([
    { role: 'system', content: config.systemPrompt }, { role: 'user', content: taskPrompt(contract.assembly) },
  ])
  let messages = continuation ? deepFreeze([history[0], history[1], ...continuation.history.slice(2)]) : history
  const usedCallIds = new Set(continuation?.usedCallIds ?? [])
  let nextStep = continuation?.nextStep ?? 0, compactions = continuation?.compactions ?? 0
  let forceCompaction = false, overflowRetries = 0
  for (const checkpoint of continuation?.approvedCheckpoints ?? []) contract.approveCheckpoint(checkpoint)
  checkDirectHistory(messages, contract.checkpoints)
  const record = (type, data) => { trace.events.push({ seq: trace.events.length, time: Date.now(), type, data: structuredClone(data) }); persist() }
  const bridge = toolBridge(ctx, contract, control, record, execution, journal)
  const stopAccount = direct.auth === 'deepseek-account'
    ? ctx.on('deepseek-account/signed-out', () => control.abort(new DynamicContextError('DIRECT_ACCOUNT_SIGNED_OUT'))) : () => {}
  const snapshot = async (phase, reportText) => {
    if (!journal) return null
    const state = { configHash, assembly: contract.assembly, contractHash: contract.hash,
      toolFingerprint: toolFingerprint(contract), trace: structuredClone(trace), history: messages,
      usedCallIds: [...usedCallIds], nextStep, compactions, approvedCheckpoints: contract.checkpoints,
      archives: [...journal.archives.values()], runtime: execution ? { ...await execution.snapshot(), requestBase: nextStep } : null,
      ...(reportText === undefined ? {} : { reportText }) }
    return { state, record: journal.checkpoint(phase, state) }
  }
  const summarize = async payload => {
    control.signal.throwIfAborted()
    const body = JSON.stringify(payload)
    if (direct.maxRequestBytes !== null && Buffer.byteLength(body) > direct.maxRequestBytes) fail('DIRECT_REQUEST_BYTE_LIMIT')
    await execution?.beforeAuxiliaryRequest()
    const inputMeasurement = await measureInput(meter, payload, control.signal, config.maxInputTokens)
    const authHeaders = await directAuthHeaders(ctx, direct, control.signal)
    const request = { ordinal: trace.requests.length + 1, purpose: 'compaction', beforeTaskOrdinal: nextStep + 1, payload,
      bodySha256: createHash('sha256').update(body).digest('hex'), inputCharacters: body.length,
      inputBytes: Buffer.byteLength(body), contractHash: contract.hash, validation: 'PASS', status: 'PREPARED',
      finish: null, usage: null, inputMeasurement }
    trace.requests.push(request); persist()
    journal.append('MODEL_PENDING', { purpose: 'compaction', ordinal: request.ordinal, bodySha256: request.bodySha256 })
    request.status = 'SENT'; persist()
    try {
      const response = await fetch(direct.endpoint, { method: 'POST', redirect: 'error', signal: control.signal,
        headers: { 'content-type': 'application/json', ...authHeaders }, body })
      request.httpStatus = response.status
      request.serverRequestId = response.headers.get('x-request-id')?.slice(0, 1024) ?? null
      const completed = await readCompletion(response, { signal: control.signal, model: config.model, direct, maxResponseBytes: direct.maxResponseBytes, onProgress: meter?.observe })
      Object.assign(request, { responseId: completed.responseId, finish: completed.finish, usage: completed.usage,
        responseBytes: completed.responseBytes, status: 'COMPLETE' })
      record('compaction/response', completed)
      control.signal.throwIfAborted()
      return completed
    } catch (error) {
      if (error.directReceipt) request.transportReceipt = structuredClone(error.directReceipt)
      request.status = 'UNKNOWN_OR_FAILED'; request.errorCode = error.code ?? 'DIRECT_COMPACTION_TRANSPORT_FAILED'; persist(); throw error
    }
  }
  try {
    if (continuation?.reportText !== undefined) {
      const last = messages.at(-1)
      if (last?.role !== 'assistant' || last.tool_calls?.length || last.content !== continuation.reportText
          || trace.requests.at(-1)?.finish !== 'stop') fail('DIRECT_RESUME_REPORT_RECEIPT_INVALID')
      record('task/report-recovered', { noModelRequestRepeated: true })
      return continuation.reportText
    }
    execution?.start(contract)
    await snapshot('READY')
    for (let step = nextStep; config.maxRequestsPerTask === null || step < config.maxRequestsPerTask; step++) {
      control.signal.throwIfAborted()
      if (shouldPause?.(step)) {
        if (!journal) fail('DIRECT_PAUSE_REQUIRES_DURABILITY')
        const saved = await snapshot('READY')
        record('task/paused', { nextRequest: step + 1, noPendingEffects: true })
        trace.status = 'PAUSED_AT_CHECKPOINT'; persist()
        saved.state.trace = structuredClone(trace)
        return { paused: true, continuationState: saved.state }
      }
      const compact = direct.compaction
      const newHistoryStart = checkpointData(messages[2] ?? {}) ? 3 : 2
      if (compact?.strategy === 'dsh-native') {
        const recoveringOverflow = forceCompaction
        const result = await compactNativeHistory({ history: messages, contract, journal, execution, count: compactions,
          requests: trace.requests, summarize, onEvent: record, force: forceCompaction })
        forceCompaction = false
        messages = result.history; compactions = result.count
        if (result.actions.length) {
          execution?.checkpoint({ strategy: 'dsh-native', actions: result.actions, pressure: result.measurement.tokens })
          if (!recoveringOverflow) await snapshot('READY')
        }
      } else if (compact && messages.length > 2 && (JSON.stringify(messages.slice(newHistoryStart)).length > compact.triggerCharacters
          || JSON.stringify({ messages, tools: wireTools(contract.schemas) }).length > config.maxContextCharacters)) {
        if (compactions >= compact.maxCompactions) fail('DIRECT_COMPACTION_LIMIT')
        const result = compactDirectHistory({ history: messages, contract, journal, execution,
          approved: contract.checkpoints, count: compactions })
        messages = result.history; compactions++
        const data = { generation: compactions, archive: result.archive, beforeCharacters: result.beforeCharacters, afterCharacters: result.afterCharacters }
        record('history/compacted', data); execution?.checkpoint(data)
        await snapshot('READY')
      }
      const reportOnly = direct.reserveFinalReport && step + 1 === config.maxRequestsPerTask
      const payload = deepFreeze({ ...direct.generation, ...apiParameters(direct), model: config.model, messages,
        ...(contract.schemas.length ? { tools: wireTools(contract.schemas) } : {}),
        ...(reportOnly ? { tool_choice: 'none' } : {}),
        max_tokens: config.maxOutputTokens, stream: true, stream_options: { include_usage: true } })
      contract.checkDirect(payload, messages, step + 1)
      const body = JSON.stringify(payload)
      if (direct.maxRequestBytes !== null && Buffer.byteLength(body) > direct.maxRequestBytes) fail('DIRECT_REQUEST_BYTE_LIMIT')
      const inputMeasurement = await measureInput(meter, payload, control.signal, config.maxInputTokens)
      if (overflowRetries) await execution?.beforeAuxiliaryRequest()
      else await execution?.beforeRequest(step + 1)
      const authHeaders = await directAuthHeaders(ctx, direct, control.signal)
      const request = { ordinal: trace.requests.length + 1, taskOrdinal: step + 1, purpose: 'task', payload: deepFreeze(JSON.parse(body)), bodySha256: createHash('sha256').update(body).digest('hex'),
        inputCharacters: body.length, inputBytes: Buffer.byteLength(body), contractHash: contract.hash,
        validation: 'PASS', status: 'PREPARED', finish: null, usage: null, inputMeasurement }
      trace.requests.push(request); persist()
      journal?.append('MODEL_PENDING', { ordinal: request.ordinal, taskOrdinal: step + 1, bodySha256: request.bodySha256 })
      request.status = 'SENT'; persist()
      try {
        const response = await fetch(direct.endpoint, { method: 'POST', redirect: 'error', signal: control.signal,
          headers: { 'content-type': 'application/json', ...authHeaders }, body })
        request.httpStatus = response.status
        request.serverRequestId = response.headers.get('x-request-id')?.slice(0, 1024) ?? null
        const completed = await readCompletion(response, { signal: control.signal, model: config.model, direct, maxResponseBytes: direct.maxResponseBytes, onProgress: meter?.observe })
        overflowRetries = 0
        request.responseId = completed.responseId
        request.responseMessageSha256 = digest(completed.message)
        request.finish = completed.finish; request.usage = completed.usage; request.responseBytes = completed.responseBytes
        request.status = 'COMPLETE'
        record('assistant/response', completed)
        execution?.assistant(completed)
        control.signal.throwIfAborted()
        const calls = completed.message.tool_calls ?? []
        if (reportOnly && calls.length) fail('DIRECT_REPORT_ONLY_TOOL_CALL_FORBIDDEN')
        // Check batch identities and JSON shapes before the first tool effect;
        // each tool's parameter schema is enforced by the native tool runtime.
        for (const call of calls) {
          if (!contract.assembly.tools.includes(call.function.name) || !execution && !direct.agentlessTools.includes(call.function.name)) fail('DIRECT_MODEL_TOOL_OUTSIDE_CONTRACT')
          if (usedCallIds.has(call.id)) fail('DIRECT_TOOL_CALL_ID_REUSED')
          let args
          try { args = JSON.parse(call.function.arguments) } catch { fail('DIRECT_INVALID_TOOL_ARGUMENT_JSON') }
          if (!args || typeof args !== 'object' || Array.isArray(args)) fail('DIRECT_TOOL_ARGUMENT_OBJECT_REQUIRED')
          const schema = contract.schemas.find(schema => schema.name === call.function.name)
          if (validateJsonSchemaValue(schema.parameters, args).length) fail('DIRECT_TOOL_ARGUMENT_SCHEMA_MISMATCH')
          execution?.authorize(call.function.name, args)
          usedCallIds.add(call.id)
        }
        messages = deepFreeze([...messages, completed.message])
        if (!calls.length) {
          if (!completed.text.trim() || config.maxReportCharacters !== null && completed.text.length > (config.maxReportCharacters ?? 16000)) fail('DIRECT_REPORT_EMPTY_OR_OVER_BUDGET')
          record('task/response-received', { semanticAcceptance: 'NOT_EVALUATED' })
          execution?.endStep()
          nextStep = step + 1
          await snapshot('REPORT_READY', completed.text)
          return completed.text
        }
        let deferred = await execution?.preflight(calls)
        for (let index = 0; index < calls.length; index++) {
          // Earlier effects may create instruction files or change target
          // directories. Revalidate the still-unexecuted suffix, not just pins
          // that existed before the first call in this model response.
          if (index > 0 && !deferred) deferred = await execution?.preflight(calls.slice(index))
          messages = deepFreeze([...messages, await bridge.execute(calls[index], deferred)])
          deferred ||= bridge.takeRepairDeferral()
        }
        execution?.endStep()
        nextStep = step + 1
        await snapshot('READY')
      } catch (error) {
        if (error.code === 'DIRECT_CONTEXT_LENGTH_EXCEEDED' && direct.compaction?.strategy === 'dsh-native' && overflowRetries < 1) {
          request.status = 'REJECTED_CONTEXT_OVERFLOW'; request.errorCode = error.code
          record('compaction/overflow-recovery', { bodySha256: request.bodySha256, retry: ++overflowRetries })
          forceCompaction = true; step--; continue
        }
        if (error.directReceipt) request.transportReceipt = structuredClone(error.directReceipt)
        request.status = 'UNKNOWN_OR_FAILED'; request.errorCode = error.code ?? 'DIRECT_TRANSPORT_OR_EXECUTION_FAILED'; persist(); throw error
      }
    }
    fail('TASK_REQUEST_LIMIT')
  } finally { stopAccount(); bridge.close() }
}
