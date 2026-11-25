// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs'
import path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { spawnSync } from 'node:child_process'
import { symbols } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { fail } from './core.mjs'

const active = new AsyncLocalStorage(), installations = new WeakMap()
const inside = (root, value) => { const p = path.relative(root, value); return p === '' || p !== '..' && !p.startsWith('..' + path.sep) && !path.isAbsolute(p) }
const original = value => value?.[symbols.original] ?? value
const signature = stat => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(k => String(stat[k])).join(':')
function canonicalLocation(value, exists = fs.existsSync) {
  let current = path.resolve(value)
  const missing = []
  while (!exists(current)) {
    const parent = path.dirname(current)
    if (parent === current) fail('DIRECT_PRIVATE_PATH_INVALID_TARGET')
    missing.unshift(path.basename(current)); current = parent
  }
  return path.join(fs.realpathSync(current), ...missing)
}

export function workflowCredentialFiles(config, credentials) {
  const homes = [resolveDshHome(), config.direct?.runtime?.instructionHomes?.dshHome, path.join(config.projectRoot, '.dsh')]
  return [original(credentials)?.spec?.filename, ...homes.filter(Boolean).map(home => path.join(home, '.credentials.yaml'))]
    .filter(file => typeof file === 'string' && path.isAbsolute(file))
}

export function roleWorkspacePathResolver(config, credentials) {
  const project = fs.realpathSync(config.projectRoot), runtime = config.direct?.runtime
  const requestedCwd = path.resolve(project, runtime?.cwd ?? '.')
  if (!inside(project, requestedCwd)) fail('DIRECT_RUNTIME_PATH_OUTSIDE_WORKSPACE')
  const cwd = fs.realpathSync(requestedCwd)
  if (!inside(project, cwd) || !fs.statSync(cwd).isDirectory()) fail('DIRECT_RUNTIME_PATH_OUTSIDE_WORKSPACE')
  const storage = config.storageRoot ?? project
  const privateRoots = [config.directory, path.join(storage, '.dsh', 'workflow-witnesses-v1'),
    ...(runtime?.privateReadRoots ?? []), ...(canonicalLocation(storage) === project ? [] : [storage])]
    .filter(Boolean).flatMap(root => [path.resolve(root), canonicalLocation(root)]).filter(root => inside(project, root))
  const credentialsGuard = createPrivatePathGuard({ workspaceRoot: project, protectedRoots: [], credentialFiles: workflowCredentialFiles(config, credentials) })
  return requested => {
    const target = path.resolve(project, requested)
    if (![requestedCwd, cwd].some(root => inside(root, target))) fail('DIRECT_RUNTIME_PATH_OUTSIDE_WORKSPACE')
    const resolved = credentialsGuard.assertPath(target)
    if (!inside(cwd, resolved)) fail('DIRECT_RUNTIME_PATH_OUTSIDE_WORKSPACE')
    if (privateRoots.some(root => inside(root, target) || inside(root, resolved))) fail('DIRECT_RUNTIME_PRIVATE_PATH_DENIED')
    return resolved
  }
}
const runner = '/usr/bin/bwrap'
let verifiedRunner
function ensureRunner() {
  if (process.platform !== 'linux') fail('DIRECT_PRIVATE_PATH_PLATFORM_UNSUPPORTED')
  const st = fs.statSync(runner), identity = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`
  if (identity === verifiedRunner) return identity
  const probe = spawnSync(runner, ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--', '/usr/bin/true'], { timeout: 5000, stdio: 'pipe' })
  if (probe.status !== 0) fail('DIRECT_PRIVATE_PATH_RUNNER_UNAVAILABLE')
  verifiedRunner = identity; return identity
}
function hook(service, method, transform) {
  service = original(service)
  if (!service || typeof service[method] !== 'function') fail('DIRECT_PRIVATE_PATH_SERVICE_UNAVAILABLE')
  let methods = installations.get(service)
  if (!methods) installations.set(service, methods = new Map())
  let entry = methods.get(method)
  if (!entry) {
    const descriptor = Object.getOwnPropertyDescriptor(service, method), previous = service[method]
    const wrapped = function (...args) {
      const scope = active.getStore()
      if (!scope || !scope.services.has(service)) return Reflect.apply(previous, this, args)
      scope.check()
      return transform(previous, this, args, scope)
    }
    Object.defineProperty(service, method, { value: wrapped, configurable: true, writable: true })
    entry = { count: 0, descriptor, previous, wrapped }; methods.set(method, entry)
  }
  entry.count++
  return {
    check() { if (service[method] !== entry.wrapped) fail('DIRECT_PRIVATE_PATH_SERVICE_CHANGED') },
    close() {
      if (--entry.count) return
      if (service[method] === entry.wrapped) {
        if (entry.descriptor) Object.defineProperty(service, method, entry.descriptor)
        else delete service[method]
      }
      methods.delete(method)
    },
  }
}

/** Per-tool private mounts. Native write confinement remains an independent layer. */
export function createPrivatePathGuard({ sandbox, subprocess, workspaceRoot, protectedRoots, credentialFiles = [],
  credentialEnvironment = () => [], maskRoot, mode = 'workspace-write' }) {
  const processIsolation = Boolean(sandbox || subprocess)
  const runnerIdentity = processIsolation ? ensureRunner() : null, workspace = fs.realpathSync(workspaceRoot)
  const directories = [...new Set(protectedRoots.map(p => fs.realpathSync(p)))].sort((a, b) => a.length - b.length)
  if (directories.some(p => p === path.parse(p).root || p === workspace || !fs.statSync(p).isDirectory())) fail('DIRECT_PRIVATE_PATH_INVALID_ROOT')
  const directoryPins = [...new Set([workspace, ...directories])].map(p => { const s = fs.statSync(p); return [p, s.dev, s.ino] })
  const credentialLocations = [...new Set(credentialFiles.map(p => path.resolve(p)))].sort()
  let files = [], locations = [], credentialParents = []
  const privateTarget = target => directories.some(p => inside(p, target) && !(inside(p, workspace) && inside(workspace, target)))
  const credentialTarget = target => locations.some(file => target === file || target.startsWith(file + '.')) || files.includes(target)
  const refresh = () => {
    files = [...new Set(credentialLocations.filter(p => fs.existsSync(p)).map(p => fs.realpathSync(p)))]
    if (files.some(p => { const s = fs.statSync(p); return !s.isFile() || s.nlink !== 1 })) fail('DIRECT_PRIVATE_CREDENTIAL_PATH_INVALID')
    locations = [...new Set([...credentialLocations.map(file => canonicalLocation(file)), ...files])]
    credentialParents = [...new Set(locations.map(path.dirname))].filter(p => fs.existsSync(p) && !privateTarget(p)).sort((a, b) => a.length - b.length)
    // Rebuilding an ancestor of the project would change ordinary project writes.
    // Keep custom credential stores in a dedicated directory, as the SDK does.
    if (processIsolation && credentialParents.some(p => inside(p, workspace))) fail('DIRECT_PRIVATE_CREDENTIAL_PARENT_IS_WORKSPACE')
  }
  refresh()
  let maskFile, maskSignature
  if (processIsolation) {
    const parent = fs.realpathSync(maskRoot ?? directories.find(p => !inside(workspace, p)))
    if (inside(workspace, parent)) fail('DIRECT_PRIVATE_PATH_MASK_ROOT_REQUIRED')
    maskFile = path.join(parent, '.private-empty')
    let fd
    try { fd = fs.openSync(maskFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o400); fs.fsyncSync(fd) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
    finally { if (fd !== undefined) fs.closeSync(fd) }
    const st = fs.lstatSync(maskFile, { bigint: true })
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1n || st.size !== 0n) fail('DIRECT_PRIVATE_PATH_MASK_INVALID')
    maskSignature = signature(st)
  }
  let closed = false
  const services = new Set([original(sandbox), original(subprocess)].filter(Boolean)), disposers = []
  const scope = { services, excludedEnvironment: () => new Set(credentialEnvironment().filter(Boolean)), check() {
    if (closed) fail('DIRECT_PRIVATE_PATH_GUARD_CLOSED')
    for (const [directory, dev, ino] of directoryPins) {
      const st = fs.statSync(directory)
      if (!st.isDirectory() || st.dev !== dev || st.ino !== ino || fs.realpathSync(directory) !== directory) fail('DIRECT_PRIVATE_PATH_ROOT_CHANGED')
    }
    if (processIsolation) {
      const s = fs.statSync(runner), m = fs.lstatSync(maskFile, { bigint: true })
      if (`${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}` !== runnerIdentity) fail('DIRECT_PRIVATE_PATH_RUNNER_CHANGED')
      if (!m.isFile() || m.isSymbolicLink() || m.nlink !== 1n || signature(m) !== maskSignature) fail('DIRECT_PRIVATE_PATH_MASK_CHANGED')
    }
    refresh()
    for (const h of disposers) h.check()
  }, wrap(argv, effectiveMode = typeof mode === 'function' ? mode() : mode, excluded = scope.excludedEnvironment()) {
    if (!Array.isArray(argv) || !argv.length) fail('DIRECT_PRIVATE_PATH_ARGV_INVALID')
    const nativeBwrap = path.basename(argv[0]) === 'bwrap'
    const boundary = nativeBwrap ? argv.indexOf('--') : -1
    if (nativeBwrap && boundary < 1) fail('DIRECT_PRIVATE_PATH_RUNNER_DIALECT')
    const args = nativeBwrap ? argv.slice(0, boundary) : [runner, effectiveMode === 'danger-full-access' ? '--bind' : '--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
    if (nativeBwrap) args[0] = runner
    // Native bwrap already grants an isolated writable /tmp for workspace-write.
    // Point child utilities there rather than inheriting an unwritable host
    // TMPDIR. This changes neither mounts/permissions nor the parent environment.
    if (nativeBwrap && effectiveMode === 'workspace-write' && args.some((arg, index) => arg === '--tmpfs' && args[index + 1] === '/tmp'))
      args.push('--setenv', 'TMPDIR', '/tmp')
    for (const root of directories) args.push('--tmpfs', root)
    args.push(effectiveMode !== 'read-only' ? '--bind' : '--ro-bind', workspace, workspace)
    for (const root of directories) if (inside(workspace, root)) args.push('--tmpfs', root)
    // A single bind over the current credential inode is insufficient: the host
    // atomically replaces it during refresh. Snapshot its dedicated parent in
    // the child namespace, retaining non-secret toolchain/configuration entries
    // but omitting the credential family (including atomic temps and locks).
    for (const parent of credentialParents) {
      args.push('--tmpfs', parent)
      const entries = fs.readdirSync(parent, { withFileTypes: true })
      if (entries.length > 4096) fail('DIRECT_PRIVATE_CREDENTIAL_DIRECTORY_TOO_LARGE')
      for (const entry of entries) {
        const source = path.join(parent, entry.name)
        if (credentialTarget(source)) continue
        let target, st
        try { target = fs.realpathSync(source); st = fs.statSync(source) }
        catch (error) { if (error.code === 'ENOENT') continue; throw error }
        if ((!st.isFile() && !st.isDirectory()) || privateTarget(target) || credentialTarget(target)) continue
        // Do not turn a symlink to a protected ancestor into a new bind alias.
        if (source !== target && (directories.some(p => inside(target, p)) || locations.some(p => inside(target, p)))) continue
        args.push('--ro-bind', target, source)
      }
      for (const file of locations.filter(p => path.dirname(p) === parent)) args.push('--ro-bind', maskFile, file)
      for (const root of directories) if (inside(parent, root)) args.push('--tmpfs', root)
      args.push('--remount-ro', parent)
    }
    for (const root of directories) args.push('--remount-ro', root)
    for (const name of excluded) args.push('--unsetenv', name)
    return [...args, '--', ...(nativeBwrap ? argv.slice(boundary + 1) : argv)]
  } }
  try {
    if (sandbox) disposers.push(hook(sandbox, 'confine', (previous, receiver, args, scope) => Promise.resolve(Reflect.apply(previous, receiver, args))
      .then(value => ({ ...value, argv: scope.wrap(value.argv, args[1].mode) }))))
    if (subprocess) disposers.push(hook(subprocess, 'spawn', (previous, receiver, [spec], scope) => {
      const excluded = scope.excludedEnvironment()
      const env = spec.env && Object.fromEntries(Object.entries(spec.env).filter(([name]) => !excluded.has(name)))
      return Reflect.apply(previous, receiver, [{ ...spec, ...(env ? { env } : {}), argv: scope.wrap([...spec.argv], undefined, excluded) }])
    }))
    return { facts: { kind: 'host-private-paths-v1', processIsolation, protectedRoots: directories, credentialFiles: credentialLocations,
      credentialParentPolicy: 'read-only-snapshot-without-credential-family', workspaceRoot: workspace },
      check: () => scope.check(), run: fn => active.run(scope, fn),
      assertPath(requested) {
        if (typeof requested !== 'string') fail('DIRECT_PRIVATE_PATH_INVALID_TARGET')
        scope.check()
        const target = path.resolve(workspace, requested)
        const resolved = canonicalLocation(target, file => fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined)
        if (credentialTarget(target) || credentialTarget(resolved) || privateTarget(resolved)) fail('DIRECT_RUNTIME_PRIVATE_PATH_DENIED')
        return resolved
      },
      close() {
        if (closed) return
        closed = true
        for (const h of disposers.splice(0).reverse()) h.close()
      },
    }
  } catch (error) { for (const h of disposers.reverse()) h.close(); throw error }
}
