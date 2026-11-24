// Real DSH Web and persisted display events. This fixture never sends a model request.
import assert from 'node:assert/strict'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import * as persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { Session, appendPluginRecord } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { DISPLAY_EVENT } from '../client.source.mjs'
import { startWorkflowWeb, until } from './web-workflow-harness.mjs'

const { chromium } = await import(pathToFileURL(process.env.DSH_TEST_BROWSER_MODULE))
const sessionId = 'session-' + randomUUID(), title = 'Workflow tool display fixture'
const samples = [
  ['dynamic_context_read_rules', '读取前序规则', 'Read prerequisite rules'],
  ['dynamic_task_status', '查看当前任务状态', 'Read current task status'],
  ['transaction_graph_read', '读取事务图', 'Read transaction graph'],
  ['dynamic_context_route_task', '路由任务请求', 'Route task request'],
]
const foreign = 'other_plugin_lookup'
let web, browser
try {
  web = await startWorkflowWeb({ respond: () => { throw Error('Unexpected model request') }, beforeStart: async ({ home, workspace }) => {
    const ctx = new Context(), store = await ctx.plugin(persistence, { root: path.join(home, 'sessions'), compression: 'zstd' })
    let handle
    try {
      const session = Session.create(sessionId, undefined, { version: 4, id: sessionId, createdAt: Date.now(), cwd: workspace, isSeeded: false, agentPreset: 'standard' })
      session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: title }] }), { surfaceOp: 'append' })
      session.append('turn/start', { turn: 1 })
      session.append('step/start', { turn: 1, step: 1 })
      const nativeName = 'transaction_graph_read', callId = 'call-' + nativeName, args = '{"target":"unit_a"}'
      session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
        source: { kind: 'model', provider: 'fixture', model: 'fixture' },
        content: [{ type: 'tool-call', id: callId, name: nativeName, arguments: args }],
      }) }, { surfaceOp: 'append' })
      const call = session.append('tool/call', { turn: 1, step: 1, callId, name: nativeName, arguments: args })
      session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({
        callId, isError: false, content: [{ type: 'text', text: 'recorded output' }],
      }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
      for (const [name] of [...samples, [foreign]]) {
        if (name === nativeName) continue
        appendPluginRecord(session, DISPLAY_EVENT, { version: 1, workflowId: 'display-fixture', turn: 1, offset: 0, reset: true, text: '',
          row: { id: name, kind: 'tool', stage: 'EXECUTING', step: 1, revision: 1, state: 'complete', title: name, bytes: 0, at: new Date().toISOString() },
          native: { callId: 'call-' + name, name, argsRaw: '{"target":"unit_a"}', content: [{type:'text', text:'recorded output'}] } })
      }
      session.append('step/end', { turn: 1, step: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      handle = await ctx.sessionPersistence.create(session.header)
      await handle.append(session.snapshotEvents()); await handle.flush()
    } finally { await handle?.close(); await store.dispose() }
  } })
  await web.call('session/rename', {sessionId, title})
  browser = await chromium.launch({ executablePath: process.env.DSH_TEST_CHROME, args: ['--no-sandbox'] })
  const context = await browser.newContext({ locale: 'zh-CN', permissions: ['clipboard-read', 'clipboard-write'] })
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.setDefaultTimeout(10000)
  // Keep one activity in progress across language changes on a replayed, finished session.
  let activeTool = samples[0][0]
  await page.route('**/api/transactionGraphView/status', async route => {
    const response = await route.fetch(), json = await response.json()
    if (json.result.ok && json.result.value.sessionId === sessionId) {
      json.result.value.execution = {
        workflowId: 'display-fixture', state: 'running', phase: 'EXECUTING', reason: null,
        pauseKind: null, canPause: false, canResume: false,
        activity: { stage: 'EXECUTING', kind: 'tool', sessionId, step: 1, tool: activeTool, at: '2026-11-23T00:00:00Z' },
      }
    }
    await route.fulfill({ response, json })
  })
  await page.goto(web.readyUrl)
  await until(() => page.locator('body').innerText(), text => text.includes('描述你想要'), 'DSH Web ready')
  if (await page.getByText('预览版说明', { exact: true }).isVisible()) await page.getByRole('button', {name:'继续',exact:true}).click()
  await page.getByText(title, {exact:true}).click()
  const card = id => page.locator('[data-chat-call-id="call-' + id + '"]')
  async function checkActivity(id, text) {
    const entry = page.locator('.tg-execution [data-tool-id="' + id + '"]').filter({ hasText: text })
    await entry.waitFor()
    assert.equal(await entry.innerText(), text)
    assert.equal(await entry.getAttribute('title'), id)
  }
  async function check(language) {
    const turnDetails = page.locator('button[data-turn-process="1"]')
    await turnDetails.waitFor()
    if (await turnDetails.getAttribute('aria-expanded') === 'false') await turnDetails.click()
    const stepDetails = page.locator('[data-step-process]').filter({ has: card('transaction_graph_read') }).locator('button[data-process-activity]')
    await stepDetails.waitFor()
    if (await stepDetails.getAttribute('aria-expanded') === 'false') await stepDetails.click()
    for (const [id, zh, en] of samples) await card(id).getByText(language === 'zh' ? zh : en, {exact:true}).waitFor()
    assert.match(await card(foreign).innerText(), new RegExp(foreign))
    await checkActivity(activeTool, language === 'zh' ? '工具执行 · 读取前序规则' : 'Tool execution · Read prerequisite rules')
  }
  await check('zh')
  const [id, zh] = samples[0], row = card(id)
  await row.getByText(zh, {exact:true}).click()
  assert.equal(await row.locator('code[translate="no"]').innerText(), id)
  await row.getByRole('button', { name: '复制 ' + id, exact: true }).click()
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), id)
  assert.match(await row.innerText(), /unit_a/)
  assert.match(await row.innerText(), /recorded output/)
  const rpcId = randomUUID()
  const response = await fetch(web.origin + '/api/settings/update', { method:'POST', headers:{'content-type':'application/json',cookie:web.cookie,origin:web.origin},
    body:JSON.stringify({type:'client-request',rpcId,method:'settings/update',payload:{args:{ns:'locale',patch:{preference:'en'}}}}) })
  assert.equal((await response.json()).result.ok, true)
  await check('en')
  assert.equal(await row.locator('code[translate="no"]').innerText(), id)
  await page.reload()
  await check('en')
  activeTool = foreign
  await checkActivity(foreign, 'Tool execution · ' + foreign)
  assert.deepEqual(errors, [])
  assert.equal(web.backend.requests.length, 0)
  console.log('Verified bilingual native and Direct tool cards, activity labels, copy, live language changes, replay and external IDs.')
} finally { await browser?.close(); await web?.stop() }
