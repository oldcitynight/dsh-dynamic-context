import http from 'node:http'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'

/** Independent Messages fixture. Records actual wire bytes, never normalizes
 * requests to Chat Completions and never contacts a model service. */
export function messagesSSE(output = {}, index = 1, model = 'fake-llama') {
  const events = [], send = (type, value = {}) => events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`)
  const usage = output.messagesUsage ?? { input_tokens: 70, cache_read_input_tokens: 30, output_tokens: 10 }
  send('message_start', { message: { id: `fake-messages-${index}`, type: 'message', role: 'assistant', model, content: [],
    stop_reason: null, usage: { ...usage, output_tokens: 0 } } })
  const blocks = output.blocks ?? [...(output.reasoning === undefined ? [] : [{ type: 'thinking', thinking: output.reasoning, signature: output.signature ?? 'fake-signature' }]),
    ...(output.tools ?? []).map((tool, i) => ({ type: 'tool_use', id: tool.id ?? `fake-call-${index}-${i}`, name: tool.name,
      arguments: tool.argumentsText ?? JSON.stringify(tool.arguments ?? {}) })),
    ...(output.text === undefined ? [] : [{ type: 'text', text: output.text }])]
  blocks.forEach((block, i) => {
    const content_block = block.type === 'tool_use' ? { type: block.type, id: block.id, name: block.name, input: {} }
      : block.type === 'thinking' ? { type: block.type, thinking: '' } : { type: block.type, text: '' }
    send('content_block_start', { index: i, content_block })
    if (block.type === 'thinking') {
      send('content_block_delta', { index: i, delta: { type: 'thinking_delta', thinking: block.thinking } })
      if (block.signature !== undefined) send('content_block_delta', { index: i, delta: { type: 'signature_delta', signature: block.signature } })
    } else if (block.type === 'text') send('content_block_delta', { index: i, delta: { type: 'text_delta', text: block.text } })
    else {
      const raw = block.arguments, middle = Math.ceil(raw.length / 2)
      for (const partial_json of [raw.slice(0, middle), raw.slice(middle)])
        send('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json } })
    }
    send('content_block_stop', { index: i })
  })
  send('message_delta', { delta: { stop_reason: output.stopReason ?? (blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn') }, usage })
  send('message_stop')
  return events.join('')
}

export async function startFakeMessages({ respond, maxRequestBytes = 8 * 1024 * 1024, maxRequests = 128 }) {
  const requests = [], errors = []
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || !['/v1/messages', '/anthropic/v1/messages'].includes(req.url)) { res.writeHead(404); res.end(); return }
      const chunks = []; let bytes = 0
      for await (const part of req) { chunks.push(part); bytes += part.length; if (bytes > maxRequestBytes) throw Error('FAKE_REQUEST_LIMIT') }
      const body = Buffer.concat(chunks).toString('utf8')
      const payload = JSON.parse(body), index = requests.length + 1
      if (index > maxRequests || !payload.stream || payload.messages.some(m => !Array.isArray(m.content))
          || payload.reasoning_effort !== undefined || payload.stream_options !== undefined
          || req.headers['anthropic-version'] !== '2023-06-01') throw Error('FAKE_MESSAGES_INVALID_REQUEST')
      const record = { index, path: req.url, headers: req.headers, payload, rawBody: body }
      requests.push(record)
      const output = await respond({ payload, index, record })
      if (output.disconnectBeforeResponse) { res.destroy(); return }
      if (output.hang) return
      if (output.status) { res.writeHead(output.status, output.headers); res.end(output.body ?? ''); return }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const raw = output.rawSSE ?? messagesSSE(output, index, payload.model)
      for (const part of Array.isArray(raw) ? raw : [raw]) {
        if (res.destroyed) return
        res.write(part); if (output.fragmentDelayMs) await delay(output.fragmentDelayMs)
      }
      res.end()
    } catch (error) {
      errors.push(error.message)
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: error.message } }))
    }
  })
  // Long local scenarios can spend time checking files between two HTTP calls.
  // Keep idle test sockets alive until the fixture explicitly closes them.
  server.keepAliveTimeout = 120000
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  return { origin: `http://127.0.0.1:${server.address().port}`, requests, errors,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}
