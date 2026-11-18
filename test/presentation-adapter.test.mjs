import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { patchNativePresentation, presentationHosts, presentationHashes } from '../scripts/patch-native-presentation.mjs'

test('native presentation adapter is exact, idempotent and refuses incompatible or partial changes', t => {
  const require = createRequire(import.meta.url)
  const modules = path.resolve(path.dirname(require.resolve('@deepseek-ai/dsh/package.json')), '../..')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-presentation-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const relative = '@deepseek-ai/dsh-client-ui-renderer', directory = path.join(root, relative)
  fs.mkdirSync(path.join(directory, 'lib'), { recursive: true })
  const original = fs.readFileSync(path.join(modules, relative, 'lib/client.js'), 'utf8')
    .replaceAll('const Comp=host.presentation?.component(slotKey,entry)??entry.component;', 'const Comp=entry.component;')
    .replace('/* dsh-dynamic-context native-presentation-v1 */get presentation(){return service.ctx.get("dynamicContextPresentation")},', '')
  const file = path.join(directory, 'lib/client.js'), manifest = path.join(directory, 'package.json')
  const installedVersion = JSON.parse(fs.readFileSync(path.join(modules, relative, 'package.json'))).version
  assert.ok(presentationHosts.includes(installedVersion))
  fs.writeFileSync(file, original); fs.writeFileSync(manifest, JSON.stringify({ version: installedVersion }))
  assert.equal(patchNativePresentation(root).changed, true)
  const patched = fs.readFileSync(file, 'utf8')
  assert.equal(patchNativePresentation(root).changed, false)
  assert.equal(fs.readFileSync(file, 'utf8'), patched)
  fs.writeFileSync(file, patched + '\n// unrelated local change\n')
  assert.throws(() => patchNativePresentation(root), /SOURCE_CHANGED/)
  assert.equal(fs.readFileSync(file, 'utf8'), patched + '\n// unrelated local change\n')
  fs.writeFileSync(file, patched.replace('const Comp=host.presentation?.component(slotKey,entry)??entry.component;', 'const Comp=entry.component;'))
  assert.throws(() => patchNativePresentation(root), /PARTIAL_PATCH/)
  for (const version of presentationHosts.filter(version => presentationHashes[version] === presentationHashes[installedVersion])) {
    fs.writeFileSync(file, original); fs.writeFileSync(manifest, JSON.stringify({ version }))
    assert.equal(patchNativePresentation(root).changed, true)
    assert.equal(patchNativePresentation(root).changed, false)
  }
  fs.writeFileSync(file, original); fs.writeFileSync(manifest, JSON.stringify({ version: '0.0.0' }))
  assert.throws(() => patchNativePresentation(root), /VERSION_UNSUPPORTED/)
  assert.equal(fs.readFileSync(file, 'utf8'), original)
})
