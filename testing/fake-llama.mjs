import http from 'node:http'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'

/** Synthetic llama-compatible HTTP/SSE server. It never loads a model or forwards traffic. */
export async function startFakeLlama({ respond, maxRequests = 64, maxRequestBytes = 1024 * 1024, contextWindow, countInputTokens }) {
  if (contextWindow && typeof countInputTokens !== 'function') throw Error('FAKE_WINDOW_REQUIRES_TOKEN_COUNTER')
  const requests = [], errors = [], routes = []
  const server = http.createServer(async (req, res) => {
    try {
      routes.push({ method: req.method, path: req.url })
      if (req.method === 'GET' && req.url === '/health') {
        res.setHeader('content-type', 'application/json'); res.end('{"status":"ok","synthetic":true}'); return
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404); res.end(); return
      }
      let bytes = 0, body = ''
      for await (const chunk of req) {
        bytes += chunk.length
        if (bytes > maxRequestBytes) throw new Error('FAKE_LLAMA_REQUEST_BYTE_LIMIT')
        body += chunk
      }
      const payload = JSON.parse(body), index = requests.length + 1
      if (index > maxRequests || payload.stream !== true || !Array.isArray(payload.messages)) throw new Error('FAKE_LLAMA_UNEXPECTED_REQUEST')
      const record = { index, method: req.method, path: req.url, payload, rawBody: body, completed: false }
      requests.push(record)
      if (contextWindow) {
        record.windowInputTokens = await countInputTokens(payload)
        if (record.windowInputTokens + payload.max_tokens > contextWindow) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { code: 'context_length_exceeded', message: `This model's maximum context length is ${contextWindow} tokens. However, you requested ${record.windowInputTokens + payload.max_tokens} tokens.` } }))
          return
        }
      }
      const output = await respond({ payload, index, record })
      if (output.hang) return
      if (output.status) { res.writeHead(output.status, output.headers); res.end(output.body ?? ''); return }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      if (output.rawSSE !== undefined) {
        for (const chunk of Array.isArray(output.rawSSE) ? output.rawSSE : [output.rawSSE]) {
          if (res.destroyed) return
          res.write(chunk)
          if (output.fragmentDelayMs) await delay(output.fragmentDelayMs)
        }
        record.completed = true; res.end(); return
      }
      const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
        id: `fake-llama-${index}`, object: 'chat.completion.chunk', created: 1,
        model: payload.model, choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`)
      send({ role: 'assistant' })
      if (output.reasoning !== undefined) send({ reasoning_content: output.reasoning })
      for (const [i, tool] of (output.tools ?? []).entries()) {
        const args = tool.argumentsText ?? JSON.stringify(tool.arguments ?? {}), midpoint = Math.ceil(args.length / 2)
        send({ tool_calls: [{ index: i, id: tool.id ?? `fake-call-${index}-${i}`, type: 'function',
          function: { name: tool.name, arguments: args.slice(0, midpoint) } }] })
        send({ tool_calls: [{ index: i, function: { arguments: args.slice(midpoint) } }] })
      }
      if (output.text !== undefined) send({ content: output.text })
      if (output.disconnect) { res.destroy(); return }
      send({}, output.finishReason ?? (output.tools?.length ? 'tool_calls' : 'stop'))
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`)
      record.completed = true
      res.end('data: [DONE]\n\n')
    } catch (error) {
      errors.push(error.message)
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: error.message, type: 'synthetic_backend_error' } }))
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { origin: `http://127.0.0.1:${server.address().port}`, requests, errors, routes,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) },
  }
}
