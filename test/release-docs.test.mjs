// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { renderInstallBlock, checkReadme, syncReadme } from '../scripts/release-docs.mjs'
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)))
const line = JSON.parse(fs.readFileSync(new URL('../DSH-COMPATIBILITY.json', import.meta.url)))
const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8')

test('README installation instructions match this exact package and companion', () => {
  assert.equal(checkReadme(readme, pkg, line), true)
  const obsolete = readme.replaceAll(line.taskgraph, '0.3.1-rc.40').replaceAll(line.dynamicContext, '0.1.1-rc.40')
  assert.throws(() => checkReadme(obsolete, pkg, line), /INSTALL_DOCS_STALE: README.md:\d+/)
})
test('installation metadata refuses an incompatible companion or host', () => {
  const stale = structuredClone(pkg)
  if (pkg.name === 'dsh-dynamic-context') {
    stale.peerDependencies['dsh-better-task-grapth'] = '0.3.1-rc.40'
    assert.throws(() => renderInstallBlock(stale, line), /peerDependencies.*companion mismatch/)
  }
  stale.engines.dsh = '0.0.0'
  assert.throws(() => renderInstallBlock(stale, line), /engines\/dsh/)
})
test('sync changes only the installation block and rejects duplicate blocks', () => {
  const doc = '# Heading\n\n' + renderInstallBlock(pkg, line).replace('npm ci', 'npm install') + '\n\nHistorical notes\n'
  assert.equal(syncReadme(doc, pkg, line), '# Heading\n\n' + renderInstallBlock(pkg, line) + '\n\nHistorical notes\n')
  assert.throws(() => syncReadme(doc + renderInstallBlock(pkg, line), pkg, line), /expected one installation block/)
})
