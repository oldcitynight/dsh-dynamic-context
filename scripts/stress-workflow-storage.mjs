// SPDX-License-Identifier: GPL-3.0-only
// Read the optional historical workflow only as a byte source. Trials live in a new
// private directory and are destroyed in finally; stdout contains measurements only.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { WorkflowDatabase, sha256 } from '../workflow-database.mjs'
import { backupWorkflow, restoreWorkflow } from '../workflow-backup.mjs'
const historic = process.argv[2],
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-storage-load-')))
const name = 'isolated-load-v1',
  samples = {},
  measures = {},
  start = performance.now()
let db
function time(key, operation) {
  const then = performance.now(),
    value = operation()
  ;(samples[key] ??= []).push(performance.now() - then)
  return value
}
function treeSize(dir) {
  let allocated = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    allocated += entry.isDirectory() ? treeSize(p) : fs.statSync(p).blocks * 512
  }
  return allocated
}
try {
  db = new WorkflowDatabase(root, name, { create: true })
  let message = 'common system prompt and exact tool definitions\n'.repeat(2048)
  let logicalBytes = 0
  for (let i = 1; i <= 320; i++) {
    message += 'turn ' + i + ' ' + randomBytes(512).toString('base64') + '\n'
    let body = Buffer.from(
      JSON.stringify({ messages: [{ role: 'system', content: message }], tools: ['read', 'write'], step: i })
    )
    const receipt = time('growingHistoryWrite', () => db.put('journal/request-' + i, body))
    logicalBytes += body.length
    assert.equal(receipt.sha, sha256(body))
    if (i % 40 === 0) {
      assert.deepEqual(db.read('journal/request-' + i), body)
      ;(measures.growth ??= []).push({ turn: i, logicalBytes, allocated: treeSize(root) })
    }
  }
  const small = Buffer.from('merged static role notice\n'.repeat(180))
  for (let i = 0; i < 2000; i++) time('logicalReference', () => db.put('small/' + i, small))
  for (let i = 0; i < 30; i++) time('incompressible256KiB', () => db.put('random/' + i, randomBytes(262144)))
  for (let i = 0; i < 2500; i++)
    time('indexedLookup', () => assert.ok(db.info('journal/request-' + (1 + ((i * 127) % 320)))))
  measures.historical = []
  if (historic) {
    const families = new Map()
    function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.isFile()) {
          const group =
            /^(request-|snapshot-|archive-|record-)/.exec(e.name)?.[1] ??
            (['role.json', 'trace.json', 'dynamic-context.json'].includes(e.name) ? e.name : null)
          if (group) {
            let a = families.get(group) ?? []
            a.push({ file: p, size: fs.statSync(p).size })
            families.set(group, a)
          }
        }
      }
    }
    walk(historic)
    for (const [family, all] of families) {
      all.sort((a, b) => a.size - b.size)
      for (const rank of new Set(
        [0, 0.25, 0.5, 0.75, 0.9, 0.99, 1].map((x) => Math.floor(x * (all.length - 1)))
      )) {
        const { file } = all[rank],
          src = fs.readFileSync(file),
          k = 'historical/' + family + rank
        const entry = time('historicalWrite', () => db.put(k, src))
        assert.equal(entry.sha, sha256(src))
        const restored = time('historicalFullRead', () => db.read(k))
        assert.deepEqual(restored, src)
        const at = Math.max(0, Math.floor(src.length * 0.61) - 19),
          length = Math.min(733, src.length - at),
          m = { decodedBytes: 0 }
        assert.deepEqual(
          time('historicalRangeRead', () => db.read(k, at, length, m)),
          src.subarray(at, at + length)
        )
        measures.historical.push({
          family,
          rank,
          population: all.length,
          bytes: src.length,
          rangeBytes: length,
          decoded: m.decodedBytes
        })
      }
    }
  }
  measures.pages = db.q('PRAGMA page_count').get().page_count
  measures.tables = Object.fromEntries(
    ['documents', 'layouts', 'chunks', 'members', 'files', 'spans'].map((t) => [
      t,
      db.q('SELECT count(*) AS n FROM ' + t).get().n
    ])
  )
  measures.backups = []
  for (let i = 0; i < 4; i++) {
    db.put('backup/control', String(i))
    const result = time('backup', () => backupWorkflow(db))
    measures.backups.push({ ...result, allocated: treeSize(root) })
  }
  const restored = path.join(root, 'copy')
  fs.mkdirSync(restored)
  time('restore', () => restoreWorkflow(path.join(root, 'recovery'), path.join(restored, 'workflow.sqlite')))
  const copy = new WorkflowDatabase(restored, name)
  try {
    assert.equal(copy.read('backup/control').toString(), '3')
    assert.equal(copy.q('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.deepEqual(copy.q('PRAGMA foreign_key_check').all(), [])
  } finally {
    copy.close()
  }
} finally {
  db?.close()
  fs.rmSync(root, { recursive: true, force: true })
}
const distributions = Object.fromEntries(
  Object.entries(samples).map(([name, values]) => {
    const ordered = values.sort((a, b) => a - b)
    const at = (q) => +ordered[Math.ceil(q * values.length) - 1].toFixed(3)
    return [name, { n: values.length, p50ms: at(0.5), p95ms: at(0.95), maxMs: at(1) }]
  })
)
console.log(
  JSON.stringify(
    {
      scope: 'production storage engine, isolated temporary database',
      status: 'PASS',
      durationMs: Math.round(performance.now() - start),
      temporaryDatabasesRemoved: !fs.existsSync(root),
      ...measures,
      distributions
    },
    null,
    2
  )
)
