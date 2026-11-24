// SPDX-License-Identifier: GPL-3.0-only
import { statStored, hasStored } from './workflow-io.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { located } from 'dsh-better-task-grapth/validation'
import { realProjectPath } from './artifacts.mjs'
import { saveBlockage, readBlockage } from './blockage-evidence.mjs'

const prefix = '@evidence/'
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const denied = () => { throw located('AUDIT_EVIDENCE_NOT_ISSUED', { path: '/file_path', reason: 'Use a file reference returned by an evidence tool in this audit.' }) }
const relativeName = name => typeof name === 'string' && !path.win32.isAbsolute(name) && !/[\\\x00-\x1f]/.test(name)
  && name.split('/').every(part => part && part !== '.' && part !== '..')

// v1 producers returned paths in a dedicated, role-private output directory.
// The persisted layout is the only legacy dependency. The host does not assign filenames.
export const AUDIT_FRAME_PREFIX = '@audit/'
export const auditFrameDirectory = directory => path.join(directory, 'audit-frame-sheets')
export const isAuditReference = value => value.startsWith(prefix) || value.startsWith(AUDIT_FRAME_PREFIX)

export function auditEvidence(directory, resolveInput, observe) {
  const outputDirectory = path.join(directory, 'audit-artifacts')
  const receipts = path.join(directory, 'audit-references')
  const fileInside = (root, name) => {
    realProjectPath(directory, root)
    return realProjectPath(root, path.join(root, name), { directory: false })
  }
  return {
    host: {
      resolveInput, outputDirectory,
      directory: auditFrameDirectory(directory), prefix: AUDIT_FRAME_PREFIX,
      publish(folder, names) {
        if (!relativeName(folder) || !Array.isArray(names) || !names.length || !names.every(relativeName)) denied()
        const hashes = Object.fromEntries([...new Set(names)].map(name =>
          [name, observe(() => fileInside(outputDirectory, path.join(folder, name)), name).identity.fileSha256]))
        const id = randomUUID()
        fs.mkdirSync(receipts, { recursive: true, mode: 0o700 })
        realProjectPath(directory, receipts)
        saveBlockage(path.join(receipts, id + '.json'), { id, folder, hashes })
        return prefix + id + '/'
      },
    },
    resolve(reference) {
      if (reference.startsWith(AUDIT_FRAME_PREFIX)) {
        const [entry, name, ...rest] = reference.slice(AUDIT_FRAME_PREFIX.length).split('/')
        if (!/^[a-f0-9-]{36}$/.test(entry) || !relativeName(name) || rest.length)
          throw located('AUDIT_FRAME_PATH_DENIED', { path: '/file_path', reason: 'Use the original reference returned by this audit.' })
        return { file: () => fileInside(auditFrameDirectory(directory), reference.slice(AUDIT_FRAME_PREFIX.length)) }
      }
      if (!reference.startsWith(prefix)) return undefined
      const [id, ...parts] = reference.slice(prefix.length).split('/'), name = parts.join('/')
      if (!uuid.test(id) || !relativeName(name) || !fs.existsSync(receipts)) denied()
      const receipt = path.join(receipts, id + '.json')
      if (!hasStored(receipt)) denied()
      realProjectPath(directory, receipt, { directory: false })
      if (statStored(receipt).nlink !== 1) denied()
      const record = readBlockage(receipt)
      if (record?.id !== id || !relativeName(record.folder) || !record.hashes || typeof record.hashes !== 'object' || !Object.hasOwn(record.hashes, name)
        || !/^[a-f0-9]{64}$/.test(record.hashes[name])) denied()
      return { file: () => fileInside(outputDirectory, path.join(record.folder, name)), sha256: record.hashes[name] }
    },
  }
}
