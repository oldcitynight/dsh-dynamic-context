// SPDX-License-Identifier: GPL-3.0-only
export const PERMISSION_UPDATE_PROTOCOL = 'direct-host-permissions-v1'
export const permissionModes = ['read-only', 'workspace-write', 'danger-full-access']
export function effectivePermissions(options, owner, cwd) {
  const cap = options.sandboxMode === 'auto' ? owner.mode : options.sandboxMode
  return { sandboxMode: permissionModes[Math.min(permissionModes.indexOf(cap), permissionModes.indexOf(owner.mode))],
    approvalPolicy: options.approvalPolicy === 'never' || owner.approval === 'never' ? 'never' : 'ask',
    plan: Boolean(options.plan || owner.plan), cwd }
}
export function permissionsTightened(before, after) {
  return permissionModes.indexOf(after.sandboxMode) < permissionModes.indexOf(before.sandboxMode)
    || before.approvalPolicy === 'ask' && after.approvalPolicy === 'never'
}
export function permissionUpdateData(message) {
  try { const value = JSON.parse(message.content); return value.protocol === PERMISSION_UPDATE_PROTOCOL ? value : null } catch { return null }
}
export const PERMISSION_NOTICE = 'The user changed the main conversation permissions. The current host policy below supersedes older permission facts only. Task scope, role tool permissions, private-state protection and Plan mode are unchanged. Continue from recorded results. A cancelled tool may have partial effects: inspect its receipt and current artifacts; never assume rollback or replay completed writes.'

// Planning/acceptance authority pins task identity, inputs, workspace and Plan;
// operation permissions are instead re-read at each native tool dispatch.
export const livePermissionAuthority = value => ({ ...value,
  ...(value.sandbox ? { sandbox: { ...value.sandbox, mode: 'host-live' } } : {}),
  ...(value.approval != null ? { approval: 'host-live' } : {}) })
export function permissionAuthorityVariants(value) {
  if (!value?.sandbox || !permissionModes.includes(value.sandbox.mode) || !['ask', 'never'].includes(value.approval)) return [value]
  return permissionModes.flatMap(mode => ['ask', 'never'].map(approval => ({ ...value, sandbox: { ...value.sandbox, mode }, approval })))
}

export function permissionConfigVariants(config) {
  if (config.direct?.runtime?.sandboxMode !== 'auto' || config.direct.runtime.approvalPolicy !== 'auto') return [config]
  const previous = structuredClone(config)
  previous.direct.runtime.sandboxMode = 'workspace-write'; previous.direct.runtime.approvalPolicy = 'ask'
  return [config, previous]
}
