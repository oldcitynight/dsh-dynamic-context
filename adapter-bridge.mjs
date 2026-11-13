import { AsyncLocalStorage } from 'node:async_hooks'

const key = Symbol.for('dsh.project.contextGuard.v1')
export const bridge = globalThis[key] ??= new AsyncLocalStorage()
export const adapterReady = () => globalThis[Symbol.for('dsh.project.contextGuard.adapter.v1')] === true

// Nesting policy middleware must preserve the enclosing policy. Payloads flow
// serially; event callbacks run in the same order, stopping on the first error.
export function composeHooks(parent = {}, own = {}) {
  const hooks = {}
  for (const name of ['onPayload', 'onResponse', 'onProviderStreamEvent']) {
    const callbacks = [parent?.[name], own?.[name]].filter(fn => typeof fn === 'function')
    if (!callbacks.length) continue
    hooks[name] = async (value, meta) => {
      let current = value
      for (const callback of callbacks) {
        const replacement = await callback(current, meta)
        if (name === 'onPayload' && replacement !== undefined) current = replacement
      }
      if (name === 'onPayload') return current
    }
  }
  return hooks
}
