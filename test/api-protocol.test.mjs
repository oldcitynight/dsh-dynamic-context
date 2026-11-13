import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRuntimeHarness, runtimeProposal } from '../testing/runtime-harness.mjs'
import { startFakeLlama } from '../testing/fake-llama.mjs'
import { checkpointData } from '../checkpoints.mjs'
import { RequestContract, taskPrompt } from '../request-policy.mjs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { FsError } from '@deepseek-ai/dsh-fs'

async function fixture(t, respond, config = {}, setup) {
  const storageRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-api-release-'))), projectRoot = path.join(storageRoot, 'workspace')
  fs.mkdirSync(projectRoot)
  const backend = await startFakeLlama({ respond }), instances = []
  t.after(async () => { for (const h of instances) await h.close(); await backend.close(); fs.rmSync(storageRoot, { recursive: true, force: true }) })
  return { projectRoot, backend, async open() {
    const h = await createRuntimeHarness({ projectRoot, directory: path.join(storageRoot, 'state'), backend, setup,
      config: { storageRoot, ...config, direct: { api: 'deepseek', ...config.direct } } })
    instances.push(h); return h
  } }
}

test('DeepSeek thinking retains exact reasoning through real tool rounds and a restart', async t => {
  const where = await fixture(t, ({ index, payload }) => {
    assert.deepEqual(payload.thinking, { type: 'enabled' }); assert.equal(payload.reasoning_effort, 'high')
    if (index > 1) assert.deepEqual(JSON.parse(payload.messages.at(-1).content).requestBudget, { limit: 4, used: index - 1, remaining: 5 - index, includesCurrentRequest: true, reservedReportOnlyRequest: null })
    if (index > 1) assert.equal(payload.messages.find(row => row.role === 'assistant').reasoning_content, 'FAKE_REASONING_1: inspect evidence first.\n')
    if (index > 2) assert.equal(payload.messages.filter(row => row.role === 'assistant')[1].reasoning_content, 'FAKE_REASONING_2: inspect current state.\n')
    return index < 3 ? { reasoning: `FAKE_REASONING_${index}: ${index === 1 ? 'inspect evidence first.' : 'inspect current state.'}\n`,
      tools: [{ name: 'dynamic_task_status', arguments: {} }] } : { reasoning: 'FAKE_REASONING_3', text: 'Qualified final report.' }
  }, { direct: { durable: true, reasoningEffort: 'high' } })
  const first = await where.open(); first.runner.submit(runtimeProposal(['dynamic_task_status']))
  const paused = await first.runner.runNext({ expectedRevision: 1, pauseAfterRequests: 1 }); await first.close()
  const second = await where.open()
  const result = await second.runner.resumeActive({ expectedRevision: 2, checkpointChecksum: paused.checkpoint.checksum })
  assert.equal(result.report.text, 'Qualified final report.'); assert.equal(where.backend.requests.length, 3)
  assert.equal(result.trace.requests.at(-1).responseId, 'fake-llama-3')
  assert.equal(result.trace.requests.at(-1).usage.prompt_tokens, 100)
})

test('DeepSeek thinking permits an empty reasoning turn and replays an explicit empty field', async t => {
  const where = await fixture(t, ({ index, payload }) => {
    if (index === 1) return { tools: [{ name: 'write', arguments: { file_path: 'result.txt', content: 'exact effect' } }] }
    assert.equal(payload.messages.find(row => row.role === 'assistant').reasoning_content, '')
    return { text: 'Empty reasoning replayed without invented content.' }
  })
  const h = await where.open(); h.runner.submit(runtimeProposal(['write']))
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(fs.readFileSync(path.join(where.projectRoot, 'result.txt'), 'utf8'), 'exact effect')
  assert.equal(result.trace.requests.length, 2)
})

test('a rejected completed stream retains accounting metadata without allowing tool effects', async t => {
  const where = await fixture(t, () => ({ finishReason: 'length', tools: [{ name: 'write', arguments: { file_path: 'never.txt', content: 'must not write' } }] }))
  const h = await where.open(); h.runner.submit(runtimeProposal(['write']))
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }), /DIRECT_REPORT_DID_NOT_STOP_NORMALLY/)
  assert.equal(fs.existsSync(path.join(where.projectRoot, 'never.txt')), false)
  const trace = JSON.parse(fs.readFileSync(path.join(h.runner.config.directory, h.runner.graph.read().graph.state.active.attemptId, 'trace.json')))
  assert.equal(trace.requests[0].transportReceipt.usage.prompt_tokens, 100)
  assert.equal(trace.requests[0].transportReceipt.terminated, true)
  assert.equal(trace.requests[0].status, 'UNKNOWN_OR_FAILED')
})

test('a definitive missing-file read can precede file creation without hiding its original error', async t => {
  const where = await fixture(t, ({ index, payload }) => {
    if (index === 1) return { tools: [{ name: 'read', arguments: { file_path: 'new-file.txt' } }] }
    if (index === 2) {
      assert.match(payload.messages.at(-1).content, /not found/)
      return { tools: [{ name: 'write', arguments: { file_path: 'new-file.txt', content: 'created once' } }] }
    }
    return { text: 'File created after observed absence.' }
  }, { direct: { thinking: { type: 'disabled' } } })
  const h = await where.open(); h.runner.submit(runtimeProposal(['read', 'write']))
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(fs.readFileSync(path.join(where.projectRoot, 'new-file.txt'), 'utf8'), 'created once')
  assert.equal(result.trace.events.find(row => row.type === 'tool/result').data.isError, true)
  assert.equal(result.trace.events.filter(row => row.type === 'tool/missing-file-observed').length, 1)
  assert.equal(result.report.acceptance, 'UNVERIFIED_MODEL_REPORT')
})

test('a native overwrite guard returns a no-effect observation request before a fresh read and intentional retry', async t => {
  const where = await fixture(t, ({ index, payload }) => {
    if (index === 1 || index === 3) return { tools: [{ name: 'write', arguments: { file_path: 'existing.txt', content: 'replacement' } }] }
    if (index === 2) {
      assert.match(payload.messages.at(-1).content, /read the file/)
      assert.equal(fs.readFileSync(path.join(where.projectRoot, 'existing.txt'), 'utf8'), 'original')
      return { tools: [{ name: 'read', arguments: { file_path: 'existing.txt' } }] }
    }
    return { text: 'Updated after a fresh observation.' }
  }, { direct: { thinking: { type: 'disabled' } } })
  fs.writeFileSync(path.join(where.projectRoot, 'existing.txt'), 'original')
  const h = await where.open(); h.runner.submit(runtimeProposal(['read', 'write']))
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(fs.readFileSync(path.join(where.projectRoot, 'existing.txt'), 'utf8'), 'replacement')
  assert.equal(result.trace.events.filter(row => row.type === 'tool/observation-required').length, 1)
  const writes = result.trace.events.filter(row => row.type === 'tool/result' && row.data.name === 'write')
  assert.equal(writes[0].data.isError, true); assert.equal(Boolean(writes[1].data.isError), false)
})

for (const [name, code] of [['read', 'FS_NOT_FOUND'], ['write', 'FS_NOT_OBSERVED'], ['edit', 'FS_STALE_VERSION'], ['edit', 'FS_EDIT_NOT_FOUND'], ['edit', 'FS_AMBIGUOUS_EDIT']]) test(`registered ${name} cannot impersonate a native filesystem recovery error`, async t => {
  const where = await fixture(t, () => ({ tools: [{ name, arguments: {} }] }),
    { allowedTools: [name], direct: { thinking: { type: 'disabled' }, runtime: { modules: ['state'], registeredTools: [name] } } },
    async ctx => ctx.tools.register(defineTool({ name, description: 'Host-owned external fixture', parameters: {},
      output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [] }, execute: async () => { throw new FsError('External failure', code) } })))
  const h = await where.open(); h.runner.submit(runtimeProposal([name]))
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }), /DIRECT_TOOL_EXECUTION_FAILED/)
  assert.equal(where.backend.requests.length, 1)
})

test('a registered tool named read cannot inherit the native read-only Plan classification', async t => {
  let effects = 0
  const where = await fixture(t, () => ({ tools: [{ name: 'read', arguments: {} }] }),
    { allowedTools: ['read'], direct: { runtime: { modules: ['state'], registeredTools: ['read'], plan: true } } },
    async ctx => ctx.tools.register(defineTool({ name: 'read', description: 'External tool with no host read classification', parameters: {},
      output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [] },
      execute: async () => { effects++; return {} } })))
  const h = await where.open(); h.runner.submit(runtimeProposal(['read']))
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }), /DIRECT_RUNTIME_PLAN_READ_ONLY/)
  assert.equal(effects, 0)
})

test('DeepSeek non-thinking sends its explicit toggle and permits normal tool completion', async t => {
  const where = await fixture(t, ({ index, payload }) => {
    assert.deepEqual(payload.thinking, { type: 'disabled' })
    return index === 1 ? { tools: [{ name: 'dynamic_task_status', arguments: {} }] } : { text: 'Non-thinking report.' }
  }, { direct: { thinking: { type: 'disabled' }, generation: { temperature: 0.5 } } })
  const h = await where.open(); h.runner.submit(runtimeProposal(['dynamic_task_status']))
  await h.runner.runNext({ expectedRevision: 1 }); assert.equal(where.backend.errors.length, 0)
})

test('compression archives original reasoning and does not attach it to new checkpoints', async t => {
  const where = await fixture(t, ({ index, payload }) => {
    if (index === 1) return { reasoning: 'FAKE_PRIVATE_REASONING_SOURCE', tools: [{ name: 'read', arguments: { file_path: 'long.txt' } }] }
    const checkpoint = payload.messages.map(checkpointData).find(Boolean)
    assert.ok(checkpoint)
    assert.doesNotMatch(JSON.stringify(checkpoint), /FAKE_PRIVATE_REASONING_SOURCE/)
    if (index === 2) return { reasoning: 'FAKE_READ_ARCHIVE', tools: [{ name: 'dynamic_context_source_read', arguments: {
      archive_id: checkpoint.source.archiveId, message_index: 0, field: 'reasoning_content', length: 100 } }] }
    assert.match(payload.messages.at(-1).content, /FAKE_PRIVATE_REASONING_SOURCE/)
    return { reasoning: 'FAKE_FINAL_REASONING', text: 'Source retained.' }
  }, { allowedTools: ['read', 'dynamic_context_source_read'], maxContextCharacters: 32000,
    direct: { durable: true, compaction: { triggerCharacters: 14000, maxCheckpointCharacters: 10000 } } })
  fs.writeFileSync(path.join(where.projectRoot, 'long.txt'), Array.from({ length: 260 }, (_, i) => `line-${i}: ${'x'.repeat(60)}`).join('\n'))
  const h = await where.open(); h.runner.submit(runtimeProposal(['read', 'dynamic_context_source_read']))
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(result.trace.events.filter(row => row.type === 'history/compacted').length, 1)
  assert.equal(result.report.text, 'Source retained.')
})

test('checkpoint tail locators retrieve exact Unicode source outside the bounded previews', async t => {
  const marker = 'EXACT_ARCHIVED_TAIL_测试🙂'
  const where = await fixture(t, ({ index, payload }) => {
    if (index === 1) return { tools: [{ name: 'read', arguments: { file_path: 'unicode.txt' } }] }
    if (index === 2) {
      const checkpoint = payload.messages.map(checkpointData).find(Boolean), fact = checkpoint.historicalToolFacts.find(row => row.tool === 'read')
      assert.match(fact.resultTailPreview, /EXACT_ARCHIVED_TAIL/)
      assert.ok(fact.sourceRead.tail.offset > 0)
      return { tools: [{ name: 'dynamic_context_source_read', arguments: fact.sourceRead.tail }] }
    }
    assert.match(payload.messages.at(-1).content, /EXACT_ARCHIVED_TAIL_测试🙂/)
    return { text: 'Exact tail recovered using host-provided source locator.' }
  }, { allowedTools: ['read', 'dynamic_context_source_read'], maxContextCharacters: 32000,
    direct: { durable: true, compaction: { triggerCharacters: 14000, maxCheckpointCharacters: 10000 } } })
  fs.writeFileSync(path.join(where.projectRoot, 'unicode.txt'), Array.from({ length: 260 }, (_, i) => `line-${i}: ${'x🙂'.repeat(25)}`).join('\n') + '\n' + marker)
  const h = await where.open(); h.runner.submit(runtimeProposal(['read', 'dynamic_context_source_read']))
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(result.trace.events.filter(row => row.type === 'history/compacted').length, 1)
  assert.equal(result.trace.requests.length, 3)
})

for (const method of ['exact', 'estimate']) test(`input token budget validates the actual pinned payload (method=${method})`, async t => {
  const where = await fixture(t, () => ({ text: 'Should not be requested.' }), { maxInputTokens: 100 })
  const h = await where.open(); h.runner.submit(runtimeProposal([]))
  let measured
  h.runner.registerInputMeter({ version: 'fixture-counter-v1', measure: async payload => {
    assert.equal(Object.isFrozen(payload), true); measured = payload
    return { tokens: 101, method }
  } })
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }), method === 'exact' ? /DIRECT_INPUT_TOKEN_LIMIT/ : /DIRECT_EXACT_INPUT_MEASUREMENT_REQUIRED/)
  assert.equal(measured.messages[1].role, 'user'); assert.equal(where.backend.requests.length, 0)
})

test('input measurement is recorded with its version when the exact budget passes', async t => {
  const where = await fixture(t, () => ({ text: 'Measured report.', reasoning: 'FAKE' }), { maxInputTokens: 100 })
  const h = await where.open(); h.runner.submit(runtimeProposal([]))
  h.runner.registerInputMeter({ version: 'fixture-counter-v1', measure: async () => ({ tokens: 99, method: 'exact' }) })
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.deepEqual(result.trace.requests[0].inputMeasurement, { tokens: 99, method: 'exact', meterVersion: 'fixture-counter-v1' })
})

test('request contract receipts distinguish API thinking, route and input-budget policies', async t => {
  const where = await fixture(t, () => ({ text: 'No request should be sent.' }))
  const h = await where.open(); h.runner.submit(runtimeProposal([])); h.runner.graph.begin({ expectedRevision: 1 })
  const assembly = h.runner.graph.assemble(), seed = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: taskPrompt(assembly) }] })
  const hash = config => new RequestContract({ config, assembly, seed, schemas: [], definitions: [] }).hash
  const original = hash(h.runner.config)
  for (const config of [
    { ...h.runner.config, direct: { ...h.runner.config.direct, thinking: { type: 'disabled' } } },
    { ...h.runner.config, direct: { ...h.runner.config.direct, endpoint: 'https://example.invalid/chat/completions' } },
    { ...h.runner.config, maxInputTokens: 100 },
  ]) assert.notEqual(hash(config), original)
  assert.equal(where.backend.requests.length, 0)
})

test('a configured 32-request window exposes remaining calls and still stops before request 33', async t => {
  const where = await fixture(t, () => ({ tools: [{ name: 'dynamic_task_status', arguments: {} }] }),
    { maxRequestsPerTask: 32, timeoutMs: 30000, maxContextCharacters: 128000, direct: { thinking: { type: 'disabled' } } })
  const h = await where.open(); h.runner.submit(runtimeProposal(['dynamic_task_status']))
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }), /TASK_REQUEST_LIMIT/)
  assert.equal(where.backend.requests.length, 32)
  const active = h.runner.graph.read().graph.state.active
  const trace = JSON.parse(fs.readFileSync(path.join(h.runner.config.directory, active.attemptId, 'trace.json')))
  const last = trace.events.filter(row => row.type === 'tool/result' && row.data.name === 'dynamic_task_status').at(-1)
  assert.deepEqual(last.data.value.requestBudget, { limit: 32, used: 32, remaining: 0, includesCurrentRequest: true, reservedReportOnlyRequest: null })
  assert.equal(h.runner.graph.read().reports.length, 0)
})
