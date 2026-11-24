// SPDX-License-Identifier: GPL-3.0-only
import crypto from 'node:crypto'
import fs from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { syncBuiltinESMExports } from 'node:module'
import { fileURLToPath } from 'node:url'

const scopes = new AsyncLocalStorage()
const ownFile = fileURLToPath(import.meta.url)
const byteLength = (data, encoding) =>
  typeof data === 'string' ? Buffer.byteLength(data, encoding) : (data?.byteLength ?? 0)
let users = 0
const restore = []

function location() {
  const frames = []
  for (const line of new Error().stack.split('\n').slice(1)) {
    const internal = line.includes(ownFile) || line.includes('node:internal') || line.includes('(node:')
    if (frames.length && (internal || line.trim().startsWith('at async '))) break
    if (!internal) frames.push(line.trim())
    if (frames.length === 3) break
  }
  return frames.join('\n')
}
function sample(scope, action, site, bytes = 0, target, failed = false) {
  const key = action + '\n' + site
  let row = scope.samples.get(key)
  if (!row) scope.samples.set(key, (row = { action, site, calls: 0, bytes: 0 }))
  row.calls++
  row.bytes += bytes
  if (failed) row.failures = (row.failures ?? 0) + 1
  if (target !== undefined) {
    let seen = scope.targets.get(key)
    if (!seen) scope.targets.set(key, (seen = new Set()))
    if (seen.size < 4096) seen.add(String(target))
    row.distinctTargets = seen.size
  }
}
function wrap(target, key, factory) {
  const original = target[key]
  if (typeof original !== 'function') return
  const wrapped = factory(original)
  target[key] = wrapped
  restore.push(() => {
    if (target[key] === wrapped) target[key] = original
  })
}
function install() {
  wrap(
    crypto,
    'createHash',
    (original) =>
      function (algorithm, ...args) {
        const hash = Reflect.apply(original, this, [algorithm, ...args]),
          scope = scopes.getStore()
        if (!scope || !/^sha/i.test(algorithm)) return hash
        const site = location(),
          update = hash.update,
          digest = hash.digest
        let bytes = 0
        hash.update = function (data, encoding) {
          const value = Reflect.apply(update, this, arguments)
          bytes += byteLength(data, encoding)
          return value
        }
        hash.digest = function () {
          const value = Reflect.apply(digest, this, arguments)
          sample(scope, 'hash:' + algorithm.toLowerCase(), site, bytes)
          return value
        }
        return hash
      }
  )
  wrap(
    crypto,
    'hash',
    (original) =>
      function (algorithm, data) {
        const result = Reflect.apply(original, this, arguments),
          scope = scopes.getStore()
        if (scope && /^sha/i.test(algorithm))
          sample(scope, 'hash:' + algorithm.toLowerCase(), location(), byteLength(data))
        return result
      }
  )
  for (const op of ['readFileSync', 'statSync', 'lstatSync', 'readdirSync', 'existsSync'])
    wrap(
      fs,
      op,
      (original) =>
        function () {
          const scope = scopes.getStore()
          if (!scope) return Reflect.apply(original, this, arguments)
          const site = location()
          try {
            const result = Reflect.apply(original, this, arguments)
            sample(scope, op, site, op === 'readFileSync' ? byteLength(result) : 0, arguments[0])
            return result
          } catch (error) {
            sample(scope, op, site, 0, arguments[0], true)
            throw error
          }
        }
    )
  for (const op of ['readFile', 'stat', 'lstat', 'readdir'])
    wrap(
      fs.promises,
      op,
      (original) =>
        function () {
          const result = Reflect.apply(original, this, arguments),
            scope = scopes.getStore()
          if (!scope) return result
          const site = location(),
            target = arguments[0]
          return result.then(
            (data) => {
              sample(scope, op, site, op === 'readFile' ? byteLength(data) : 0, target)
              return data
            },
            (error) => {
              sample(scope, op, site, 0, target, true)
              throw error
            }
          )
        }
    )
  wrap(
    crypto.webcrypto.subtle,
    'digest',
    (original) =>
      function (algorithm, data) {
        const result = Reflect.apply(original, this, arguments),
          scope = scopes.getStore()
        const name = typeof algorithm === 'string' ? algorithm : algorithm?.name
        if (!scope || !/^sha/i.test(name)) return result
        const site = location(),
          length = byteLength(data)
        return result.then((value) => {
          sample(scope, 'hash:' + name.replace('-', '').toLowerCase(), site, length)
          return value
        })
      }
  )
  syncBuiltinESMExports()
}

// Run around one polling tick, resume action or other bounded operation. Exceptions propagate.
export async function monitorHotPath(
  name,
  operation,
  { calls = 32, bytes = 8 * 1024 * 1024, limits = {}, diagnostic, record = true } = {}
) {
  const scope = { samples: new Map(), targets: new Map() }
  if (users++ === 0) install()
  try {
    const value = await scopes.run(scope, operation)
    const samples = [...scope.samples.values()]
    const warnings = samples.filter((row) => {
      const limit = limits[row.action] ?? {}
      return row.calls > (limit.calls ?? calls) || row.bytes > (limit.bytes ?? bytes)
    })
    const status = warnings.length ? 'PASS_WITH_WARNINGS' : 'PASS'
    const report = { name, status, color: warnings.length ? 'yellow' : 'green', warnings, samples }
    if (warnings.length)
      (diagnostic ?? ((message) => process.stderr.write(message + '\n')))(
        '[YELLOW PASS_WITH_WARNINGS] ' +
          name +
          '\n' +
          warnings
            .map((row) => row.action + ' ×' + row.calls + ' (' + row.bytes + ' bytes)\n' + row.site)
            .join('\n')
      )
    if (record && process.env.DSH_PERFORMANCE_REPORT)
      fs.appendFileSync(process.env.DSH_PERFORMANCE_REPORT, JSON.stringify(report) + '\n', { mode: 0o600 })
    return { value, report }
  } finally {
    if (--users === 0) {
      for (const reset of restore.splice(0).reverse()) reset()
      syncBuiltinESMExports()
    }
  }
}
