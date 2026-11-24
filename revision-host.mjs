// SPDX-License-Identifier: GPL-3.0-only
import { readStored, statStored } from './workflow-io.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { BlockAssembler, createMessage } from '@deepseek-ai/dsh-llm'
import { copy, digest, GraphError } from 'dsh-better-task-grapth/core'
import { artifactProof } from './artifacts.mjs'
import { authorityInputs, authorityHeader } from './authority.mjs'
import { ROLE_PROMPTS_SERVICE } from './role-policy.mjs'
import { ROLE_MODELS_SERVICE, nativeRoleModel } from './role-models.mjs'

export function revisionAuthority(ctx, agent) {
  const sessions = ctx.get?.('sessions') ?? ctx.sessions
  if (!agent || ctx.agents.get(agent.id) !== agent || sessions.get(agent.session.id) !== agent.session)
    throw new GraphError('REVISION_CONTROLLER_CHANGED')
  const sandbox = ctx.get('sandboxPolicy')?.resolve({ session: agent.session }), goal = ctx.get('goals')?.get(agent)
  const plan = ctx.get('runtimeQuality')?.planActive(agent)
    ?? ctx.get('agentPresets')?.serviceFor(agent, 'planMode')?.loggedActive(agent.session)
    ?? agent.ctx?.get('planMode')?.loggedActive(agent.session)
  return { cwd: ctx.get?.('workingDirectory')?.get(agent.session) ?? agent.session.header.cwd, header: authorityHeader(agent.session.header),
    input: authorityInputs(agent.session),
    sandbox: sandbox ? { mode: sandbox.mode, workspaceRoot: sandbox.workspaceRoot } : null,
    approval: ctx.get('approval')?.effectivePolicy(agent.session) ?? null, plan: Boolean(plan),
    goal: goal ? { id: goal.id, revision: goal.revision, phase: goal.phase } : null }
}
function checkFactPath(root, file, forbiddenRoots = []) {
  const relative = path.relative(root, file), parts = relative.split(path.sep)
  const blocked = forbiddenRoots.some(directory => {
    const rel = path.relative(directory, file); return rel === '' || rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)
  })
  if (blocked || parts.some(part => ['.dsh', '.git', '.agents', 'credentials', 'secrets'].includes(part.toLowerCase()))
      || /^(?:\.env.*|credentials\.json|auth\.json|tokens?\.json)$/i.test(path.basename(file))
      || /\.(?:key|pem|p12)$/i.test(file) || statStored(file).nlink !== 1) throw new GraphError('REVISION_PRIVATE_EVIDENCE_DENIED')
}
export function artifactFacts(root, references, signal, forbiddenRoots = []) {
  if (!Array.isArray(references) || !references.length || references.some(ref => ref.kind !== 'artifact'))
    throw new GraphError('REVISION_ARTIFACT_EVIDENCE_REQUIRED')
  return references.map((ref, index) => {
    const proof = artifactProof(root, ref, signal)
    checkFactPath(root, proof.path, forbiddenRoots)
    const text = readStored(proof.path, 'utf8')
    // Revalidate after reading: bytes inspected by the roles must match the receipt.
    artifactProof(root, ref, signal)
    return { id: `fact_${index}`, text, source: { ...copy(ref), ref: proof.path } }
  })
}
/** Result acceptance needs byte identity, not every artifact's body in the prompt. */
export function artifactMetadata(root, references, signal, forbiddenRoots = []) {
  return references.map(ref => {
    const proof = artifactProof(root, ref, signal)
    checkFactPath(root, proof.path, forbiddenRoots)
    return { source: { ...copy(ref), ref: proof.path }, bytes: statStored(proof.path).size,
      verified: true, method: 'host SHA-256 of current bytes' }
  })
}
export function verifyArtifactFacts(root, facts, signal, forbiddenRoots = []) {
  for (const fact of facts) {
    artifactProof(root, fact.source, signal)
    checkFactPath(root, fact.source.ref, forbiddenRoots)
    if (digest(readStored(fact.source.ref, 'utf8')) !== digest(fact.text)) throw new GraphError('REVISION_FACT_CHANGED')
  }
}
export async function nativeRevisionRole(ctx, agent, { messages, runId, signal, role, scope = {} }) {
  const llm = ctx.get('llm')
  if (!llm) throw new GraphError('REVISION_LLM_REQUIRED')
  const roleScope = { ...scope, ...(agent.session.id ? { sessionId: agent.session.id } : {}) }
  const selection = role && role !== 'compaction' && ctx.get(ROLE_MODELS_SERVICE)?.resolve(role, roleScope)
  const config = nativeRoleModel(agent.session.requestHeader()?.config ?? agent.options, selection)
  if (!config.provider || !config.model) throw new GraphError('REVISION_MODEL_REQUIRED')
  const prompts = role && ctx.get(ROLE_PROMPTS_SERVICE)
  if (prompts && messages[0]?.role === 'system') {
    const resolved = prompts.resolve(role, messages[0].content, roleScope)
    messages = [{ ...messages[0], content: resolved.content }, ...messages.slice(1)]
  }
  const assembler = new BlockAssembler()
  const options = { provider: config.provider, model: config.model,
    messages: messages.map(message => createMessage({ role: message.role, content: [{ type: 'text', text: message.content }] })),
    tools: [], signal, sessionId: runId,
    ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
    ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }) }
  for await (const chunk of llm.stream(options)) assembler.push(chunk)
  if (assembler.finish?.kind !== 'stop') throw new GraphError('REVISION_ROLE_DID_NOT_STOP_NORMALLY')
  const blocks = assembler.blocks()
  if (blocks.some(block => !['text', 'reasoning'].includes(block.type))) throw new GraphError('REVISION_ROLE_TOOLS_FORBIDDEN')
  return blocks.filter(block => block.type === 'text').map(block => block.text).join('')
}
