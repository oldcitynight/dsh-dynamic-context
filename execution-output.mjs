// SPDX-License-Identifier: GPL-3.0-only
// Display-only journal. Never a source of model messages, execution authority or receipts.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { importWorkflowPerformance } from './performance-history.mjs'

export const OUTPUT_RECORD = 'plugin:dsh-dynamic-context/execution-display-v1'

const noop = () => {}
const inert = { delta: noop, end: noop }
const json = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2)
const contentText = value => Array.isArray(value) ? value.map(block => block.type === 'text' ? block.text : json(block)).join('\n') : json(value)
const stamp = () => new Date().toISOString()
export class ExecutionOutput {
  constructor(directory, warn = noop) {
    this.directory = path.join(directory, 'execution-view-v1'); this.warn = warn
    this.rows = new Map(); this.keys = new Map(); this.pending = new Map(); this.live = new Set()
    this.revision = 0; this.sequence = 0; this.loaded = false; this.warning = null
  }
  safe(fn, fallback) {
    try { return fn() } catch (error) {
      this.warning = 'EXECUTION_DISPLAY_WRITE_FAILED'; this.warn(this.warning); return fallback
    }
  }
  load() {
    if (this.loaded) return
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    for (const name of fs.readdirSync(this.directory).filter(name => /^[\da-f-]{36}\.json$/.test(name))) {
      const row = JSON.parse(fs.readFileSync(path.join(this.directory, name), 'utf8'))
      if (row.id + '.json' !== name || !Number.isSafeInteger(row.revision) || !Number.isSafeInteger(row.sequence)) throw Error('INVALID_DISPLAY_RECORD')
      this.rows.set(row.id, row); this.keys.set(row.key, row.id)
      this.revision = Math.max(this.revision, row.revision); this.sequence = Math.max(this.sequence, row.sequence)
    }
    this.loaded = true
    // A new owner instance never claims an old unfinished stream is still running.
    for (const row of this.rows.values()) if (row.state === 'running') this.end(row.id, 'interrupted')
  }
  create(meta, kind, title, key = randomUUID()) {
    return this.safe(() => {
      this.load()
      if (this.keys.has(key)) return this.keys.get(key)
      const id = randomUUID(), at = meta.at ?? stamp()
      const row = { id, key, sequence: ++this.sequence, revision: 0, at, updatedAt: at,
        stage: String(meta.stage ?? 'EXECUTING').slice(0, 128), step: meta.step ?? 0,
        taskId: meta.taskId ?? null, sessionId: meta.sessionId ?? null,
        kind, title: String(title).slice(0, 256), state: 'running', bytes: 0 }
      this.rows.set(id, row); this.keys.set(key, id); this.live.add(id); this.touch(id)
      return id
    }, null)
  }
  touch(id) {
    const row = this.rows.get(id); if (!row) return
    row.revision = ++this.revision; row.updatedAt = stamp()
    if (!this.pending.has(id)) this.pending.set(id, '')
    this.timer ??= setTimeout(() => { this.timer = null; this.safe(() => this.flush()) }, 150).unref()
  }
  append(id, text) {
    if (!id || !text) return
    this.safe(() => { this.touch(id); this.pending.set(id, (this.pending.get(id) ?? '') + text) })
  }
  end(id, state = 'complete', suffix = '') {
    if (!id) return
    this.safe(() => { const row = this.rows.get(id); if (!row) return
      this.append(id, suffix); row.state = state; this.live.delete(id); this.touch(id)
      this.flush()
    })
  }
  interrupt({ sessionId, prefix } = {}) {
    this.safe(() => {
      for (const row of this.rows.values()) if (row.state === 'running'
          && (sessionId === undefined || row.sessionId === sessionId) && (prefix === undefined || row.key.startsWith(prefix))) this.end(row.id, 'interrupted')
      this.flush()
    })
  }
  flush() {
    clearTimeout(this.timer); this.timer = null
    for (const [id, text] of this.pending) {
      const row = this.rows.get(id), body = path.join(this.directory, id + '.txt')
      // bytes is the committed display boundary; discard an uncommitted append after a crash.
      const fd = fs.openSync(body, fs.existsSync(body) ? 'r+' : 'w', 0o600)
      try { fs.ftruncateSync(fd, row.bytes); if (text) fs.writeSync(fd, Buffer.from(text), 0, Buffer.byteLength(text), row.bytes) } finally { fs.closeSync(fd) }
      const offset = row.bytes
      row.bytes += Buffer.byteLength(text)
      const target = path.join(this.directory, id + '.json'), tmp = target + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(row), { mode: 0o600 }); fs.renameSync(tmp, target)
      this.pending.delete(id)
      this.safe(() => this.publisher?.(row, text, offset, false))
    }
  }
  model(meta, key, measurement) {
    const parent = this.create(meta, 'model', 'Model request', key)
    if (!parent) return inert
    const performance = measurement && this.runner?.ctx.get('dynamicContextPerformance')?.direct(this.runner.controller,
      this.runner.workflowId + ':' + key, { ...measurement, config: this.runner.config,
        source: meta.stage, group: measurement.group ?? key.replace(/:model:\d+$/, '') })
    const children = new Map()
    const delta = ({ text, reasoning, tools } = {}) => {
      performance?.delta({ text, reasoning, tools })
      for (const [kind, value] of [['reasoning', reasoning], ['message', text], ['tool_input', tools?.length ? tools.map(p => (p.function?.name ? '\n' + p.function.name + '\n' : '') + (p.function?.arguments ?? '')).join('') : '']]) {
        if (!value) continue
        if (!children.has(kind)) children.set(kind, this.create(meta, kind, kind, `${parent}:${kind}`))
        this.append(children.get(kind), value)
      }
    }
    return { delta, progress: value => performance?.progress(value), end: (state = 'complete', finish = '', usage) => {
      performance?.end(state, usage)
      for (const id of children.values()) this.end(id, state)
      this.end(parent, state, finish ? json(finish) : '')
    } }
  }
  tool(meta, type, data, prefix) {
    if (!['tool/call', 'tool/result', 'tool/deferred'].includes(type)) return
    if (!prefix.startsWith('native:')) this.runner?.ctx.get('dynamicContextPerformance')?.tool(this.runner.controller, prefix, type, data)
    const key = `${prefix}:tool:${data.callId}`
    const id = this.create(meta, 'tool', data.name ?? 'tool', key)
    const row = this.rows.get(id)
    if (row) row.native = type === 'tool/call'
      ? { callId: data.callId, name: data.name, argsRaw: json(data.arguments) }
      : { ...row.native, content: Array.isArray(data.content ?? data.message?.content) ? data.content ?? data.message.content
          : [{ type: 'text', text: contentText(data.content ?? data.message?.content ?? data) }],
        isError: Boolean(data.isError || data.message?.isError || data.error), ...(data.error ? { error: data.error.info ?? data.error } : {}) }
    if (row && data.meta !== undefined) row.native.meta = data.meta
    if (type === 'tool/call') this.append(id, '[arguments]\n' + json(data.arguments) + '\n')
    else {
      this.append(id, '[result]\n' + contentText(data.content ?? data.message?.content ?? data) + '\n')
      this.end(id, data.isError || data.message?.isError || data.error ? 'error' : 'complete')
    }
  }
  nativeEvent(meta, event) {
    const data = event.data
    if (event.type === 'tool/call' || event.type === 'tool/result') this.tool({ ...meta, step: data.step ?? 0 }, event.type,
      { ...data, callId: data.callId ?? data.message?.toolCallId ?? data.message?.callId ?? data.id }, 'native:' + meta.sessionId)
  }
  publishText(meta, title, text, key) {
    this.safe(() => {
      this.load(); this.flush()
      const id = this.create(meta, 'message', title, key), row = this.rows.get(id)
      if (!row) return
      const body = path.join(this.directory, id + '.txt'), bytes = Buffer.from(text)
      const committed = fs.existsSync(body) ? fs.readFileSync(body).subarray(0, row.bytes) : Buffer.alloc(0)
      if (!bytes.subarray(0, committed.length).equals(committed)) throw Error('DISPLAY_FINAL_REPORT_CHANGED')
      if (row.state === 'complete' && committed.length === bytes.length) return
      this.append(id, bytes.subarray(committed.length).toString('utf8')); this.end(id)
    })
  }
  nativeModel(meta) {
    const model = this.model(meta)
    return { delta(chunk) {
      if (chunk.type === 'text-delta') model.delta({ text: chunk.text })
      if (chunk.type === 'reasoning-delta') model.delta({ reasoning: chunk.text })
      if (chunk.type === 'tool-call-delta') model.delta({ tools: [{ function: { name: chunk.name, arguments: chunk.argumentsDelta } }] })
    }, end: model.end }
  }
  async importHistory(runner) {
    this.load()
    if (this.importing) return this.importing
    // Existing live display journals already cover their history. Import only the
    // pre-observation generation, without rewriting its execution/session files.
    this.importing = (async () => {
      if (this.rows.size) return
      const events = []
      const planner = runner.controller && runner.interaction?.orchestrator.record(runner.controller)?.plannerSessionId
      if (planner) {
        let handle
        try {
          handle = await runner.ctx.get('sessionPersistence').open(planner, 'read')
          if (handle.header.parentSession !== runner.controller.session.id) throw Error('DISPLAY_PARENT_MISMATCH')
          for (const event of (await handle.read()).events) events.push({ source: 'native', sessionId: planner, event, time: event.time })
        } catch { this.warning = 'EXECUTION_HISTORY_PARTIAL' } finally { await handle?.close() }
      }
      const directory = runner.config.directory
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^attempt_[\w-]+$/.test(entry.name)) continue
        const file = path.join(directory, entry.name, 'trace.json')
        if (!fs.existsSync(file)) continue
        try {
          const trace = JSON.parse(fs.readFileSync(file, 'utf8'))
          const nativeResults = new Map((trace.executionEvents ?? []).filter(event => event.type === 'tool/result')
            .map(event => [event.data.message?.source?.callId ?? event.data.message?.toolCallId, event.data]))
          let step = 0
          for (const event of trace.events ?? []) {
            if (event.type === 'assistant/response' || event.type === 'compaction/response') step++
            events.push({ source: 'direct', taskId: trace.assembly?.task.id, sessionId: trace.sessionId,
              prefix: 'direct:' + entry.name, step, event: event.type === 'tool/result' && nativeResults.get(event.data.callId)?.meta !== undefined
                ? { ...event, data: { ...event.data, meta: nativeResults.get(event.data.callId).meta } } : event, time: event.time })
          }
        } catch { this.warning = 'EXECUTION_HISTORY_PARTIAL' }
      }
      const revisions = path.join(directory, 'revisions')
      if (fs.existsSync(revisions)) for (const entry of fs.readdirSync(revisions, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        try {
          const record = JSON.parse(fs.readFileSync(path.join(revisions, entry.name, 'role.json'), 'utf8'))
          for (const call of record.calls ?? []) if (call.response) events.push({ source: 'role',
            stage: call.purpose === 'compaction' ? 'compaction' : record.role, step: call.sequence, prefix: `role:${record.runId ?? entry.name}:${call.sequence}`,
            event: { type: 'assistant/response', data: call.response }, time: Date.parse(record.createdAt ?? record.at) || 0 })
        } catch { this.warning = 'EXECUTION_HISTORY_PARTIAL' }
      }
      if (this.rows.size) return // Live observation won a concurrent historical read.
      for (const item of events.sort((a,b) => a.time - b.time)) {
        const meta = { stage: item.event.type === 'compaction/response' ? 'compaction' : item.stage ?? (item.source === 'native' ? 'PREPLANNING' : 'EXECUTING'),
          taskId: item.taskId, sessionId: item.sessionId, step: item.step ?? item.event.data?.step ?? 0,
          at: new Date(item.time || Date.now()).toISOString() }
        const { event } = item
        if (item.source === 'native') {
          if (['tool/call', 'tool/result'].includes(event.type)) this.nativeEvent(meta, event)
          if (event.type === 'assistant/message') {
            const model = this.model(meta, `history:${item.sessionId}:${event.seq}`)
            for (const block of event.data.message?.content ?? []) {
              if (block.type === 'text') model.delta({ text: block.text })
              if (block.type === 'reasoning') model.delta({ reasoning: block.text })
            }
            model.end()
          }
        } else if (['assistant/response', 'compaction/response'].includes(event.type)) {
          const model = this.model(meta, item.source === 'role' ? item.prefix : `${item.prefix}:model:${item.step}`)
          model.delta({ text: event.data.text, reasoning: event.data.reasoning }); model.end('complete', event.data.finish)
        } else this.tool(meta, event.type, event.data, item.prefix)
      }
      // Historical tool calls without a matching receipt must stay visibly unknown.
      for (const row of this.rows.values()) if (row.state === 'running') this.end(row.id, 'interrupted')
      this.flush()
    })().catch(() => { this.warning = 'EXECUTION_HISTORY_PARTIAL' })
    return this.importing
  }
  bindConversation(runner) {
    this.runner = runner
    const performanceCutoff = Date.now()
    const agent = runner.controller, seen = new Map(), labels = new Map(), initial = agent.session.snapshotEvents()
    const starts = initial.filter(event => event.type === 'turn/start'); let ownerSeq = initial.length
    for (const event of initial) if (event.type === OUTPUT_RECORD && event.ignorable
        && event.data.workflowId === runner.workflowId) seen.set(event.data.row.id, event.data.row.revision)
    const publish = (row, text, offset, reset) => {
      if (runner.closed || runner.ctx.agents.get(agent.id) !== agent || (seen.get(row.id) ?? 0) >= row.revision) return
      if (row.taskId && !labels.has(row.taskId)) {
        try { for (const node of runner.graph.read()?.graph.state.plan.nodes ?? []) labels.set(node.id, node.label) } catch {}
      }
      const { key, ...publicRow } = row
      let native = row.native
      delete publicRow.native
      if (row.kind === 'tool' && !native) {
        const body = fs.readFileSync(path.join(this.directory, row.id + '.txt'), 'utf8'), split = body.indexOf('\n[result]\n')
        const argsRaw = body.slice('[arguments]\n'.length, split < 0 ? body.length : split).trim()
        try { JSON.parse(argsRaw); native = { name: row.title, callId: row.key.split(':tool:').at(-1), argsRaw,
          ...(split < 0 ? {} : { content: [{ type: 'text', text: body.slice(split + '\n[result]\n'.length) }], isError: row.state === 'error' }) } } catch {}
      }
      // A late tool receipt or historical backfill can arrive after turn/end.
      // Keep its native view anchored to the owning turn, not a synthetic turn 0.
      for (const event of agent.session.snapshotEvents(ownerSeq)) {
        if (event.type === 'turn/start') starts.push(event)
        ownerSeq = event.seq + 1
      }
      const ownerTurn = (starts.findLast(event => event.time <= Date.parse(row.at)) ?? starts.at(-1))?.data.turn ?? null
      appendPluginRecord(agent.session, OUTPUT_RECORD, { version: 1, workflowId: runner.workflowId, turn: ownerTurn,
        row: { ...publicRow, taskLabel: labels.get(row.taskId) ?? null }, text, offset, reset,
        ...(native ? { native } : {}) })
      seen.set(row.id, row.revision)
      // Only ignorable log records are emitted. No assistant/user surface message
      // or execution receipt is forged; native Chat supplies all rendering logic.
      void runner.ctx.sessions.flush(agent.session).catch(() => { this.warning = 'EXECUTION_DISPLAY_WRITE_FAILED' })
    }
    queueMicrotask(async () => {
      try { await importWorkflowPerformance(runner, performanceCutoff) }
      catch { this.warning = 'EXECUTION_PERFORMANCE_HISTORY_PARTIAL' }
      try {
        await this.importHistory(runner); this.load(); this.flush()
        this.publisher = publish
        for (const row of this.rows.values()) if ((seen.get(row.id) ?? 0) < row.revision)
          this.publisher(row, fs.readFileSync(path.join(this.directory, row.id + '.txt'), 'utf8'), 0, true)
      } catch { this.warning = 'EXECUTION_HISTORY_PARTIAL' }
    })
  }
  read({ cursor = 0, before } = {}) {
    this.load(); this.flush()
    const all = [...this.rows.values()]
    const initial = !cursor || before !== undefined
    const ordered = initial ? all.filter(row => before === undefined || row.sequence < before).sort((a,b) => b.sequence - a.sequence)
      : all.filter(row => row.revision > cursor).sort((a,b) => a.revision - b.revision)
    const selected = ordered.slice(0, 40)
    const items = selected.map(row => {
      const body = this.slice(row, Math.max(0, row.bytes - 8192), 8192)
      const { key, native, ...publicRow } = row
      return { ...publicRow, preview: body.text, previewOffset: body.offset }
    }).sort((a,b) => a.sequence - b.sequence)
    return { items, cursor: initial ? this.revision : selected.at(-1)?.revision ?? cursor,
      more: !initial && ordered.length > selected.length,
      older: items.length ? all.some(row => row.sequence < items[0].sequence) : false, warning: this.warning }
  }
  slice(row, offset, size) {
    const fd = fs.openSync(path.join(this.directory, row.id + '.txt'), 'r')
    const buffer = Buffer.alloc(Math.min(size + 4, Math.max(0, row.bytes - offset)))
    try { fs.readSync(fd, buffer, 0, buffer.length, offset) } finally { fs.closeSync(fd) }
    let start = 0, end = Math.min(size, buffer.length)
    while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++
    while (end < buffer.length && (buffer[end] & 0xc0) === 0x80) end++
    return { text: buffer.subarray(start, end).toString('utf8'), offset: offset + start, nextOffset: offset + end, totalBytes: row.bytes }
  }
  body({ itemId, offset = 0 }) {
    this.load(); this.flush()
    const row = this.rows.get(itemId)
    if (!row || !Number.isSafeInteger(offset) || offset < 0 || offset > row.bytes) throw Error('EXECUTION_OUTPUT_NOT_FOUND')
    return { itemId, ...this.slice(row, offset, 32768) }
  }
}
