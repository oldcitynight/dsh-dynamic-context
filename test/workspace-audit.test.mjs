// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { crc32 } from 'node:zlib'
import { digest } from 'dsh-better-task-grapth/core'
import { workspaceAuditTools, WORKSPACE_TOOLS, registerWorkspaceReceipts } from '../workspace-audit.mjs'
import { verifyReference } from '../blockage-protocol.mjs'
import { zipInventory } from '../delivery-evidence.mjs'
import { validateConfig } from '../index.mjs'
import { directRevisionRole, readRoleRecord } from '../revision-runtime.mjs'
import { startFakeLlama } from '../testing/fake-llama.mjs'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const signal = () => new AbortController().signal
const citation = (receipt, pointer = '/text', quote = receipt.value.text) => ({ source: receipt.source, sha256: receipt.sourceSha256, path: pointer, quote })
function fixture(t, configure = () => {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-audit-')))
  const projectRoot = path.join(root, 'project'), directory = path.join(root, 'state')
  fs.mkdirSync(projectRoot); fs.mkdirSync(directory)
  const config = { projectRoot, directory, storageRoot: root, direct: {} }
  configure(config)
  const runner = { config, ctx: { get: () => undefined } }, run = path.join(directory, 'revisions', 'revision_group_audit_' + randomUUID())
  const scopes = []
  const create = () => { const catalog = new Map(), tools = workspaceAuditTools(runner, run, catalog, signal()); scopes.push(tools); return { tools, catalog } }
  const { tools, catalog } = create()
  let ordinal = 0
  const call = (name, args) => ({ id: 'call_' + ++ordinal, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } })
  t.after(() => { scopes.forEach(s => s.close()); fs.rmSync(root, { recursive: true, force: true }) })
  return { root, projectRoot, runner, run, create, tools, catalog, call, read: (args, name = WORKSPACE_TOOLS.read) => tools.execute(call(name, args)) }
}

test('text pages expose independent file/source hashes, exact citations and UTF-16 continuation', t => {
  const h = fixture(t), file = path.join(h.projectRoot, 'guide.txt'), content = 'A😀B\nactual current artifact'
  fs.writeFileSync(file, content)
  const first = h.read({ path: 'guide.txt', start: 0, end: 3 })
  assert.equal(first.value.text, 'A😀'); assert.equal(first.value.next, 3)
  assert.equal(first.value.fileSha256, sha(content)); assert.equal(first.sourceSha256, digest(first.value))
  assert.equal(verifyReference(citation(first), h.catalog, '/evidence/0').kind, 'workspace')
  const next = h.read({ path: 'guide.txt', start: first.value.next })
  assert.equal(first.value.text + next.value.text, content)
  assert.equal(h.read({ path: 'guide.txt', start: 2 }).error, 'WORKSPACE_PAGE_RANGE_INVALID')
  assert.match(JSON.stringify(h.read({ path: 'guide.txt', end: 2 }).diagnostic), /\/end/)
  assert.match(JSON.stringify(h.read({ path: 'guide.txt', start: 3, end: 1 }).diagnostic), /\/end/)
  h.tools.checkCurrent({ action: 'COMPLETE', evidence: [citation(first), citation(next)] })
  assert.equal(fs.readFileSync(file, 'utf8'), content)
})

test('workspace access is read only and excludes escapes, symlinks, hard links and private credentials', t => {
  const h = fixture(t), outside = path.join(h.root, 'private.txt')
  fs.writeFileSync(outside, 'NEVER_EXPOSE')
  fs.symlinkSync(outside, path.join(h.projectRoot, 'escape'))
  fs.linkSync(outside, path.join(h.projectRoot, 'linked'))
  fs.mkdirSync(path.join(h.projectRoot, '.dsh')); fs.writeFileSync(path.join(h.projectRoot, '.dsh/.credentials.yaml'), 'NEVER_EXPOSE')
  fs.mkdirSync(path.join(h.projectRoot, 'private')); fs.writeFileSync(path.join(h.projectRoot, 'private/data'), 'NEVER_EXPOSE')
  // The declared private roots are fixed when this role starts.
  h.runner.config.direct.runtime = { privateReadRoots: [path.join(h.projectRoot, 'private')] }
  const guarded = h.create()
  for (const p of ['../private.txt', outside, 'escape', 'linked', '.dsh/.credentials.yaml', '.dsh/.credentials.yaml.tmp', 'private/data']) {
    const value = guarded.tools.execute(h.call(WORKSPACE_TOOLS.read, { path: p }))
    assert.ok(value.error, p); assert.doesNotMatch(JSON.stringify(value), /NEVER_EXPOSE/)
  }
  assert.ok(guarded.tools.tools.every(row => Object.values(WORKSPACE_TOOLS).includes(row.function.name)))
  assert.equal(fs.readFileSync(outside, 'utf8'), 'NEVER_EXPOSE')
})

test('a narrowed execution workspace cannot be widened by the auditor', t => {
  const h = fixture(t, config => { fs.mkdirSync(path.join(config.projectRoot, 'permitted')); config.direct.runtime = { cwd: 'permitted' } })
  fs.writeFileSync(path.join(h.projectRoot, 'other.txt'), 'out of scope')
  fs.writeFileSync(path.join(h.projectRoot, 'permitted/allowed.txt'), 'allowed')
  assert.equal(h.read({ path: 'other.txt' }).error, 'WORKSPACE_PATH_OUTSIDE_PROJECT')
  assert.equal(h.read({ path: 'permitted/allowed.txt' }).value.text, 'allowed')
})

test('v2 PASS rechecks uncited latest observations and its child observation can be read by another role', t => {
  const h = fixture(t), parent = path.dirname(h.run), runId = 'revision_unit_audit_' + randomUUID()
  const reader = workspaceAuditTools(h.runner, path.join(parent, runId), new Map(), signal())
  t.after(() => reader.close())
  const file = path.join(h.projectRoot, 'guide.txt')
  fs.writeFileSync(file, 'Observed content')
  const first = reader.execute(h.call(WORKSPACE_TOOLS.read, { path: 'guide.txt' }))
  const catalog = new Map()
  registerGroupObservations(h.runner, { graph: { state: { hierarchy: { groups: {
    fixture_child: { runId, workspaceInspection: reader.index() },
  } } } } }, catalog, signal())
  assert.equal(catalog.get(first.source).load().text, 'Observed content')
  fs.appendFileSync(file, ' (updated)')
  assert.throws(() => reader.checkCurrent({ action: 'PASS' }), { code: 'WORKSPACE_OBSERVATION_STALE' })
  const second = reader.execute(h.call(WORKSPACE_TOOLS.read, { path: 'guide.txt' }))
  reader.checkCurrent({ action: 'PASS' })
  assert.throws(() => reader.checkCurrent({ action: 'PASS', evidence: [citation(first), citation(second)] }), { code: 'WORKSPACE_OBSERVATION_STALE' })
})

test('listing is paginated, excludes private stores and never claims a recursive content identity', t => {
  const h = fixture(t)
  fs.mkdirSync(path.join(h.projectRoot, 'deliverable'))
  fs.writeFileSync(path.join(h.projectRoot, 'deliverable/a.txt'), 'a')
  fs.writeFileSync(path.join(h.projectRoot, 'deliverable/b.txt'), 'b')
  fs.mkdirSync(path.join(h.projectRoot, 'deliverable/private'))
  h.runner.config.direct.runtime = { privateReadRoots: [path.join(h.projectRoot, 'deliverable/private')] }
  const local = h.create(), first = local.tools.execute(h.call(WORKSPACE_TOOLS.list, { path: 'deliverable', end: 1 }))
  assert.equal(first.value.entries.length, 1); assert.equal(first.value.count, 2)
  assert.equal(first.value.next, 1); assert.equal(first.value.excludedPrivateEntries, 1)
  assert.match(first.value.coverage, /not-recursive-file-content/)
  assert.equal(first.value.fileSha256, undefined)
  local.tools.checkCurrent({ action: 'COMPLETE' })
  fs.writeFileSync(path.join(h.projectRoot, 'deliverable/new.txt'), 'new')
  assert.throws(() => local.tools.checkCurrent({ action: 'COMPLETE' }), { code: 'WORKSPACE_OBSERVATION_STALE' })
})

test('binary contents yield host identity without being executed or presented as decoded text', t => {
  const h = fixture(t), bytes = Buffer.from([0, 255, 12, 65])
  fs.writeFileSync(path.join(h.projectRoot, 'result.bin'), bytes)
  const value = h.read({ path: 'result.bin' })
  assert.equal(value.value.fileSha256, sha(bytes)); assert.equal(value.value.content, 'binary-identity-only')
  assert.equal(value.value.text, undefined)
  assert.equal(value.value.pagination, undefined)
  for (const args of [{ start: 0 }, { start: 5, end: 8 }]) {
    const observation = h.read({ path: 'result.bin', ...args })
    assert.equal(observation.value.fileSha256, sha(bytes))
    assert.equal(observation.value.bytes, bytes.length)
    assert.equal(observation.value.text, undefined)
    assert.equal(observation.value.next, null)
    assert.equal(observation.value.pagination.applied, false)
    assert.equal(verifyReference(observation.citationExamples[0], h.catalog, '/evidence/0').kind, 'workspace')
  }
  const error = h.read({ path: 'result.bin', start: 0, end: 0 })
  assert.equal(error.error, 'SCHEMA_VALIDATION_FAILED')
  assert.deepEqual(error.diagnostic.issues.map(issue => issue.path), ['/end'])
  assert.deepEqual(error.retryArguments, { path: 'result.bin' })
  assert.deepEqual(h.read(error.retryArguments).value, value.value)
  assert.equal(h.read({ path: '', end: 0 }).retryArguments, undefined)
})

test('a missing required artifact is citable negative evidence and is invalidated if later created', t => {
  const h = fixture(t), value = h.read({ path: 'missing.txt' })
  assert.equal(value.value.kind, 'missing')
  const ref = citation(value, '/kind', 'missing')
  assert.equal(verifyReference(ref, h.catalog, '/evidence').kind, 'workspace')
  h.tools.checkCurrent({ action: 'REWORK', evidence: [ref] })
  fs.writeFileSync(path.join(h.projectRoot, 'missing.txt'), 'now exists')
  assert.throws(() => h.tools.checkCurrent({ action: 'REWORK', evidence: [ref] }), { code: 'WORKSPACE_OBSERVATION_STALE' })
})

test('paused tools replay exact old bytes; rereads refresh current conclusions without laundering old references', t => {
  const h = fixture(t), file = path.join(h.projectRoot, 'result.txt')
  fs.writeFileSync(file, 'old result')
  const call = h.call(WORKSPACE_TOOLS.read, { path: 'result.txt' }), prior = h.tools.execute(call)
  fs.writeFileSync(file, 'new result')
  const resumed = h.create(), replayed = resumed.tools.execute(call)
  assert.deepEqual(replayed, prior)
  assert.throws(() => resumed.tools.checkCurrent({ action: 'COMPLETE' }), { code: 'WORKSPACE_OBSERVATION_STALE' })
  const fresh = resumed.tools.execute(h.call(WORKSPACE_TOOLS.read, { path: 'result.txt' }))
  resumed.tools.checkCurrent({ action: 'COMPLETE', evidence: [citation(fresh)] })
  assert.throws(() => resumed.tools.checkCurrent({ action: 'COMPLETE', evidence: [citation(prior)] }), { code: 'WORKSPACE_OBSERVATION_STALE' })
  const catalog = new Map(); registerWorkspaceReceipts(h.run, catalog)
  assert.equal(verifyReference(citation(prior), catalog, '/evidence').kind, 'workspace')
  assert.equal(catalog.get(prior.source).load().text, 'old result')
})

test('deleted files can be reread as missing without locking the auditor into stale evidence forever', t => {
  const h = fixture(t), file = path.join(h.projectRoot, 'result.txt')
  fs.writeFileSync(file, 'old result'); h.read({ path: 'result.txt' }); fs.unlinkSync(file)
  const missing = h.read({ path: 'result.txt' })
  h.tools.checkCurrent({ action: 'REWORK', evidence: [citation(missing, '/kind', 'missing')] })
  assert.equal(missing.value.kind, 'missing')
})

test('changed tool identities and tampered read receipts are rejected on replay', t => {
  const h = fixture(t); fs.writeFileSync(path.join(h.projectRoot, 'x'), 'x')
  const call = h.call(WORKSPACE_TOOLS.read, { path: 'x' }); h.tools.execute(call)
  assert.throws(() => h.create().tools.execute({ ...call, id: 'other' }), { code: 'WORKSPACE_TOOL_RECEIPT_CHANGED' })
  const file = path.join(h.run, 'workspace-tool-results/1.json'), stored = JSON.parse(fs.readFileSync(file))
  stored.value.value.value.text = 'forged'; fs.writeFileSync(file, JSON.stringify(stored))
  assert.throws(() => h.create().tools.execute(call), { code: 'BLOCKAGE_JOURNAL_CHANGED' })
})

function zipFixture(name, content = 'hello') {
  const n = Buffer.from(name), b = Buffer.from(content), crc = crc32(b)
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(2048, 6)
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(b.length, 18); local.writeUInt32LE(b.length, 22); local.writeUInt16LE(n.length, 26)
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(2048, 8)
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(b.length, 20); central.writeUInt32LE(b.length, 24); central.writeUInt16LE(n.length, 28)
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10)
  end.writeUInt32LE(46 + n.length, 12); end.writeUInt32LE(30 + n.length + b.length, 16)
  return Buffer.concat([local, n, b, central, n, end])
}
test('ZIP inspection streams delivered member bytes without extraction and rejects corruption', async t => {
  const h = fixture(t), bytes = zipFixture('docs/guide.txt', 'real delivered content')
  fs.writeFileSync(path.join(h.projectRoot, 'delivery.zip'), bytes)
  const value = await h.read({ path: 'delivery.zip' }, WORKSPACE_TOOLS.zip)
  assert.ok(value.value, JSON.stringify(value))
  assert.equal(value.value.entries[0].sha256, sha('real delivered content'))
  assert.equal(value.value.entries[0].path, 'docs/guide.txt'); assert.equal(fs.existsSync(path.join(h.projectRoot, 'docs')), false)
  h.tools.checkCurrent({ action: 'COMPLETE', evidence: [citation(value, '/entries/0/path', 'docs/guide.txt')] })
  assert.throws(() => zipInventory(bytes, signal(), { maxExpandedBytes: 1 }), /expanded content exceeds/)
  fs.writeFileSync(path.join(h.projectRoot, 'bad.zip'), zipFixture('../escaped'))
  assert.equal((await h.read({ path: 'bad.zip' }, WORKSPACE_TOOLS.zip)).error, 'DELIVERY_EVIDENCE_INVALID')
  const corrupt = Buffer.from(bytes); corrupt[45] ^= 1; fs.writeFileSync(path.join(h.projectRoot, 'bad.zip'), corrupt)
  assert.ok((await h.read({ path: 'bad.zip' }, WORKSPACE_TOOLS.zip)).error)
})

test('completed audit replay revalidates current files and preserves earlier rejection history when files revert', async t => {
  const h = fixture(t), file = path.join(h.projectRoot, 'result.txt')
  fs.writeFileSync(file, 'alpha')
  const backend = await startFakeLlama({ respond: ({ payload, index }) => {
    if (payload.messages.at(-1).role !== 'tool') return { tools: [{ name: WORKSPACE_TOOLS.read, arguments: { path: 'result.txt' } }] }
    const receipt = JSON.parse(payload.messages.at(-1).content)
    if (index === 2) fs.writeFileSync(file, 'beta')
    return { text: JSON.stringify({ action: 'COMPLETE', evidence: [citation(receipt)], observed: receipt.value.text }) }
  } })
  t.after(() => backend.close())
  const runner = { ctx: { get: () => ({ resolve: async () => ({ value: 'fake-only' }) }) }, config: validateConfig({
    ...h.runner.config, provider: 'fake', model: 'fake-llama', systemPrompt: 'Final review', transport: 'direct',
    direct: { endpoint: backend.origin + '/v1/chat/completions', apiKeyEnv: 'FAKE_ONLY', durable: true, protocol: 'chat-completions' },
    revision: { policy: { objective: 'Inspect current fixture', requirements: [{ id: 'result', text: 'Read actual result' }] } },
  }) }
  const runId = path.basename(h.run), messages = [{ role: 'system', content: 'Read current result and return a cited COMPLETE JSON object.' }, { role: 'user', content: '{}' }]
  async function run() {
    const scoped = h.create()
    return directRevisionRole(runner, { runId, role: 'group_audit', messages, signal: signal(), readOnlyTools: scoped.tools,
      validateOutput: true, revalidateCompleted: true, validateResult: value => { scoped.tools.checkCurrent(value); return value } })
  }
  assert.equal((await run()).observed, 'beta')
  assert.equal(backend.requests.length, 4)
  assert.equal(readRoleRecord(runner, runId).calls[1].validationRejection.code, 'WORKSPACE_OBSERVATION_STALE')
  assert.equal((await run()).observed, 'beta'); assert.equal(backend.requests.length, 4)
  fs.writeFileSync(file, 'alpha')
  // Do not accept the obsolete second response merely because alpha is back.
  // Replay its historical rejection, reject stale beta, then make a new read.
  assert.equal((await run()).observed, 'alpha'); assert.equal(backend.requests.length, 6)
  const record = readRoleRecord(runner, runId)
  assert.equal(record.calls.filter(row => row.validationRejection).length, 2)
  assert.equal(record.phase, 'COMPLETE'); assert.deepEqual(backend.errors, [])
})

test('ZIP auditor accepts stored and deflated members beyond 128 MiB without extraction', { timeout: 30000 }, async t => {
  const { createDeflateRaw } = await import('node:zlib'), { Readable } = await import('node:stream'), { pipeline } = await import('node:stream/promises')
  const h = fixture(t), size = 129 * 1024 * 1024, chunk = Buffer.alloc(1024 * 1024, 65), name = Buffer.from('large.bin')
  let crc = 0; const hash = createHash('sha256')
  for (let i = 0; i < 129; i++) { crc = crc32(chunk, crc); hash.update(chunk) }
  const expectedHash = hash.digest('hex')
  for (const method of [0, 8]) {
    const file = path.join(h.projectRoot, 'large-' + method + '.zip'), data = path.join(h.projectRoot, 'compressed')
    const chunks = Readable.from((function* () { for (let i = 0; i < 129; i++) yield chunk })())
    if (method === 8) await pipeline(chunks, createDeflateRaw(), fs.createWriteStream(data))
    else await pipeline(chunks, fs.createWriteStream(data))
    const compressed = fs.statSync(data).size, local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22)
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(2048, 6); local.writeUInt16LE(method, 8); local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26)
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(2048, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed, 20); central.writeUInt32LE(size, 24); central.writeUInt16LE(name.length, 28)
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + name.length, 12); end.writeUInt32LE(30 + name.length + compressed, 16)
    fs.writeFileSync(file, Buffer.concat([local, name])); await pipeline(fs.createReadStream(data), fs.createWriteStream(file, { flags: 'a' }))
    fs.appendFileSync(file, Buffer.concat([central, name, end])); fs.unlinkSync(data)
    const result = await h.read({ path: path.basename(file) }, WORKSPACE_TOOLS.zip)
    assert.ok(result.value, JSON.stringify(result)); assert.equal(result.value.entries[0].sha256, expectedHash)
    assert.equal(fs.existsSync(path.join(h.projectRoot, 'large.bin')), false)
  }
})
import { registerGroupObservations } from '../blockage-evidence.mjs'
