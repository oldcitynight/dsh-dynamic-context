// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
fs.mkdirSync(new URL('../dist/', import.meta.url), { recursive: true })
const result = spawnSync('npm', ['pack', '--pack-destination', 'dist'], { cwd: new URL('../', import.meta.url), stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
