import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { bridge, composeHooks } from './adapter-bridge.mjs'
import { createHarness } from './testing/harness.mjs'
import { proposal } from './testing/scenario.mjs'

const projectRoot = fs.realpathSync(process.cwd())
const args = process.argv.slice(2)
const directOnly = args.includes('--direct-only'), options = args.filter(arg => arg !== '--direct-only')
if (options.length && (options.length !== 2 || options[0] !== '--output')) throw new Error('Usage: transport-audit.mjs [--direct-only] [--output NEW_DIRECTORY]')
if (!directOnly && globalThis[Symbol.for('dsh.project.contextGuard.adapter.v1')] !== true) throw new Error('Native comparison requires an external context-guard wire hook; use --direct-only for the self-contained release route')
const root = path.resolve(options[1] ?? path.join(projectRoot, '.tmp', `dynamic-context-transport-audit-${Date.now()}`))
if (!root.startsWith(projectRoot + path.sep)) throw new Error('AUDIT_OUTPUT_MUST_BE_IN_PROJECT')
fs.mkdirSync(path.dirname(root), { recursive: true, mode: 0o700 }); fs.mkdirSync(root, { mode: 0o700 })
const conditions = ['baseline', 'extra-tool-provider', 'pre-step-message', 'adapter-payload-replacement', 'complete-prompt-conflict', 'discarded-provider-error']
const results = []
for (const transport of directOnly ? ['direct'] : ['native-guarded', 'direct']) for (const condition of conditions) {
  const directory = path.join(root, transport, condition)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const h = await createHarness({ projectRoot, directory: path.join(directory, 'state'),
    respond: () => ({ text: 'Synthetic audited task report' }), config: { transport } })
  let callbacks = 0, result, failure
  try {
    if (condition === 'extra-tool-provider') h.ctx.systemPrompt.tools(() => {
      callbacks++; return { schemas: [{ name: 'audit_unlisted_tool', description: 'AUDIT_UNAPPROVED_TOOL', parameters: { type: 'object', properties: {}, additionalProperties: false } }] }
    })
    if (condition === 'pre-step-message') h.ctx.on('agent/pre-step', async (_event, next) => {
      callbacks++; const value = await next()
      return value.kind === 'enter' ? { ...value, messages: [...value.messages,
        createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'AUDIT_UNAPPROVED_MESSAGE' }] })] } : value
    })
    if (condition === 'adapter-payload-replacement') h.ctx.on('llm/stream', async function* (_options, next) {
      callbacks++
      const hooks = composeHooks(bridge.getStore()?.hooks, { onPayload: payload => ({ ...payload,
        messages: [...payload.messages, { role: 'user', content: 'AUDIT_UNAPPROVED_WIRE_MESSAGE' }] }) })
      let iterator
      try {
        iterator = bridge.run({ hooks }, () => next()[Symbol.asyncIterator]())
        for (;;) { const item = await bridge.run({ hooks }, () => iterator.next()); if (item.done) return; yield item.value }
      } finally { await bridge.run({ hooks }, () => iterator?.return?.()) }
    })
    if (condition === 'complete-prompt-conflict') h.ctx.systemPrompt.section({ name: 'audit:complete', order: 2, complete: true, text: 'AUDIT_OTHER_COMPLETE' })
    if (condition === 'discarded-provider-error') h.ctx.systemPrompt.section({ name: 'audit:discarded', order: 2,
      text: () => { callbacks++; throw new Error('AUDIT_DISCARDED_PROVIDER_RAN') } })
    h.runner.submit(proposal())
    try { result = await h.runner.runNext({ expectedRevision: 1 }) } catch (error) { failure = error.code ?? 'TASK_FAILED' }
    const expectedComplete = transport === 'direct' || condition === 'baseline'
    const trace = result?.trace ?? JSON.parse(fs.readFileSync(path.join(h.runner.config.directory,
      h.runner.graph.status().active.attemptId, 'trace.json')))
    const wire = h.backend.requests
    const row = { transport, condition, expectedComplete, completed: Boolean(result), failure: failure ?? null,
      httpRequests: wire.length, defaultCallbacksExecuted: callbacks,
      unapprovedInputSent: wire.some(request => /AUDIT_UNAPPROVED|AUDIT_OTHER_COMPLETE/.test(JSON.stringify(request.payload))),
      reportsCommitted: h.runner.graph.read().reports.length, activeRetained: Boolean(h.runner.graph.status().active),
      contractRejection: trace.contractRejection ?? null,
      nativeErrors: transport === 'native-guarded' ? trace.events.filter(event => event.type === 'turn/end' && event.data.reason.kind === 'error').map(event => event.data.reason.error.message) : [],
    }
    assert.equal(row.completed, expectedComplete)
    assert.equal(row.httpRequests, expectedComplete ? 1 : 0)
    assert.equal(row.unapprovedInputSent, false)
    assert.equal(row.reportsCommitted, expectedComplete ? 1 : 0)
    assert.equal(row.activeRetained, !expectedComplete)
    if (transport === 'direct') assert.equal(callbacks, 0)
    row.status = 'PASS'
    fs.writeFileSync(path.join(directory, 'wire-requests.json'), JSON.stringify(wire, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    results.push(row)
  } finally { await h.close() }
}
const summary = { schema: 1, status: 'PASS_TRANSPORT_PROTOTYPE_ONLY', date: new Date().toISOString(),
  dshVersion: JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.resolve('@deepseek-ai/dsh-session')))).version,
  results, cases: results.length, allPassed: true,
  conclusion: 'Native guards reject unexpected inputs but cannot prevent default provider evaluation or complete-prompt conflicts. Direct mode bypasses the tested DSH prompt/Agent-loop/LLM extension paths.',
  limits: ['synthetic backend only', 'no production Web profile installation', 'direct tools require explicit agentless permission; no Agent impersonation or per-Agent sandbox bypass'],
}
fs.writeFileSync(path.join(root, 'verification.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify({ status: summary.status, cases: results.length, verification: path.join(root, 'verification.json') }))
