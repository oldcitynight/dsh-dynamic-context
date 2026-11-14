// SPDX-License-Identifier: GPL-3.0-only
// Large direct execution records opt into an extension-owned resource policy.
import { artifactProof as prove, artifactCurrentIdentity as identify } from 'dsh-better-task-grapth/host'
export { realProjectPath } from 'dsh-better-task-grapth/host'
export const DIRECT_ARTIFACT_MAX_BYTES = 1024 * 1024 * 1024
export const artifactProof = (root, ref, signal, options = { maxBytes: DIRECT_ARTIFACT_MAX_BYTES }) => prove(root, ref, signal, options)
export const artifactCurrentIdentity = (root, ref, signal, options = { maxBytes: DIRECT_ARTIFACT_MAX_BYTES }) => identify(root, ref, signal, options)
