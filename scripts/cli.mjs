#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { validateConfig } from '../index.mjs'
import { createDirectHost, installAccountServices } from '../host.mjs'

const [command, ...args] = process.argv.slice(2), flags = new Map()
if (!['check', 'run', 'resume', 'status'].includes(command)) throw new Error('Usage: dsh-dynamic-context check|run|resume|status --config FILE [--proposal FILE] [--ticket FILE] [--output NEW_DIRECTORY] [--execute]')
for (let i = 0; i < args.length; i++) {
  const name = args[i]
  if (!['--config', '--proposal', '--ticket', '--output', '--execute'].includes(name) || flags.has(name)) throw new Error('Unknown or repeated argument')
  if (name === '--execute') flags.set(name, true)
  else { if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Argument value required'); flags.set(name, args[++i]) }
}
if (!flags.get('--config')) throw new Error('--config is required')
const config = validateConfig({ interaction: { mode: 'host' }, exposeControlTools: false, ...JSON.parse(fs.readFileSync(flags.get('--config'), 'utf8')) })
if (config.interaction.mode !== 'host') throw new Error('The CLI requires interaction.mode=host; interactive mode belongs to native conversations')
if (config.transport !== 'direct' || !config.enabled) throw new Error('An enabled direct configuration is required')
if (/YOUR_|REPLACE|<[^>]+>/.test(config.model)) throw new Error('Configure the explicit model before API acceptance')
let credentialsPresent = config.direct.apiKeyEnv ? Boolean(process.env[config.direct.apiKeyEnv]) : true
if (config.direct.auth === 'deepseek-account') {
  const accountContext = new Context()
  try {
    await installAccountServices(accountContext)
    credentialsPresent = Boolean(await accountContext.deepseekAccount.resolveToken(config.direct.endpoint))
  } finally { await accountContext.fiber.dispose() }
}
if (command === 'check') {
  const root = fs.realpathSync(config.projectRoot), storage = fs.realpathSync(config.storageRoot ?? root)
  const stateRelative = path.relative(storage, path.resolve(config.directory))
  if (root !== path.resolve(config.projectRoot) || storage !== path.resolve(config.storageRoot ?? root)
      || !path.isAbsolute(config.directory) || !stateRelative || stateRelative === '..' || stateRelative.startsWith('..' + path.sep) || path.isAbsolute(stateRelative)) throw new Error('Configure canonical project/storage roots and a state child directory')
  if (root === storage || config.directory === root || config.directory.startsWith(root + path.sep)) throw new Error('State storage must be outside the writable project')
  console.log(JSON.stringify({ status: credentialsPresent ? 'READY_FOR_EXPLICIT_API_EXECUTION' : 'AWAITING_CREDENTIAL',
    model: config.model, endpoint: config.direct.endpoint, credentialsPresent, networkCalled: false, executeRequired: true }))
  process.exitCode = credentialsPresent ? 0 : 2
} else {
  if (['run', 'resume'].includes(command) && (!flags.get('--execute') || !credentialsPresent)) throw new Error('Execution requires --execute and the configured credential or account sign-in')
  let output
  if (['run', 'resume'].includes(command)) {
    if (!flags.get('--output')) throw new Error('--output NEW_DIRECTORY is required')
    output = path.resolve(flags.get('--output'))
    const storage = fs.realpathSync(config.storageRoot ?? config.projectRoot)
    const parent = fs.realpathSync(path.dirname(output)), relative = path.relative(storage, output)
    if (parent !== path.dirname(output) || relative === '' || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Output must be a new canonical child of storageRoot')
    fs.mkdirSync(output, { mode: 0o700 })
  }
  const host = await createDirectHost(config), results = []
  const abort = new AbortController(), stop = () => abort.abort(new Error('API_ACCEPTANCE_INTERRUPTED'))
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  try {
    if (command === 'status') console.log(JSON.stringify(host.runner.status()))
    else {
      if (command === 'run') {
        if (!flags.get('--proposal')) throw new Error('--proposal is required for a new workflow')
        host.runner.submit(JSON.parse(fs.readFileSync(flags.get('--proposal'), 'utf8')))
      } else {
        if (!flags.get('--ticket')) throw new Error('--ticket is required for a resume')
        const ticket = JSON.parse(fs.readFileSync(flags.get('--ticket'), 'utf8'))
        results.push(await host.runner.resumeActive({ expectedRevision: ticket.revision, checkpointChecksum: ticket.checkpoint.checksum, signal: abort.signal }))
      }
      while (host.runner.graph.status().legalNext.length) results.push(await host.runner.runNext({ expectedRevision: host.runner.graph.read().revision, signal: abort.signal }))
      const verification = { status: 'API_EXECUTION_RECORDED_NOT_SEMANTIC_ACCEPTANCE', model: config.model, reports: results.map(result => result.report),
        usage: results.flatMap(result => result.trace.requests.map(request => ({ ordinal: request.ordinal, purpose: request.purpose ?? 'task', taskOrdinal: request.taskOrdinal,
          usage: request.usage, responseId: request.responseId, serverRequestId: request.serverRequestId }))),
        workflow: host.runner.status(), goalReached: false }
      fs.writeFileSync(path.join(output, 'execution.json'), JSON.stringify(verification, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
      console.log(JSON.stringify({ status: verification.status, reports: verification.reports.length, execution: path.join(output, 'execution.json') }))
    }
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); await host.close() }
}
