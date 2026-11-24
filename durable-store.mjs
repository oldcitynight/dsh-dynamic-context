// SPDX-License-Identifier: GPL-3.0-only
import { workflowLocation, storedEntry, writeStored, hasStored, namesStored, statStored } from './workflow-io.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { setImmediate as yieldToLoop } from 'node:timers/promises'
import { canonical, digest } from 'dsh-better-task-grapth/core'
import { fail } from './core.mjs'
import { searchEvidence } from './evidence-search.mjs'

const clean = value => JSON.parse(JSON.stringify(value))
const sha = value => createHash('sha256').update(value).digest('hex')
const seal = value => { const body = clean(value); return { ...body, checksum: digest(body) } }
const checkpointPhases = new Set(['READY', 'PAUSED', 'REPORT_READY'])
const syncDirectory = directory => { const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) } }
function readFile(file) {
  const virtual=storedEntry(file)
  if(virtual) {
    if(virtual.info.size<1) fail('DIRECT_JOURNAL_FILE_INVALID')
    return virtual.db.range(virtual.info)
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const before = fs.fstatSync(fd)
    if (!before.isFile() || before.nlink !== 1 || before.size < 1) fail('DIRECT_JOURNAL_FILE_INVALID')
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd)
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail('DIRECT_JOURNAL_FILE_CHANGED')
    return bytes
  } finally { fs.closeSync(fd) }
}
function decode(bytes) {
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch { fail('DIRECT_JOURNAL_INVALID_JSON') }
  const { checksum, ...body } = value
  if (value.schema !== 1 || checksum !== digest(body)) fail('DIRECT_JOURNAL_CHECKSUM')
  return value
}
function writeFile(file, value, { replace = false } = {}) {
  const bytes = Buffer.from(JSON.stringify(seal(value)) + '\n')
  const saved = writeStored(file,bytes,{exclusive:!replace})
  if(saved) return saved
  const target = replace ? path.join(path.dirname(file), `.journal-${randomUUID()}.tmp`) : file
  const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  if (replace) fs.renameSync(target, file)
  syncDirectory(path.dirname(file))
  return { ref: file, sha256: sha(bytes) }
}

/** Kernel lock: crashes release ownership; a stale PID file is never a lease. */
export async function acquireDirectLease(directory) {
  if (process.platform !== 'linux') fail('DIRECT_DURABLE_LEASE_PLATFORM_UNSUPPORTED')
  const file = path.join(directory, '.direct-execution.lock')
  const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600)
  let child, timer
  try {
    const info = fs.fstatSync(fd)
    if (!info.isFile() || info.nlink !== 1) fail('DIRECT_DURABLE_LEASE_PATH_INVALID')
    // flock's numeric-FD form locks the shared open-file description. The
    // helper exits after acquisition; this runner keeps its own FD open, so
    // no helper process can accidentally release a live runner's lease.
    child = spawn('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], { stdio: ['ignore', 'ignore', 'pipe', fd] })
    await new Promise((resolve, reject) => {
      child.once('error', () => reject(Object.assign(new Error('DIRECT_DURABLE_LEASE_UNAVAILABLE'), { code: 'DIRECT_DURABLE_LEASE_UNAVAILABLE' })))
      child.once('exit', code => {
        if (code === 0) resolve()
        else { const codeName = code === 1 ? 'DIRECT_EXECUTION_LEASE_HELD' : 'DIRECT_DURABLE_LEASE_UNAVAILABLE'; reject(Object.assign(new Error(codeName), { code: codeName })) }
      })
      timer = setTimeout(() => reject(Object.assign(new Error('DIRECT_DURABLE_LEASE_TIMEOUT'), { code: 'DIRECT_DURABLE_LEASE_TIMEOUT' })), 5000)
    })
  } catch (error) { child?.kill(); fs.closeSync(fd); throw error }
  finally { clearTimeout(timer) }
  let released = false
  return { async release() { if (released) return; released = true; fs.closeSync(fd) } }
}

/** Immutable records + atomic head. Effects begin only after their intent is durable. */
export class DirectJournal {
  static open(directory, expected, options) {
    const file = path.join(directory, 'continuation', 'record-1.json')
    if (!hasStored(file)) fail('DIRECT_NO_SAFE_CHECKPOINT')
    const { identity } = decode(readFile(file))
    for (const [key, value] of Object.entries(expected)) if (canonical(identity?.[key]) !== canonical(value)) fail('DIRECT_CHECKPOINT_SCOPE_MISMATCH')
    return new DirectJournal(directory, identity, options)
  }
  constructor(directory, identity) {
    this.directory = path.join(directory, 'continuation')
    this.db = workflowLocation(path.join(directory,'continuation','head.json'))?.db
    this.identity = clean(identity)
    if (!hasStored(this.directory)) { fs.mkdirSync(this.directory, { mode: 0o700 }); syncDirectory(directory) }
    const info = fs.lstatSync(this.directory)
    if (!info.isDirectory() || info.isSymbolicLink()) fail('DIRECT_JOURNAL_DIRECTORY_INVALID')
    this.inode = { dev: info.dev, ino: info.ino }
    this.archives = new Map()
    this.payloadFiles = new Map()
  }
  check() {
    const info = fs.lstatSync(this.directory)
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== this.inode.dev || info.ino !== this.inode.ino) fail('DIRECT_JOURNAL_DIRECTORY_CHANGED')
  }
  inspectHead({ collectRecords = false } = {}) {
    this.check()
    const headFile = path.join(this.directory, 'head.json')
    const records = collectRecords ? [] : undefined
    if (!hasStored(headFile)) {
      if (namesStored(this.directory).some(name => /^record-/.test(name))) fail('DIRECT_JOURNAL_UNCOMMITTED_TAIL')
      return { head: null, checkpoint: null, records }
    }
    const head = decode(readFile(headFile))
    if (!Number.isSafeInteger(head.sequence) || head.sequence < 1) fail('DIRECT_JOURNAL_SEQUENCE')
    if (this.db && !collectRecords && this.lastRead?.head?.checksum === head.record
        && this.lastRead.head.sequence === head.sequence && !hasStored(path.join(this.directory, `record-${head.sequence + 1}.json`))) return this.lastRead
    const identity = canonical(this.identity)
    let previous = null, last, checkpoint = null
    for (let sequence = 1; sequence <= head.sequence; sequence++) {
      last = decode(readFile(path.join(this.directory, `record-${sequence}.json`)))
      if (last.sequence !== sequence || last.previous !== previous || canonical(last.identity) !== identity) fail('DIRECT_JOURNAL_CHAIN')
      previous = last.checksum
      if (checkpointPhases.has(last.phase)) checkpoint = last
      records?.push(last)
    }
    if (head.record !== last.checksum || hasStored(path.join(this.directory, `record-${head.sequence + 1}.json`))) fail('DIRECT_JOURNAL_UNCOMMITTED_TAIL')
    if (this.db) this.lastRead = {head:last,checkpoint}
    return { head: last, checkpoint, records }
  }
  latest() { return this.inspectHead().head }
  assertHeadUnchanged(record) {
    this.check()
    const head = decode(readFile(path.join(this.directory, 'head.json')))
    if (head.sequence !== record.sequence || head.record !== record.checksum
        || hasStored(path.join(this.directory, `record-${head.sequence + 1}.json`))) fail('DIRECT_RESUME_CHECKPOINT_CHANGED')
  }
  append(phase, data = {}) {
    if (this.db && !this.db.inTransaction) return this.db.transaction(() => this.append(phase,data))
    const previous = this.latest(), sequence = (previous?.sequence ?? 0) + 1
    if (!Number.isSafeInteger(sequence)) fail('DIRECT_JOURNAL_RECORD_LIMIT')
    const value = { schema: 1, sequence, identity: this.identity, previous: previous?.checksum ?? null, phase, data }
    writeFile(path.join(this.directory, `record-${sequence}.json`), value)
    const record = seal(value)
    writeFile(path.join(this.directory, 'head.json'), { schema: 1, sequence, record: record.checksum }, { replace: true })
    if (this.db) this.lastRead={head:record,checkpoint:checkpointPhases.has(phase)?record:this.lastRead?.checkpoint ?? null}
    return record
  }
  checkpoint(phase, state) {
    if (this.db && !this.db.inTransaction) return this.db.transaction(() => this.checkpoint(phase,state))
    if (!checkpointPhases.has(phase)) fail('DIRECT_CHECKPOINT_PHASE')
    // Keep the exact wire body once per request. This is lossless storage
    // deduplication; resident model history and its source roles do not change.
    const requests = state.trace?.requests?.map(request => this.referenceRequest(request))
    const stored = requests ? { ...state, trace: { ...state.trace, requests }, payloadReferences: requests.map(r => r.savedPayload) } : state
    const body = { schema: 1, identity: this.identity, ...(requests ? { payloadEncoding: 'request-files-v1' } : {}), state: stored }
    const reference = writeFile(path.join(this.directory, `snapshot-${randomUUID()}.json`), body)
    return this.append(phase, { snapshot: reference })
  }
  referenceRequest(request) {
    const { payload, savedPayload, ...receipt } = request
    if (payload) {
      if (sha(JSON.stringify(payload)) !== request.bodySha256) fail('DIRECT_REQUEST_PAYLOAD_MISMATCH')
      return { ...receipt, savedPayload: this.savePayload(payload, request.bodySha256) }
    }
    const file = this.ownedReference(savedPayload, /^request-[a-f0-9]{64}\.json$/)
    const cached = this.payloadFiles.get(request.bodySha256)
    if (!cached || canonical(cached.reference) !== canonical(savedPayload)) this.loadPayload(savedPayload, request.bodySha256)
    else if (this.payloadSignature(file) !== cached.signature) fail('DIRECT_REQUEST_PAYLOAD_CHANGED')
    return { ...receipt, savedPayload }
  }
  /** Preserve each wire body exactly once. Keep only the latest body resident
   * for the usage anchor; old bodies remain hash-bound, never summarized. */
  externalizeTrace(trace) {
    const requests = trace.requests.map(request => this.referenceRequest(request))
    for (let i = 0; i < trace.requests.length; i++) {
      trace.requests[i].savedPayload = requests[i].savedPayload
      if (i < trace.requests.length - 1) delete trace.requests[i].payload
    }
    return { ...trace, schema: 3, payloadEncoding: 'request-files-v1', requests }
  }
  readCheckpoint(record) {
    if (!checkpointPhases.has(record?.phase)) fail('DIRECT_RESUME_UNCERTAIN_EFFECT')
    const reference = record.data.snapshot
    const file = this.ownedReference(reference, /^snapshot-[a-f0-9-]+\.json$/)
    const bytes = readFile(file)
    if (sha(bytes) !== reference.sha256) fail('DIRECT_CHECKPOINT_HASH_MISMATCH')
    const value = decode(bytes)
    if (canonical(value.identity) !== canonical(this.identity)) fail('DIRECT_CHECKPOINT_SCOPE_MISMATCH')
    if (value.payloadEncoding !== undefined) {
      if (value.payloadEncoding !== 'request-files-v1' || !Array.isArray(value.state.trace?.requests)
          || canonical(value.state.payloadReferences) !== canonical(value.state.trace.requests.map(r => r.savedPayload))) fail('DIRECT_CHECKPOINT_ENCODING_INVALID')
    }
    return value
  }
  restoreRequest(request, hydratePayloads, last) {
    const { savedPayload, ...receipt } = request
    if (receipt.payload !== undefined) fail('DIRECT_CHECKPOINT_ENCODING_INVALID')
    if (!hydratePayloads && !last) return this.referenceRequest(request)
    const payload = this.loadPayload(savedPayload, receipt.bodySha256)
    return hydratePayloads ? { ...receipt, payload } : { ...receipt, savedPayload, payload }
  }
  loadCheckpoint(record, { hydratePayloads = true } = {}) {
    const { state, payloadEncoding } = this.readCheckpoint(record)
    if (payloadEncoding) state.trace.requests = state.trace.requests.map((request, index, all) =>
      this.restoreRequest(request, hydratePayloads, index === all.length - 1))
    return state
  }
  async loadResumeCheckpoint(record, { hydratePayloads = true, signal } = {}) {
    signal?.throwIfAborted()
    const { state, payloadEncoding } = this.readCheckpoint(record)
    if (!payloadEncoding) return state
    const requests = state.trace.requests, restored = []
    // A restart still verifies the exact recorded bodies. Yield between
    // bodies so a long history cannot monopolize the Web service.
    for (const [index, request] of requests.entries()) {
      await yieldToLoop()
      signal?.throwIfAborted()
      restored.push(this.restoreRequest(request, hydratePayloads, index === requests.length - 1))
    }
    // An earlier file must still be the file checked before a later yield.
    for (const request of requests) this.referenceRequest(request)
    state.trace.requests = restored
    return state
  }
  records() { return this.inspectHead({ collectRecords: true }).records }
  latestCheckpoint() { return this.inspectHead().checkpoint }
  readTrace() { return JSON.parse(readFile(path.join(path.dirname(this.directory), 'trace.json'))) }
  payloadSignature(file) {
    const stat = statStored(file, { bigint: true })
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) fail('DIRECT_JOURNAL_FILE_INVALID')
    return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => String(stat[key])).join(':')
  }
  savePayload(payload, bodySha256) {
    this.check()
    const cached = this.payloadFiles.get(bodySha256)
    if (cached) {
      if (this.payloadSignature(cached.reference.ref) !== cached.signature) fail('DIRECT_REQUEST_PAYLOAD_CHANGED')
      return cached.reference
    }
    const file = path.join(this.directory, `request-${bodySha256}.json`)
    let reference
    if (hasStored(file)) {
      reference = { ref: file, sha256: sha(readFile(file)) }
      this.loadPayload(reference, bodySha256)
    } else {
      const body = { schema: 1, identity: this.identity, bodySha256, payload }
      reference = writeFile(file, body)
    }
    this.payloadFiles.set(bodySha256, { reference, signature: this.payloadSignature(file) })
    return reference
  }
  loadPayload(reference, bodySha256) {
    const file = this.ownedReference(reference, /^request-[a-f0-9]{64}\.json$/)
    const signature = this.payloadSignature(file), bytes = readFile(file)
    if (path.basename(file) !== `request-${bodySha256}.json` || sha(bytes) !== reference.sha256) fail('DIRECT_REQUEST_PAYLOAD_HASH_OR_SCOPE_MISMATCH')
    const value = decode(bytes)
    if (canonical(value.identity) !== canonical(this.identity) || value.bodySha256 !== bodySha256
        || sha(JSON.stringify(value.payload)) !== bodySha256) fail('DIRECT_REQUEST_PAYLOAD_HASH_OR_SCOPE_MISMATCH')
    if (this.payloadSignature(file) !== signature) fail('DIRECT_REQUEST_PAYLOAD_CHANGED')
    this.payloadFiles.set(bodySha256, { reference, signature })
    return value.payload
  }
  ownedReference(reference, pattern) {
    this.check()
    if (!reference || typeof reference.ref !== 'string' || path.dirname(reference.ref) !== this.directory
        || !pattern.test(path.basename(reference.ref)) || !/^[a-f0-9]{64}$/.test(reference.sha256)) fail('DIRECT_JOURNAL_REFERENCE_INVALID')
    return reference.ref
  }
  archive(messages) {
    this.check()
    const body = { schema: 1, identity: this.identity, messages }
    const reference = writeFile(path.join(this.directory, `archive-${randomUUID()}.json`), body)
    this.archives.set(reference.sha256, reference)
    return { id: reference.sha256, ...reference }
  }
  restoreArchives(references) {
    for (const reference of references) {
      const file = this.ownedReference(reference, /^archive-[a-f0-9-]+\.json$/)
      const bytes = readFile(file)
      if (sha(bytes) !== reference.sha256 || canonical(decode(bytes).identity) !== canonical(this.identity)) fail('DIRECT_ARCHIVE_HASH_OR_SCOPE_MISMATCH')
      this.archives.set(reference.sha256, reference)
    }
  }
  usage() {
    this.check()
    const location=workflowLocation(path.join(this.directory,'head.json'))
    if(location) return location.db.q('SELECT coalesce(sum(d.size),0) AS bytes FROM files f JOIN documents d ON d.id=f.doc WHERE f.parent=?').get(path.posix.dirname(location.name)).bytes
    let bytes = 0
    for (const file of namesStored(this.directory)) {
      const info = statStored(path.join(this.directory, file))
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('DIRECT_JOURNAL_FILE_INVALID')
      bytes += info.size
    }
    return bytes
  }
  orphans(protectedReferences = []) {
    const head = this.latest(), retained = new Set(['head.json'])
    const protect = references => {
      for (const reference of references ?? []) {
        if (reference?.kind !== 'artifact' || typeof reference.ref !== 'string' || !path.isAbsolute(reference.ref)) continue
        const file = path.resolve(reference.ref)
        if (path.dirname(file) === this.directory) retained.add(path.basename(file))
      }
    }
    protect(protectedReferences)
    for (let sequence = 1; sequence <= (head?.sequence ?? 0); sequence++) {
      const file = `record-${sequence}.json`, record = decode(readFile(path.join(this.directory, file)))
      retained.add(file)
      protect(record.data.evidence)
      if (record.data.snapshot) {
        const reference = record.data.snapshot
        retained.add(path.basename(this.ownedReference(reference, /^snapshot-[a-f0-9-]+\.json$/)))
        const snapshot = this.loadCheckpoint(record)
        for (const reference of snapshot.payloadReferences ?? []) retained.add(path.basename(this.ownedReference(reference, /^request-[a-f0-9]{64}\.json$/)))
        for (const archive of snapshot.archives) {
          this.restoreArchives([archive]); retained.add(path.basename(archive.ref))
        }
      }
    }
    const result = []
    for (const file of namesStored(this.directory).sort()) {
      if (retained.has(file)) continue
      if (!/^(?:snapshot|archive)-[a-f0-9-]+\.json$|^request-[a-f0-9]{64}\.json$|^\.journal-[a-f0-9-]+\.tmp$/.test(file)) fail('DIRECT_MAINTENANCE_UNKNOWN_FILE')
      const ref = path.join(this.directory, file), info = statStored(ref)
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('DIRECT_JOURNAL_FILE_INVALID')
      result.push({ ref, bytes: info.size, ino: info.ino, mtimeMs: info.mtimeMs })
    }
    return result
  }
  loadArchive(archive_id) {
    const reference = this.archives.get(archive_id)
    if (!reference) fail('DIRECT_ARCHIVE_NOT_OWNED')
    const file = this.ownedReference(reference, /^archive-[a-f0-9-]+\.json$/), bytes = readFile(file)
    if (sha(bytes) !== reference.sha256) fail('DIRECT_ARCHIVE_HASH_OR_SCOPE_MISMATCH')
    const archive = decode(bytes)
    if (canonical(archive.identity) !== canonical(this.identity)) fail('DIRECT_ARCHIVE_HASH_OR_SCOPE_MISMATCH')
    return archive
  }
  searchSources(args) {
    const journal = this
    function* documents() {
      for (const [archive_id, reference] of journal.archives) {
        const archive = journal.loadArchive(archive_id)
        for (const [message_index, message] of archive.messages.entries()) {
          for (const field of ['content', 'tool_calls', 'reasoning_content']) {
            const text = field === 'tool_calls' ? JSON.stringify(message.tool_calls ?? []) : message[field] ?? ''
            if (typeof text !== 'string') fail('DIRECT_ARCHIVE_READ_RANGE')
            yield { archive_id, message_index, field, role: message.role, tool_call_id: message.tool_call_id ?? null,
              archiveSha256: reference.sha256, sourceSha256: digest(text), text,
              reader: (start, end) => ({ tool: 'dynamic_context_source_read',
                arguments: { archive_id, message_index, field, offset: start, length: end - start } }) }
          }
        }
      }
    }
    return searchEvidence(documents(), { identity: this.identity, archives: [...this.archives.keys()] }, args)
  }
  readSource({ archive_id, message_index, offset = 0, length = 4096, field = 'content' }) {
    const archive = this.loadArchive(archive_id)
    if (!Number.isSafeInteger(message_index) || message_index < 0 || message_index >= archive.messages.length
        || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1
        || !['content', 'tool_calls', 'reasoning_content'].includes(field)) fail('DIRECT_ARCHIVE_READ_RANGE')
    const message = archive.messages[message_index]
    const source = field === 'tool_calls' ? JSON.stringify(message.tool_calls ?? []) : message[field] ?? ''
    if (typeof source !== 'string' || offset > source.length) fail('DIRECT_ARCHIVE_READ_RANGE')
    return { archive_id, message_index, role: message.role, tool_call_id: message.tool_call_id ?? null,
      sourceKind: message.role === 'user' ? 'generated-checkpoint' : message.role === 'assistant' ? 'model' : 'tool',
      field, offset, sourceSha256: digest(source), archiveSha256: this.archives.get(archive_id).sha256,
      totalCharacters: source.length, text: source.slice(offset, offset + length),
      nextOffset: offset + length < source.length ? offset + length : null, authority: 'archived source; no new permission or current verification' }
  }
}
