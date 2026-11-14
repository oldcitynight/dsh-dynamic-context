import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createDirectHost } from '../host.mjs'
import { startFakeLlama } from '../testing/fake-llama.mjs'
import { runtimeProposal } from '../testing/runtime-harness.mjs'

test('the pinned host mounts the concrete account provider with an empty credential store', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-account-host-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = `
    import assert from 'node:assert/strict'
    import { Context } from '@deepseek-ai/cordis'
    import { installAccountServices } from ${JSON.stringify(new URL('../host.mjs', import.meta.url).href)}
    import { directAuthHeaders } from ${JSON.stringify(new URL('../direct-auth.mjs', import.meta.url).href)}
    const ctx = new Context()
    try {
      await installAccountServices(ctx)
      assert.equal(typeof ctx.deepseekAccount.resolveToken, 'function')
      const direct = { auth: 'deepseek-account', api: 'deepseek', endpoint: 'https://api.deepseek.com/chat/completions' }
      await assert.rejects(directAuthHeaders(ctx, direct, new AbortController().signal), /DIRECT_ACCOUNT_SIGN_IN_REQUIRED/)
    } finally { await ctx.fiber.dispose() }
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 10000,
    env: { PATH: process.env.PATH, DSH_HOME: path.join(root, 'dsh'), DSH_AGENTS_HOME: path.join(root, 'agents'),
      DSH_PROJECT_ROOT: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root, XDG_DATA_HOME: root, XDG_STATE_HOME: root },
  })
  assert.equal(result.status, 0, result.stderr || String(result.error ?? result.signal))
})

test('the standalone acceptance host executes real tools through fake DeepSeek HTTP without a native model adapter', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-standalone-'))), projectRoot = path.join(root, 'workspace')
  fs.mkdirSync(projectRoot)
  const backend = await startFakeLlama({ respond: ({ index }) => index === 1 ? { reasoning: 'FAKE_HOST_REASONING', tools: [{ name: 'write', arguments: { file_path: 'result.txt', content: 'standalone effect\n' } }] } : { reasoning: 'FAKE_HOST_FINAL', text: 'Standalone report, unverified.' } })
  const h = await createDirectHost({ projectRoot, storageRoot: root, directory: path.join(root, 'state'), transport: 'direct', provider: 'acceptance-label', model: 'fake-llama', systemPrompt: 'Host constraints remain authoritative.',
    allowedTools: ['write'], direct: { endpoint: backend.origin + '/v1/chat/completions', api: 'deepseek', durable: true,
      runtime: { modules: ['filesystem', 'state'], sandboxMode: 'workspace-write', instructionHomes: { dshHome: projectRoot + '/.dsh', agentsHome: projectRoot + '/.agents' } } } })
  t.after(async () => { await h.close(); await backend.close(); fs.rmSync(root, { recursive: true, force: true }) })
  h.ctx.on('llm/stream', async function* () { throw new Error('Native model API must stay unused') })
  h.runner.submit(runtimeProposal(['write']))
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(result.report.text, 'Standalone report, unverified.')
  assert.equal(fs.readFileSync(path.join(projectRoot, 'result.txt'), 'utf8'), 'standalone effect\n')
  assert.equal(backend.requests[1].payload.messages[2].reasoning_content, 'FAKE_HOST_REASONING')
})

test('standalone restart restores a sealed attempt alongside real native JSONL persistence', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-host-restart-'))), projectRoot = path.join(root, 'workspace')
  fs.mkdirSync(projectRoot)
  const backend = await startFakeLlama({ respond: ({ index }) => index === 1
    ? { reasoning: 'FAKE_FIRST_REASONING', tools: [{ name: 'write', arguments: { file_path: 'once.txt', content: 'only one write\n' } }] }
    : { reasoning: 'FAKE_RESUMED_REASONING', text: 'Restarted report, unverified.' } })
  const config = { projectRoot, storageRoot: root, directory: path.join(root, 'state'), transport: 'direct', provider: 'api-acceptance', model: 'fake-llama', systemPrompt: 'Pinned host constraints.', allowedTools: ['write'],
    direct: { endpoint: backend.origin + '/v1/chat/completions', api: 'deepseek', durable: true,
      runtime: { modules: ['filesystem', 'state'], sandboxMode: 'workspace-write', instructionHomes: { dshHome: projectRoot + '/.dsh', agentsHome: projectRoot + '/.agents' } } } }
  const hosts = []
  t.after(async () => { for (const h of hosts) await h.close(); await backend.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const first = await createDirectHost(config); hosts.push(first)
  first.runner.submit(runtimeProposal(['write']))
  const paused = await first.runner.runNext({ expectedRevision: 1, pauseAfterRequests: 1 }); await first.close()
  const second = await createDirectHost(config); hosts.push(second)
  const result = await second.runner.resumeActive({ expectedRevision: paused.revision, checkpointChecksum: paused.checkpoint.checksum })
  assert.equal(result.report.text, 'Restarted report, unverified.')
  assert.equal(backend.requests.length, 2)
  assert.equal(fs.readFileSync(path.join(projectRoot, 'once.txt'), 'utf8'), 'only one write\n')
})
