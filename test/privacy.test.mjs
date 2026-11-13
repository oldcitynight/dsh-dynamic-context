import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createPrivatePathGuard } from '../execution-privacy.mjs'
import { createRuntimeHarness, runtimeProposal } from '../testing/runtime-harness.mjs'

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
async function fixture(t, options = {}) {
  const storageRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-private-paths-')))
  const projectRoot = storageRoot + '/workspace', home = projectRoot + '/.dsh'
  fs.mkdirSync(projectRoot); fs.mkdirSync(home)
  const credential = home + '/.credentials.yaml'
  fs.writeFileSync(credential, 'SYNTHETIC_SECRET_CREDENTIAL\n')
  fs.writeFileSync(home + '/toolchain.txt', 'NONSECRET_TOOLCHAIN\n')
  fs.writeFileSync(storageRoot + '/host-only.txt', 'SYNTHETIC_PRIVATE_HISTORY\n')
  const h = await createRuntimeHarness({ projectRoot, directory: storageRoot + '/state', ...options,
    config: { storageRoot, timeoutMs: 20000, ...options.config } })
  t.after(async () => { await h.close(); fs.rmSync(storageRoot, { recursive: true, force: true }) })
  return { ...h, storageRoot, projectRoot, home, credential }
}

test('native shell and broad search conceal private state and credentials while ordinary project work continues', async t => {
  let h
  h = await fixture(t, { respond: ({ index, payload }) => {
    if (index > 1) {
      const outputs = payload.messages.filter(m => m.role === 'tool').map(m => m.content).join('\n')
      assert.doesNotMatch(outputs, /SYNTHETIC_SECRET_CREDENTIAL|SYNTHETIC_PRIVATE_HISTORY/)
      assert.match(outputs, /PRIVATE_BOUNDARY_CHECKS_PASSED/)
      return { text: 'Synthetic privacy and ordinary project checks completed.' }
    }
    const program = `from pathlib import Path
import json
private = Path(${JSON.stringify(h.storageRoot + '/host-only.txt')})
credential = Path(${JSON.stringify(h.credential)})
assert not private.exists()
assert credential.read_bytes() == b''
assert (credential.parent / 'toolchain.txt').read_text() == 'NONSECRET_TOOLCHAIN\\n'
for target in [credential, private]:
    try:
        target.write_text('FORBIDDEN')
    except OSError:
        pass
    else:
        raise AssertionError('private target was writable')
Path('ordinary.txt').write_text('ORDINARY_PROJECT_WRITE')
assert json.loads('{"works":true}')['works']
print('PRIVATE_BOUNDARY_CHECKS_PASSED')`
    return { tools: [{ name: 'bash', arguments: { command: 'python3 -B -c ' + quote(program), description: 'Check synthetic private paths', timeoutMs: 3000 } },
      { name: 'grep', arguments: { pattern: 'SYNTHETIC_SECRET|SYNTHETIC_PRIVATE', path: '.' } }] }
  } })
  h.runner.submit(runtimeProposal(['bash', 'grep']))
  const result = await h.runner.runNext({ expectedRevision: 1 })
  assert.equal(result.trace.executionHost.privatePaths.processIsolation, true)
  assert.equal(fs.readFileSync(h.projectRoot + '/ordinary.txt', 'utf8'), 'ORDINARY_PROJECT_WRITE')
  assert.equal(fs.readFileSync(h.credential, 'utf8'), 'SYNTHETIC_SECRET_CREDENTIAL\n')
  assert.equal(fs.readFileSync(h.storageRoot + '/host-only.txt', 'utf8'), 'SYNTHETIC_PRIVATE_HISTORY\n')
})

for (const kind of ['credential', 'credential-temp', 'file-alias', 'directory-alias']) test(`native file reads reject the protected ${kind} before dispatch`, async t => {
  let target
  const h = await fixture(t, { respond: () => ({ tools: [{ name: 'read', arguments: { file_path: target } }] }) })
  if (kind === 'file-alias') { fs.symlinkSync(h.credential, h.projectRoot + '/alias'); target = 'alias' }
  else if (kind === 'directory-alias') { fs.symlinkSync(h.home, h.projectRoot + '/alias'); target = 'alias/.credentials.yaml' }
  else target = '.dsh/.credentials.yaml' + (kind === 'credential-temp' ? '.abcdef.tmp' : '')
  h.runner.submit(runtimeProposal(['read']))
  await assert.rejects(h.runner.runNext({ expectedRevision: 1 }), /DIRECT_RUNTIME_PRIVATE_PATH_DENIED/)
  assert.equal(h.backend.requests.length, 1)
  assert.equal(h.runner.graph.read().reports.length, 0)
})

test('an atomic host credential refresh and its new temporary siblings stay hidden from a running native command', async t => {
  let h
  h = await fixture(t, { respond: ({ index }) => index > 1 ? { text: 'Credential refresh remained hidden.' } : { tools: [{ name: 'bash', arguments: {
    description: 'Check a synthetic credential refresh race', timeoutMs: 3000,
    command: 'python3 -B -c ' + quote(`from pathlib import Path
import time
credential = Path(${JSON.stringify(h.credential)})
assert credential.read_bytes() == b''
Path('ready').write_text('ready')
for _ in range(200):
    if Path('continue').exists(): break
    time.sleep(.01)
else: raise AssertionError('host did not continue')
assert credential.read_bytes() == b''
assert not (credential.parent / '.credentials.yaml.refresh.tmp').exists()
assert not (credential.parent / 'new-after-snapshot.txt').exists()
assert (credential.parent / 'toolchain.txt').read_text() == 'NONSECRET_TOOLCHAIN\\n'
print('ATOMIC_REFRESH_HIDDEN')`),
  } }] } })
  h.runner.submit(runtimeProposal(['bash']))
  const pending = h.runner.runNext({ expectedRevision: 1 })
  for (let n = 0; !fs.existsSync(h.projectRoot + '/ready'); n++) {
    if (n > 200) { await pending; assert.fail('Child did not enter the namespace') }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const temporary = h.credential + '.replacement.tmp'
  fs.writeFileSync(temporary, 'SYNTHETIC_NEW_SECRET\n'); fs.renameSync(temporary, h.credential)
  fs.writeFileSync(h.credential + '.refresh.tmp', 'SYNTHETIC_TEMP_SECRET\n')
  fs.writeFileSync(h.home + '/new-after-snapshot.txt', 'new')
  fs.writeFileSync(h.projectRoot + '/continue', 'continue')
  const result = await pending
  assert.match(result.trace.events.find(e => e.type === 'tool/result').data.content[0].text, /ATOMIC_REFRESH_HIDDEN/)
  assert.equal(fs.readFileSync(h.credential, 'utf8'), 'SYNTHETIC_NEW_SECRET\n')
})

test('per-tool service wrapping leaves other sessions unchanged and detects replacement of its native methods', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-private-hook-'))), workspace = root + '/workspace'
  fs.mkdirSync(workspace)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const spawn = spec => spec, subprocess = { spawn }
  const guard = createPrivatePathGuard({ subprocess, workspaceRoot: workspace, protectedRoots: [root], maskRoot: root })
  t.after(() => guard.close())
  const plain = { argv: ['/usr/bin/true'] }
  assert.equal(subprocess.spawn(plain), plain)
  const confined = guard.run(() => subprocess.spawn(plain))
  assert.equal(confined.argv[0], '/usr/bin/bwrap')
  assert.ok(confined.argv.includes(root))
  assert.equal(subprocess.spawn(plain), plain)
  guard.close()
  assert.equal(subprocess.spawn, spawn)
  const another = createPrivatePathGuard({ subprocess, workspaceRoot: workspace, protectedRoots: [root], maskRoot: root })
  subprocess.spawn = () => undefined
  assert.throws(() => another.check(), /DIRECT_PRIVATE_PATH_SERVICE_CHANGED/)
  another.close()
})

test('a native bwrap profile uses the verified absolute runner even when PATH contains a counterfeit', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-private-runner-'))), workspace = root + '/workspace'
  fs.mkdirSync(workspace)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(workspace + '/bwrap', '#!/bin/sh\nprintf PATH_RUNNER_HIJACKED\n', { mode: 0o700 })
  fs.writeFileSync(root + '/private.txt', 'SYNTHETIC_PRIVATE_DATA')
  const profile = ['bwrap', '--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--']
  const sandbox = { confine: argv => ({ argv: [...profile, ...argv], enforcement: 'full' }) }
  const guard = createPrivatePathGuard({ sandbox, workspaceRoot: workspace, protectedRoots: [root], maskRoot: root })
  t.after(() => guard.close())
  const program = `from pathlib import Path; assert not Path(${JSON.stringify(root + '/private.txt')}).exists(); print('VERIFIED_RUNNER_PROTECTED')`
  const argv = ['/usr/bin/python3', '-B', '-c', program], policy = { mode: 'workspace-write' }
  assert.equal((await sandbox.confine(argv, policy)).argv[0], 'bwrap')
  const confined = await guard.run(() => sandbox.confine(argv, policy))
  const result = spawnSync(confined.argv[0], confined.argv.slice(1), { encoding: 'utf8', env: { PATH: workspace } })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), 'VERIFIED_RUNNER_PROTECTED')
  assert.equal(fs.readFileSync(root + '/private.txt', 'utf8'), 'SYNTHETIC_PRIVATE_DATA')
})

test('native workspace-write shell uses its existing isolated temporary directory without changing the host TMPDIR', async t => {
  let h
  h = await fixture(t, { respond: ({ index }) => index > 1 ? { text: 'Temporary directory works inside native isolation.' }
    : { tools: [{ name: 'bash', arguments: { description: 'Check temporary directory within the native mount',
      command: 'test "$TMPDIR" = /tmp && scratch_dir=$(mktemp -d) && printf verified > "$scratch_dir/proof" && cat "$scratch_dir/proof"', timeoutMs: 3000 } }] } })
  const old = process.env.TMPDIR, hostScratch = h.storageRoot + '/host-scratch'; fs.mkdirSync(hostScratch)
  process.env.TMPDIR = hostScratch
  t.after(() => { if (old === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = old })
  h.runner.submit(runtimeProposal(['bash']))
  const result = await h.runner.runNext({ expectedRevision: 1 })
  const receipt = result.trace.events.find(e => e.type === 'tool/result').data
  assert.equal(receipt.value.exitCode, 0)
  assert.equal(receipt.value.stdout.text, 'verified')
  assert.equal(process.env.TMPDIR, hostScratch)
  assert.deepEqual(fs.readdirSync(hostScratch), [])
  assert.equal(fs.readFileSync(h.credential, 'utf8'), 'SYNTHETIC_SECRET_CREDENTIAL\n')
})
