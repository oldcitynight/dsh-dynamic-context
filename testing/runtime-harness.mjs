import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import Approval from '@deepseek-ai/dsh-user-approval'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import Shell from '@deepseek-ai/dsh-bash-sandbox'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import Skills from '@deepseek-ai/dsh-skill'
import * as FsObservation from '@deepseek-ai/dsh-fs-observation-policy'
import { createHarness } from './harness.mjs'

/** Real local execution services; model HTTP is the isolated fake endpoint. */
export async function createRuntimeHarness({ projectRoot, directory, respond, backend, config = {}, setup, taskGraph = true, mode = 'workspace-write', approval = 'never' }) {
  const direct = config.direct ?? {}
  const runtime = { modules: ['filesystem', 'search', 'shell', 'skills', 'state'], sandboxMode: mode,
    instructionHomes: { dshHome: projectRoot + '/.dsh', agentsHome: projectRoot + '/.agents' }, ...direct.runtime }
  return createHarness({ projectRoot, directory, respond, backend, taskGraph,
    config: { transport: 'direct', allowedTools: ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'skill', 'dynamic_task_status'],
      ...config, direct: { ...direct, agentlessTools: direct.agentlessTools ?? [], runtime } },
    setup: async ctx => {
      await ctx.plugin(SandboxPolicy, { mode, workspaceRoot: projectRoot })
      await ctx.plugin(SandboxedFileSystem, { cwd: projectRoot })
      await ctx.plugin(WorkingDirectory, { defaultDirectory: projectRoot })
      await ctx.plugin(Approval, { policy: approval })
      await ctx.plugin(Subprocess)
      await ctx.plugin(Sandbox)
      await ctx.plugin(ShellEnv, { dshHome: projectRoot + '/.dsh' })
      await ctx.plugin(Shell, { cwd: projectRoot, timeoutMs: 1000, maxTimeoutMs: 3000 })
      await ctx.plugin(Skills)
      await ctx.plugin(FsObservation)
      ctx.skills.register({ name: 'fixture-skill', description: 'Isolated fixture workflow', content: 'SKILL_FIXTURE_BODY: inspect evidence before reporting success.', source: 'runtime' })
      if (setup) await setup(ctx)
    },
  })
}

export function runtimeProposal(tools, instruction = 'Use the declared tools and return an evidence-qualified report.') {
  return { taskGraph: { title: 'Direct runtime validation', nodes: [
    { key: 'root', kind: 'container', label: 'Controlled workflow' },
    { key: 'task', kind: 'leaf', label: 'Isolated task', parent: 'root' },
  ], edges: [] }, contextGraph: { nodes: [{ key: 'task_data', content: 'DIRECT_RUNTIME_TASK_DATA', parents: [] }],
    bindings: [{ task: 'task', instruction, contexts: ['task_data'], tools, inheritReports: [] }] } }
}
