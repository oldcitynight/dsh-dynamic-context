// SPDX-License-Identifier: GPL-3.0-only
// Backport the native ignorable-record writer to exact pre-API DSH builds.
// The existing Session append publication path is reused byte-for-byte; native
// surface messages, sequence numbers, JSON snapshots and reentrancy stay native.
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
const digest = value => createHash('sha256').update(value).digest('hex')
export const nativeSessionHashes = Object.freeze({"0.1.7-rc.2": "c7edbf46b9af2a50114ac396596870eaf8bf7ad2970618ec6c5221b053bb5523"})
const methodStart = '\n\t/* dsh-plugin-record-backport-v1:start */\n'
const methodEnd = '\n\t/* dsh-plugin-record-backport-v1:end */\n'
const exportStart = '\n/* dsh-plugin-record-backport-export-v1:start */\n'
const exportEnd = '\n/* dsh-plugin-record-backport-export-v1:end */\n'
function removeBlock(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end)
  if (a < 0 && b < 0) return source
  if (a < 0 || b < a || source.indexOf(start, a + start.length) >= 0 || source.indexOf(end, b + end.length) >= 0)
    throw Error('NATIVE_SESSION_ADAPTER_PARTIAL_PATCH')
  return source.slice(0, a) + source.slice(b + end.length)
}
export function restoreNativeSessionSource(source) {
  return removeBlock(removeBlock(source, methodStart, methodEnd), exportStart, exportEnd)
}
export function patchNativeSession(modules) {
  const directory = path.join(modules, '@deepseek-ai/dsh-session')
  const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json')))
  if (!Object.hasOwn(nativeSessionHashes, pkg.version)) throw Error('NATIVE_SESSION_ADAPTER_VERSION_UNSUPPORTED:' + pkg.version)
  const file = path.join(directory, 'lib/index.js'), source = fs.readFileSync(file, 'utf8')
  const restored = restoreNativeSessionSource(source)
  if (digest(restored) !== nativeSessionHashes[pkg.version]) throw Error('NATIVE_SESSION_ADAPTER_SOURCE_CHANGED')
  const head = '\tappend(type, data, ...opts) {'
  const start = restored.indexOf(head), end = restored.indexOf('\n\t}', start) + 3
  if (start < 0 || end <= start || restored.indexOf(head, start + head.length) >= 0) throw Error('NATIVE_SESSION_ADAPTER_LAYOUT_CHANGED')
  const original = restored.slice(start, end)
  let method = original.replace(head, '\t__dshPluginRecord(type, data) {')
  const metadataStart = method.indexOf('\n\t\tconst surfaceOpts = opts[0];'), metadataEnd = method.indexOf('\n\t\tconst dataSnapshot', metadataStart)
  if (metadataStart < 0 || metadataEnd < metadataStart) throw Error('NATIVE_SESSION_ADAPTER_LAYOUT_CHANGED')
  method = method.slice(0, metadataStart) + '\n\t\tif (typeof type !== "string" || !/^plugin:[a-z][a-z0-9-]*\\/[a-z][a-z0-9-]*$/.test(type)) throw new Error("invalid plugin record type");' + method.slice(metadataEnd)
  const snapshotStart = method.indexOf('\n\t\tconst surfaceMetadataSnapshot'), snapshotEnd = method.indexOf('\n\t\tconst entry =', snapshotStart)
  if (snapshotStart < 0 || snapshotEnd < snapshotStart) throw Error('NATIVE_SESSION_ADAPTER_LAYOUT_CHANGED')
  method = method.slice(0, snapshotStart) + method.slice(snapshotEnd)
  method = method.replace('...surfaceMetadataSnapshot', 'ignorable: true')
    .replace('\n\t\tvalidateSessionEventData(event, `session event "${type}" at seq ${event.seq}`);', '')
    .replace('return event;', 'return event.seq;')
  if (method.includes('surfaceMetadata') || method.includes('validateSessionEventData(') || !method.includes('return event.seq;')) throw Error('NATIVE_SESSION_ADAPTER_LAYOUT_CHANGED')
  const wrapper = 'export function appendPluginRecord(session, type, data) {\n'
    + '\tif (!(session instanceof Session)) throw new TypeError("native Session required");\n'
    + '\treturn session.__dshPluginRecord(type, data);\n}\n'
  const patched = restored.slice(0, start) + methodStart + method + methodEnd + restored.slice(start) + exportStart + wrapper + exportEnd
  if (source !== restored && source !== patched) throw Error('NATIVE_SESSION_ADAPTER_PARTIAL_PATCH')
  if (source !== patched) {
    const tmp = file + '.' + randomUUID() + '.tmp'
    fs.writeFileSync(tmp, patched); fs.renameSync(tmp, file)
  }
  return { version: pkg.version, file, upstreamSHA256: digest(restored), patchedSHA256: digest(patched), changed: source !== patched }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw Error('Usage: node patch-native-session.mjs /path/to/runtime/node_modules')
  process.stdout.write(JSON.stringify(patchNativeSession(path.resolve(process.argv[2]))) + '\n')
}
