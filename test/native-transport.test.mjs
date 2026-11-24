import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { bridge, composeHooks } from '../adapter-bridge.mjs'
import { createHarness, GLOBAL_PRIVATE, HOST_POLICY } from '../testing/harness.mjs'
import { proposal, scenarioResponse } from '../testing/scenario.mjs'

async function fixture(t, { transport = 'native-guarded', respond = () => ({ text: 'Synthetic report' }), config = {}, contextWindow } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-context-transport-')))
  let h
  t.after(async () => { if (h) await h.close(); fs.rmSync(root, { recursive: true, force: true }) })
  h = await createHarness({ projectRoot: root, directory: path.join(root, 'state'), respond, contextWindow, config: { transport, ...config } })
  return h
}
const extraTool = h => h.ctx.systemPrompt.tools(() => ({ schemas: [{ name: 'probe_unlisted_schema',
  description: 'UNAPPROVED_TOOL_DESCRIPTION', parameters: { type: 'object', properties: {}, additionalProperties: false } }] }))
function preStepMessage(h, { secondOnly = false } = {}) {
  h.ctx.on('agent/pre-step', async (event, next) => {
    const decision = await next()
    if (decision.kind !== 'enter' || secondOnly && event.step !== 2) return decision
    return { ...decision, messages: [...decision.messages, createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'UNAPPROVED_PRESTEP_MESSAGE' }] })] }
  })
}
function payloadHook(h) {
  h.ctx.on('llm/stream', async function* (_options, next) {
    const hooks = composeHooks(bridge.getStore()?.hooks, { onPayload: payload => ({ ...payload,
      messages: [...payload.messages, { role: 'user', content: 'UNAPPROVED_WIRE_MESSAGE' }] }) })
    let iterator
    try {
      iterator = bridge.run({ hooks }, () => next()[Symbol.asyncIterator]())
      for (;;) {
        const item = await bridge.run({ hooks }, () => iterator.next())
        if (item.done) return
        yield item.value
      }
    } finally { await bridge.run({ hooks }, () => iterator?.return?.()) }
  })
}
function failedTrace(h) {
  const attempt = h.runner.graph.status().active.attemptId
  return JSON.parse(fs.readFileSync(path.join(h.runner.config.directory, attempt, 'trace.json')))
}
function assertBlocked(h, count) {
  assert.equal(h.backend.requests.length, count)
  assert.equal(h.runner.graph.read().reports.length, 0)
  assert.ok(h.runner.graph.status().active)
}

for (const [name, install] of [
  ['extra global tool-schema provider', extraTool],
  ['pre-step user message', preStepMessage],
  ['adapter payload replacement', payloadHook],
  ['changed output cap', h => h.ctx.on('agent/request', async (_event, next) => ({ ...await next(), maxTokens: 1 }))],
  ['changed allowed-tool description', h => h.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const value = await next(); return { ...value, tools: value.tools.map(tool => ({ ...tool, description: 'UNAPPROVED_DESCRIPTION_REPLACEMENT' })) }
  })],
]) test(`native final validation blocks ${name} before HTTP`, async t => {
  const h = await fixture(t); install(h); h.runner.submit(proposal())
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }))
  assertBlocked(h, 0)
  assert.ok(failedTrace(h).contractRejection)
})

test('native validation blocks an auxiliary public LLM call made during task pre-step', async t => {
  const h = await fixture(t)
  h.ctx.on('agent/pre-step', async (_event, next) => {
    for await (const chunk of h.ctx.llm.stream({ provider: 'dynamic-context-fake', model: 'fake-llama', maxTokens: 512,
      messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'UNAPPROVED_AUXILIARY_CALL' }] })] })) {}
    return next()
  })
  h.runner.submit(proposal())
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }), /UNAPPROVED_AUXILIARY_MODEL_CALL/)
  assertBlocked(h, 0)
})

test('native validation also checks the second model request after a real tool result', async t => {
  const h = await fixture(t, { respond: scenarioResponse }); preStepMessage(h, { secondOnly: true }); h.runner.submit(proposal())
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }), /REQUEST_UNAPPROVED_MESSAGE/)
  assertBlocked(h, 1)
  assert.deepEqual(h.toolCalls, ['fixture_read_a'])
})

for (const [name, install, error] of [
  ['another complete prompt', h => h.ctx.systemPrompt.section({ name: 'probe:complete', order: 2, complete: true, text: 'OTHER_COMPLETE_POLICY' }), /multiple complete prompt sections/],
  ['a discarded default section callback', h => h.ctx.systemPrompt.section({ name: 'probe:throwing', order: 2,
    text: () => { throw new Error('DISCARDED_DEFAULT_SECTION_EVALUATED') } }), /DISCARDED_DEFAULT_SECTION_EVALUATED/],
]) test(`native plugin suppression cannot prevent ${name} from affecting execution`, async t => {
  const h = await fixture(t); install(h); h.runner.submit(proposal())
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }))
  assertBlocked(h, 0)
  const errorMessage = failedTrace(h).events.findLast(event => event.type === 'turn/end').data.reason.error.message
  assert.match(errorMessage, error)
})

for (const transport of ['native-guarded']) test(`${transport} refuses tool-deferred user context`, async t => {
  const h = await fixture(t, { transport, respond: scenarioResponse })
  h.ctx.on('tools/execute', (exec, next) => {
    exec.deferContext(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'UNAPPROVED_DEFERRED_CONTEXT' }] }))
    return next()
  })
  h.runner.submit(proposal())
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }))
  assertBlocked(h, 1)
  assert.equal(JSON.stringify(h.backend.requests).includes('UNAPPROVED_DEFERRED_CONTEXT'), false)
})

for (const transport of ['native-guarded']) test(`${transport} accepts large host policy and tool schemas`, async t => {
  const h = await fixture(t, { transport, contextWindow: 131072, config: {
    systemPrompt: 'HOST_POLICY_KEEP '.repeat(900), allowedTools: ['fixture_read_a', 'fixture_read_b', 'fixture_large'],
    ...(transport === 'direct' ? { direct: { agentlessTools: ['fixture_read_a', 'fixture_read_b', 'fixture_large'] } } : {}),
  } })
  h.ctx.tools.register(defineTool({ name: 'fixture_large', description: 'large schema description '.repeat(2400), parameters: {},
    output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [] }, execute: async () => ({}) }))
  const p = proposal(); p.contextGraph.bindings[0].tools = ['fixture_large']; h.runner.submit(p)
  assert.ok((await h.runner.runNext({ expectedRevision: 1 })).report.text)
  assert.ok(h.backend.requests.length > 0)
  assert.equal(h.runner.graph.read().reports.length, 1)
})
