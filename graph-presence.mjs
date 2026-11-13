// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { digest, copy, GraphError } from 'dsh-bettertaskgraphs/core'
import { FileGraphStore } from 'dsh-bettertaskgraphs/store'

const fail = (code, presence) => { const error = new GraphError(code); error.presence = presence; throw error }
export const GRAPH_COMMIT_RECORD = 'plugin:dsh-dynamic-context/graphs-committed-v1'
const seal = value => ({ ...value, checksum: digest(value) })
const sync = directory => { const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) } }

/** The extension's independent commit witness survives loss of its graph file.
 * The base supplies the same generic CAS store for both durable documents.
 * A PREPARED receipt is uncertainty, never proof that no graph existed.
 */
export class TrackedGraphStore {
  constructor(options, factory = config => new FileGraphStore(config)) {
    this.raw = factory(options)
    for (const key of ['file', 'directory', 'projectRoot', 'maximumBytes']) this[key] = this.raw[key]
    this.validate = options.validator; this.checkUpdate = options.updateValidator
    this.binding = digest({ projectRoot: this.projectRoot, directory: this.directory, file: path.basename(this.file) })
    this.witness = factory({ projectRoot: this.projectRoot,
      directory: path.join(this.projectRoot, '.dsh', 'workflow-witnesses-v1', this.binding), fileName: 'witness.json', maximumBytes: null,
      validator: value => {
        if (!value || !Number.isSafeInteger(value.revision) || value.revision < 1 || value.binding !== this.binding
            || !['PREPARED', 'COMMITTED'].includes(value.phase)) fail('GRAPH_WITNESS_INVALID')
        const { checksum, ...body } = value
        if (checksum !== digest(body) || !/^[a-f0-9]{64}$/.test(value.candidateChecksum)) fail('GRAPH_WITNESS_INVALID')
        if (value.committed) this.validate(value.committed)
        if (value.phase === 'COMMITTED' && value.committed?.checksum !== value.candidateChecksum) fail('GRAPH_WITNESS_INVALID')
      },
      updateValidator: (before, after) => {
        if (after.revision !== (before?.revision ?? 0) + 1) fail('GRAPH_WITNESS_REVISION')
      } })
  }
  writeWitness(previous, phase, committed, candidateChecksum) {
    return this.witness.compareAndSwap(previous?.revision ?? 0, () => seal({ revision: (previous?.revision ?? 0) + 1,
      binding: this.binding, phase, committed: committed ? copy(committed) : null, candidateChecksum }))
  }
  inspect() {
    let witness, state, readError
    try { witness = this.witness.read() } catch (error) { return { presence: { state: 'WITNESS_INVALID', previouslyCommitted: null, code: error.code ?? error.name } } }
    try { state = this.raw.read() } catch (error) { readError = error }
    const prior = Boolean(witness?.committed)
    if (readError) {
      let kind = prior ? 'INVALID_AFTER_COMMIT' : 'UNVERIFIED_GRAPH_DATA'
      // This observation classifies damage only; it never authorizes a commit.
      try {
        const stat = fs.lstatSync(this.file)
        if (stat.isFile() && !stat.isSymbolicLink() && (this.maximumBytes === null || stat.size <= this.maximumBytes)) {
          const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
          if (prior && !raw.graph && raw.contexts) kind = 'TASK_GRAPH_LOST'
          if (prior && raw.graph && !raw.contexts) kind = 'CONTEXT_GRAPH_LOST'
        }
      } catch {}
      return { witness, presence: { state: kind, previouslyCommitted: prior, code: readError.code ?? readError.name } }
    }
    if (!witness) return { state, presence: { state: state ? 'COMMIT_WITNESS_MISSING' : 'NEVER_CREATED', previouslyCommitted: state ? null : false } }
    if (witness.phase === 'PREPARED') {
      if (state?.checksum === witness.candidateChecksum) {
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
  read() {
    const result = this.inspect()
    if (!['NEVER_CREATED', 'READY'].includes(result.presence.state)) fail('GRAPH_RECOVERY_REQUIRED', result.presence)
    return result.state ?? null
  }
  compareAndSwap(expectedRevision, update) {
    this.read()
    let prepared
    const next = this.raw.compareAndSwap(expectedRevision, previous => {
      const before = this.inspect()
      if (!['NEVER_CREATED', 'READY'].includes(before.presence.state)) fail('GRAPH_RECOVERY_REQUIRED', before.presence)
      const candidate = update(previous)
      if (candidate?.then) fail('ASYNC_STORE_UPDATE_FORBIDDEN')
      this.validate(candidate); this.checkUpdate(previous, candidate)
      const bytes = Buffer.byteLength(JSON.stringify(candidate) + '\n')
      if (this.maximumBytes !== null && bytes > this.maximumBytes) fail('STORE_BYTE_LIMIT')
      prepared = this.writeWitness(before.witness, 'PREPARED', previous, candidate.checksum)
      return candidate
    })
    this.writeWitness(prepared, 'COMMITTED', next, next.checksum)
    return next
  }
  recoveryPlan() {
    const { witness, presence } = this.inspect()
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
    this.raw.checkDirectory()
    try { fs.mkdirSync(this.raw.lock, { mode: 0o700 }) } catch (error) { if (error.code === 'EEXIST') fail('CAS_LOCK_BUSY_NO_AUTOMATIC_STEAL'); throw error }
    const identity = fs.lstatSync(this.raw.lock), temporary = path.join(this.directory, '.restore-' + randomUUID() + '.tmp')
    let damaged
    try {
      if (this.witness.read()?.checksum !== expectedWitnessChecksum) fail('GRAPH_RECOVERY_WITNESS_CHANGED')
      const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600)
      try { fs.writeFileSync(fd, JSON.stringify(witness.committed) + '\n'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      this.raw.checkDirectory()
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
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
      const current = fs.lstatSync(this.raw.lock)
      if (current.dev !== identity.dev || current.ino !== identity.ino) fail('LOCK_OWNERSHIP_CHANGED')
      fs.rmdirSync(this.raw.lock); sync(this.directory)
    }
  }
}
