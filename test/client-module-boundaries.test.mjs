// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { flattenClientModules } from '../scripts/client-module.mjs'

const moduleUrl = code => 'data:text/javascript,' + encodeURIComponent(code)

test('flattened clients preserve native statement boundaries around imports and exports', async () => {
  const dependency = 'export const box = {}\nexport const base = 41 // trailing comment'
  for (const prefix of ['', 'const before = 7\n', 'const before = 7\nexport { before }\n']) {
    const source = prefix + "import { box, base } from './base.mjs'\n"
      + '(() => { box.answer = base + 1 })()\nexport const result = box.answer'
    const native = await import(moduleUrl(source.replace("'./base.mjs'", JSON.stringify(moduleUrl(dependency)))))
    const bundled = flattenClientModules([['./base.mjs', dependency], ['./client.mjs', source]])
    assert.equal(vm.runInNewContext(bundled + '\n;result'), native.result)
  }
  const source = 'const number = 41\nexport { number }\n(() => 42)()'
  await import(moduleUrl(source))
  assert.equal(vm.runInNewContext(flattenClientModules([['./client.mjs', source]])), 42)
  assert.equal(vm.runInNewContext(flattenClientModules([['./one.mjs', 'const n = 41 // trailing comment'],
    ['./two.mjs', '(() => n + 1)()']])), 42)
})
