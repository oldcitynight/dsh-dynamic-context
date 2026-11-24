// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { RolePromptRegistry, assertPreloadBudget } from '../role-policy.mjs'
import { createRoleContext, EVIDENCE_TOOL } from '../role-context.mjs'
import { boundedSnapshot, readSnapshot } from '../context-budget.mjs'

test('static and dynamic extensions enforce the 10 KiB UTF-8 boundary, including combined slots', () => {
  const p = new RolePromptRegistry(), exact = '😀'.repeat(2560)
  const entry = { pluginId:'fixture', registrationId:'a', role:'scope_update', mode:'replace' }
  p.register({ ...entry, text: exact })
  assert.throws(() => p.register({ ...entry, registrationId:'large', text: exact+'a' }), /ROLE_PRELOAD_LIMIT/)
  const role = p.resolve(entry.role, 'base')
  p.registerProvider({ ...entry, registrationId:'tool', slot:'tools', assemble: () => 'a' })
  assert.throws(() => assertPreloadBudget(role, p.resolve(entry.role, 'tools', {}, 'tools')), /ROLE_PRELOAD_LIMIT/)
  const remove = p.register({ ...entry, registrationId:'extra', mode:'append', text:'b' })
  assert.throws(() => p.resolve(entry.role, 'base'), /ROLE_PRELOAD_LIMIT/)
  remove()
  p.registerProvider({ ...entry, registrationId:'provider', assemble: () => '汉'.repeat(3414) })
  assert.throws(() => p.resolve(entry.role, 'base'), /ROLE_PRELOAD_LIMIT/)
})

test('many small shared facts and reports are jointly bounded, exact text is paged and private to the role', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'unit-material-'))
  t.after(() => fs.rmSync(directory,{recursive:true,force:true}))
  const records = Array.from({length:120},(_,i)=>({ id:'fact_'+i, content:'证据😀'+i+'x'.repeat(30) }))
  const input = { taskId:'t', contract:{objective:'inspect'}, sharedContexts:records, reports:records, audit:'done' }
  const config = { dynamicContextMaxBytes:2048, directory, model:'fixture', maxOutputTokens:512, direct:{} }
  const create = toolPolicy => createRoleContext({config, directory, role:'baseline_audit', signal:new AbortController().signal,
    messages:[{role:'system',content:'Review only.'},{role:'user',content:JSON.stringify(input)}],toolPolicy})
  const actor = create(), request = await actor.prepare(), wire = JSON.stringify(request.messages)
  assert.ok(Buffer.byteLength(wire)<Buffer.byteLength(JSON.stringify(input)))
  assert.ok(!wire.includes('fact_119'))
  const view = JSON.parse(request.messages[1].content)
  assert.deepEqual(view.contract,input.contract)
  const meta = view.materialSummary, id = meta.reader.arguments.id
  assert.equal(meta.reader.tool,EVIDENCE_TOOL)
  let raw = '', start = 0
  while (start < actor.sources[0].characters) {
    const end = actor.sources[0].characters
    await actor.continueRead({finish:'tool_calls',message:{role:'assistant',content:'',tool_calls:[{id:'read_'+start,type:'function',
      function:{name:EVIDENCE_TOOL,arguments:JSON.stringify({id,start,end})}}]}})
    const page = JSON.parse((await actor.prepare()).messages.filter(row=>row.role==='tool').at(-1).content)
    assert.ok(page.end>start)
    raw+=page.text; start=page.end
  }
  assert.equal(createHash('sha256').update(raw).digest('hex'),meta.sha256)
  assert.deepEqual(JSON.parse(raw),{sharedContexts:records,reports:records,audit:'done'})
  const denied = create({ tools:(_role,base)=>({...base,tools:[]}), extensions:()=>[] })
  await assert.rejects(denied.prepare(), {code:'ROLE_MATERIAL_READER_REQUIRED'})
  const runner = {config}, snapshot = boundedSnapshot(runner,'controller',input,'dynamic_context_status')
  const args = snapshot.materialSummary.reader.arguments
  assert.equal(readSnapshot(runner,'controller',args).text,raw.slice(0,1024))
  assert.throws(()=>readSnapshot(runner,'planner-abcdef',args),/MATERIAL_SOURCE_OUTSIDE_ROLE/)
})
