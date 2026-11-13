import test from 'node:test'
import assert from 'node:assert/strict'
import { readCompletion } from '../direct-http.mjs'

const options = { signal: new AbortController().signal, model: 'fake', direct: { responseModelAliases: [] }, maxResponseBytes: null }
const frame = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'response-test', model: 'fake', choices: [{ index: 0, delta, finish_reason }] })}\n\n`
const ending = finish => frame({}, finish) + 'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":100,"total_tokens":200}}\n\ndata: [DONE]\n\n'
test('unbounded reception keeps complete large tool arguments and batches beyond the old 16-call ceiling', async () => {
  const args = JSON.stringify({ content: 'x'.repeat(40000) })
  const calls = Array.from({ length: 17 }, (_, index) => ({ index, id: `call-${index}`, type: 'function', function: { name: 'write', arguments: args } }))
  const body = frame({ role: 'assistant', tool_calls: calls }) + ending('tool_calls')
  const response = () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  const result = await readCompletion(response(), options)
  assert.equal(result.message.tool_calls.length, 17)
  assert.ok(result.message.tool_calls.every(call => call.function.arguments === args))
  await assert.rejects(readCompletion(response(), { ...options, maxResponseBytes: 8388608 }), /DIRECT_TOOL_FRAGMENT_LIMIT/)
})
test('native-style idle timeout applies to stalled reads, retaining a partial receipt and cancelling the stream', async () => {
  let cancelled = false
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(frame({ role: 'assistant', content: 'partial' }))) }, cancel() { cancelled = true } })
  const response = new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  await assert.rejects(readCompletion(response, { ...options, direct: { ...options.direct, streamIdleTimeoutMs: 20 } }), error => {
    assert.equal(error.code, 'DIRECT_STREAM_IDLE_TIMEOUT')
    assert.equal(error.directReceipt.responseId, 'response-test')
    assert.equal(error.directReceipt.terminated, false)
    return true
  })
  assert.equal(cancelled, true)
})
