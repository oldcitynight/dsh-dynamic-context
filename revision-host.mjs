// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs'
import path from 'node:path'
import { BlockAssembler, createMessage } from '@deepseek-ai/dsh-llm'
import { copy, digest, GraphError } from 'dsh-bettertaskgraphs/core'
import { artifactProof } from './artifacts.mjs'

export function revisionAuthority(ctx, agent) {
  const sessions = ctx.get?.('sessions') ?? ctx.sessions, workingDirectory = ctx.get?.('workingDirectory') ?? ctx.workingDirectory
  if (!agent || ctx.agents.get(agent.id) !== agent || sessions.get(agent.session.id) !== agent.session)
    throw new GraphError('REVISION_CONTROLLER_CHANGED')
  const sandbox = ctx.get('sandboxPolicy')?.resolve({ session: agent.session }), goal = ctx.get('goals')?.get(agent)
  const plan = ctx.get('runtimeQuality')?.planActive(agent)
    ?? ctx.get('agentPresets')?.serviceFor(agent, 'planMode')?.loggedActive(agent.session)
    ?? agent.ctx?.get('planMode')?.loggedActive(agent.session)
  return { cwd: workingDirectory.get(agent.session), header: agent.session.header,
    input: agent.session.deriveMessages().filter(message => ['user', 'developer', 'system'].includes(message.role)),
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
      || /\.(?:key|pem|p12)$/i.test(file) || fs.lstatSync(file).nlink !== 1) throw new GraphError('REVISION_PRIVATE_EVIDENCE_DENIED')
}
export function artifactFacts(root, references, signal, forbiddenRoots = []) {
  if (!Array.isArray(references) || !references.length || references.some(ref => ref.kind !== 'artifact'))
    throw new GraphError('REVISION_ARTIFACT_EVIDENCE_REQUIRED')
  return references.map((ref, index) => {
    const proof = artifactProof(root, ref, signal)
    checkFactPath(root, proof.path, forbiddenRoots)
    const text = fs.readFileSync(proof.path, 'utf8')
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
    return { source: { ...copy(ref), ref: proof.path }, bytes: fs.statSync(proof.path).size,
      verified: true, method: 'host SHA-256 of current bytes' }
  })
}
export function verifyArtifactFacts(root, facts, signal, forbiddenRoots = []) {
  for (const fact of facts) {
    artifactProof(root, fact.source, signal)
    checkFactPath(root, fact.source.ref, forbiddenRoots)
    if (digest(fs.readFileSync(fact.source.ref, 'utf8')) !== digest(fact.text)) throw new GraphError('REVISION_FACT_CHANGED')
  }
}
export async function nativeRevisionRole(ctx, agent, { messages, runId, signal }) {
  const llm = ctx.get('llm')
  if (!llm) throw new GraphError('REVISION_LLM_REQUIRED')
  const config = agent.session.requestHeader()?.config ?? agent.options
  if (!config.provider || !config.model) throw new GraphError('REVISION_MODEL_REQUIRED')
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
