// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs, { readFileSync } from 'node:fs'
import { monitorHotPath } from '../testing/hot-path-probe.mjs'

test('a functional pass with repeated SHA and full reads carries a yellow source-located diagnostic', async () => {
  const messages = []
  const operation = () => {
    for (let i = 0; i < 4; i++)
      createHash('sha256')
        .update(readFileSync(new URL(import.meta.url)))
        .digest()
    return 'ok'
  }
  const { value, report } = await monitorHotPath('negative control', operation, {
    calls: 3,
    record: false,
    diagnostic: (message) => messages.push(message)
  })
  assert.equal(value, 'ok')
  assert.equal(report.color, 'yellow')
  assert.deepEqual(report.warnings.map((row) => row.action).sort(), ['hash:sha256', 'readFileSync'])
  for (const row of report.warnings) {
    assert.equal(row.calls, 4)
    assert.ok(row.bytes > 1000)
    assert.match(row.site, /hot-path-probe.test.mjs:\d+/)
  }
  assert.match(messages[0], /YELLOW PASS_WITH_WARNINGS/)
})

test('parallel scopes are independent and a failed operation still fails', async () => {
  const hash = () => createHash('sha256').update('x').digest()
  const concurrent = await Promise.all(
    [1, 2].map((count) =>
      monitorHotPath('concurrent', async () => {
        await Promise.resolve()
        for (let i = 0; i < count; i++) hash()
      })
    )
  )
  assert.deepEqual(
    concurrent.map((result) => result.report.samples[0].calls),
    [1, 2]
  )
  assert.ok(concurrent.every((result) => result.report.status === 'PASS'))
  await assert.rejects(
    monitorHotPath('failed', () => {
      throw new Error('functional failure')
    }),
    /functional failure/
  )
})

test('WebCrypto SHA and asynchronous file lookups report the calling source and distinct targets', async (t) => {
  const { webcrypto } = await import('node:crypto')
  const { report } = await monitorHotPath(
    'async validation',
    async () => {
      for (let i = 0; i < 4; i++) {
        await webcrypto.subtle.digest('SHA-256', Buffer.from('abc'))
        await fs.promises.stat(import.meta.filename)
      }
    },
    { calls: 3, record: false, diagnostic: t.diagnostic.bind(t) }
  )
  assert.equal(report.color, 'yellow')
  assert.equal(report.warnings.find((row) => row.action === 'stat').distinctTargets, 1)
  assert.equal(report.warnings.find((row) => row.action === 'hash:sha256').calls, 4)
})

test('repeated failed file observations remain visible and preserve their original errors', async (t) => {
  const file = import.meta.filename + '.absent'
  const { report } = await monitorHotPath(
    'invalidated evidence',
    async () => {
      for (let i = 0; i < 4; i++) {
        assert.throws(() => fs.lstatSync(file), { code: 'ENOENT' })
        await assert.rejects(fs.promises.stat(file), { code: 'ENOENT' })
      }
    },
    { calls: 3, record: false, diagnostic: t.diagnostic.bind(t) }
  )
  for (const action of ['lstatSync', 'stat']) {
    const row = report.warnings.find((entry) => entry.action === action)
    assert.equal(row.calls, 4)
    assert.equal(row.failures, 4)
    assert.equal(row.distinctTargets, 1)
  }
})
