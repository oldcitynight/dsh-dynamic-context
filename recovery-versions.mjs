// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs'
import { releaseFromManifests } from 'dsh-better-task-grapth/workflow-compatibility'

// Resolve both package roots from this installation, including DSH's profile resolver.
const manifests = [
  ['dsh-dynamic-context', new URL('./package.json', import.meta.url)],
  ['dsh-better-task-grapth', new URL('./package.json', import.meta.resolve('dsh-better-task-grapth'))],
]

export function readWorkflowReleaseSync() {
  return releaseFromManifests(manifests.map(([name, url]) => [name, JSON.parse(fs.readFileSync(url, 'utf8'))]))
}

export async function readWorkflowRelease() {
  return releaseFromManifests(await Promise.all(manifests.map(async ([name, url]) =>
    [name, JSON.parse(await fs.promises.readFile(url, 'utf8'))])))
}

export function readPluginVersionsSync() { return readWorkflowReleaseSync().pluginVersions }
export async function readPluginVersions() { return (await readWorkflowRelease()).pluginVersions }
