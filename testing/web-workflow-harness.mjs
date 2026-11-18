// Real DSH Web, session RPC and shipped plugin client; fake model HTTP only.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { startFakeLlama } from './fake-llama.mjs'
import { patchNativePresentation } from '../scripts/patch-native-presentation.mjs'

const require = createRequire(import.meta.url)
export async function until(read, accept, label, timeout = 15000) {
  const deadline = Date.now() + timeout
  let value
  while (Date.now() < deadline) { value = await read(); if (accept(value)) return value; await delay(40) }
  throw new Error(label + ': ' + JSON.stringify(value)?.slice(0, 1500))
}
export async function startWorkflowWeb({ respond, root: suppliedRoot, beforeStart } = {}) {
  const root = suppliedRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-web-'))
  const home = path.join(root, 'home'), profile = path.join(home, 'profiles/web'), workspace = path.join(root, 'project')
  for (const directory of [profile, workspace]) fs.mkdirSync(directory, { recursive: true })
  const dynamic = fileURLToPath(new URL('../', import.meta.url))
  const graph = path.dirname(require.resolve('dsh-better-task-grapth'))
  const dshRoot = path.dirname(require.resolve('@deepseek-ai/dsh/package.json'))
  patchNativePresentation(path.resolve(dshRoot, '../..'))
  const modules = path.join(profile, 'node_modules'); fs.mkdirSync(modules)
  for (const [name, target] of [['dsh-dynamic-context', dynamic], ['dsh-better-task-grapth', graph]]) fs.symlinkSync(target, path.join(modules, name), 'dir')
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-better-task-grapth', 'dsh-dynamic-context'] } }, dependencies: {
    'dsh-dynamic-context': 'file:' + dynamic, 'dsh-better-task-grapth': 'file:' + graph,
  } }))
  fs.writeFileSync(path.join(profile, 'cordis.yml'), '[]\n')
  const backend = await startFakeLlama({ respond })
  const config = [
    { insert: [{ id: 'workflow-fixture-answers', name: fileURLToPath(new URL('web-test-driver.mjs', import.meta.url)) }] },
    { id: 'workspace-controller', config: { documentsDirectory: path.join(root, 'Documents') } },
    { id: 'session-title-llm', disabled: true },
    { id: 'llm-deepseek', disabled: true }, { id: 'llm-deepseek-account', disabled: true },
    { id: 'llm-pi-ai', config: { providers: { fixture: { displayName: 'Isolated workflow fixture', apiKeyEnv: 'DSH_WORKFLOW_FIXTURE_KEY',
      api: 'openai-completions', baseURL: backend.origin + '/v1', defaultContextWindow: 32768, defaultMaxTokens: 2048,
      retryPolicy: { mode: 'normal', maxRetries: 0 }, models: [{ id: 'fake-llama', name: 'Fake workflow model', contextWindow: 32768, maxTokens: 2048, input: ['text'] }] } } } },
    { id: 'agent-default-model', config: { provider: 'fixture', model: 'fake-llama' } },
    { id: 'dsh-better-task-grapth', name: 'dsh-better-task-grapth', config: { projectRoot: workspace } },
    { id: 'dsh-dynamic-context', name: 'dsh-dynamic-context', config: { enabled: true, projectRoot: workspace, storageRoot: root,
      directory: path.join(root, 'state'), transport: 'direct', provider: 'fixture', model: 'fake-llama',
      systemPrompt: 'Follow the authorized task; return the scoped result.', interaction: { mode: 'interactive', orchestration: true },
      allowedTools: ['read', 'write'], maxOutputTokens: 2048, timeoutMs: null,
      direct: { endpoint: backend.origin + '/v1/chat/completions', apiKeyEnv: 'DSH_WORKFLOW_FIXTURE_KEY', durable: true,
        runtime: { modules: ['filesystem'], sandboxMode: 'workspace-write', approvalPolicy: 'never', instructionHomes: { dshHome: home, agentsHome: path.join(root, 'agents') } } } } },
  ]
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), JSON.stringify(config, null, 2))
  const env = Object.fromEntries(['PATH', 'HOME', 'LANG'].filter(key => process.env[key]).map(key => [key, process.env[key]]))
  Object.assign(env, { DSH_HOME: home, DSH_AGENTS_HOME: path.join(root, 'agents'), DSH_WORKFLOW_FIXTURE_KEY: 'fake-only',
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'system-state'),
    XDG_DATA_HOME: path.join(root, 'data'), XDG_RUNTIME_DIR: path.join(root, 'run'), TMPDIR: path.join(root, 'tmp') })
  for (const [key, value] of Object.entries(env)) if (key.startsWith('XDG_') || key === 'TMPDIR' || key === 'DSH_AGENTS_HOME') fs.mkdirSync(value, { recursive: true, mode: 0o700 })
  let child, readyUrl, cookie, origin
  const logs = []
  function spawnServer() {
    readyUrl = undefined
    child = spawn(process.execPath, [path.join(dshRoot, 'lib/bin.js'), 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'],
      { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.on('error', error => logs.push(error.message))
    for (const stream of [child.stdout, child.stderr]) {
      let pending = ''
      stream.on('data', chunk => { pending += chunk; const lines = pending.split('\n'); pending = lines.pop()
        for (const line of lines) { logs.push(line); if (line.startsWith('dsh web: http://')) readyUrl = line.slice(9) } })
      stream.on('end', () => { if (pending) logs.push(pending) })
    }
  }
  async function connect() {
    await until(() => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Web stopped (' + child.exitCode + '/' + child.signalCode + '): ' + logs.join('\n'))
      return readyUrl
    }, Boolean, 'Web startup', 45000)
    const auth = await fetch(readyUrl, { redirect: 'manual' })
    cookie = auth.headers.get('set-cookie')?.split(';', 1)[0]
    if (auth.status !== 303 || !cookie) throw new Error('Web authentication failed')
    origin = new URL(readyUrl).origin
  }
  async function stopProcess(signal = 'SIGTERM') {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit'); child.kill(signal)
    await Promise.race([exited, delay(5000, undefined, { ref: false })])
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited }
  }
  async function stop() { await stopProcess(); await backend.close(); if (!suppliedRoot && !process.env.DSH_TEST_KEEP_FIXTURE) fs.rmSync(root, { recursive: true, force: true }) }
  try {
    // Tests can seed an isolated persisted transcript without making any model
    // request. The hook never receives the user's installed profile or session.
    await beforeStart?.({ root, home, workspace })
    spawnServer(); await connect()
    const rpc = async (endpoint, request = {}) => {
      const response = await fetch(`${origin}/api/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, origin },
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint,
          payload: { args: endpoint === 'commands/execute' ? request : endpoint === 'transactionGraphView/status' ? { sessionId: request.sessionId }
            : endpoint.startsWith('transactionGraphView/') ? { sessionId: request.sessionId, request }
            : { [endpoint === 'session/list' ? '_request' : 'request']: request } } }) })
      const body = await response.json()
      if (response.status !== 200) throw new Error(`${endpoint}: HTTP ${response.status}: ${JSON.stringify(body).slice(0, 500)}`)
      return body.result
    }
    const call = async (endpoint, request) => { const result = await rpc(endpoint, request); if (!result.ok) throw new Error(endpoint + ': ' + JSON.stringify(result.error)); return result.value }
    return { root, home, workspace, backend, logs, rpc, call, stop,
      get readyUrl() { return readyUrl }, get origin() { return origin }, get cookie() { return cookie },
      async restart() { await stopProcess('SIGKILL'); spawnServer(); await connect() },
    }
  } catch (error) { await stop(); throw error }
}
