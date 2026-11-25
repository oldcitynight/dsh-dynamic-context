// SPDX-License-Identifier: GPL-3.0-only
import { unitSnapshotCodec, unitWitnessCodec } from './unit-storage.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { digest, copy, GraphError } from 'dsh-better-task-grapth/core'
import { acquireFileLease, FileGraphStore } from 'dsh-better-task-grapth/store'

const fail = (code, presence) => { const error = new GraphError(code); error.presence = presence; throw error }
export const GRAPH_COMMIT_RECORD = 'plugin:dsh-dynamic-context/graphs-committed-v1'
const seal = value => ({ ...value, checksum: digest(value) })
const sync = directory => { const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) } }

/** The extension's independent commit witness survives loss of its graph file.
 * The base supplies the same generic CAS store for both durable documents.
 * A PREPARED receipt is uncertainty, never proof that no graph existed.
 */
export class TrackedGraphStore {
  #verifiedWitnessState = null

  constructor(options, factory = config => new FileGraphStore(config)) {
    this.raw = factory({ ...options, codec: unitSnapshotCodec, reuseValidatedReads: true })
    for (const key of ['file', 'directory', 'projectRoot']) this[key] = this.raw[key]
    this.validate = options.validator; this.checkUpdate = options.updateValidator
    this.binding = digest({ projectRoot: this.projectRoot, directory: this.directory, file: path.basename(this.file) })
    this.witness = factory({ projectRoot: this.projectRoot,
      directory: path.join(this.projectRoot, '.dsh', 'workflow-witnesses-v1', this.binding), fileName: 'witness.json', codec: unitWitnessCodec, reuseValidatedReads: true,
      validator: value => {
        if (!value || !Number.isSafeInteger(value.revision) || value.revision < 1 || value.binding !== this.binding
            || !['PREPARED', 'COMMITTED'].includes(value.phase)) fail('GRAPH_WITNESS_INVALID')
        const { checksum, ...body } = value
        if (checksum !== digest(body) || !/^[a-f0-9]{64}$/.test(value.candidateChecksum)) fail('GRAPH_WITNESS_INVALID')
        if (value.committed && value.committed !== this.#verifiedWitnessState) this.validate(value.committed)
        if (value.phase === 'COMMITTED' && value.committed?.checksum !== value.candidateChecksum) fail('GRAPH_WITNESS_INVALID')
      },
      updateValidator: (before, after) => {
        if (after.revision !== (before?.revision ?? 0) + 1) fail('GRAPH_WITNESS_REVISION')
      } })
  }
  writeWitness(previous, phase, committed, candidateChecksum) {
    return this.#recordWitness(previous, phase, committed, candidateChecksum, false)
  }
  #recordWitness(previous, phase, committed, candidateChecksum, alreadyValidated) {
    const snapshot = committed ? copy(committed) : null
    // This exemption applies only to this exact object inside the synchronous
    // CAS. Witnesses loaded from disk still go through the normal verifier.
    if (alreadyValidated) this.#verifiedWitnessState = snapshot
    try {
      return this.witness.compareAndSwap(previous?.revision ?? 0, () => seal({ revision: (previous?.revision ?? 0) + 1,
        binding: this.binding, phase, committed: snapshot, candidateChecksum }))
    } finally { this.#verifiedWitnessState = null }
  }
  inspect(options) { return this.#inspect(options) }
  #inspect({ reconcilePrepared = true, readState = () => this.raw.read() } = {}) {
    let witness, state, readError
    try { witness = this.witness.read() } catch (error) { return { presence: { state: 'WITNESS_INVALID', previouslyCommitted: null, code: error.code ?? error.name } } }
    try { state = readState() } catch (error) { readError = error }
    const prior = Boolean(witness?.committed)
    if (readError) {
      let kind = prior ? 'INVALID_AFTER_COMMIT' : 'UNVERIFIED_GRAPH_DATA'
      // This observation classifies damage only; it never authorizes a commit.
      try {
        const stat = fs.lstatSync(this.file)
        if (stat.isFile() && !stat.isSymbolicLink()) {
          const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
          if (prior && !raw.graph && raw.contexts) kind = 'TASK_GRAPH_LOST'
          if (prior && raw.graph && !raw.contexts) kind = 'CONTEXT_GRAPH_LOST'
        }
      } catch {}
      return { witness, presence: { state: kind, previouslyCommitted: prior, code: readError.code ?? readError.name } }
    }
    if (!witness) return { state, presence: { state: state ? 'COMMIT_WITNESS_MISSING' : 'NEVER_CREATED', previouslyCommitted: state ? null : false } }
    if (witness.phase === 'PREPARED') {
      if (reconcilePrepared && state?.checksum === witness.candidateChecksum) {
        // The atomic graph publication is observable and matches its intent.
        witness = this.writeWitness(witness, 'COMMITTED', state, state.checksum)
      } else return { witness, state, presence: { state: 'COMMIT_REQUIRES_RECONCILIATION', previouslyCommitted: prior } }
    }
    if (!state) return { witness, presence: { state: 'BOTH_GRAPHS_LOST', previouslyCommitted: true,
      lastRevision: witness.committed.revision, witnessChecksum: witness.checksum } }
    if (state.checksum !== witness.committed.checksum) return { witness, state,
      presence: { state: 'GRAPH_WITNESS_CONFLICT', previouslyCommitted: true } }
    return { witness, state, presence: { state: 'READY', previouslyCommitted: true, revision: state.revision, witnessChecksum: witness.checksum } }
  }
  presence() { return this.inspect().presence }
  read(result = this.inspect()) {
    if (!['NEVER_CREATED', 'READY'].includes(result.presence.state)) fail('GRAPH_RECOVERY_REQUIRED', result.presence)
    return result.state ?? null
  }
  compareAndSwap(expectedRevision, update) {
    const db = this.raw.db
    if (db && !db.inTransaction) return db.transaction(() => this.compareAndSwap(expectedRevision,update))
    this.read()
    let witness
    let prepared
    const inspectAndUpdate = previous => {
      const before = this.#inspect({ readState: () => previous })
      if (!['NEVER_CREATED', 'READY'].includes(before.presence.state)) fail('GRAPH_RECOVERY_REQUIRED', before.presence)
      witness = before.witness
      return update(previous)
    }
    const prepare = (previous, candidate) => {
      prepared = this.#recordWitness(witness, 'PREPARED', previous, candidate.checksum, true)
    }
    let next
    if (typeof this.raw.compareAndSwapPrepared === 'function') {
      next = this.raw.compareAndSwapPrepared(expectedRevision, inspectAndUpdate, prepare)
    } else next = this.raw.compareAndSwap(expectedRevision, previous => {
      const candidate = inspectAndUpdate(previous)
      if (candidate?.then) fail('ASYNC_STORE_UPDATE_FORBIDDEN')
      this.validate(candidate); this.checkUpdate(previous, candidate)

      prepare(previous, candidate)
      return candidate
    })
    this.#recordWitness(prepared, 'COMMITTED', next, next.checksum, true)
    return next
  }
  recoveryPlan({ witness, presence } = this.inspect()) {
    return { ...presence, recoveryRequired: !['READY', 'NEVER_CREATED'].includes(presence.state),
      canRestore: witness?.phase === 'COMMITTED' && Boolean(witness.committed),
      ...(witness?.phase === 'COMMITTED' ? { expectedWitnessChecksum: witness.checksum, restoreRevision: witness.committed.revision,
        activeAttemptPreserved: Boolean(witness.committed.graph.state.active) } : {}),
      instruction: 'Never create a replacement graph or downgrade a previously committed workflow because files are missing. Restore an exact verified snapshot or investigate; restoration does not resume execution or clear an active/unknown attempt.' }
  }
  restore(expectedWitnessChecksum) {
    const before = this.inspect(), witness = before.witness
    if (!witness || witness.phase !== 'COMMITTED' || witness.checksum !== expectedWitnessChecksum) fail('GRAPH_RECOVERY_WITNESS_CHANGED')
    this.validate(witness.committed)
    if (before.presence.state === 'READY') return { restored: false, revision: witness.committed.revision }
    if (this.raw.restoreCommitted) return this.raw.db.transaction(() => {
      if (this.witness.read()?.checksum !== expectedWitnessChecksum) fail('GRAPH_RECOVERY_WITNESS_CHANGED')
      this.raw.restoreCommitted(witness.committed)
      const restored=this.read()
      return { restored:true, revision:restored.revision, activeAttemptPreserved:Boolean(restored.graph.state.active), executionResumed:false }
    })
    this.raw.checkDirectory()
    const lease = acquireFileLease(this.raw.lock, { busy: 'CAS_LOCK_BUSY_NO_AUTOMATIC_STEAL',
      invalid: 'LOCK_OWNERSHIP_CHANGED', unavailable: 'CAS_LOCK_UNAVAILABLE' })
    const temporary = path.join(this.directory, '.restore-' + randomUUID() + '.tmp')
    let damaged
    try {
      if (this.witness.read()?.checksum !== expectedWitnessChecksum) fail('GRAPH_RECOVERY_WITNESS_CHANGED')
      const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600)
      try { fs.writeFileSync(fd, JSON.stringify(unitSnapshotCodec.encode(witness.committed)) + '\n'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      this.raw.checkDirectory()
      lease.check()
      if (fs.existsSync(this.file)) {
        const stat = fs.lstatSync(this.file)
        if (!stat.isFile() || stat.isSymbolicLink()) fail('GRAPH_RECOVERY_UNSAFE_TARGET')
        damaged = path.join(this.directory, 'damaged-graph-' + randomUUID() + '.json')
        fs.renameSync(this.file, damaged)
      }
      fs.renameSync(temporary, this.file); sync(this.directory)
      const restored = this.read()
      return { restored: true, revision: restored.revision, activeAttemptPreserved: Boolean(restored.graph.state.active),
        ...(damaged ? { preservedDamagedFile: damaged } : {}), executionResumed: false }
    } finally {
      try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) }
      finally { lease.release() }
    }
  }
}
