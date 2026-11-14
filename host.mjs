// SPDX-License-Identifier: GPL-3.0-only
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Llm from '@deepseek-ai/dsh-llm'
import Sessions from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Prompts from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import Filesystem from '@deepseek-ai/dsh-fs-sandbox'
import Approval from '@deepseek-ai/dsh-user-approval'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import Shell from '@deepseek-ai/dsh-bash-sandbox'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import Skills from '@deepseek-ai/dsh-skill'
import * as Observations from '@deepseek-ai/dsh-fs-observation-policy'
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import TaskGraph from 'dsh-bettertaskgraphs'
import * as DynamicContext from './index.mjs'

/** Authentication services only; no native model adapter or message assembly. */
export async function installAccountServices(ctx) {
  const [{ default: Credentials }, { default: Authorization }, { default: Account }] = await Promise.all([
    import('@deepseek-ai/dsh-credentials-local'), import('@deepseek-ai/dsh-authorization'), import('@deepseek-ai/dsh-deepseek-account-platform'),
  ])
  await ctx.plugin(Credentials, { watch: false })
  await ctx.plugin(Authorization)
  await ctx.plugin(Account)
}

/** Standalone acceptance host: no native model adapter, fake credentials or Web boot. */
export async function createDirectHost(input) {
  const config = DynamicContext.validateConfig({ interaction: { mode: 'host' }, exposeControlTools: false, ...input })
  if (!config.enabled || config.transport !== 'direct' || !config.direct.runtime || config.direct.runtime.modules.includes('web')) throw new Error('Standalone acceptance requires enabled direct runtime; Web providers belong to a configured DSH host')
  const ctx = new Context()
  try {
    if (config.direct.auth === 'deepseek-account') await installAccountServices(ctx)
    for (const plugin of [Llm, Sessions, Projections, Prompts, Tools, Agents, TokenMeter]) await ctx.plugin(plugin)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(Persistence, { root: path.join(config.directory, 'native-sessions') })
    const runtime = config.direct.runtime
    await ctx.plugin(SandboxPolicy, { mode: runtime.sandboxMode, workspaceRoot: config.projectRoot })
    await ctx.plugin(Filesystem, { cwd: config.projectRoot })
    await ctx.plugin(Approval, { policy: runtime.approvalPolicy })
    await ctx.plugin(Subprocess)
    await ctx.plugin(Sandbox)
    await ctx.plugin(ShellEnv, { dshHome: runtime.instructionHomes?.dshHome ?? path.join(config.projectRoot, '.dsh') })
    await ctx.plugin(Shell, { cwd: config.projectRoot, ...(runtime.nativeRequestControls ? { timeoutMs: 60000 } : { timeoutMs: 30000, maxTimeoutMs: 60000 }) })
    if (runtime.nativeRequestControls) await ctx.plugin(await import('@deepseek-ai/dsh-tool-call-timeout-policy'))
    await ctx.plugin(Skills)
    await ctx.plugin(Observations)
    await ctx.plugin(TaskGraph, { projectRoot: config.projectRoot })
    await ctx.plugin(DynamicContext, config)
    let closed = false
    return { ctx, runner: ctx.dynamicContext, async close() { if (closed) return; closed = true; await ctx.dynamicContext.close(); await ctx.fiber.dispose() } }
  } catch (error) { await ctx.fiber.dispose(); throw error }
}
