// SPDX-License-Identifier: GPL-3.0-only
const managedRoots = new Set(['revisions', 'execution-view-v1', 'planning-history', 'context-material',
  'suspensions', 'directory-snapshots', 'blockage'])
const managedTopLevel = new Set(['planning-rules.json', 'blockage-control.json', 'dynamic-context.json'])

export function managedRecordDirectory(name) {
  const [root, ...parts] = name.split('/')
  return (root.startsWith('attempt_') || managedRoots.has(root)) &&
    !parts.some(part => part === 'audit-artifacts' || part === 'audit-frame-sheets')
}

export function isManagedRecord(name) {
  if (!/\.(json|txt)$/.test(name)) return false
  return name.includes('/') ? managedRecordDirectory(name.slice(0, name.lastIndexOf('/')))
    : managedTopLevel.has(name) || /^unit-rules-[a-f0-9]{48}\.json$/.test(name)
}
