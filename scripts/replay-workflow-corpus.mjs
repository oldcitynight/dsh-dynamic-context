// SPDX-License-Identifier: GPL-3.0-only
// Read-only historical replay. Native images are copied to the trial before pinning,
// so that even link counts in a running profile remain untouched.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { WorkflowDatabase, sha256 } from '../workflow-database.mjs'
import { backupWorkflow, restoreWorkflow } from '../workflow-backup.mjs'
const [source, home, output, locationReceipt] = process.argv.slice(2)
if (!source || !home || !output)
  throw Error('Expected workflow directory, native profile home, and measurement file')
const trial = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-corpus-replay-'))),
  pinSource = path.join(trial, 'native-staging')
fs.mkdirSync(pinSource)
if (locationReceipt) fs.writeFileSync(locationReceipt, trial, { flag: 'wx', mode: 0o600 })
const start = Date.now(),
  count = {},
  bytesByFamily = {},
  observed = [],
  rows = [],
  registered = new Map(),
  cache = new Map()
const result = {
  phase: 'import',
  scope: 'historical bytes captured per file, live source read-only',
  sourceFiles: 0,
  sourceBytes: 0,
  restoredFiles: 0,
  restoredBytes: 0,
  elapsedMs: 0,
  changesDuringRead: 0
}
const alloc = (f) => {
  const s = fs.statSync(f, { throwIfNoEntry: false })
  return s ? s.blocks * 512 : 0
}
function files(dir, list) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) files(full, list)
    else if (e.isFile()) list.push(full)
  }
}
function lookup(hash, size) {
  if (registered.has(hash)) return registered.get(hash)
  const raw = path.join(home, 'attachments/v1/objects', hash.slice(0, 2), hash)
  let src = fs.existsSync(raw) ? raw : null
  if (!src)
    for (const f of cache.get(size) ?? []) {
      if (sha256(fs.readFileSync(f)) === hash) {
        src = f
        break
      }
    }
  if (!src) return null
  const out = path.join(pinSource, hash)
  fs.copyFileSync(src, out, fs.constants.COPYFILE_EXCL)
  registered.set(hash, out)
  return out
}
let db
function progress() {
  result.elapsedMs = Date.now() - start
  result.mainBytes = alloc(path.join(trial, 'workflow.sqlite'))
  result.walBytes = alloc(path.join(trial, 'workflow.sqlite-wal'))
  result.peakWalBytes = Math.max(result.peakWalBytes ?? 0, result.walBytes)
  fs.writeFileSync(output + '.progress', JSON.stringify(result) + '\n')
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    if (db) db.close()
    db = null
    fs.rmSync(trial, { recursive: true, force: true })
    Object.assign(result, {
      status: 'INTERRUPTED',
      temporaryDatabasesRemoved: !fs.existsSync(trial),
      elapsedMs: Date.now() - start
    })
    fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
    fs.rmSync(output + '.progress', { force: true })
    process.exit(2)
  })
try {
  const cs = []
  files(path.join(home, 'cache/attachments/request-images'), cs)
  for (const f of cs) {
    const s = fs.statSync(f).size
    const a = cache.get(s) ?? []
    a.push(f)
    cache.set(s, a)
  }
  files(source, rows)
  rows.sort()
  const oldCount = rows.length
  db = new WorkflowDatabase(trial, 'corpus', { create: true, mediaLookup: lookup })
  let cursor = 0
  while (cursor < oldCount) {
    db.transaction(() => {
      let written = 0
      for (let i = 0; i < 160 && cursor < oldCount && written < 48 * 1024 * 1024; i++) {
        const file = rows[cursor++],
          key = path.relative(source, file)
        const before = fs.statSync(file, { bigint: true }),
          bytes = fs.readFileSync(file),
          after = fs.statSync(file, { bigint: true })
        if (
          before.ctimeNs !== after.ctimeNs ||
          before.ino !== after.ino ||
          bytes.length !== Number(after.size)
        ) {
          result.changesDuringRead++
          throw Error('SOURCE_CHANGED_DURING_READ')
        }
        const kind = path
          .basename(file)
          .replace(/^(request|record|archive|snapshot)-.*$/, '$1')
          .replace(/^[a-f\d-]{36}\.(txt|json)$/, 'display-$1')
        const rec = db.put(key, bytes)
        observed.push([key, rec.sha, bytes.length])
        count[kind] = (count[kind] ?? 0) + 1
        bytesByFamily[kind] = (bytesByFamily[kind] ?? 0) + bytes.length
        result.sourceFiles++
        result.sourceBytes += bytes.length
        written += bytes.length
      }
    })
    if (!result.penultimate && cursor >= Math.floor(oldCount * 0.9)) {
      result.penultimate = backupWorkflow(db)
      result.penultimate.fileCount = cursor
    }
    result.peakWalBytes = Math.max(result.peakWalBytes ?? 0, alloc(db.file + '-wal'))
    if (cursor % 1600 < 160) progress()
  }
  result.uniquePinned = registered.size
  result.tables = Object.fromEntries(
    [
      'documents',
      'chunks',
      'layouts',
      'members',
      'nested',
      'layout_images',
      'spans',
      'files',
      'display_index',
      'images'
    ].map((t) => [t, db.q('SELECT count(*) AS count FROM ' + t).get().count])
  )
  result.sourceFamilies = Object.fromEntries(
    Object.keys(count)
      .sort()
      .map((key) => [key, { count: count[key], logicalBytes: bytesByFamily[key] }])
  )
  result.versions = Object.fromEntries(
    db
      .q('SELECT kind,count(*) AS n FROM versions GROUP BY kind')
      .all()
      .map((r) => [r.kind, r.n])
  )
  try {
    result.tableBytes = Object.fromEntries(
      db
        .q('SELECT name,sum(pgsize) AS bytes FROM dbstat GROUP BY name')
        .all()
        .map((r) => [r.name, r.bytes])
    )
  } catch (error) {
    if (!String(error.message).includes('no such table: dbstat')) throw error
  }
  result.displayPagePlan = db
    .q('EXPLAIN QUERY PLAN SELECT id FROM display_index WHERE seq<? ORDER BY seq DESC LIMIT 41')
    .all(Number.MAX_SAFE_INTEGER)
    .map((row) => row.detail)
  result.phase = 'backup'
  progress()
  result.backup = backupWorkflow(db)
  result.mainBytes = alloc(db.file)
  result.walBytes = alloc(db.file + '-wal')
  const backupDir = path.join(trial, 'recovery')
  const parts = []
  files(backupDir, parts)
  result.backupBytes = parts.reduce((n, f) => n + alloc(f), 0)
  const ledger = createHash('sha256')
  for (const [key, hash, length] of observed) ledger.update(key + '\0' + hash + '\0' + length + '\n')
  result.manifestSha256 = ledger.digest('hex')
  result.phase = 'restore'
  progress()
  db.close()
  db = null
  fs.unlinkSync(path.join(trial, 'workflow.sqlite'))
  restoreWorkflow(backupDir, path.join(trial, 'workflow.sqlite'))
  db = new WorkflowDatabase(trial, 'corpus')
  for (const [key, hash, length] of observed) {
    const bytes = db.read(key)
    if (bytes.length !== length || sha256(bytes) !== hash) throw Error('BYTE_REPLAY_MISMATCH')
    result.restoredFiles++
    result.restoredBytes += length
    if (result.restoredFiles % 4000 === 0) progress()
  }
  result.integrity = db.q('PRAGMA integrity_check').get().integrity_check
  result.foreignKeys = db.q('PRAGMA foreign_key_check').all().length
  result.phase = 'finished'
  result.status = 'PASS'
} catch (error) {
  result.status = 'FAIL'
  result.error = error.code ?? error.message
  process.exitCode = 1
} finally {
  if (db) db.close()
  fs.rmSync(trial, { recursive: true, force: true })
  result.elapsedMs = Date.now() - start
  result.temporaryDatabasesRemoved = !fs.existsSync(trial)
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
  fs.rmSync(output + '.progress', { force: true })
}
