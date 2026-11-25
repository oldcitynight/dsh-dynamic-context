// SPDX-License-Identifier: GPL-3.0-only
import { needsReleaseUpdate } from 'dsh-better-task-grapth/workflow-compatibility'
import { Worker } from 'node:worker_threads'
import { setTimeout as delay } from 'node:timers/promises'
import fs from 'node:fs'
import path from 'node:path'
import { WorkflowDatabase, privateFile, sha256, storageError, withStorageLock } from './workflow-database.mjs'
import { backupWorkflow } from './workflow-backup.mjs'
import { isManagedRecord } from './workflow-record-paths.mjs'

const instances = new Map()
const markerName = '.workflow-storage-v1'
const syncDir = (dir) => {
  const fd = fs.openSync(dir, 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}
function checkDir(root, directory) {
  if (!path.isAbsolute(root) || fs.realpathSync(root) !== root || !path.isAbsolute(directory))
    storageError('EXPLICIT_ABSOLUTE_STORE_ROOT_REQUIRED')
  const rel = path.relative(root, directory)
  if (!rel || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel))
    storageError('STORE_OUTSIDE_PROJECT')
  let current = root
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part)
    try {
      fs.mkdirSync(current, { mode: 0o700 })
      syncDir(path.dirname(current))
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    if (!fs.lstatSync(current).isDirectory()) storageError('INVALID_STORE_DIRECTORY')
  }
}
function nativeLookup(home) {
  const originals = path.join(home, 'attachments/v1/objects'),
    cache = path.join(home, 'cache/attachments/request-images')
  let cached = new Map(),
    refreshed = 0
  return (hash, size) => {
    const orig = path.join(originals, hash.slice(0, 2), hash)
    if (fs.existsSync(orig) && fs.realpathSync(orig) === orig) return orig
    if (!fs.existsSync(cache) || fs.realpathSync(cache) !== cache) return
    if (Date.now() - refreshed > 30000) {
      cached = new Map()
      refreshed = Date.now()
      for (const prefix of fs.readdirSync(cache, { withFileTypes: true }))
        if (prefix.isDirectory() && /^[0-9a-f]{2}$/.test(prefix.name)) {
          const folder = path.join(cache, prefix.name)
          for (const ent of fs.readdirSync(folder, { withFileTypes: true }))
            if (ent.isFile() && /^[a-f0-9]{64}(?:\.[a-z]+)?$/.test(ent.name)) {
              const file = path.join(folder, ent.name),
                stat = fs.statSync(file, { throwIfNoEntry: false })
              if (!stat) continue
              const bucket = cached.get(stat.size) ?? []
              bucket.push(file)
              cached.set(stat.size, bucket)
            }
        }
    }
    return cached.get(size)?.find((file) => {
      try {
        return fs.realpathSync(file) === file && sha256(fs.readFileSync(file)) === hash
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        return false
      }
    })
  }
}
const exists = (file) => Boolean(fs.lstatSync(file, { throwIfNoEntry: false }))

// Prior file-store readers expect a bare SQLite binding in this marker and reject the
// tagged form. A pre-epoch reader therefore cannot silently resume a frozen file graph.
const fileReleaseTag = 'files-compatibility-v1\n'
function fileRelease(marker, binding) {
  privateFile(marker)
  const body = fs.readFileSync(marker, 'utf8')
  if (body === binding + '\n') return null
  if (!body.startsWith(fileReleaseTag)) storageError('WORKFLOW_STORAGE_IDENTITY_MISMATCH')
  const value = JSON.parse(body.slice(fileReleaseTag.length))
  if (value?.binding !== binding || !value.release) storageError('WORKFLOW_STORAGE_IDENTITY_MISMATCH')
  return value.release
}

export function hasFrozenWorkflow({ directory }, storage) {
  return storage ? storage.db.q('PRAGMA user_version').get().user_version === 2 : exists(path.join(directory, markerName))
}

export function admitWorkflowRelease({ projectRoot, storageRoot = projectRoot, directory }, storage, installed, { checkOnly = false, beforeFirstFreeze } = {}) {
  if (storage) {
    const db = storage.db
    db.check()
    const read = () => {
      if (db.q('PRAGMA user_version').get().user_version === 1) return undefined
      const value = db.q('SELECT workflow_release AS release FROM instance WHERE id=1').get()?.release
      if (!value) storageError('WORKFLOW_FROZEN_RELEASE_MISSING')
      return JSON.parse(value)
    }
    if (!needsReleaseUpdate(read(), installed) || checkOnly) return
    // Recheck under the writer lock. The schema flag also fences pre-epoch readers.
    return db.transaction(() => {
      const saved = read()
      if (!needsReleaseUpdate(saved, installed)) return
      if (!saved) {
        beforeFirstFreeze?.()
        db.db.exec('ALTER TABLE instance ADD COLUMN workflow_release TEXT; PRAGMA user_version=2')
      }
      db.q('UPDATE instance SET workflow_release=? WHERE id=1').run(JSON.stringify(installed))
    })
  }
  const marker = path.join(directory, markerName), binding = sha256(JSON.stringify([storageRoot, directory]))
  return withStorageLock(path.join(directory, '.workflow-open.lock'), false, 3000, 'WORKFLOW_STORAGE_INITIALIZATION_BUSY', () => {
    const saved = exists(marker) ? fileRelease(marker, binding) : undefined
    if (saved === null || exists(path.join(directory, 'workflow.sqlite')) || exists(path.join(directory, '.workflow-init-v1')))
      storageError('WORKFLOW_STORAGE_FORMAT_CONFLICT')
    if (!needsReleaseUpdate(saved, installed) || checkOnly) return
    if (!saved) beforeFirstFreeze?.()
    const pending = path.join(directory, '.workflow-file-release-pending')
    if (exists(pending)) { privateFile(pending); fs.unlinkSync(pending) }
    const fd = fs.openSync(pending, 'wx', 0o600)
    try {
      fs.writeFileSync(fd, fileReleaseTag + JSON.stringify({ binding, release: installed }) + '\n')
      fs.fsyncSync(fd)
    } finally { fs.closeSync(fd) }
    fs.renameSync(pending, marker)
    syncDir(directory)
  })
}

function selectDatabase(directory, storageRoot, storageFormat, binding) {
  const marker = path.join(directory, markerName)
  const file = path.join(directory, 'workflow.sqlite')
  const staging = path.join(directory, '.workflow-init-v1')
  const options = { mediaLookup: nativeLookup(storageRoot) }
  function openMarked() {
    if (fileRelease(marker, binding)) {
      if (storageFormat === 'sqlite' || exists(file) || exists(staging)) storageError('WORKFLOW_STORAGE_FORMAT_CONFLICT')
      return null
    }
    if (!exists(file)) storageError('WORKFLOW_STORAGE_DATABASE_MISSING')
    if (storageFormat === 'files') storageError('WORKFLOW_STORAGE_FORMAT_CONFLICT')
    return new WorkflowDatabase(directory, binding, options)
  }
  if (exists(marker) && !exists(staging)) return openMarked()
  const graphBinding = sha256(
    JSON.stringify({ directory, file: 'dynamic-context.json', projectRoot: storageRoot })
  )
  const witness = path.join(storageRoot, '.dsh/workflow-witnesses-v1', graphBinding, 'witness.json')
  function hasLegacy() {
    if (exists(witness)) return true
    return fs.readdirSync(directory).some((name) => {
      if (
        [
          markerName,
          '.workflow-open.lock',
          '.workflow-open.lock-journal',
          '.workflow-init-v1',
          'workflow.sqlite',
          'workflow.sqlite-wal',
          'workflow.sqlite-shm'
        ].includes(name)
      )
        return false
      return (
        name !== 'native-sessions' ||
        !fs.lstatSync(path.join(directory, name)).isDirectory() ||
        fs.readdirSync(path.join(directory, name)).length > 0
      )
    })
  }
  if (!exists(file) && !exists(staging) && !exists(marker) && (storageFormat === 'files' || hasLegacy()))
    return null
  // Two processes may mount a conversation at once. The lock releases on process exit.
  return withStorageLock(
    path.join(directory, '.workflow-open.lock'),
    false,
    3000,
    'WORKFLOW_STORAGE_INITIALIZATION_BUSY',
    () => {
      const staged = exists(staging)
      if (staged && !fs.lstatSync(staging).isDirectory()) storageError('WORKFLOW_STORAGE_UNSAFE_FILE')
      if (!exists(marker) && exists(file) && !staged)
        storageError('WORKFLOW_STORAGE_INITIALIZATION_INCOMPLETE')
      if (!exists(marker) && !staged && (storageFormat === 'files' || hasLegacy())) return null
      if (exists(marker) && !staged) return openMarked()
      if (storageFormat === 'files') storageError('WORKFLOW_STORAGE_FORMAT_CONFLICT')
      if (!staged) {
        fs.mkdirSync(staging, { mode: 0o700 })
        syncDir(directory)
      }
      // Only the unpublished files produced by this exact initialization protocol can be discarded.
      const pending = path.join(staging, 'binding')
      for (const name of fs.readdirSync(staging)) {
        if (
          ![
            'binding',
            'workflow.sqlite',
            'workflow.sqlite-wal',
            'workflow.sqlite-shm',
            'workflow.sqlite-journal'
          ].includes(name)
        )
          storageError('WORKFLOW_STORAGE_INITIALIZATION_INCOMPLETE')
        privateFile(path.join(staging, name))
      }
      if (!exists(marker)) {
        if (exists(file)) {
          // The main DB is already visible. Verify its identity before repairing the unpublished marker.
          if (!exists(pending) || fs.readFileSync(pending, 'utf8') !== binding + '\n')
            storageError('WORKFLOW_STORAGE_INITIALIZATION_INCOMPLETE')
          const check = new WorkflowDatabase(directory, binding)
          check.close()
        } else {
          if (hasLegacy()) storageError('WORKFLOW_STORAGE_FORMAT_CONFLICT')
          for (const name of fs.readdirSync(staging)) fs.unlinkSync(path.join(staging, name))
          const pf = fs.openSync(pending, 'wx', 0o600)
          try {
            fs.writeFileSync(pf, binding + '\n')
            fs.fsyncSync(pf)
          } finally {
            fs.closeSync(pf)
          }
          const prepared = new WorkflowDatabase(staging, binding, { create: true })
          prepared.close()
          syncDir(staging)
          fs.renameSync(path.join(staging, 'workflow.sqlite'), file)
          syncDir(directory)
        }
        fs.renameSync(pending, marker)
        syncDir(directory)
      }
      const db = openMarked()
      try {
        fs.rmdirSync(staging)
        syncDir(directory)
        return db
      } catch (error) {
        db.close()
        throw error
      }
    }
  )
}

function externalIdentity(storageRoot, binding) {
  return path.join(storageRoot, '.dsh', 'workflow-sqlite-v1', binding)
}
function verifyIdentityFile(file, binding) {
  if (fs.realpathSync(file) !== file) storageError('WORKFLOW_STORAGE_UNSAFE_FILE')
  privateFile(file)
  if (fs.readFileSync(file, 'utf8') !== binding + '\n') storageError('WORKFLOW_STORAGE_IDENTITY_MISMATCH')
}
function ensureExternalIdentity(storageRoot, directory, file, binding) {
  if (exists(file)) {
    verifyIdentityFile(file, binding)
    return
  }
  const parent = path.dirname(file)
  checkDir(storageRoot, parent)
  withStorageLock(
    path.join(directory, '.workflow-open.lock'),
    false,
    3000,
    'WORKFLOW_STORAGE_INITIALIZATION_BUSY',
    () => {
      if (exists(file)) {
        verifyIdentityFile(file, binding)
        return
      }
      const pending = path.join(parent, '.pending-' + binding)
      if (exists(pending)) {
        privateFile(pending)
        fs.unlinkSync(pending)
      }
      const fd = fs.openSync(pending, 'wx', 0o600)
      try {
        fs.writeFileSync(fd, binding + '\n')
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      fs.renameSync(pending, file)
      syncDir(parent)
    }
  )
}
export function openWorkflowStorage({
  projectRoot,
  storageRoot = projectRoot,
  directory,
  storageFormat = 'auto'
}) {
  checkDir(storageRoot, directory)
  const binding = sha256(JSON.stringify([storageRoot, directory]))
  const existing = instances.get(directory)
  if (existing) {
    if (storageFormat === 'files') storageError('WORKFLOW_STORAGE_FORMAT_CONFLICT')
    if (existing.binding !== binding) storageError('WORKFLOW_STORAGE_IDENTITY_MISMATCH')
    existing.db.check()
    existing.users++
    return existing
  }
  const identity = externalIdentity(storageRoot, binding)
  const knownIdentity = exists(identity)
  if (knownIdentity) {
    verifyIdentityFile(identity, binding)
    if (!exists(path.join(directory, 'workflow.sqlite'))) storageError('WORKFLOW_STORAGE_DATABASE_MISSING')
    if (!exists(path.join(directory, markerName))) storageError('WORKFLOW_STORAGE_IDENTITY_MARKER_MISSING')
  }
  const db = selectDatabase(directory, storageRoot, storageFormat, binding)
  if (!db) return null
  try {
    if (!knownIdentity) ensureExternalIdentity(storageRoot, directory, identity, binding)
  } catch (error) {
    db.close()
    throw error
  }
  let current,
    backedUp = db.q('SELECT 1 FROM files LIMIT 1').get() || db.q('PRAGMA user_version').get().user_version === 2 ? -1 : db.generation
  const retryable = error => ['WORKFLOW_BACKUP_CHECKPOINT_BUSY', 'WORKFLOW_BACKUP_SNAPSHOT_CHANGED'].includes(error.code)
  function capture(closing) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./workflow-backup-worker.mjs', import.meta.url), {
        workerData: { directory, binding, closing }, execArgv: []
      })
      let result
      worker.once('message', value => { result = value })
      worker.once('error', reject)
      worker.once('exit', code => {
        if (code || !result || result.error)
          reject(Object.assign(Error(result?.message ?? 'Backup worker exited'), { code: result?.error ?? 'WORKFLOW_BACKUP_FAILED' }))
        else resolve(result.result)
      })
    })
  }
  async function drain(closing) {
    let result, retries = 0
    while (backedUp !== db.generation) {
      const target = db.generation
      try {
        result = await capture(closing)
        backedUp = target
        retries = 0
      } catch (error) {
        if (!retryable(error) || ++retries >= 4) throw error
        await delay(20 * retries)
      }
    }
    return result
  }
  const handle = {
    db,
    binding,
    users: 1,
    backup: () => backupWorkflow(db),
    async backupAtBoundary() {
      let result
      while (current || backedUp !== db.generation) {
        current ??= drain().finally(() => { current = null })
        result = await current
      }
      return result
    },
    async flushBackup() {
      // A background pass may have used its retries during active graph writes.
      // Retry under the longer SQLite wait once the caller has drained its work.
      try { await current } catch (error) { if (!retryable(error)) throw error }
      while (current || backedUp !== db.generation) {
        current ??= drain(true).finally(() => { current = null })
        await current
      }
    },
    close() {
      if (--this.users === 0) {
        instances.delete(directory)
        db.close()
      }
    }
  }
  instances.set(directory, handle)
  return handle
}
export function workflowLocation(file) {
  if (typeof file !== 'string' || !instances.size || !path.isAbsolute(file) || path.resolve(file) !== file)
    return
  let parent = path.dirname(file)
  while (parent !== path.dirname(parent)) {
    const hit = instances.get(parent)
    if (hit) return { db: hit.db, name: path.relative(parent, file) }
    parent = path.dirname(parent)
  }
}
function record(file) {
  const entry = workflowLocation(file)
  if (!entry) return
  const info = entry.db.info(entry.name)
  if (!info && isManagedRecord(entry.name) && exists(file)) storageError('WORKFLOW_STORAGE_UNTRACKED_FILE')
  return info && { ...entry, info }
}
export function writeStored(file, bytes, options) {
  const entry = workflowLocation(file)
  if (!entry) return null
  if (fs.realpathSync(path.dirname(file)) !== path.dirname(file))
    storageError('WORKFLOW_STORAGE_DIRECTORY_CHANGED')
  const result = entry.db.put(entry.name, bytes, options)
  return { ref: file, sha256: result.sha }
}
export function readStored(file, encoding) {
  const entry = record(file)
  if (!entry) return fs.readFileSync(file, encoding)
  const bytes = entry.db.range(entry.info)
  return encoding ? bytes.toString(encoding) : bytes
}
export function hasStored(file) {
  return Boolean(record(file)) || fs.existsSync(file)
}
export function statStored(file, opts) {
  const entry = record(file)
  if (!entry) return fs.lstatSync(file, opts)
  const { info } = entry,
    convert = opts?.bigint ? BigInt : Number,
    ino = convert(info.doc),
    stamp = convert(info.updated)
  const ns = BigInt(info.updated) * 1000000n + BigInt(info.generation)
  return {
    dev: convert(0),
    ino,
    size: convert(info.size),
    nlink: convert(1),
    mtimeMs: stamp,
    ctimeMs: stamp,
    mtimeNs: ns,
    ctimeNs: ns,
    isFile: () => true,
    isSymbolicLink: () => false,
    isDirectory: () => false
  }
}
export function namesStored(dir) {
  const native = fs.readdirSync(dir)
  const entry = workflowLocation(path.join(dir, 'lookup'))
  if (!entry) return native
  return [...new Set([...native, ...entry.db.list(path.posix.dirname(entry.name))])]
}
export function unlinkStored(file) {
  const entry = record(file)
  if (entry) return entry.db.remove(entry.name)
  return fs.unlinkSync(file)
}
export function storedEntry(file) {
  return record(file)
}

// The base graph plugin supplies path and policy validation. This adapter retains
// its synchronous CAS contract and stores the witness and graph in one transaction.
export function graphView(raw, options, db) {
  const witness = options.fileName === 'witness.json'
  const name = witness ? 'graph/witness' : 'graph/state'
  let cache
  const view = {
    file: raw.file,
    directory: raw.directory,

    projectRoot: raw.projectRoot,
    db,
    read() {
      db.check()
      const row = db.info(name)
      if (!row) return null

      const version = db.q('PRAGMA data_version').get().data_version
      if (!cache || cache.doc !== row.doc || cache.sha !== row.sha || cache.version !== version) {
        const stored = JSON.parse(db.range(row))
        const value = options.codec ? options.codec.decode(stored) : stored
        options.validator(value)
        cache = { doc: row.doc, sha: row.sha, version, value }
      }
      return structuredClone(cache.value)
    },
    compareAndSwap(expected, update) {
      return this.compareAndSwapPrepared(expected, update)
    },
    compareAndSwapPrepared(expected, update, prepare) {
      return db.transaction(() => {
        const previous = this.read()
        if (!Number.isSafeInteger(expected) || expected < 0) storageError('INVALID_REVISION')
        if ((previous?.revision ?? 0) !== expected) storageError('CAS_CONFLICT')
        const next = update(previous ? structuredClone(previous) : null)
        if (next?.then) storageError('ASYNC_STORE_UPDATE_FORBIDDEN')
        options.validator(next)
        options.updateValidator(previous, next)
        const bytes = Buffer.from(JSON.stringify(options.codec ? options.codec.encode(next) : next) + '\n')

        prepare?.(previous, next)
        db.put(name, bytes, witness ? {} : { revision: next.revision })
        cache = null
        return structuredClone(next)
      })
    },
    restoreCommitted(state) {
      options.validator(state)
      const bytes = Buffer.from(JSON.stringify(options.codec ? options.codec.encode(state) : state) + '\n')

      db.put(name, bytes)
      cache = null
    }
  }
  return view
}
