// SPDX-License-Identifier: GPL-3.0-only
import { documentKind, childSpans } from './workflow-format.mjs'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'

export const sha256 = (data) => createHash('sha256').update(data).digest('hex')
export function storageError(code) {
  throw Object.assign(new Error(code), { code })
}
export function sqliteLockContention(error) {
  const code = Number.isInteger(error?.errcode) ? error.errcode & 255 : null
  return code === 5 || code === 6
}
const word = new Uint32Array(256)
let seed = 11711
for (let i = 0; i < word.length; i++) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  word[i] = seed
}
const schema = `
CREATE TABLE instance(id INTEGER PRIMARY KEY CHECK(id=1), binding TEXT NOT NULL);
CREATE TABLE chunks(id INTEGER PRIMARY KEY, hash BLOB NOT NULL UNIQUE, codec INTEGER NOT NULL, data BLOB NOT NULL);
CREATE TABLE layouts(id INTEGER PRIMARY KEY, hash BLOB NOT NULL UNIQUE, entries BLOB NOT NULL);
CREATE TABLE documents(id INTEGER PRIMARY KEY, sha TEXT NOT NULL UNIQUE, size INTEGER NOT NULL);
CREATE TABLE spans(doc INTEGER NOT NULL REFERENCES documents ON DELETE CASCADE, at INTEGER NOT NULL,
  layout INTEGER NOT NULL REFERENCES layouts, PRIMARY KEY(doc,at)) WITHOUT ROWID;
CREATE INDEX spans_layout ON spans(layout);
CREATE TABLE members(layout INTEGER NOT NULL REFERENCES layouts ON DELETE CASCADE, chunk INTEGER NOT NULL REFERENCES chunks,
 PRIMARY KEY(layout,chunk)) WITHOUT ROWID;
CREATE INDEX members_chunk ON members(chunk);
CREATE TABLE nested(layout INTEGER NOT NULL REFERENCES layouts ON DELETE CASCADE, child INTEGER NOT NULL REFERENCES documents,
 PRIMARY KEY(layout,child)) WITHOUT ROWID;
CREATE INDEX nested_child ON nested(child);
CREATE TABLE versions(kind TEXT NOT NULL,doc INTEGER NOT NULL REFERENCES documents ON DELETE CASCADE,PRIMARY KEY(kind,doc)) WITHOUT ROWID;
CREATE TABLE files(name TEXT PRIMARY KEY, parent TEXT NOT NULL, doc INTEGER NOT NULL REFERENCES documents,
  generation INTEGER NOT NULL, updated INTEGER NOT NULL) WITHOUT ROWID;
CREATE INDEX file_directory ON files(parent,name);
CREATE TABLE display_index(name TEXT PRIMARY KEY REFERENCES files(name) ON DELETE CASCADE,id TEXT NOT NULL UNIQUE,
 recorded_key TEXT NOT NULL,seq INTEGER NOT NULL,rev INTEGER NOT NULL,state TEXT NOT NULL) WITHOUT ROWID;
CREATE INDEX display_seq ON display_index(seq);
CREATE INDEX display_rev ON display_index(rev);
CREATE INDEX display_key ON display_index(recorded_key,seq);
CREATE INDEX display_state ON display_index(state);
CREATE TABLE state_history(series TEXT NOT NULL, ordinal INTEGER NOT NULL, rev INTEGER NOT NULL, doc INTEGER NOT NULL REFERENCES documents,
  PRIMARY KEY(series,ordinal)) WITHOUT ROWID;
CREATE INDEX history_revision ON state_history(series,rev,ordinal);
CREATE INDEX files_doc ON files(doc); CREATE INDEX history_doc ON state_history(doc);
CREATE TABLE streams(name TEXT PRIMARY KEY,size INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE stream_parts(name TEXT NOT NULL REFERENCES streams, at INTEGER NOT NULL, doc INTEGER NOT NULL REFERENCES documents,
 PRIMARY KEY(name,at)) WITHOUT ROWID;
CREATE INDEX stream_doc ON stream_parts(doc);
CREATE TABLE images(id INTEGER PRIMARY KEY, sha TEXT NOT NULL UNIQUE, size INTEGER NOT NULL, pin TEXT NOT NULL);
CREATE TABLE layout_images(layout INTEGER NOT NULL REFERENCES layouts ON DELETE CASCADE, image INTEGER NOT NULL REFERENCES images,
 PRIMARY KEY(layout,image)) WITHOUT ROWID;
CREATE INDEX layout_images_image ON layout_images(image);
PRAGMA application_id=1146308663; PRAGMA user_version=1;
`
export function privateFile(file) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    storageError('WORKFLOW_STORAGE_UNSAFE_FILE')
  return stat
}
// SQLite supplies cross-process, crash-released advisory locking through an
// empty guard file. It stays zero bytes: no schema, journal or business data.
export function withStorageLock(file, shared, timeoutMs, busyCode, operation) {
  fs.closeSync(fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600))
  if (privateFile(file).size !== 0) storageError('WORKFLOW_STORAGE_INVALID_LOCK')
  const guard = new DatabaseSync(file)
  try {
    guard.exec('PRAGMA busy_timeout=' + timeoutMs)
    try {
      guard.exec('PRAGMA journal_mode=MEMORY')
      guard.exec(shared ? 'BEGIN' : 'BEGIN EXCLUSIVE')
      guard.prepare('PRAGMA schema_version').get()
    } catch (error) {
      if (sqliteLockContention(error)) storageError(busyCode)
      throw error
    }
    return operation()
  } finally {
    try {
      if (guard.isTransaction) guard.exec('ROLLBACK')
    } finally {
      guard.close()
    }
  }
}
function canonicalKey(key) {
  if (
    typeof key !== 'string' ||
    !key ||
    key === '.' ||
    key.includes('\0') ||
    path.isAbsolute(key) ||
    key.split('/').some((part) => !part || part === '.' || part === '..')
  )
    storageError('WORKFLOW_STORAGE_INVALID_KEY')
  return key
}
const minChunkBytes = 2048
const maxChunkBytes = 32768
const addressedChildren = new Set(['message', 'tools', 'system', 'graph'])

// Pack small structural fields with their parent, but keep addressable descendants
// even when the enclosing request, message list or checkpoint fits on one page.
function* storedChildren(bytes, kind, pageBytes, offset = 0) {
  for (const { start, end, kind: childKind } of childSpans(bytes, kind)) {
    if (end - start >= pageBytes || addressedChildren.has(childKind))
      yield { start: offset + start, end: offset + end, kind: childKind }
    else
      yield* storedChildren(bytes.subarray(start, end), childKind, pageBytes, offset + start)
  }
}
function* textPieces(bytes) {
  let begin = 0,
    hash = 0
  for (let i = 0; i < bytes.length; i++) {
    hash = ((hash << 1) + word[bytes[i]]) >>> 0
    const length = i + 1 - begin
    if (length < minChunkBytes || ((hash & 8191) !== 0 && length < maxChunkBytes)) continue
    yield bytes.subarray(begin, i + 1)
    begin = i + 1
    hash = 0
  }
  if (begin !== bytes.length) yield bytes.subarray(begin)
}
const is64 = (c) =>
  (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47 || c === 61
const same = (a, b) => a.dev === b.dev && a.ino === b.ino

/** A logical document is an ordered sequence of shared layouts. Each layout holds
 * (object id, rendered length, encoding) tuples; positive object ids refer to chunks.
 * Negative ids pin verified native media. Image range reads align to 4:3 boundaries. */
export class WorkflowDatabase {
  constructor(directory, binding, { create = false, mediaLookup } = {}) {
    this.directory = directory
    this.file = path.join(directory, 'workflow.sqlite')
    if (fs.realpathSync(directory) !== directory) storageError('WORKFLOW_STORAGE_DIRECTORY_CHANGED')
    this.directoryIdentity = fs.statSync(directory)
    this.generation = 0
    this.mediaLookup = mediaLookup
    this.verifiedPins = new Map()
    this.shortHashes = new Map()
    this.shortHashBytes = 0
    if (create) fs.closeSync(fs.openSync(this.file, 'wx', 0o600))
    this.identity = privateFile(this.file)
    for (const suffix of ['-wal', '-shm', '-journal']) {
      if (fs.lstatSync(this.file + suffix, { throwIfNoEntry: false })) privateFile(this.file + suffix)
    }
    this.db = new DatabaseSync(this.file)
    this.statements = new Map()
    try {
      this.db.exec('PRAGMA busy_timeout=1500; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF')
      if (create)
        this.transaction(() => {
          this.db.exec(schema)
          this.q('INSERT INTO instance VALUES(1,?)').run(binding)
        })
      if (
        this.q('PRAGMA application_id').get().application_id !== 1146308663 ||
        ![1, 2].includes(this.q('PRAGMA user_version').get().user_version) ||
        this.q('SELECT binding FROM instance WHERE id=1').get()?.binding !== binding
      )
        storageError('WORKFLOW_STORAGE_IDENTITY_MISMATCH')
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=512')
      this.pageBytes = this.q('PRAGMA page_size').get().page_size
      // Older writers hashed even a single 12-byte layout. Index just those
      // legacy keys so a byte-for-byte lookup can reuse them on an upgraded DB.
      this.db.exec(`CREATE INDEX IF NOT EXISTS layouts_compact_legacy ON layouts(entries)
        WHERE length(hash)=32 AND length(entries)<32`)
    } catch (error) {
      this.db.close()
      throw error
    }
  }
  check() {
    if (
      !same(this.identity, privateFile(this.file)) ||
      !same(this.directoryIdentity, fs.lstatSync(this.directory))
    )
      storageError('WORKFLOW_STORAGE_IDENTITY_CHANGED')
  }
  q(sql) {
    let statement = this.statements.get(sql)
    if (!statement) this.statements.set(sql, (statement = this.db.prepare(sql)))
    return statement
  }
  transaction(operation) {
    if (this.inTransaction) {
      try {
        return operation()
      } catch (error) {
        this.rollbackReason ??= error
        throw error
      }
    }
    this.check()
    this.db.exec('BEGIN IMMEDIATE')
    this.inTransaction = true
    this.rollbackReason = null
    this.newPins = []
    try {
      const value = operation()
      if (value?.then) storageError('WORKFLOW_STORAGE_ASYNC_TRANSACTION')
      if (this.rollbackReason) throw this.rollbackReason
      this.db.exec('COMMIT')
      this.generation++
      return value
    } catch (error) {
      this.db.exec('ROLLBACK')
      for (const pin of this.newPins) fs.rmSync(pin, { force: true })
      throw error
    } finally {
      this.inTransaction = false
    }
  }
  contentHash(bytes) {
    // Reuse only exact byte values. Every integrity check still compares the current bytes with the expected digest.
    if (bytes.length > 8192) return sha256(bytes)
    const key = bytes.toString('latin1')
    const known = this.shortHashes.get(key)
    if (known) return known
    while (this.shortHashes.size >= 2048 || this.shortHashBytes + key.length > 1024 * 1024) {
      const oldest = this.shortHashes.keys().next().value
      this.shortHashBytes -= oldest.length
      this.shortHashes.delete(oldest)
    }
    const digest = sha256(bytes)
    this.shortHashes.set(key, digest)
    this.shortHashBytes += key.length
    return digest
  }
  chunk(bytes, knownSha) {
    const hash = Buffer.from(knownSha ?? this.contentHash(bytes), 'hex')
    const old = this.q('SELECT id FROM chunks WHERE hash=?').get(hash)
    if (old) return old.id
    const compressed = bytes.length >= 256 ? zstdCompressSync(bytes) : bytes
    const codec = compressed.length < bytes.length ? 1 : 0
    return Number(
      this.q('INSERT INTO chunks(hash,codec,data) VALUES(?,?,?)').run(hash, codec, codec ? compressed : bytes)
        .lastInsertRowid
    )
  }
  *pieces(bytes, knownSha) {
    // Both Messages blocks (source.data) and Chat Completions use canonical
    // image bytes. Magic prefixes also occur inside nested JSON strings.
    const magic = /data:image\/[a-zA-Z0-9.+-]+;base64,|iVBORw0KGg|\/9j\/|R0lGOD|UklGR/g
    const text = bytes.length >= 4096 ? bytes.toString('latin1') : ''
    let start = 0,
      match
    while ((match = magic.exec(text))) {
      const explicit = match[0].startsWith('data:')
      const body = explicit ? magic.lastIndex : match.index
      if (!explicit && body && is64(bytes[body - 1])) continue
      let end = body
      while (end < bytes.length && is64(bytes[end])) end++
      if (end - body < 4096 || (end - body) % 4) continue
      const encoded = text.slice(body, end),
        raw = Buffer.from(encoded, 'base64')
      if (raw.toString('base64') !== encoded) continue
      magic.lastIndex = end
      for (const piece of textPieces(bytes.subarray(start, body))) yield [this.chunk(piece), piece.length, 0]
      const id = this.pin(raw)
      if (id) yield [-id, encoded.length, 1]
      else
        for (let i = 0; i < raw.length; i += 49152) {
          const piece = raw.subarray(i, i + 49152)
          yield [this.chunk(piece), Math.ceil(piece.length / 3) * 4, 1]
        }
      start = end
    }
    if (knownSha && start === 0 && bytes.length && bytes.length <= maxChunkBytes) {
      yield [this.chunk(bytes, knownSha), bytes.length, 0]
      return
    }
    for (const piece of textPieces(bytes.subarray(start))) yield [this.chunk(piece), piece.length, 0]
  }
  pin(raw) {
    if (!this.mediaLookup) return null
    const sha = sha256(raw)
    const known = this.q('SELECT id FROM images WHERE sha=?').get(sha)
    if (known) return known.id
    const source = this.mediaLookup(sha, raw.length)
    if (!source) return null
    const dir = path.join(this.directory, 'media-pins')
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (fs.realpathSync(dir) !== dir) storageError('WORKFLOW_STORAGE_UNSAFE_PIN')
    const target = path.join(dir, sha)
    try {
      fs.linkSync(source, target)
      this.newPins.push(target)
    } catch (error) {
      if (error.code === 'EXDEV' || error.code === 'ENOENT') return null
      if (error.code !== 'EEXIST') throw error
    }
    const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      const info = fs.fstatSync(fd)
      if (!info.isFile() || info.size !== raw.length || !fs.readFileSync(fd).equals(raw))
        storageError('WORKFLOW_STORAGE_PIN_CONTENT_CHANGED')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    const dirfd = fs.openSync(dir, 'r')
    try {
      fs.fsyncSync(dirfd)
    } finally {
      fs.closeSync(dirfd)
    }
    return Number(
      this.q('INSERT INTO images(sha,size,pin) VALUES(?,?,?)').run(sha, raw.length, sha).lastInsertRowid
    )
  }
  *documentPieces(bytes, kind, sha) {
    const spans = storedChildren(bytes, kind, this.pageBytes)
    let pos = 0
    for (const { start, end, kind: childKind } of spans) {
      if (start > pos) yield* this.pieces(bytes.subarray(pos, start))
      const child = this.intern(bytes.subarray(start, end), childKind)
      yield [child.id, end - start, 2]
      pos = end
    }
    if (pos < bytes.length) yield* this.pieces(bytes.subarray(pos), pos === 0 ? sha : undefined)
  }
  intern(bytes, kind) {
    const sha = this.contentHash(bytes),
      old = this.q('SELECT id,size FROM documents WHERE sha=?').get(sha)
    if (old) {
      if (kind) this.q('INSERT OR IGNORE INTO versions VALUES(?,?)').run(kind, old.id)
      return { id: old.id, sha, size: old.size }
    }
    const doc = Number(
      this.q('INSERT INTO documents(sha,size) VALUES(?,?)').run(sha, bytes.length).lastInsertRowid
    )
    if (kind) this.q('INSERT INTO versions VALUES(?,?)').run(kind, doc)
    let entries = [],
      at = 0
    const flush = () => {
      if (!entries.length) return
      const data = Buffer.allocUnsafe(entries.length * 12)
      let count = 0
      for (const [index, [id, length, codec]] of entries.entries()) {
        data.writeInt32LE(id, index * 12)
        data.writeUInt32LE(length, index * 12 + 4)
        data.writeUInt32LE(codec, index * 12 + 8)
        count += length
      }
      // An ordered tuple sequence shorter than a SHA-256 key is already an
      // exact, collision-free key. The old 32-byte namespace stays disjoint.
      const compact = data.length < 32
      const hash = compact ? data : Buffer.from(this.contentHash(data), 'hex')
      const existing = compact
        ? this.q(`SELECT id FROM layouts
            WHERE hash=? OR (length(hash)=32 AND length(entries)<32 AND entries=?) LIMIT 1`).get(data, data)
        : this.q('SELECT id FROM layouts WHERE hash=?').get(hash)
      const id =
        existing?.id ??
        Number(this.q('INSERT INTO layouts(hash,entries) VALUES(?,?)').run(hash, data).lastInsertRowid)
      if (!existing)
        for (const chunk of new Set(
          entries.filter((item) => item[2] !== 2 && item[0] > 0).map((item) => item[0])
        ))
          this.q('INSERT INTO members VALUES(?,?)').run(id, chunk)
      if (!existing)
        for (const child of new Set(entries.filter((item) => item[2] === 2).map((item) => item[0])))
          this.q('INSERT INTO nested VALUES(?,?)').run(id, child)
      if (!existing)
        for (const image of new Set(entries.filter((item) => item[0] < 0).map((item) => -item[0])))
          this.q('INSERT INTO layout_images VALUES(?,?)').run(id, image)
      this.q('INSERT INTO spans(doc,at,layout) VALUES(?,?,?)').run(doc, at, id)
      at += count
      entries = []
    }
    for (const piece of this.documentPieces(bytes, kind, sha)) {
      entries.push(piece)
      if (
        entries.length >= 96 ||
        (entries.length >= 12 && ((Math.imul(piece[0], 2654435761) >>> 21) & 31) === 0)
      )
        flush()
    }
    flush()
    return { id: doc, sha, size: bytes.length }
  }
  put(name, data, { exclusive = false, expected, revision } = {}) {
    canonicalKey(name)
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data)
    return this.transaction(() => {
      const old = this.info(name)
      if (exclusive && old) storageError('EEXIST')
      if (expected !== undefined && (old?.sha ?? null) !== expected) storageError('CAS_CONFLICT')
      const doc = this.intern(bytes, documentKind(name))
      if (old?.sha !== doc.sha)
        this.q(
          `INSERT INTO files VALUES(?,?,?,?,?)
        ON CONFLICT(name) DO UPDATE SET doc=excluded.doc,generation=excluded.generation,updated=excluded.updated`
        ).run(name, path.posix.dirname(name), doc.id, (old?.generation ?? 0) + 1, Date.now())
      if (old?.sha !== doc.sha && /^execution-view-v1\/[a-f0-9-]{36}\.json$/.test(name)) {
        const row = JSON.parse(bytes)
        if (
          row.id + '.json' !== path.posix.basename(name) ||
          !Number.isSafeInteger(row.sequence) ||
          !Number.isSafeInteger(row.revision) ||
          typeof row.key !== 'string' ||
          typeof row.state !== 'string'
        )
          storageError('INVALID_DISPLAY_RECORD')
        this.q(
          `INSERT INTO display_index VALUES(?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET rev=excluded.rev,state=excluded.state`
        ).run(name, row.id, row.key, row.sequence, row.revision, row.state)
      }
      // A supervision-only commit legitimately keeps the graph revision. Its
      // durable ordinal still advances and both exact states remain queryable.
      if (revision !== undefined && old?.sha !== doc.sha)
        this.q(
          'INSERT INTO state_history SELECT ?,coalesce(max(ordinal),0)+1,?,? FROM state_history WHERE series=?'
        ).run(name, revision, doc.id, name)
      if (old && old.doc !== doc.id) this.release(old.doc)
      return { sha: doc.sha, size: bytes.length }
    })
  }
  info(name) {
    return this.q(
      'SELECT f.doc,f.generation,f.updated,d.sha,d.size FROM files f JOIN documents d ON d.id=f.doc WHERE f.name=?'
    ).get(canonicalKey(name))
  }
  list(directory) {
    return this.q('SELECT name FROM files WHERE parent=? ORDER BY name')
      .all(directory)
      .map((row) => path.posix.basename(row.name))
  }
  read(name, start = 0, length, metrics) {
    const row = this.info(name)
    if (!row) storageError('ENOENT')
    return this.range(row, start, length, metrics)
  }
  range(row, start = 0, length = row.size - start, metrics, verify = true) {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(length) ||
      start < 0 ||
      length < 0 ||
      start > row.size
    )
      storageError('WORKFLOW_STORAGE_RANGE')
    const end = Math.min(row.size, start + length)
    if (start === end) return Buffer.alloc(0)
    const full = verify && start === 0 && end === row.size
    const base = this.q('SELECT max(at) AS at FROM spans WHERE doc=? AND at<=?').get(row.doc, start).at
    const result = []
    for (const span of this.q(
      'SELECT s.at,l.entries FROM spans s JOIN layouts l ON l.id=s.layout WHERE s.doc=? AND s.at>=? AND s.at<? ORDER BY s.at'
    ).all(row.doc, base, end)) {
      const list = Buffer.from(span.entries)
      let cursor = span.at
      for (let i = 0; i < list.length && cursor < end; i += 12) {
        const id = list.readInt32LE(i),
          size = list.readUInt32LE(i + 4),
          encoded = list.readUInt32LE(i + 8)
        const low = Math.max(0, start - cursor),
          high = Math.min(size, end - cursor)
        cursor += size
        if (low >= high) continue
        let piece
        if (encoded === 2) {
          const child = this.q('SELECT id AS doc,size,sha FROM documents WHERE id=?').get(id)
          if (!child || child.size !== size) storageError('WORKFLOW_STORAGE_CONTENT_MISSING')
          piece = this.range(child, low, high - low, metrics, verify && !full)
        } else if (id < 0) {
          const image = this.q('SELECT pin,size FROM images WHERE id=?').get(-id)
          const from = Math.floor(low / 4) * 3,
            to = Math.min(image.size, Math.ceil(high / 4) * 3)
          const fd = fs.openSync(
            path.join(this.directory, 'media-pins', image.pin),
            fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
          )
          try {
            const stat = fs.fstatSync(fd, { bigint: true }),
              signature = [stat.dev, stat.ino, stat.size, stat.ctimeNs, stat.mtimeNs].join(':')
            if (this.verifiedPins.get(image.pin) !== signature) {
              if (sha256(fs.readFileSync(fd)) !== image.pin)
                storageError('WORKFLOW_STORAGE_PIN_CONTENT_CHANGED')
              this.verifiedPins.set(image.pin, signature)
              if (metrics) metrics.verifiedBytes = (metrics.verifiedBytes ?? 0) + Number(stat.size)
            }
            const info = fs.fstatSync(fd),
              bytes = Buffer.alloc(to - from)
            if (
              !info.isFile() ||
              info.size !== image.size ||
              fs.readSync(fd, bytes, 0, bytes.length, from) !== bytes.length
            )
              storageError('WORKFLOW_STORAGE_PIN_CONTENT_CHANGED')
            piece = Buffer.from(bytes.toString('base64').slice(low % 4, (low % 4) + high - low))
            if (metrics) metrics.decodedBytes += bytes.length
          } finally {
            fs.closeSync(fd)
          }
        } else {
          const blob = this.q('SELECT codec,data,hash FROM chunks WHERE id=?').get(id)
          if (!blob) storageError('WORKFLOW_STORAGE_CONTENT_MISSING')
          const raw = blob.codec ? zstdDecompressSync(blob.data) : Buffer.from(blob.data)
          if (verify && !full && !Buffer.from(blob.hash).equals(Buffer.from(this.contentHash(raw), 'hex')))
            storageError('WORKFLOW_STORAGE_CONTENT_CHANGED')
          if (metrics) metrics.decodedBytes += raw.length
          piece = encoded ? Buffer.from(raw.toString('base64').slice(low, high)) : raw.subarray(low, high)
        }
        result.push(piece)
      }
    }
    const data = Buffer.concat(result)
    if (data.length !== end - start || (full && this.contentHash(data) !== row.sha))
      storageError('WORKFLOW_STORAGE_CONTENT_CHANGED')
    return data
  }
  release(doc) {
    if (
      this.q('SELECT 1 FROM nested WHERE child=? LIMIT 1').get(doc) ||
      this.q('SELECT 1 FROM stream_parts WHERE doc=? LIMIT 1').get(doc) ||
      this.q('SELECT 1 FROM files WHERE doc=? LIMIT 1').get(doc) ||
      this.q('SELECT 1 FROM state_history WHERE doc=? LIMIT 1').get(doc)
    )
      return
    const layouts = this.q('SELECT DISTINCT layout FROM spans WHERE doc=?').all(doc)
    this.q('DELETE FROM documents WHERE id=?').run(doc)
    for (const { layout } of layouts) {
      if (this.q('SELECT 1 FROM spans WHERE layout=? LIMIT 1').get(layout)) continue
      const chunks = this.q('SELECT chunk FROM members WHERE layout=?').all(layout)
      const children = this.q('SELECT child FROM nested WHERE layout=?').all(layout)
      this.q('DELETE FROM layouts WHERE id=?').run(layout)
      for (const { child } of children) this.release(child)
      for (const { chunk } of chunks)
        this.q('DELETE FROM chunks WHERE id=? AND NOT EXISTS(SELECT 1 FROM members WHERE chunk=?)').run(
          chunk,
          chunk
        )
    }
  }
  appendStream(name, offset, bytes) {
    canonicalKey(name)
    return this.transaction(() => {
      this.q('INSERT OR IGNORE INTO streams VALUES(?,0)').run(name)
      const current = this.q('SELECT size FROM streams WHERE name=?').get(name)
      if (current.size !== offset) storageError('WORKFLOW_STREAM_OFFSET_CONFLICT')
      if (!bytes.length) return
      const doc = this.intern(bytes)
      this.q('INSERT INTO stream_parts VALUES(?,?,?)').run(name, offset, doc.id)
      this.q('UPDATE streams SET size=? WHERE name=?').run(offset + bytes.length, name)
    })
  }
  readStream(name, start = 0, length) {
    const size = this.q('SELECT size FROM streams WHERE name=?').get(canonicalKey(name))?.size ?? 0
    const end = Math.min(size, start + (length ?? size))
    if (start >= end) return Buffer.alloc(0)
    const base = this.q('SELECT max(at) AS at FROM stream_parts WHERE name=? AND at<=?').get(name, start).at
    const pieces = []
    for (const row of this.q(
      'SELECT p.at,p.doc,d.size,d.sha FROM stream_parts p JOIN documents d ON d.id=p.doc WHERE p.name=? AND p.at>=? AND p.at<? ORDER BY p.at'
    ).iterate(name, base, end)) {
      const lo = Math.max(0, start - row.at),
        hi = Math.min(row.size, end - row.at)
      pieces.push(this.range(row, lo, hi - lo))
    }
    return Buffer.concat(pieces)
  }
  remove(name) {
    this.transaction(() => {
      const row = this.info(name)
      if (row) {
        this.q('DELETE FROM files WHERE name=?').run(name)
        this.release(row.doc)
      }
    })
  }
  close() {
    this.db.close()
  }
}
