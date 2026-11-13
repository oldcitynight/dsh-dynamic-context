import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startFakeLlama } from '../testing/fake-llama.mjs'
import { runtimeProposal } from '../testing/runtime-harness.mjs'

async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cli-test-'))), projectRoot = path.join(root, 'workspace')
  fs.mkdirSync(projectRoot)
  const backend = await startFakeLlama({ respond: ({ index }) => index === 1
    ? { reasoning: 'FAKE_CLI_REASONING', tools: [{ name: 'write', arguments: { file_path: 'result.txt', content: 'cli effect\n' } }] }
    : { reasoning: 'FAKE_CLI_FINAL', text: 'CLI report, still unverified.' } })
  t.after(async () => { await backend.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const config = { projectRoot, storageRoot: root, directory: path.join(root, 'state'), transport: 'direct', provider: 'api-acceptance', model: 'fake-llama', systemPrompt: 'Keep host policy and task binding.', allowedTools: ['write'],
    direct: { endpoint: backend.origin + '/v1/chat/completions', apiKeyEnv: 'DYNAMIC_CONTEXT_CLI_FIXTURE_KEY', api: 'deepseek', durable: true,
      runtime: { modules: ['filesystem', 'state'], sandboxMode: 'workspace-write', instructionHomes: { dshHome: projectRoot + '/.dsh', agentsHome: projectRoot + '/.agents' } } } }
  const configFile = path.join(root, 'config.json'), proposalFile = path.join(root, 'proposal.json')
  fs.writeFileSync(configFile, JSON.stringify(config)); fs.writeFileSync(proposalFile, JSON.stringify(runtimeProposal(['write'])))
  return { root, projectRoot, backend, invoke(command, options = []) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/cli.mjs', import.meta.url)), command, '--config', configFile, ...options],
        { env: { ...process.env, DYNAMIC_CONTEXT_CLI_FIXTURE_KEY: 'FAKE_SECRET_MUST_NOT_APPEAR' }, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      child.stdout.on('data', data => { output += data.toString() }); child.stderr.on('data', data => { output += data.toString() })
      child.once('error', reject); child.once('exit', code => resolve({ code, output }))
    })
  }, proposalFile }
}

test('API preflight does not request a model, create a workflow or expose a credential', async t => {
  const h = await fixture(t), result = await h.invoke('check')
  assert.equal(result.code, 0, result.output)
  assert.equal(JSON.parse(result.output).networkCalled, false)
  assert.equal(h.backend.requests.length, 0); assert.equal(fs.existsSync(path.join(h.root, 'state')), false)
  assert.doesNotMatch(result.output, /FAKE_SECRET_MUST_NOT_APPEAR/)
})

test('the standalone API runner requires an explicit execute flag', async t => {
  const h = await fixture(t), result = await h.invoke('run', ['--proposal', h.proposalFile, '--output', path.join(h.root, 'audit')])
  assert.notEqual(result.code, 0); assert.match(result.output, /requires --execute/)
  assert.equal(h.backend.requests.length, 0); assert.equal(fs.existsSync(path.join(h.root, 'audit')), false)
})

test('the explicit API runner records real file effects, usage and unverified reports with fake HTTP', async t => {
  const h = await fixture(t), output = path.join(h.root, 'audit')
  const result = await h.invoke('run', ['--proposal', h.proposalFile, '--output', output, '--execute'])
  assert.equal(result.code, 0, result.output)
  assert.equal(h.backend.requests.length, 2)
  assert.equal(fs.readFileSync(path.join(h.projectRoot, 'result.txt'), 'utf8'), 'cli effect\n')
  const evidence = fs.readFileSync(path.join(output, 'execution.json'), 'utf8')
  assert.doesNotMatch(evidence + result.output, /FAKE_SECRET_MUST_NOT_APPEAR/)
  const record = JSON.parse(evidence)
  assert.equal(record.reports[0].acceptance, 'UNVERIFIED_MODEL_REPORT')
  assert.equal(record.usage[0].usage.prompt_tokens, 100); assert.equal(record.goalReached, false)
})
