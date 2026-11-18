// SPDX-License-Identifier: GPL-3.0-only
// Independent final-audit observations. Project bytes are never written or run.
import fs from 'node:fs'
import { IMAGE_TOOL } from './image-content.mjs'
import { nativeImageDescription, readAuditImage } from './audit-image.mjs'
import { auditEvidence, isAuditReference } from './audit-artifacts.mjs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { symbols } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { digest } from 'dsh-better-task-grapth/core'
import { diagnostic, located, parseModelJSON } from 'dsh-better-task-grapth/validation'
import { realProjectPath } from './artifacts.mjs'
import { createPrivatePathGuard } from './execution-privacy.mjs'
import { readBlockage, saveBlockage } from './blockage-evidence.mjs'
import { zipInventoryFile } from './zip-stream.mjs'
import { fail } from './core.mjs'

export { WORKSPACE_AUDIT_MARKER } from './work-quality.mjs'
export const WORKSPACE_TOOLS = Object.freeze({ list: 'dynamic_context_workspace_list', read: 'dynamic_context_workspace_read', zip: 'dynamic_context_workspace_zip' })
export { AUDIT_FRAME_PREFIX, auditFrameDirectory } from './audit-artifacts.mjs'

const inside = (root, target) => { const p = path.relative(root, target); return p === '' || p !== '..' && !p.startsWith('..' + path.sep) && !path.isAbsolute(p) }
const relative = (root, file) => path.relative(root, file).split(path.sep).join('/') || '.'
const sameStat = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink', 'mode'].every(key => a[key] === b[key])
const reject = (code, at, reason, extra = {}) => { throw located(code, { path: at, reason, ...extra }) }
const pageSchema = z.object({ path: z.string().trim().min(1), start: z.number().int().nonnegative().default(0), end: z.number().int().positive().optional() }).strict()
const parameters = { type: 'object', properties: { path: { type: 'string', minLength: 1 }, start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 1 } }, required: ['path'], additionalProperties: false }
const citationInstruction = 'Evidence references use source and sourceSha256 from the result envelope, but path is relative to the returned value: /text, /fileSha256 or /entries/0/path, never /value/text. fileSha256 is a top-level value field, not /image/fileSha256; image contains attachment metadata only. The returned citationExamples show exact identity/text references; identity alone does not prove visual or semantic correctness.'
const wire = (name, description) => ({ type: 'function', function: { name, description: description + '\n' + citationInstruction, parameters } })
const TEXT_BYTES = 16 * 1024 * 1024
const qualification = 'HOST_READ_ONLY_OBSERVATION_NOT_RUNTIME_OR_SEMANTIC_ACCEPTANCE'
const receiptFolder = directory => path.join(directory, 'workspace-tool-results')
function register(catalog, stored) {
  if (stored.value?.source) catalog.set(stored.value.source, { kind: 'workspace', load: () => structuredClone(stored.value.value) })
}
// A pause application can cite the original observations without opening a new
// filesystem capability. Only the host's recorded trigger run is passed here.
export function registerWorkspaceReceipts(directory, catalog) {
  const folder = receiptFolder(directory)
  if (!fs.existsSync(folder)) return
  for (const name of fs.readdirSync(folder).filter(name => /^\d+\.json$/.test(name))) register(catalog, readBlockage(path.join(folder, name)))
}
function pageOf(textOrRows, args, maximum) {
  const count = textOrRows.length, isText = typeof textOrRows === 'string'
  const split = n => isText && n > 0 && n < count && /[\uD800-\uDBFF]/.test(textOrRows[n - 1]) && /[\uDC00-\uDFFF]/.test(textOrRows[n])
  if (args.start > count || split(args.start) || args.end !== undefined && (args.end <= args.start || split(args.end)))
    reject('WORKSPACE_PAGE_RANGE_INVALID', args.end !== undefined && (args.end <= args.start || split(args.end)) ? '/end' : '/start', 'Use an in-range start and a greater end; do not split a UTF-16 character.', { count })
  let end = Math.min(args.end ?? args.start + maximum, args.start + maximum, count)
  if (split(end)) end--
  return { start: args.start, end, count, next: end < count ? end : null,
    ...(isText ? { text: textOrRows.slice(args.start, end), offsets: 'UTF-16' } : { entries: textOrRows.slice(args.start, end), offsets: 'entries' }) }
}

export function workspaceAuditTools(runner, directory, catalog, signal, { images = false, imagesOnly = false, evidenceDirectory = directory } = {}) {
  const { config } = runner, root = fs.realpathSync(config.projectRoot)
  const allowedRoot = realProjectPath(root, path.resolve(root, config.direct.runtime?.cwd ?? '.'))
  const configuredRoots = [config.directory, config.storageRoot, path.join(config.storageRoot ?? root, '.dsh', 'workflow-witnesses-v1'), ...(config.direct.runtime?.privateReadRoots ?? [])].filter(Boolean)
  const privateRoots = [config.directory, path.join(config.storageRoot ?? root, '.dsh', 'workflow-witnesses-v1'), ...(config.direct.runtime?.privateReadRoots ?? [])].filter(Boolean)
  const protectedRoots = configuredRoots.filter(p => fs.existsSync(p) && fs.realpathSync(p) !== root)
  const credentials = runner.ctx?.get?.('credentials'), original = credentials?.[symbols.original] ?? credentials
  const guard = createPrivatePathGuard({ workspaceRoot: root, protectedRoots, credentialFiles: [original?.spec?.filename,
    path.join(resolveDshHome(), '.credentials.yaml'), path.join(root, '.dsh', '.credentials.yaml'),
    config.direct.runtime?.instructionHomes?.dshHome && path.join(config.direct.runtime.instructionHomes.dshHome, '.credentials.yaml')]
    .filter(p => typeof p === 'string' && path.isAbsolute(p)) })
  let ordinal = 0
  const observations = new Map()
  const ensurePublic = requested => {
    signal?.throwIfAborted()
    const target = path.resolve(root, requested)
    if (!inside(root, target) || !inside(allowedRoot, target)) reject('WORKSPACE_PATH_OUTSIDE_PROJECT', '/path', 'Choose a path inside this workflow workspace.', { item: requested, workspace: relative(root, allowedRoot) })
    // Keep even a not-yet-created private store protected. An ancestor storage
    // root does not mask the explicitly authorized project subtree.
    if (privateRoots.some(p => inside(path.resolve(p), target)) || configuredRoots.some(p => { const value = path.resolve(p); return value !== root && inside(root, value) && inside(value, target) }))
      reject('WORKSPACE_PRIVATE_PATH_DENIED', '/path', 'Workflow stores and private read roots are not public project evidence.', { item: requested })
    guard.assertPath(target)
    return target
  }
  const resolveInput = requested => realProjectPath(root, ensurePublic(requested), { directory: false })
  const evidence = auditEvidence(evidenceDirectory, resolveInput, observeFile)
  function workspaceTarget(requested) {
    const name = relative(root, path.resolve(root, requested))
    return { file: () => resolveInput(requested), identityPath: isAuditReference(name) ? './' + name : name }
  }
  function imageTarget(requested) {
    const issued = evidence.resolve(requested)
    return issued ? { ...issued, identityPath: requested } : workspaceTarget(requested)
  }
  function fileObservation(requested, includeBytes = false, maxBytes = Infinity, allowGenerated = false) {
    const target = allowGenerated ? imageTarget(requested) : workspaceTarget(requested)
    return observeFile(target.file, target.identityPath, includeBytes, maxBytes, target.sha256)
  }
  function observeFile(resolve, identityPath, includeBytes = false, maxBytes = Infinity, expectedHash) {
    signal?.throwIfAborted()
    const file = resolve()
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      const before = fs.fstatSync(fd, { bigint: true })
      if (!before.isFile() || before.nlink !== 1n) reject('WORKSPACE_FILE_TYPE_DENIED', '/path', 'Only regular files with one link can be inspected.', { item: identityPath })
      if (Number.isFinite(maxBytes) && before.size > BigInt(maxBytes)) reject('WORKSPACE_FILE_TOO_LARGE', '/path', 'The file exceeds the byte limit for this read.', { item: identityPath, maxBytes, bytes: Number(before.size) })
      const hash = createHash('sha256'), parts = [], buffer = Buffer.alloc(65536)
      let total = 0
      for (;;) {
        signal?.throwIfAborted()
        const size = fs.readSync(fd, buffer, 0, buffer.length, null)
        if (!size) break
        total += size
        if (total > Number(before.size)) reject('WORKSPACE_CHANGED_DURING_READ', '/path', 'The file changed while being read; repeat this read.', { item: identityPath })
        hash.update(buffer.subarray(0, size))
        if (includeBytes) parts.push(Buffer.from(buffer.subarray(0, size)))
      }
      const after = fs.fstatSync(fd, { bigint: true }), outside = fs.lstatSync(resolve(), { bigint: true })
      if (total !== Number(before.size) || !sameStat(before, after) || !sameStat(before, outside) || fs.realpathSync(file) !== file)
        reject('WORKSPACE_CHANGED_DURING_READ', '/path', 'The file changed while being read; repeat this read.', { item: identityPath })
      const fileSha256 = hash.digest('hex')
      if (expectedHash && fileSha256 !== expectedHash)
        reject('AUDIT_EVIDENCE_CHANGED', '/file_path', 'The file differs from its issued evidence reference. Obtain a new observation.', { item: identityPath })
      return { stat: before, identity: { path: identityPath, kind: 'file', fileSha256, bytes: total, mode: Number(before.mode & 0o7777n) },
        ...(includeBytes ? { bytes: Buffer.concat(parts) } : {}) }
    } finally { fs.closeSync(fd) }
  }
  async function archiveObservation(args) {
    const { identity, stat } = fileObservation(args.path)
    const file = realProjectPath(root, ensurePublic(args.path), { directory: false }), fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      if (!sameStat(stat, fs.fstatSync(fd, { bigint: true }))) reject('WORKSPACE_CHANGED_DURING_READ', '/path', 'The archive changed before inspection; repeat the read.')
      const entries = await zipInventoryFile(fd, identity.bytes, signal)
      if (!sameStat(stat, fs.fstatSync(fd, { bigint: true })) || !sameStat(stat, fs.lstatSync(ensurePublic(args.path), { bigint: true })) || fs.realpathSync(file) !== file)
        reject('WORKSPACE_CHANGED_DURING_READ', '/path', 'The archive changed during inspection; repeat the read.')
      return { identity, value: { ...identity, archive: 'ZIP32', ...pageOf(entries, args, 200), qualification,
        coverage: 'validated-member-paths-and-byte-hashes-not-execution-or-archive-member-text' } }
    } finally { fs.closeSync(fd) }
  }
  function directoryObservation(requested) {
    const folder = realProjectPath(root, ensurePublic(requested)), before = fs.lstatSync(folder, { bigint: true })
    const entries = []; let excluded = 0
    // Walk just this directory. Pagination never implies a recursive tree hash.
    const handle = fs.opendirSync(folder)
    try {
      for (;;) {
        signal?.throwIfAborted()
        const entry = handle.readSync(); if (!entry) break
        const file = path.join(folder, entry.name)
        try { ensurePublic(file) } catch (error) {
          if (['WORKSPACE_PRIVATE_PATH_DENIED', 'DIRECT_RUNTIME_PRIVATE_PATH_DENIED'].includes(error.code)) { excluded++; continue }
          throw error
        }
        const st = fs.lstatSync(file)
        entries.push({ name: entry.name, kind: st.isSymbolicLink() ? 'symlink-not-followed' : st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'special-not-readable', bytes: st.size })
        if (entries.length > 100000) reject('WORKSPACE_DIRECTORY_TOO_LARGE', '/path', 'Choose a more specific directory; this shallow listing exceeds 100000 entries.')
      }
    } finally { handle.closeSync() }
    if (!sameStat(before, fs.lstatSync(ensurePublic(requested), { bigint: true })) || fs.realpathSync(folder) !== folder)
      reject('WORKSPACE_CHANGED_DURING_READ', '/path', 'Directory membership changed while listing; repeat this read.')
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    return { entries, identity: { path: relative(root, folder), kind: 'directory', listingSha256: digest(entries), excludedPrivateEntries: excluded,
      coverage: 'shallow-visible-entry-names-types-sizes-not-recursive-file-content' } }
  }
  function inspect(name, args, paginationRequested) {
    if (name === WORKSPACE_TOOLS.list) {
      const { identity, entries } = directoryObservation(args.path)
      return { identity, value: { ...identity, ...pageOf(entries, args, 200), qualification } }
    }
    if (name === WORKSPACE_TOOLS.read) {
      // Large or non-text files still yield a byte identity, not invented text.
      const file = realProjectPath(root, ensurePublic(args.path), { directory: false }), small = fs.statSync(file).size <= TEXT_BYTES
      const { identity, bytes } = fileObservation(args.path, small, small ? TEXT_BYTES : Infinity)
      let text
      if (bytes && !bytes.includes(0)) { try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch {} }
      const content = text === undefined ? { content: small ? 'binary-identity-only' : 'large-file-identity-only', next: null,
        ...(paginationRequested ? { pagination: { applied: false, reason: 'Text pagination is unavailable for this file. Only the whole-file SHA-256 and byte size were verified.' } } : {}) }
        : pageOf(text, args, 16000)
      return { identity, value: { ...identity, ...content, qualification } }
    }
    if (name !== WORKSPACE_TOOLS.zip) fail('WORKSPACE_TOOL_UNKNOWN')
    return archiveObservation(args)
  }
  async function inspectImage(args) {
    const { identity, image, display } = await readAuditImage(runner, args.path, signal, imageTarget, observeFile)
    return { identity, value: { ...identity, image, qualification, display } }
  }
  const tools = [...(imagesOnly ? [] : [wire(WORKSPACE_TOOLS.list, 'Read a shallow directory listing inside the workflow workspace. No writes or symlink traversal. Excluded private entries are counted; this is not a recursive directory identity. Follow next to paginate. Example: {"path":".","start":0,"end":100}.'),
    wire(WORKSPACE_TOOLS.read, 'Verify the SHA-256 and byte size of any file using only its path, e.g. {"path":"delivery/output.bin"}. Omit start and end for file identity. Binary or oversized files return identity only; pagination.applied=false means no text page was read. For UTF-8 text up to 16 MiB, e.g. {"path":"delivery/README.md","start":0,"end":8000}, start is a zero-based UTF-16 offset and end is optional, exclusive and greater than start. Use read_image for image pixels and dynamic_context_workspace_zip for ZIP members.'),
    wire(WORKSPACE_TOOLS.zip, 'Inspect a ZIP32 delivery without extracting or executing it; stream member bytes to validate paths, CRC and hashes. No compressed-file or expanded-byte quota. Other formats return a located limitation. Follow next to paginate entries. Example: {"path":"delivery.zip","start":0,"end":100}.')]),
    ...(images || imagesOnly ? [{ type: 'function', function: { name: IMAGE_TOOL, description: nativeImageDescription + '\nUse a workspace path or a reference returned by a tool in this audit.\n' + citationInstruction,
      parameters: { type: 'object', properties: { file_path: { type: 'string', minLength: 1 } }, required: ['file_path'], additionalProperties: false } } }] : [])]
  return { tools, resolveInput, auditArtifacts: evidence.host, close: () => guard.close(), index() {
    const latest = new Map()
    for (const [source, observation] of observations) latest.set(observation.path, { source, sourceSha256: digest(catalog.get(source).load()), ...observation })
    return { protocol: 'workspace-readonly-v1', qualification, observations: [...latest.values()] }
  }, execute(tool) {
    signal?.throwIfAborted()
    const identity = { ordinal: ++ordinal, name: tool.function.name, id: tool.id, arguments: tool.function.arguments }
    const file = path.join(receiptFolder(directory), ordinal + '.json'), stored = readBlockage(file)
    if (stored) {
      if (digest(stored.identity) !== digest(identity)) fail('WORKSPACE_TOOL_RECEIPT_CHANGED')
      register(catalog, stored)
      if (stored.observation) observations.set(stored.value.source, stored.observation)
      return stored.value
    }
    const persist = (value, observation) => {
      const saved = { identity, value, ...(observation ? { observation } : {}) }
      saveBlockage(file, saved); register(catalog, saved)
      if (observation) observations.set(value.source, observation)
      return value
    }
    const accept = result => {
      const source = `workspace:${path.basename(directory)}:${identity.ordinal}`, sourceSha256 = digest(result.value), value = result.value
      const citationExamples = [], example = (pointer, text) => {
        if (typeof text === 'string' && text) {
          let quote = text.slice(0, 240)
          if (/[\uD800-\uDBFF]$/.test(quote)) quote = quote.slice(0, -1)
          citationExamples.push({ source, sha256: sourceSha256, path: pointer, quote })
        }
      }
      example('/fileSha256', value.fileSha256)
      example('/text', value.text)
      if (value.entries?.length) example('/entries/0/' + (value.entries[0].path ? 'path' : 'name'), value.entries[0].path ?? value.entries[0].name)
      if (!citationExamples.length) example('/path', value.path)
      return persist({ source, sourceSha256, hashFormat: 'canonical-json-object', value,
        citationRoot: 'value (omit the /value envelope prefix)', citationExamples }, result.identity)
    }
    let raw, args
    const rejected = error => {
      if (signal?.aborted) throw error
      if (error.code === 'ENOENT' && args && tool.function.name !== IMAGE_TOOL) {
        const identity = { path: relative(root, ensurePublic(args.path)), kind: 'missing' }
        return accept({ identity, value: { ...identity, qualification } })
      }
      const details = diagnostic(error, { stage: 'workspace-audit', path: args ? (tool.function.name === IMAGE_TOOL ? '/file_path' : '/path') : '' })
      if (tool.function.name === IMAGE_TOOL) {
        const remap = value => {
          if (!value || typeof value !== 'object') return
          if (typeof value.path === 'string') value.path = value.path.replace(/^\/path(?=\/|$)/, '/file_path')
          Object.values(value).forEach(remap)
        }
        remap(details)
      }
      const retryPath = raw && typeof raw.path === 'string' ? raw.path.trim() : ''
      const retryWithPathOnly = tool.function.name === WORKSPACE_TOOLS.read && retryPath &&
        details.issues.length && details.issues.every(issue => issue.path === '/start' || issue.path === '/end')
      if (retryWithPathOnly)
        details.repair = 'Retry with only path to verify file identity or read the first page of UTF-8 text. Supply offsets only for text.'
      return persist({ error: details.code, diagnostic: details, ...(retryWithPathOnly ? { retryArguments: { path: retryPath } } : {}) })
    }
    try {
      raw = parseModelJSON(tool.function.arguments).value
      args = tool.function.name === IMAGE_TOOL
        ? { path: z.object({ file_path: z.string().min(1) }).strict().parse(raw).file_path, start: 0 }
        : pageSchema.parse(raw)
      const result = tool.function.name === IMAGE_TOOL ? inspectImage(args)
        : inspect(tool.function.name, args, Object.hasOwn(raw, 'start') || Object.hasOwn(raw, 'end'))
      return result?.then ? result.then(accept, rejected) : accept(result)
    } catch (error) { return rejected(error) }
  }, checkCurrent(result) {
    // Verify each latest observation and every cited observation. An older,
    // explicitly reread page is historical, never silently updated in place.
    const latest = new Map(), checks = new Map()
    for (const [source, observation] of observations) latest.set(observation.path, { source, observation, at: '/workspaceObservations' })
    if (result.action === 'COMPLETE') for (const row of latest.values()) checks.set(row.source, row)
    const visit = (value, at = '') => {
      if (!value || typeof value !== 'object') return
      if (typeof value.source === 'string' && observations.has(value.source)) checks.set(value.source, { source: value.source, observation: observations.get(value.source), at })
      else for (const [key, item] of Object.entries(value)) visit(item, at + '/' + key.replaceAll('~', '~0').replaceAll('/', '~1'))
    }
    visit(result)
    const current = new Map()
    for (const { source, observation, at } of checks.values()) {
      let now
      try {
        if (!current.has(observation.path)) {
          if (observation.kind === 'missing') {
            const target = ensurePublic(observation.path)
            try { realProjectPath(root, target, { directory: false }); current.set(observation.path, { path: observation.path, kind: 'present' }) }
            catch (error) { if (error.code !== 'ENOENT') throw error; current.set(observation.path, observation) }
          } else current.set(observation.path, observation.kind === 'directory'
            ? directoryObservation(observation.path).identity : fileObservation(observation.path, false, Infinity, true).identity)
        }
        now = current.get(observation.path)
      } catch (error) {
        if (signal?.aborted) throw error
        reject('WORKSPACE_OBSERVATION_STALE', at, 'A previously inspected artifact is no longer readable. Inspect the current state and revise this audit, preserving historical reports.', { source, item: observation.path, cause: error.code ?? error.name })
      }
      if (digest(now) !== digest(observation)) reject('WORKSPACE_OBSERVATION_STALE', at,
        'The inspected artifact changed before audit submission. Read it again and revise affected conclusions and citations; do not replace hashes in historical reports.', { source, item: observation.path })
    }
  } }
}
