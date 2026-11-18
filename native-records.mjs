// SPDX-License-Identifier: GPL-3.0-only
import * as NativeSession from '@deepseek-ai/dsh-session'
export function requireNativeRecords() {
  if (typeof NativeSession.appendPluginRecord !== 'function') throw new Error('DSH_LEGACY_RECORD_BACKPORT_REQUIRED: before starting DSH, run this bundle scripts/patch-native-presentation.mjs with the runtime node_modules path, then restart DSH.')
}
export function appendPluginRecord(session, type, data) {
  requireNativeRecords()
  return NativeSession.appendPluginRecord(session, type, data)
}
