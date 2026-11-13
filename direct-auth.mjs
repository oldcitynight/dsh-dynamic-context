// SPDX-License-Identifier: GPL-3.0-only
import { fail } from './core.mjs'

/** Resolve only authentication; model payloads never pass through a native provider. */
export async function directAuthHeaders(ctx, direct, signal) {
  signal.throwIfAborted()
  let abort
  const wait = async work => {
    try {
      const cancelled = new Promise((_, reject) => {
        abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })
      const value = await Promise.race([work, cancelled])
      signal.throwIfAborted()
      return value
    } finally { signal.removeEventListener('abort', abort) }
  }
  if (direct.auth === 'deepseek-account') {
    if (direct.api !== 'deepseek' || new URL(direct.endpoint).origin !== 'https://api.deepseek.com' || direct.apiKeyEnv)
      fail('DIRECT_ACCOUNT_DESTINATION_DENIED')
    const account = ctx.get('deepseekAccount')
    if (!account) fail('DIRECT_ACCOUNT_SERVICE_REQUIRED')
    const token = await wait(account.resolveToken(direct.endpoint))
    if (!token) fail('DIRECT_ACCOUNT_SIGN_IN_REQUIRED')
    return { 'x-dsh-auth-token': token }
  }
  if (!direct.apiKeyEnv) return {}
  const credentials = ctx.get('credentials')
  const key = credentials ? (await wait(credentials.resolve(direct.apiKeyEnv)))?.value : process.env[direct.apiKeyEnv]
  if (!key) fail('DIRECT_MISSING_CONFIGURED_CREDENTIAL')
  return { authorization: `Bearer ${key}` }
}
