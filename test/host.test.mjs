import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDirectHost } from '../host.mjs'
import { startFakeLlama } from '../testing/fake-llama.mjs'
import { runtimeProposal } from '../testing/runtime-harness.mjs'

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
