// SPDX-License-Identifier: GPL-3.0-only
import { symbols } from '@deepseek-ai/cordis'
// DSH 0.2.2 computes model schemas outside the prompt middleware. Filter the
// resolved native admission instead: model descriptions and dispatch see the
// same exact definitions, including agent-local registrations. Other owners and
// native executor selection are preserved. Unloading restores the native API.
const installed = new WeakMap()
export function installToolAdmission(ctx, choose) {
  const service = ctx.tools[symbols.original] ?? ctx.tools
  let state = installed.get(service)
  if (!state) {
    const original = service.resolve, filters = new Set()
    const resolve = async function (context) {
      const native = await original.call(this, context)
      const rules = [...filters].map(rule => rule(context.agent)).filter(Boolean)
      if (!rules.length) return native
      return Object.freeze({ ...native, view(scope) {
        const view = native.view(scope)
        return new Map([...view].filter(([name]) => rules.every(allow => allow.has(name))))
      } })
    }
    state = { original, resolve, filters }; installed.set(service, state); service.resolve = resolve
  }
  state.filters.add(choose)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true; state.filters.delete(choose)
    if (!state.filters.size) {
      if (service.resolve === state.resolve) service.resolve = state.original
      installed.delete(service)
    }
  }
}
