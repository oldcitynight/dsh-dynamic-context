import assert from 'node:assert/strict'

/** Measure the selected validation within one operation without changing its behavior. */
export function watchValidation(t, target, method, { label = method, maxCalls, matches = () => true }) {
  const original = target[method]
  let count = 0, excessAt
  const monitored = t.mock.method(target, method, function (...args) {
    if (matches(...args) && ++count === maxCalls + 1) {
      excessAt = new Error().stack.split('\n').slice(1)
        .filter(frame => !frame.includes('validation-probe.mjs') && !frame.includes('node:internal'))
        .slice(0, 5).join('\n')
    }
    return Reflect.apply(original, this, args)
  })
  return () => {
    monitored.mock.restore()
    assert.ok(count <= maxCalls, `Validation call limit exceeded for ${label} (${count} > ${maxCalls})\n${excessAt}`)
    return count
  }
}
