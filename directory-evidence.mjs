// SPDX-License-Identifier: GPL-3.0-only
import { writeStored, readStored, hasStored } from './workflow-io.mjs'
// Host-owned directory identity. No model-generated exclusions or filesystem effects.
import fs from 'node:fs'
import path from 'node:path'
import { canonical, digest } from 'dsh-better-task-grapth/core'
import { located } from 'dsh-better-task-grapth/validation'
import { realProjectPath, readArtifactIdentity } from './artifacts.mjs'

export const DIRECTORY_HASH_SCHEME = 'dsh-directory-sha256-v1'
export const DIRECTORY_SNAPSHOT_TOOL = 'dynamic_context_directory_snapshot'
export const DIRECTORY_SNAPSHOT_DESCRIPTION = `Compute a host SHA-256 snapshot of an authorized deliverable directory. The path is project-relative. Read-only for project files. The digest covers sorted relative paths, regular-file bytes, directory membership including empty directories, and permission bits; timestamps are excluded. No exclusions are permitted. Symlinks, hard links, special files and protected entries are rejected, not skipped. Copy directory.path/hashScheme/sha256 from the returned receipt into executionReport.directories; omit files/subdirectories for that row. This proves byte identity only, not test success or acceptance. After verifying an intentional deliverable change, obtain a new snapshot. Standard arguments: {"path":"deliverable"}. Response template (angle-bracket values are placeholders, never evidence): {"directory":{"path":"deliverable","hashScheme":"${DIRECTORY_HASH_SCHEME}","sha256":"<host-returned 64 lowercase hex characters>"},"snapshotId":"<receipt ID>","counts":{"files":1,"directories":0},"qualification":"HOST_DIRECTORY_IDENTITY_NOT_SEMANTIC_ACCEPTANCE"}. directories counts descendants, excluding the root. Copy only directory into the report. Known path/content rejections return error and diagnostic.issues with exact paths; correct the requested scope or report and do not invent a successful snapshot.`
export const isDirectoryRequestError = error => /^(?:DIRECTORY_(?:PATH_REQUIRED|OUTSIDE_WORKSPACE|PRIVATE_ENTRY_DENIED|NONREGULAR_ENTRY|HARDLINK_DENIED|CHANGED_DURING_SNAPSHOT)|PATH_OUTSIDE_OWN_PROJECT|PROJECT_SYMLINK_REJECTED|PROJECT_PATH_TYPE_OR_IDENTITY|ARTIFACT_BYTE_LIMIT|ARTIFACT_GREW_DURING_READ|ARTIFACT_CHANGED_OR_HASH_MISMATCH|MODEL_CONTENT_IS_NOT_TRANSACTION_ARTIFACT|ENOENT|EACCES)$/.test(error.code ?? '')
export const DIRECTORY_SNAPSHOT_SCHEMA = { type: 'object', properties: { path: { type: 'string', minLength: 1 } }, required: ['path'], additionalProperties: false }
export const directorySnapshotWireTool = { type: 'function', function: { name: DIRECTORY_SNAPSHOT_TOOL, description: DIRECTORY_SNAPSHOT_DESCRIPTION, parameters: DIRECTORY_SNAPSHOT_SCHEMA } }
const inside = (root, target) => { const relative = path.relative(root, target); return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
const slash = value => value.split(path.sep).join('/')
const compare = (a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))
export const directoryDigest = entries => digest({ hashScheme: DIRECTORY_HASH_SCHEME, entries: [...entries].sort(compare) })
const reject = (code, file, reason, extra = {}) => { throw located(code, { path: '/path', item: file, reason, ...extra }) }
const statFields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'nlink']
const statIdentity = value => Object.fromEntries(statFields.map(key => [key, String(value[key])]))
const protectedName = file => ['.git', '.dsh', '.agents', 'credentials', 'secrets'].includes(path.basename(file).toLowerCase())
  || /^(?:\.env.*|credentials\.json|auth\.json|tokens?\.json)$/i.test(path.basename(file)) || /\.(?:key|pem|p12)$/i.test(file)

export function snapshotDirectory(config, requested, signal, pathGuard) {
  if (typeof requested !== 'string' || !requested.trim()) reject('DIRECTORY_PATH_REQUIRED', requested, 'Provide one nonempty project-relative directory path.')
  const projectRoot = fs.realpathSync(config.projectRoot)
  const root = realProjectPath(projectRoot, path.resolve(projectRoot, requested), { directory: true })
  const forbidden = [config.directory, ...(config.direct?.runtime?.privateReadRoots ?? [])].filter(Boolean).map(value => path.resolve(value))
  const allowedRoot = fs.realpathSync(path.resolve(projectRoot, config.direct?.runtime?.cwd ?? '.'))
  if (!inside(allowedRoot, root)) reject('DIRECTORY_OUTSIDE_WORKSPACE', requested, 'The directory is outside this worker workspace.', { workspace: allowedRoot })
  const ensurePublic = file => {
    pathGuard?.(file)
    if (forbidden.some(folder => inside(folder, file)) || path.relative(projectRoot, file).split(path.sep).some(protectedName))
      reject('DIRECTORY_PRIVATE_ENTRY_DENIED', slash(path.relative(projectRoot, file)), 'This protected entry cannot be included. Select the authorized deliverable subtree; it will not be silently excluded.')
  }
  const entries = [], pins = [], files = [], subdirectories = []
  const walk = folder => {
    signal?.throwIfAborted(); ensurePublic(folder)
    const before = fs.lstatSync(folder, { bigint: true })
    if (!before.isDirectory() || before.isSymbolicLink()) reject('DIRECTORY_NONREGULAR_ENTRY', folder, 'A real directory is required; symbolic links are not followed.')
    entries.push({ path: slash(path.relative(root, folder)), kind: 'directory', mode: Number(before.mode & 0o7777n) })
    pins.push({ file: folder, stat: statIdentity(before) })
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name); ensurePublic(file); signal?.throwIfAborted()
      if (entry.isDirectory()) { subdirectories.push(slash(path.relative(projectRoot, file))); walk(file); continue }
      if (!entry.isFile()) reject('DIRECTORY_NONREGULAR_ENTRY', slash(path.relative(projectRoot, file)), 'Symbolic links and special filesystem entries are not supported; no entry is skipped.')
      const before = fs.lstatSync(file, { bigint: true })
      if (before.nlink !== 1n) reject('DIRECTORY_HARDLINK_DENIED', slash(path.relative(projectRoot, file)), 'Hard-linked files cannot be isolated as deliverable evidence.')
      const relative = slash(path.relative(projectRoot, file)), identity = readArtifactIdentity(projectRoot, { kind: 'artifact', ref: relative }, signal)
      const after = fs.lstatSync(file, { bigint: true })
      if (canonical(statIdentity(before)) !== canonical(statIdentity(after))) reject('DIRECTORY_CHANGED_DURING_SNAPSHOT', relative, 'The file changed while its snapshot was being calculated; wait for writers to finish.')
      entries.push({ path: slash(path.relative(root, file)), kind: 'file', mode: Number(after.mode & 0o7777n), sha256: identity.sha256 })
      files.push({ path: relative, sha256: identity.sha256 }); pins.push({ file, stat: statIdentity(after) })
    }
  }
  walk(root)
  for (const pin of pins) {
    signal?.throwIfAborted()
    if (canonical(pin.stat) !== canonical(statIdentity(fs.lstatSync(pin.file, { bigint: true }))))
      reject('DIRECTORY_CHANGED_DURING_SNAPSHOT', slash(path.relative(projectRoot, pin.file)), 'Directory membership or file identity changed while the snapshot was being calculated.')
  }
  entries.sort(compare); files.sort(compare); subdirectories.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
  return { path: slash(path.relative(projectRoot, root)) || '.', hashScheme: DIRECTORY_HASH_SCHEME,
    sha256: directoryDigest(entries), entries, files, subdirectories }
}
const snapshotId = (relative, hash) => digest({ path: relative, hashScheme: DIRECTORY_HASH_SCHEME, sha256: hash })
const storePath = (config, relative, hash) => path.join(config.directory, 'directory-snapshots', snapshotId(relative, hash) + '.json')
export function issueDirectorySnapshot(config, requested, signal, pathGuard) {
  const snapshot = snapshotDirectory(config, requested, signal, pathGuard)
  const { path: relative, hashScheme, sha256, entries } = snapshot
  const body = { path: relative, hashScheme, sha256, entries }, record = { ...body, checksum: digest(body) }
  const file = storePath(config, relative, sha256)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  if (hasStored(file)) {
    if (canonical(JSON.parse(readStored(file, 'utf8'))) !== canonical(record)) reject('DIRECTORY_SNAPSHOT_RECEIPT_CHANGED', relative, 'The saved directory receipt differs from its immutable content.')
  } else if (!writeStored(file, JSON.stringify(record), {exclusive:true})) {
    const fd = fs.openSync(file, 'wx', 0o600)
    try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir) } finally { fs.closeSync(dir) }
  }
  return { directory: { path: relative, hashScheme, sha256 }, snapshotId: snapshotId(relative, sha256),
    counts: { files: snapshot.files.length, directories: snapshot.subdirectories.length },
    qualification: 'HOST_DIRECTORY_IDENTITY_NOT_SEMANTIC_ACCEPTANCE' }
}
export function directoryDifference(config, current, expectedHash) {
  const file = storePath(config, current.path, expectedHash)
  if (!hasStored(file)) return { baselineAvailable: false }
  const { checksum, ...before } = JSON.parse(readStored(file, 'utf8'))
  if (digest(before) !== checksum || before.hashScheme !== DIRECTORY_HASH_SCHEME || before.path !== current.path
      || before.sha256 !== expectedHash || directoryDigest(before.entries) !== expectedHash)
    reject('DIRECTORY_SNAPSHOT_RECEIPT_CHANGED', current.path, 'The original directory receipt failed its integrity check.')
  const old = new Map(before.entries.map(row => [row.path, row])), now = new Map(current.entries.map(row => [row.path, row]))
  return { baselineAvailable: true, added: [...now.keys()].filter(key => !old.has(key)), removed: [...old.keys()].filter(key => !now.has(key)),
    changed: [...now.keys()].filter(key => old.has(key) && canonical(old.get(key)) !== canonical(now.get(key))).map(key => ({ path: key,
      fields: ['kind', 'mode', 'sha256'].filter(field => old.get(key)[field] !== now.get(key)[field]) })) }
}
