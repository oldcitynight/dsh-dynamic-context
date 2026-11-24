// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { privateFile, sha256, storageError, withStorageLock } from './workflow-database.mjs'

const groupBytes = 64 * 1024,
  segmentBytes = 8 * 1024 * 1024
const empty = () => ({ version: 1, generations: [], objects: {} })
function directorySync(dir) {
  const fd = fs.openSync(dir, 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}
function manifest(dir) {
  const file = path.join(dir, 'manifest.json')
  if (!fs.existsSync(file)) return empty()
  privateFile(file)
  const { content, checksum } = JSON.parse(fs.readFileSync(file))
  if (content?.version !== 1 || sha256(JSON.stringify(content)) !== checksum)
    storageError('WORKFLOW_BACKUP_MANIFEST_INVALID')
  return content
}
function publish(dir, content) {
  const tmp = path.join(dir, '.manifest-' + randomUUID())
  const fd = fs.openSync(tmp, 'wx', 0o600)
  try {
    fs.writeFileSync(fd, JSON.stringify({ content, checksum: sha256(JSON.stringify(content)) }))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, path.join(dir, 'manifest.json'))
  directorySync(dir)
}
function segment(dir, name) {
  if (!/^part-[a-f0-9-]{36}$/.test(name)) storageError('WORKFLOW_BACKUP_SEGMENT_INVALID')
  return path.join(dir, name)
}
function readBlock(dir, obj) {
  if (
    !obj ||
    !Number.isSafeInteger(obj.n) ||
    obj.n < 1 ||
    obj.n > groupBytes ||
    !Number.isSafeInteger(obj.at) ||
    obj.at < 0 ||
    obj.at + obj.n > segmentBytes
  )
    storageError('WORKFLOW_BACKUP_SEGMENT_INVALID')
  const fd = fs.openSync(segment(dir, obj.part), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  const bytes = Buffer.alloc(obj.n)
  try {
    if (fs.readSync(fd, bytes, 0, bytes.length, obj.at) !== bytes.length)
      storageError('WORKFLOW_BACKUP_TRUNCATED')
  } finally {
    fs.closeSync(fd)
  }
  return bytes
}
function xorBlocks(left, right) {
  if (left.length !== right.length) storageError('WORKFLOW_BACKUP_BLOCK_CHANGED')
  const delta = Buffer.allocUnsafe(left.length)
  for (let i = 0; i < delta.length; i++) delta[i] = left[i] ^ right[i]
  return delta
}
function decodeFull(dir, object) {
  if (!object || object.base || ![0, 1].includes(object.codec)) storageError('WORKFLOW_BACKUP_BASE_INVALID')
  const bytes = readBlock(dir, object)
  return object.codec ? zstdDecompressSync(bytes, { maxOutputLength: groupBytes }) : bytes
}
function restoreBlock(dir, objects, key) {
  const row = objects[key]
  if (!row?.base) return decodeFull(dir, row)
  if (row.codec !== 2 || !/^[a-f0-9]{64}$/.test(row.base)) storageError('WORKFLOW_BACKUP_BASE_INVALID')
  const base = decodeFull(dir, objects[row.base])
  if (sha256(base) !== row.base) storageError('WORKFLOW_BACKUP_BLOCK_CHANGED')
  const delta = zstdDecompressSync(readBlock(dir, row), { maxOutputLength: groupBytes })
  return xorBlocks(base, delta)
}
function writer(dir) {
  let fd,
    part,
    pos = 0
  function close() {
    if (fd !== undefined) {
      try {
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
        fd = undefined
      }
    }
  }
  return {
    close,
    add(bytes, codec) {
      if (fd === undefined || pos + bytes.length > segmentBytes) {
        close()
        part = 'part-' + randomUUID()
        fd = fs.openSync(segment(dir, part), 'wx', 0o600)
        pos = 0
      }
      const at = pos
      fs.writeFileSync(fd, bytes)
      pos += bytes.length
      return { part, at, n: bytes.length, codec }
    }
  }
}
function clean(dir, content) {
  const used = new Set(Object.values(content.objects).map((o) => o.part))
  for (const file of fs.readdirSync(dir))
    if ((/^part-[a-f0-9-]{36}$/.test(file) && !used.has(file)) || /^\.manifest-[a-f0-9-]{36}$/.test(file))
      fs.unlinkSync(path.join(dir, file))
}
// A pinned WAL reader protects a checkpointed base image. Other writers may
// commit to WAL. A separate kernel lock serializes manifest publication and GC.
export function backupWorkflow(db) {
  if (db.inTransaction) storageError('WORKFLOW_BACKUP_WRITER_ACTIVE')
  const dir = path.join(db.directory, 'recovery')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (fs.realpathSync(dir) !== dir) storageError('WORKFLOW_BACKUP_DIRECTORY_INVALID')
  return withBackupLock(dir, () => {
    const result = capture(db, dir)
    reclaimPins(db, manifest(dir))
    return result
  })
}
function withBackupLock(dir, operation) {
  return withStorageLock(
    path.join(dir, '.backup.lock'),
    false,
    0,
    'WORKFLOW_BACKUP_CHECKPOINT_BUSY',
    operation
  )
}
function capture(db, dir) {
  const ck = db.q('PRAGMA wal_checkpoint(TRUNCATE)').get()
  if (ck.busy) storageError('WORKFLOW_BACKUP_CHECKPOINT_BUSY')
  db.db.exec('BEGIN')
  try {
    db.q('SELECT binding FROM instance WHERE id=1').get()
    const identity = () => {
      const s = fs.statSync(db.file, { bigint: true })
      return [s.dev, s.ino, s.size, s.ctimeNs, s.mtimeNs].join(':')
    }
    const before = identity()
    if ((fs.statSync(db.file + '-wal', { throwIfNoEntry: false })?.size ?? 0) !== 0)
      storageError('WORKFLOW_BACKUP_CHECKPOINT_BUSY')
    const state = manifest(dir)
    clean(dir, state)
    const out = writer(dir),
      hash = createHash('sha256'),
      groups = []
    const fd = fs.openSync(db.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    let bytes = 0,
      newGroups = 0
    try {
      const buf = Buffer.alloc(groupBytes)
      for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0; ) {
        const raw = buf.subarray(0, n),
          key = sha256(raw)
        hash.update(raw)
        bytes += n
        groups.push(key)
        if (state.objects[key]) continue
        const compressed = zstdCompressSync(raw),
          codec = compressed.length < raw.length
        const full = codec ? compressed : raw
        const priorKey = state.generations[0]?.groups[groups.length - 1]
        const prior = state.objects[priorKey]
        const baseKey = prior?.base ?? priorKey
        if (baseKey) {
          const base = decodeFull(dir, state.objects[baseKey])
          if (sha256(base) !== baseKey) storageError('WORKFLOW_BACKUP_BLOCK_CHANGED')
          if (base.length === raw.length) {
            const diff = zstdCompressSync(xorBlocks(raw, base))
            if (diff.length + 128 < full.length * 0.85) {
              state.objects[key] = { ...out.add(diff, 2), base: baseKey, fullLength: full.length }
            }
          }
        }
        state.objects[key] ??= out.add(full, codec ? 1 : 0)
        newGroups++
      }
    } finally {
      fs.closeSync(fd)
      out.close()
    }
    const pins = db
      .q('SELECT DISTINCT i.sha FROM images i JOIN layout_images l ON l.image=i.id ORDER BY i.sha')
      .all()
      .map((row) => row.sha)
    const generation = { id: randomUUID(), sha: hash.digest('hex'), bytes, groups, pins }
    state.generations = [generation, ...state.generations].slice(0, 2)
    const retained = new Set(state.generations.flatMap((g) => g.groups))
    const fullRepresentationBytes = Array.from(
      retained,
      (key) => state.objects[key].fullLength ?? state.objects[key].n
    ).reduce((a, b) => a + b, 0)
    for (const key of [...retained]) {
      const base = state.objects[key].base
      if (base) retained.add(base)
    }
    for (const key of Object.keys(state.objects)) if (!retained.has(key)) delete state.objects[key]
    if (identity() !== before) storageError('WORKFLOW_BACKUP_SNAPSHOT_CHANGED')
    publish(dir, state)
    clean(dir, state)
    const parts = Map.groupBy(Object.entries(state.objects), (entry) => entry[1].part)
    for (const [part, entries] of parts) {
      const used = entries.reduce((n, [, o]) => n + o.n, 0)
      if (used === privateFile(segment(dir, part)).size) continue
      const compact = writer(dir)
      try {
        for (const [key, old] of entries)
          state.objects[key] = { ...old, ...compact.add(readBlock(dir, old), old.codec) }
      } finally {
        compact.close()
      }
      publish(dir, state)
      clean(dir, state)
    }
    return {
      generation: generation.id,
      sha: generation.sha,
      bytes,
      newGroups,
      fullRepresentationBytes,
      storedBlockBytes: Object.values(state.objects).reduce((sum, o) => sum + o.n, 0),
      deltaGroups: Object.values(state.objects).filter((o) => o.base).length,
      groups: groups.length,
      retained: state.generations.length
    }
  } finally {
    db.db.exec('ROLLBACK')
  }
}
function reclaimPins(db, state) {
  const pinDirectory = path.join(db.directory, 'media-pins')
  if (!fs.existsSync(pinDirectory) || state.generations.some((g) => !Array.isArray(g.pins))) return
  const retained = new Set(state.generations.flatMap((g) => g.pins))
  // First commit the removable row set. A crash between phases leaves only an extra link.
  db.transaction(() =>
    db.q('DELETE FROM images WHERE NOT EXISTS (SELECT 1 FROM layout_images WHERE image=images.id)').run()
  )
  db.transaction(() => {
    for (const sha of fs.readdirSync(pinDirectory)) {
      if (
        !/^[0-9a-f]{64}$/.test(sha) ||
        retained.has(sha) ||
        db.q('SELECT 1 FROM images WHERE sha=?').get(sha)
      )
        continue
      fs.unlinkSync(path.join(pinDirectory, sha))
    }
  })
}
// The caller chooses a new destination beside the original persistent media pins.
// Never overwrite an existing database, even when a second restorer is racing.
export function restoreWorkflow(dir, destination, generation) {
  if (fs.realpathSync(dir) !== dir) storageError('WORKFLOW_BACKUP_DIRECTORY_INVALID')
  return withBackupLock(dir, () => restoreLocked(dir, destination, generation))
}
// Legacy-compatible callers enumerate role and attempt directories physically. The
// authoritative records are virtual, so an offline restore can recreate empty
// directory scaffolding from its own verified database without copying a sidecar tree.
function restoreRecordDirectories(image, root, created) {
  const uri = pathToFileURL(image)
  uri.search = 'mode=ro&immutable=1'
  const snapshot = new DatabaseSync(uri.href, { readOnly: true })
  try {
    const verified = new Set()
    for (const { parent } of snapshot.prepare('SELECT DISTINCT parent FROM files').iterate()) {
      if (
        !/^(?:attempt_[^/]+|revisions|execution-view-v1|planning-history|suspensions|directory-snapshots|blockage)(?:\/|$)/.test(
          parent
        )
      )
        continue
      let dir = root
      for (const part of parent.split('/')) {
        if (!part || part === '.' || part === '..' || part.includes('\0'))
          storageError('WORKFLOW_BACKUP_DIRECTORY_INVALID')
        dir = path.join(dir, part)
        if (verified.has(dir)) continue
        let existing = fs.lstatSync(dir, { throwIfNoEntry: false })
        if (!existing) {
          try {
            fs.mkdirSync(dir, { mode: 0o700 })
            created.push(dir)
          } catch (error) {
            if (error.code !== 'EEXIST') throw error
          }
          existing = fs.lstatSync(dir)
        }
        if (!existing.isDirectory() || existing.isSymbolicLink())
          storageError('WORKFLOW_BACKUP_DIRECTORY_INVALID')
        verified.add(dir)
      }
    }
  } finally {
    snapshot.close()
  }
}
function restoreLocked(dir, destination, generation) {
  const state = manifest(dir),
    g = generation ? state.generations.find((row) => row.id === generation) : state.generations[0]
  if (!g) storageError('WORKFLOW_BACKUP_GENERATION_MISSING')
  const parent = path.dirname(destination)
  if (fs.realpathSync(parent) !== parent) storageError('WORKFLOW_BACKUP_DIRECTORY_INVALID')
  if (fs.lstatSync(destination, { throwIfNoEntry: false })) storageError('EEXIST')
  for (const sha of g.pins ?? []) {
    if (!/^[a-f0-9]{64}$/.test(sha)) storageError('WORKFLOW_BACKUP_MANIFEST_INVALID')
    const pin = path.join(parent, 'media-pins', sha)
    const handle = fs.openSync(pin, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      if (!fs.fstatSync(handle).isFile() || sha256(fs.readFileSync(handle)) !== sha)
        storageError('WORKFLOW_STORAGE_PIN_CONTENT_CHANGED')
    } finally {
      fs.closeSync(handle)
    }
  }
  const temp = path.join(parent, '.restore-' + randomUUID())
  const fd = fs.openSync(temp, 'wx', 0o600),
    hash = createHash('sha256')
  const created = []
  let published = false
  try {
    let size = 0
    for (const key of g.groups) {
      const raw = restoreBlock(dir, state.objects, key)
      if (sha256(raw) !== key) storageError('WORKFLOW_BACKUP_BLOCK_CHANGED')
      hash.update(raw)
      size += raw.length
      fs.writeFileSync(fd, raw)
    }
    if (size !== g.bytes || hash.digest('hex') !== g.sha) storageError('WORKFLOW_BACKUP_CONTENT_CHANGED')
    fs.fsyncSync(fd)
    restoreRecordDirectories(temp, parent, created)
    for (const dir of created) directorySync(path.dirname(dir))
    fs.linkSync(temp, destination)
    published = true
    directorySync(path.dirname(destination))
  } finally {
    fs.closeSync(fd)
    fs.unlinkSync(temp)
    if (!published)
      for (const dir of created.reverse()) {
        try {
          fs.rmdirSync(dir)
        } catch (error) {
          if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error
        }
      }
  }
  return g.id
}
