// Optional real-browser regression. Install Playwright separately and point
// DSH_TEST_BROWSER_MODULE at its index.mjs; all model traffic stays on localhost.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { startWorkflowWeb, until } from './web-workflow-harness.mjs'
import { runtimeProposal } from './runtime-harness.mjs'

if (!process.env.DSH_TEST_BROWSER_MODULE) throw Error('Set DSH_TEST_BROWSER_MODULE to an installed Playwright index.mjs')
const { chromium } = await import(pathToFileURL(process.env.DSH_TEST_BROWSER_MODULE).href)
const output = path.resolve(process.argv[2] ?? 'workflow-browser-results')
fs.mkdirSync(output, { recursive: true })
const planGate = Promise.withResolvers(), workGate = Promise.withResolvers()
const planFinish = Promise.withResolvers(), workFinish = Promise.withResolvers()
const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 }
const tool = (name, args) => ({ tools: [{ name, arguments: args }], usage })
const slowTool = (marker, name, args, finish) => ({ fragmentDelayMs: 100,
  afterFragment: index => index === 0 ? finish.promise : undefined, rawSSE: [
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: marker } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'fixture-' + name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [], usage })}\n\n`, 'data: [DONE]\n\n',
] })
let plans = 0, workers = 0, foreground = 0, planningEnabled = false, h, browser
try {
  h = await startWorkflowWeb({ respond: async ({ payload }) => {
    if (!planningEnabled) {
      foreground++
      return { text: '{"verdict":"CURRENT","detail":"native-json-hidden-marker"}', usage }
    }
    if (payload.messages.some(row => row.role === 'system' && row.content.includes('DYNAMIC_CONTEXT_PREPLANNER_V1'))) {
      if (++plans === 1) { await planGate.promise; return slowTool('规划中的实时思考片段', 'bash', { command: 'printf "terminal-browser-ok\\n"', description: 'Read a synthetic condition for planning' }, planFinish) }
      return tool('dynamic_context_submit', { proposal: runtimeProposal(['write']) })
    }
    if (payload.tools?.some(row => row.function.name === 'dynamic_context_graph_status')) {
      return { text: '{"verdict":"CURRENT","detail":"native-json-hidden-marker"}', usage }
    }
    if (++workers === 1) { await workGate.promise; return slowTool('叶执行中的实时思考片段', 'write', { file_path: 'result.txt', content: 'Produced once.' }, workFinish) }
    return { reasoning: '核对输出文件与当前目标。', text: '{"outcome":"COMPLETE","executionReport":{"result":"worker-json-hidden-marker"}}', usage }
  } })
  fs.writeFileSync(path.join(h.workspace, 'probe.txt'), 'Condition available.')
  // Chromium uses a Unix socket in TMPDIR; deeply nested project temp paths
  // exceed that OS limit. Keep the isolated browser's socket directory short.
  browser = await chromium.launch({ headless: true, executablePath: process.env.DSH_TEST_CHROME,
    env: { ...process.env, TMPDIR: '/tmp' }, args: ['--no-sandbox'] })
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (['error', 'warn'].includes(message.type())) fs.appendFileSync(path.join(output, 'browser-console.log'), message.text() + '\n') })
  await page.goto(h.readyUrl)
  const preview = page.getByText('预览版说明', { exact: true })
  await until(() => page.locator('body').innerText(), text => text.includes('描述你想要'), 'browser ready')
  if (await preview.isVisible()) await page.getByRole('button', { name: '继续', exact: true }).click()
  const { sessionId } = await h.call('session/create', { cwd: h.workspace })
  for (let turn=1;turn<=2;turn++) {
    await h.call('session/prompt', { requestId:randomUUID(), sessionId, mode:'queue',
      content:[{type:'text',text:'Record ordinary foreground observation '+turn}] })
    await until(() => h.backend.requests.filter(row => row.completed).length, n => n===turn, 'foreground response '+turn)
  }
  planningEnabled = true
  const status = () => h.call('transactionGraphView/status', { sessionId })
  await h.call('commands/execute', { agentId: sessionId, line: '/task-graph Browser workflow regression', submittedAttachments: [] })
  await until(() => plans, count => count === 1, 'planning request')
  await page.reload()
  await page.getByText('未分组', { exact: true }).click()
  await page.locator('[data-row-key="session:' + sessionId + '"]').click()
  const dock = page.locator('.tg-dock').first(), chat = page.locator('[data-chat-node-key*="dynamic-context-execution"]')
  await chat.first().waitFor({ state: 'attached' })
  assert.equal(await dock.locator('.tg-output').count(), 0, 'execution details belong to the chat transcript, not the graph dock')
  planGate.resolve()
  await chat.getByText('思考', { exact: true }).last().click()
  await until(async () => (await chat.allTextContents()).join('\n'), text => text.includes('规划中的实时思考片段'), 'live planning text before completion')
  assert.equal(h.backend.requests.find(request => request.payload.messages.some(row => row.role === 'system' && row.content.includes('DYNAMIC_CONTEXT_PREPLANNER_V1')))?.completed, false)
  await dock.getByRole('button', { name: '暂停', exact: true }).click()
  assert.equal((await status()).execution.state, 'pausing')
  await page.screenshot({ path: path.join(output, 'live-planning.png'), animations: 'disabled' })
  planFinish.resolve()
  await until(status, value => value.execution?.state === 'paused', 'planning pause')
  await dock.getByRole('button', { name: '继续', exact: true }).waitFor()
  const nativeBash = page.locator('[data-chat-call-id="fixture-bash"]')
  await nativeBash.waitFor()
  await nativeBash.getByText('Read a synthetic condition for planning', { exact: true }).click()
  await until(() => nativeBash.textContent(), text => text.includes('terminal-browser-ok'), 'native terminal result in UI')
  assert.ok(await nativeBash.locator('[data-slot="tool.call.toolview"]').count())
  await page.screenshot({ path: path.join(output, 'planning-paused.png') })
  await nativeBash.getByRole('button', { name: '查看', exact: true }).click()
  await until(() => page.locator('body').innerText(), text => text.includes('terminal-browser-ok') && text.includes('第 1 轮') && text.includes('输入'), 'native tool inspection target')
  await page.screenshot({ path: path.join(output, 'native-tool-inspection.png'), animations: 'disabled' })
  await page.getByText('对话', { exact: true }).click()
  const before = h.backend.requests.length
  await page.reload()
  assert.equal(h.backend.requests.length, before, 'refresh does not resume a paused workflow')
  assert.equal(plans, 1); assert.equal(workers, 0, 'no worker request before planning resumes')
  await dock.getByRole('button', { name: '继续', exact: true }).click()
  await until(status, value => workers === 1 && value.graph?.active, 'worker request')
  await dock.getByRole('button', { name: '暂停', exact: true }).waitFor()
  await until(() => dock.innerText(), text => text.includes('叶任务') && text.includes('模型请求'), 'worker activity in UI')
  workGate.resolve()
  await until(() => chat.getByText('思考', { exact: true }).count(), count => count >= 2, 'native worker reasoning disclosure')
  await chat.getByText('思考', { exact: true }).last().click()
  await until(async () => (await chat.allTextContents()).join('\n'), text => text.includes('叶执行中的实时思考片段'), 'live worker text')
  assert.equal(h.backend.requests.at(-1).completed, false)
  await page.setViewportSize({ width: 390, height: 844 })
  await dock.getByRole('button', { name: '暂停', exact: true }).click()
  await page.screenshot({ path: path.join(output, 'leaf-running.png'), animations: 'disabled' })
  workFinish.resolve()
  await until(status, value => value.execution?.state === 'paused', 'worker pause')
  await dock.getByRole('button', { name: '继续', exact: true }).waitFor()
  await until(async () => {
    const current = await status()
    return h.call('transactionGraphView/output', { sessionId, workflowId: current.execution.workflowId })
  }, page => page.items.some(row => row.kind === 'tool' && row.title === 'write' && row.state === 'complete'), 'committed write result')
  const nativeWrite = page.locator('[data-chat-call-id="fixture-write"]')
  await nativeWrite.waitFor(); assert.ok(await nativeWrite.locator('[data-slot="tool.call.toolview"]').count())
  await page.screenshot({ path: path.join(output, 'leaf-paused-mobile.png') })
  assert.equal(workers, 1)
  const pausedProjections = (await h.call('session/projections', { sessionId })).values
  assert.equal(pausedProjections.dynamicContextPerformance.requests, 3)
  assert.equal(pausedProjections.dynamicContextPerformance.current.pressure.pressureTokens, 100)
  assert.equal(pausedProjections.dynamicContextPerformance.current.pressure.contextWindow, 32768)
  assert.equal(fs.readFileSync(path.join(h.workspace, 'result.txt'), 'utf8'), 'Produced once.')
  await dock.getByRole('button', { name: '继续', exact: true }).click()
  await until(status, value => value.execution?.state === 'complete', 'completed workflow')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await until(() => dock.innerText(), text => text.includes('任务图流程已结束'), 'completed UI')
  const stats = page.locator('[data-composer-stat="activity"]'), tokens = page.locator('[data-composer-stat="usage"]')
  await until(() => stats.innerText(), text => text.includes('6 步'), 'all foreground and background steps')
  await until(() => tokens.innerText(), text => text.includes('660') && text.includes('60%'), 'all tokens and cache hit rate')
  assert.deepEqual([foreground,plans,workers,h.backend.requests.length],[2,2,2,6])
  async function expandCompletedWork() {
    await page.getByRole('button',{name:/^已完成叶任务/}).first().waitFor()
    for (const label of [/^已完成叶任务/, /已结束的内部步骤/]) {
      for (const button of await page.getByRole('button',{name:label}).all()) {
        if (await button.getAttribute('aria-expanded')==='false') await button.press('Enter')
      }
    }
  }
  await expandCompletedWork()
  const json = page.locator('[data-structured-content="执行报告 · JSON"]').last()
  await json.waitFor()
  assert.ok(!(await json.innerText()).includes('worker-json-hidden-marker'), 'JSON starts collapsed')
  await json.getByText('执行报告 · JSON', { exact: true }).click()
  await until(() => json.innerText(), text => text.includes('worker-json-hidden-marker'), 'expanded report keeps complete JSON')
  const nativeJson = page.locator('[data-structured-content="验收或复查结果 · JSON"]').last()
  await nativeJson.waitFor()
  assert.ok(!(await nativeJson.innerText()).includes('native-json-hidden-marker'))
  await page.screenshot({ path: path.join(output, 'statistics-and-json.png'), animations: 'disabled' })
  await page.reload()
  await until(() => tokens.innerText(), text => text.includes('660') && text.includes('60%'), 'refresh preserves accounting without duplication')
  await expandCompletedWork()
  assert.ok(!(await json.innerText()).includes('worker-json-hidden-marker'), 'refreshed structured output defaults collapsed')
  await dock.getByRole('button', { name: '全屏', exact: true }).click()
  await page.screenshot({ path: path.join(output, 'complete-fullscreen.png'), animations: 'disabled' })
  assert.equal(workers, 2); assert.equal(plans, 2)
  assert.deepEqual(errors, []); assert.deepEqual(h.backend.errors, [])
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ pass: true, plans, workers,
    modelRequests: h.backend.requests.length, checks: ['planning shown before graph exists', 'pause in model request',
      'native assistant/reasoning renderers and native tool.call.toolview; no second UI style', 'native tool inspection opens the matching trajectory output', 'execution details inside native conversation chat, absent from graph UI', 'planning reasoning before response completion', 'native terminal result', 'leaf reasoning before response completion',
      'reload retains pause and output', 'resume planning', 'leaf activity shown', 'mobile pause', 'completed tool not replayed', 'full-screen view'],
    nativePerformance: { totalTokens: 660, steps: 6, cacheHitPercent: 60, directWindow: 32768, directPressure: 100 },
    structuredJSON: 'foreground and background default folded; expansion and refresh verified', browserErrors: errors }, null, 2) + '\n')
} finally { planGate.resolve(); workGate.resolve(); planFinish.resolve(); workFinish.resolve(); if (h) fs.writeFileSync(path.join(output, 'server.log'), h.logs.join('\n')); await browser?.close(); await h?.stop() }
