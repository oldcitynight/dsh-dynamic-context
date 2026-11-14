// Isolated fault-injection process; never used by the plugin runtime.
import path from 'node:path'
import { writeSync } from 'node:fs'
import { createRuntimeHarness, runtimeProposal } from './runtime-harness.mjs'
import { DirectJournal } from '../durable-store.mjs'

const [storageRoot, origin, mode] = process.argv.slice(2)
const backend = { origin }
const h = await createRuntimeHarness({ projectRoot: path.join(storageRoot, 'workspace'), directory: path.join(storageRoot, 'state'), backend,
  config: { storageRoot, direct: { durable: true } },
  setup: ctx => {
    if (mode === 'tool-pending') ctx.on('tools/result', (exec, result) => {
      if (exec.name === 'write' && !result.isError) process.kill(process.pid, 'SIGKILL')
    })
  } })
const checkpoint = DirectJournal.prototype.checkpoint
DirectJournal.prototype.checkpoint = function (phase, state) {
  const result = checkpoint.call(this, phase, state)
  if (phase === 'READY' && state.nextStep === 1 && ['safe-ready', 'hold-ready'].includes(mode)) {
    if (mode === 'safe-ready') process.kill(process.pid, 'SIGKILL')
    else {
      writeSync(1, 'READY\n')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
    }
  }
  if (phase === 'REPORT_READY' && mode === 'report-ready') process.kill(process.pid, 'SIGKILL')
  return result
}
try {
  h.runner.submit(runtimeProposal(['write']))
  await h.runner.runNext({ expectedRevision: 1 })
} finally { await h.close() }
