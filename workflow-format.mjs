// SPDX-License-Identifier: GPL-3.0-only
// Locate complete JSON values in plugin-owned documents while preserving bytes,
// whitespace, array order, repeated fields and the exact serialized API body.
const space = (c) => c === 32 || c === 9 || c === 10 || c === 13
function skip(b, i) {
  while (i < b.length && space(b[i])) i++
  return i
}
function stringEnd(b, i) {
  for (;;) {
    const next = b.indexOf(34, i + 1)
    if (next < 0) throw Error('UNTERMINATED_JSON_STRING')
    let k = next - 1
    while (b[k] === 92) k--
    if ((next - 1 - k) % 2 === 0) return next + 1
    i = next
  }
}
function endValue(b, i) {
  if (b[i] === 34) return stringEnd(b, i)
  if (b[i] === 123 || b[i] === 91) {
    let depth = 0
    for (; i < b.length; i++) {
      const c = b[i]
      if (c === 34) {
        i = stringEnd(b, i) - 1
        continue
      }
      if (c === 123 || c === 91) depth++
      else if ((c === 125 || c === 93) && --depth === 0) return i + 1
    }
    throw Error('UNTERMINATED_JSON_CONTAINER')
  }
  const start = i
  while (i < b.length && !space(b[i]) && ![44, 93, 125].includes(b[i])) i++
  if (i === start) throw Error('INVALID_JSON_VALUE')
  return i
}
function fields(buf, wanted) {
  let i = skip(buf, 0)
  if (buf[i++] !== 123) return []
  const result = []
  for (;;) {
    i = skip(buf, i)
    if (buf[i] === 125) return result
    if (buf[i] !== 34) throw Error('INVALID_JSON_KEY')
    const end = stringEnd(buf, i)
    const key = buf.toString('utf8', i + 1, end - 1)
    i = skip(buf, end)
    if (buf[i++] !== 58) throw Error('INVALID_JSON_FIELD')
    const start = skip(buf, i)
    i = endValue(buf, start)
    if (wanted[key] && Object.hasOwn(wanted, key)) result.push({ start, end: i, kind: wanted[key] })
    i = skip(buf, i)
    if (buf[i] === 125) return result
    if (buf[i++] !== 44) throw Error('INVALID_JSON_FIELD')
  }
}
function items(buf, kind) {
  let i = skip(buf, 0)
  if (buf[i++] !== 91) return []
  const result = []
  for (;;) {
    const start = skip(buf, i)
    if (buf[start] === 93) return result
    const end = endValue(buf, start)
    result.push({ start, end, kind })
    i = skip(buf, end)
    if (buf[i] === 93) return result
    if (buf[i++] !== 44) throw Error('INVALID_JSON_ARRAY')
  }
}
const selectors = {
  request: { payload: 'wire' },
  wire: { messages: 'history', system: 'system', tools: 'tools' },
  snapshot: { state: 'checkpoint' },
  checkpoint: { history: 'history', trace: 'trace', payloadReferences: 'rows' },
  archive: { messages: 'history' },
  role: { payload: 'wire', calls: 'calls', context: 'context', response: 'response' },
  call: { payload: 'wire', response: 'response' },
  trace: { requests: 'calls', events: 'rows' },
  graph: {
    graph: 'taskGraph',
    contexts: 'contextGraph',
    reports: 'rows',
    sharedContextHistory: 'rows',
    contextHistory: 'rows',
    supervision: 'supervision'
  },
  taskGraph: { state: 'taskState', events: 'rows' },
  taskState: { plan: 'plan' },
  plan: { nodes: 'rows', edges: 'rows' },
  contextGraph: { nodes: 'rows', bindings: 'rows' },
  supervision: { outcomes: 'rows' },
  witness: { committed: 'graph' }
}
const lists = { history: 'message', calls: 'call', rows: 'row' }
export function documentKind(name) {
  if (name === 'graph/state' || name.endsWith('dynamic-context.json')) return 'graph'
  if (name === 'graph/witness') return 'witness'
  const base = name.slice(name.lastIndexOf('/') + 1)
  if (base === 'role.json') return 'role'
  if (base === 'trace.json' || base === 'failure.json') return 'trace'
  return /^(request|snapshot|archive)-/.exec(base)?.[1]
}
export function childSpans(bytes, kind) {
  if (!kind || !['[', '{'].includes(String.fromCharCode(bytes[skip(bytes, 0)]))) return []
  return Object.hasOwn(lists, kind)
    ? items(bytes, lists[kind])
    : Object.hasOwn(selectors, kind)
      ? fields(bytes, selectors[kind])
      : []
}
