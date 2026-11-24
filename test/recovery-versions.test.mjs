// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'

async function install(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-recovery-versions-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const versions = { 'dsh-dynamic-context': '1.0.0', 'dsh-better-task-grapth': '2.0.0' }
  const directory = name => path.join(root, 'node_modules', name)
  const manifest = name => path.join(directory(name), 'package.json')
  const graphName = 'dsh-better-task-grapth'
  const graphExports = { '.': './index.mjs', './workflow-compatibility': './workflow-compatibility.mjs' }
  for (const [name, version] of Object.entries(versions)) {
    fs.mkdirSync(directory(name), { recursive: true })
    fs.writeFileSync(manifest(name), JSON.stringify({ name, version, workflowCompatibilityEpoch: 1, main: './index.mjs', ...(name === graphName ? { exports: graphExports } : {}) }))
    fs.writeFileSync(path.join(directory(name), 'index.mjs'), 'export default 1')
  }
  fs.copyFileSync(fileURLToPath(import.meta.resolve(graphName + '/workflow-compatibility')), path.join(directory(graphName), 'workflow-compatibility.mjs'))
  fs.symlinkSync(path.dirname(createRequire(import.meta.resolve(graphName + '/workflow-compatibility')).resolve('semver/package.json')), directory('semver'), 'dir')
  const module = path.join(directory('dsh-dynamic-context'), 'recovery-versions.mjs')
  fs.copyFileSync(new URL('../recovery-versions.mjs', import.meta.url), module)
  return { versions, directory, manifest, reader: await import(pathToFileURL(module)) }
}

test('local source edits retain eligibility and only the two installed package versions are observed', async t => {
  const { versions, directory, manifest, reader } = await install(t)
  assert.deepEqual(reader.readPluginVersionsSync(), versions)
  const reads = t.mock.method(fs.promises, 'readFile'), stats = t.mock.method(fs.promises, 'stat')
  for (const name of Object.keys(versions)) {
    fs.writeFileSync(path.join(directory(name), 'index.mjs'), 'export default 2')
    fs.writeFileSync(manifest(name), JSON.stringify({ name, version: versions[name], workflowCompatibilityEpoch: 1, description: 'Locally modified' }))
  }
  assert.deepEqual(await reader.readPluginVersions(), versions)
  assert.deepEqual(reads.mock.calls.map(call => call.arguments[0].href).sort(),
    Object.keys(versions).map(name => pathToFileURL(manifest(name)).href).sort())
  assert.equal(stats.mock.callCount(), 0)
  for (const name of Object.keys(versions)) {
    const changed = versions[name] + '-local.1'
    fs.writeFileSync(manifest(name), JSON.stringify({ name, version: changed, workflowCompatibilityEpoch: 1 }))
    assert.equal((await reader.readPluginVersions())[name], changed)
    assert.equal(reader.readPluginVersionsSync()[name], changed)
  }
})

test('missing, malformed or misidentified package versions never fall back to a previous value', async t => {
  const { manifest, reader, versions } = await install(t)
  const name = 'dsh-better-task-grapth', file = manifest(name)
  assert.deepEqual(await reader.readPluginVersions(), versions)
  fs.unlinkSync(file)
  await assert.rejects(reader.readPluginVersions(), { code: 'ENOENT' })
  fs.writeFileSync(file, '{')
  assert.throws(() => reader.readPluginVersionsSync(), SyntaxError)
  for (const data of [{ name }, { name, version: ' ' }, { name, version: 4 }, { name: 'other', version: '2.0.0' }]) {
    fs.writeFileSync(file, JSON.stringify(data))
    await assert.rejects(reader.readPluginVersions(), { code: 'DIRECT_INVALID_PLUGIN_VERSION' })
  }
  fs.writeFileSync(file, JSON.stringify({ name, version: versions[name], workflowCompatibilityEpoch: 1 }))
  assert.deepEqual(await reader.readPluginVersions(), versions)
})
