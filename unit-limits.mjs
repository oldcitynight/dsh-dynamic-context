// SPDX-License-Identifier: GPL-3.0-only
import { z } from 'zod'
import { defaultWorkflowLimits } from 'dsh-better-task-grapth/workflow-limits'

const quantity = z.number().int().nonnegative()
export const workflowLimitsSchema = z.object(Object.fromEntries(
  Object.entries(defaultWorkflowLimits).map(([key, value]) => [key, (key === 'maxUnits' ? quantity.positive() : quantity).default(value)]),
)).strict().prefault({})

function findEntry(entries, id) {
  for (const entry of entries) {
    if (entry.id === id) return entry
    if (entry.group && Array.isArray(entry.config)) {
      const child = findEntry(entry.config, id)
      if (child) return child
    }
  }
}

/** Read the same configuration layers DSH uses to mount the plugin.
 * The existing runner and its workflow stay mounted. */
export function profileUnitLimitReader(ctx, id) {
  const profile = ctx.get?.('profileContext')
  if (!profile) return undefined
  return async () => {
    const { composeEntries, readProfilePatches } = await import('@deepseek-ai/dsh-app-boot')
    const entry = findEntry(composeEntries([readProfilePatches('dsh', profile)]), id)
    return entry ? workflowLimitsSchema.parse(entry.config?.workflowLimits).maxUnits : undefined
  }
}
