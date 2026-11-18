// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { inflateRawSync, crc32 } from 'node:zlib'
import { located, validationBoundary } from 'dsh-better-task-grapth/validation'
import { realProjectPath } from './artifacts.mjs'
import { snapshotDirectory } from './directory-evidence.mjs'
const sha = data => createHash('sha256').update(data).digest('hex')
const inside = (root, file) => file === root || file.startsWith(root + path.sep)
const reject = (at, reason, extra = {}) => { throw located('DELIVERY_EVIDENCE_INVALID', { path: at, reason, ...extra }) }
function member(name, at) {
  if (!name || name.includes('\\') || name.includes('\0') || path.posix.isAbsolute(name) || /^[a-z]:/i.test(name)
      || name.split('/').some(part => part === '..' || part === '.')) reject(at, 'Use a normalized relative member path without traversal, absolute paths or backslashes.')
  return name
}
// Inspect ZIP32 directly; no extraction, subprocess, model hash calculation or
// traversal is possible. Unsupported encryption/ZIP64/methods fail explicitly.
export function zipInventory(bytes, signal, { maxExpandedBytes = Infinity } = {}) {
  const bad = reason => reject('/executionReport/delivery', reason)
  let end = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break }
  }
  if (end < 0) bad('ZIP end record is missing or truncated.')
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16)
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count
      || count === 65535 || size === 0xffffffff || start === 0xffffffff) bad('Only single-disk ZIP32 is supported; provide an independently hashed extracted delivery for other formats.')
  if (start + size !== end) bad('ZIP central directory boundaries do not match.')
  const entries = [], names = new Set(); let cursor = start, expandedTotal = 0
  for (let i = 0; i < count; i++) {
    signal?.throwIfAborted()
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) bad('ZIP central entry is truncated.')
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), crc = bytes.readUInt32LE(cursor + 16)
    const compressed = bytes.readUInt32LE(cursor + 20), expanded = bytes.readUInt32LE(cursor + 24), length = bytes.readUInt16LE(cursor + 28)
    expandedTotal += expanded
    if (expandedTotal > maxExpandedBytes) bad('ZIP expanded content exceeds this inspection byte limit; inspect a smaller delivery.')
    const extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32), local = bytes.readUInt32LE(cursor + 42)
    if (cursor + 46 + length + extra + comment > end) bad('ZIP member name is truncated.')
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + length)
    if (!(flags & 2048) && nameBytes.some(byte => byte > 127)) bad('Non-ASCII ZIP member names require UTF-8 encoding.')
    let name; try { name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes) } catch { bad('ZIP member name is invalid UTF-8.') }
    member(name, '/executionReport/delivery/items')
    const mode = bytes.readUInt32LE(cursor + 38) >>> 16
    if (names.has(name) || flags & 1 || ![0, 8].includes(method) || (mode & 0xf000) === 0xa000
        || bytes.readUInt16LE(cursor + 34) || [compressed, expanded, local].includes(0xffffffff)) bad('Duplicate, encrypted, linked, split, ZIP64 or unsupported ZIP entry.')
    names.add(name)
    if (local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50) bad('ZIP local header is missing.')
    const localName = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28)
    const dataStart = local + 30 + localName + localExtra
    if (bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method
        || !bytes.subarray(local + 30, local + 30 + localName).equals(nameBytes) || dataStart + compressed > start) bad('ZIP local and central entry identities disagree.')
    let content
    try { content = method === 0 ? bytes.subarray(dataStart, dataStart + compressed)
      : inflateRawSync(bytes.subarray(dataStart, dataStart + compressed), { maxOutputLength: Math.max(1, expanded) }) }
    catch { bad('ZIP member decompression failed.') }
    if (content.length !== expanded || crc32(content) !== crc) bad('ZIP member size or CRC mismatch.')
    entries.push({ path: name, kind: name.endsWith('/') ? 'directory' : 'file', sha256: sha(content) })
    cursor += 46 + length + extra + comment
  }
  if (cursor !== end) bad('ZIP central directory contains unaccounted entries.')
  return entries
}
export function inspectDelivery(runner, report, signal) {
  if (!report.delivery) return null
  const { projectRoot, directory, direct } = runner.config
  const forbidden = [directory, ...(direct.runtime?.privateReadRoots ?? [])].map(root => path.resolve(root))
  const resolve = (relative, dir, at) => validationBoundary({ path: at }, () => {
    const resolved = realProjectPath(projectRoot, path.resolve(projectRoot, relative), { directory: dir })
    if (forbidden.some(root => inside(root, resolved))) reject(at, 'The delivery cannot access private workflow storage.')
    return resolved
  })
  const ids = new Set(), checks = []
  for (const [i, item] of report.delivery.items.entries()) {
    signal.throwIfAborted()
    const at = `/executionReport/delivery/items/${i}`
    if (ids.has(item.id)) reject(at + '/id', 'Delivery IDs must be unique.')
    ids.add(item.id)
    const root = resolve(item.path, item.kind === 'directory', at + '/path')
    const bytes = item.kind === 'file' ? fs.readFileSync(root) : null
    const directorySnapshot = bytes ? null : snapshotDirectory(runner.config, root, signal)
    const identity = bytes ? sha(bytes) : directorySnapshot.sha256
    if (identity !== item.sha256) reject(at + '/sha256', 'The delivered bytes differ from the declared snapshot. Update the report and obtain a new acceptance; do not replace historical hashes.', { expected: item.sha256, observed: identity })
    const zipped = item.kind === 'file' && bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50
    const inventory = zipped ? zipInventory(bytes, signal) : null
    const names = [...new Set([...item.entrypoints, ...item.requiredFiles])]
    const members = names.map(name => {
      member(name, at + '/requiredFiles')
      if (inventory) { const entry = inventory.find(row => row.path === name && row.kind === 'file'); if (!entry) reject(at + '/requiredFiles', 'A declared entrypoint or dependency is missing from the actual archive.', { member: name }); return entry }
      if (item.kind !== 'directory') reject(at + '/requiredFiles', 'Member paths require a directory or a supported ZIP archive; declare a plain file itself as the entrypoint using userSteps.')
      const file = resolve(path.relative(projectRoot, path.join(root, name)), false, at + '/requiredFiles')
      if (!inside(root, file)) reject(at + '/requiredFiles', 'A dependency resolves outside the delivered directory.', { member: name })
      return { path: name, sha256: sha(fs.readFileSync(file)) }
    })
    for (const id of item.testIds) if (!report.tests.some(test => test.id === id)) reject(at + '/testIds', 'Reference tests in this report.', { testId: id })
    let consumer = null
    if (item.consumerCheck) {
      const declared = item.consumerCheck, test = report.tests.find(test => test.id === declared.testId)
      if (!test || !item.testIds.includes(test.id) || test.status !== 'PASS') reject(at + '/consumerCheck/testId', 'A consumer check must reference a PASS test listed for this delivery.')
      const consumerRoot = resolve(declared.root, true, at + '/consumerCheck/root')
      if (inside(root, consumerRoot) || inside(consumerRoot, root) || consumerRoot === fs.realpathSync(projectRoot)) reject(at + '/consumerCheck/root', 'Use a separate consumer directory, not the source delivery or project root.')
      for (const entry of inventory?.filter(row => row.kind === 'file') ?? directorySnapshot?.entries.filter(row => row.kind === 'file') ?? members) {
        const file = resolve(path.relative(projectRoot, path.join(consumerRoot, entry.path)), false, at + '/consumerCheck/root')
        if (!inside(consumerRoot, file) || sha(fs.readFileSync(file)) !== entry.sha256) reject(at + '/consumerCheck/root', 'Consumer input does not match delivered member bytes.', { member: entry.path })
      }
      consumer = { root: consumerRoot, testId: test.id, inputBytesMatched: true, isolation: declared.isolation,
        qualification: 'Input identity checked. The reviewer must verify that the recorded command actually used this directory and did not depend on undeclared developer resources.' }
    }
    checks.push({ ...item, path: root, sha256: identity, members, archive: inventory, consumer,
      qualification: 'Declared delivery identity and members checked; semantic completeness and dependency discovery remain review obligations.' })
  }
  return checks
}
