import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { patchNativeHost } from 'dsh-better-task-grapth/prepare-host'
patchNativeHost(path.resolve(path.dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh/package.json'))), '../..'))
// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs'
import { spawn } from 'node:child_process'
const native = process.argv.slice(2).join(' ') === '--native'
if (process.argv.length > (native ? 3 : 2)) throw new Error('Only --native is supported')
if (native) {
  await import('@deepseek-ai/dsh-llm-pi-ai')
  const { adapterReady } = await import('../adapter-bridge.mjs')
  if (!adapterReady()) throw new Error('Native comparison requires the external context-guard wire hook. The released direct suite needs no adapter patch.')
}
const root = new URL('../', import.meta.url)
const files = fs.readdirSync(new URL('test/', root)).filter(file => file.endsWith('.test.mjs') && file.startsWith('native-') === native)
const child = spawn(process.execPath, ['--test', '--test-concurrency=4', '--test-reporter=tap', '--test-timeout=60000', ...files.map(file => new URL('test/' + file, root).pathname)], { stdio: 'inherit' })
child.once('error', error => { throw error })
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
