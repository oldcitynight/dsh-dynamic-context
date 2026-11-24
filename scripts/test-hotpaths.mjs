// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-heat-')),
  report = path.join(temp, 'observations.jsonl')
try {
  const child = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-concurrency=2',
      '--test-name-pattern',
      'functional pass with repeated|parallel scopes|WebCrypto SHA|repeated failed file observations|new instance checkpoints|report validation reads graph|one status call shares',
      ...['hot-path-probe', 'workflow-storage-runtime', 'supervision', 'orchestration'].map(
        (name) => 'test/' + name + '.test.mjs'
      )
    ],
    { cwd: root, stdio: 'inherit', env: { ...process.env, DSH_PERFORMANCE_REPORT: report } }
  )
  if (child.error) throw child.error
  const rows = fs.existsSync(report)
    ? fs
        .readFileSync(report, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []
  const warnings = rows.filter((row) => row.warnings.length)
  const failed = child.status !== 0 || rows.length === 0
  const status = failed ? 'FAIL' : warnings.length ? 'PASS_WITH_WARNINGS' : 'PASS',
    color = failed ? 'red' : warnings.length ? 'yellow' : 'green'
  const summary = {
    status,
    color,
    scopes: rows.length,
    warnings: warnings.map((row) => ({ scope: row.name, warnings: row.warnings }))
  }
  console.log(color.toUpperCase() + ' ' + status + ' (' + rows.length + ' measured scopes)')
  if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(summary, null, 2) + '\n')
  if (failed) process.exitCode = 1
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}
