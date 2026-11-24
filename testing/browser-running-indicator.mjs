import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { startWorkflowWeb, until } from './web-workflow-harness.mjs'
import { runtimeProposal } from './runtime-harness.mjs'

const { chromium } = await import(pathToFileURL(process.env.DSH_TEST_BROWSER_MODULE))
const output = path.resolve(process.argv[2])
fs.mkdirSync(output, { recursive: true })
const beforeNativeFinish = Promise.withResolvers()
const beforeLeafPause = Promise.withResolvers()
const beforeResumedFinish = Promise.withResolvers()
const completeFirstReasoningLine = Promise.withResolvers()
const nativeMarker = 'NATIVE_WHALE_FIXTURE'
const reasoningMarker = 'MANAGED_REASONING_FIXTURE'
const tool = (name, args) => ({ tools: [{ name, arguments: args }] })
let workers = 0, harness, browser
const started = {}
function heldStream(reasoning, gate, lineGate) {
  const frame = (delta, finish_reason = null) => 'data: ' +
    JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) + '\n\n'
  return { rawSSE: [frame({ role: 'assistant', reasoning_content: reasoning }),
    ...(lineGate ? [frame({ reasoning_content: '\n\nNext thought.' })] : []),
    frame({ content: 'Synthetic output.' }), frame({}, 'stop'), 'data: [DONE]\n\n'],
    afterFragment: index => index === 0 ? (lineGate ?? gate).promise : index === 1 && lineGate ? gate.promise : undefined }
}
try {
  harness = await startWorkflowWeb({ respond: async ({ payload }) => {
    if (payload.messages.some(row => row.role === 'user' && String(row.content).includes(nativeMarker)))
      return heldStream('NATIVE_REASONING_FIXTURE', beforeNativeFinish)
    if (payload.messages.some(row => row.role === 'system' && row.content.includes('DYNAMIC_CONTEXT_PREPLANNER_V1')))
      return tool('dynamic_context_submit', { proposal: runtimeProposal(['write']) })
    if ((payload.tools ?? []).some(row => row.function.name === 'dynamic_context_graph_status')) return { text: 'Synthetic final response.' }
    if (++workers === 1) {
      await beforeLeafPause.promise
      return tool('write', { file_path: 'result.txt', content: 'Fixture output written once.' })
    }
    started.worker = performance.now()
    return heldStream(reasoningMarker, beforeResumedFinish, completeFirstReasoningLine)
  } })
  browser = await chromium.launch({ headless: true, executablePath: process.env.DSH_TEST_CHROME,
    env: { ...process.env, TMPDIR: '/tmp' }, args: ['--no-sandbox'] })
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1200, height: 850 } })
  await context.route('**/*', route =>
    new URL(route.request().url()).origin === harness.origin ? route.continue() : route.abort())
  const page = await context.newPage()
  page.setDefaultTimeout(9000)
  const htmlErrors = []
  page.on('pageerror', error => htmlErrors.push(error.message))
  await page.goto(harness.readyUrl)
  await until(() => page.locator('body').innerText(), text => text.includes('描述你想要'), 'native Web boot')
  const preview = page.getByText('预览版说明', { exact: true })
  if (await preview.isVisible()) await page.getByRole('button', { name: '继续', exact: true }).click()
  const select = async id => {
    const row = page.locator('[data-row-key="session:' + id + '"]')
    if (!await row.isVisible()) {
      const ungrouped = page.getByText('未分组', { exact: true })
      await ungrouped.waitFor()
      await ungrouped.click()
    }
    await row.click()
    await until(() => row.getAttribute('aria-selected'), value => value === 'true', 'selected expected session')
  }
  const native = await harness.call('session/create', { cwd: harness.workspace })
  await harness.call('session/rename', { sessionId: native.sessionId, title: 'Native running indicator fixture' })
  await harness.call('session/prompt', { requestId: randomUUID(), sessionId: native.sessionId, mode: 'queue',
    content: [{ type: 'text', text: nativeMarker }] })
  await until(() => harness.backend.requests.length, n => n >= 1, 'native model request')
  await select(native.sessionId)
  const running = page.locator('[data-chat-running="true"]')
  await running.waitFor()
  const ordinary = await running.evaluate(node => ({ indicator: true, text: node.innerText.trim(),
    whaleMask: Boolean(node.querySelector('[class*="runningWhaleAnimated"]')), hasSvgFallback: Boolean(node.querySelector('svg')) }))
  assert.match(ordinary.text, /深度求索中/)
  assert.ok(ordinary.whaleMask && ordinary.hasSvgFallback)
  beforeNativeFinish.resolve()
  await running.waitFor({ state: 'hidden' })
  const managed = await harness.call('session/create', { cwd: harness.workspace })
  await harness.call('session/rename', { sessionId: managed.sessionId, title: 'Managed running indicator fixture' })
  const status = () => harness.call('transactionGraphView/status', { sessionId: managed.sessionId })
  await harness.call('commands/execute', { agentId: managed.sessionId, line: '/task-graph Execute isolated running-state fixture.', submittedAttachments: [] })
  const active = await until(status, view => workers === 1 && view.execution?.state === 'running', 'first managed leaf')
  const request = { sessionId: managed.sessionId, workflowId: active.execution.workflowId }
  const pauseAt = performance.now()
  await harness.call('transactionGraphView/control', { ...request, action: 'pause' })
  const pauseAdmissionMs = Math.round(performance.now() - pauseAt)
  const releaseAt = performance.now()
  beforeLeafPause.resolve()
  await until(status, view => view.execution?.state === 'paused', 'pause sealed after tool')
  const sealedAfterReleaseMs = Math.round(performance.now() - releaseAt)
  await select(managed.sessionId)
  const requestCountBefore = harness.backend.requests.length
  const resumeAt = performance.now()
  const dock = page.locator('.tg-dock').first()
  await dock.getByRole('button', { name: '继续', exact: true }).click()
  await until(status, view => workers === 2 && view.execution?.state === 'running', 'managed resume re-enters same leaf')
  const flow = page.locator('[data-slot="conversation.chat.flow"]')
  const observed = await until(async () => {
    const page = await harness.call('transactionGraphView/output', request)
    return page.items.filter(row => row.kind === 'reasoning').map(row => ({ preview: row.preview, state: row.state }))
  }, rows => rows.some(row => row.preview.includes(reasoningMarker) && row.state === 'running'), 'host has the live reasoning')
  assert.ok(observed.some(row => row.preview.includes(reasoningMarker)))
  const mainLog = fs.readdirSync(path.join(harness.home, 'sessions'), { recursive: true })
    .find(file => file.endsWith(managed.sessionId + '/session.v4.jsonl.zstd'))
  assert.ok(mainLog)
  const logFile = path.join(harness.home, 'sessions', mainLog)
  const persisted = () => execFileSync('zstd', ['-dc', logFile], { encoding: 'utf8' })
    .split('\n').filter(row => row.includes(reasoningMarker) && row.includes('execution-display-v1')).length
  const hintsBeforeFinish = persisted()
  const bg = await flow.evaluate(node => ({ indicator: Boolean(node.querySelector('[data-chat-running]')),
    reasonRendered: node.textContent.includes('MANAGED_REASONING_FIXTURE'), executionLabel: node.textContent.includes('后台执行') }))
  assert.equal(bg.indicator, false)
  assert.equal(bg.reasonRendered, false)
  assert.ok(bg.executionLabel)
  assert.equal(harness.backend.requests.length, requestCountBefore + 1)
  assert.equal(fs.readFileSync(path.join(harness.workspace, 'result.txt'), 'utf8'), 'Fixture output written once.')
  completeFirstReasoningLine.resolve()
  await until(() => flow.textContent(), text => text?.includes(reasoningMarker), 'preview after the completed reasoning line')
  assert.equal(await running.count(), 0)
  beforeResumedFinish.resolve()
  await until(status, view => view.execution?.state === 'complete', 'managed completion')
  const hintsAfterFinish = persisted()
  const thoughtAfterFinish = (await flow.textContent()).includes(reasoningMarker)
  assert.deepEqual(harness.backend.errors, [])
  assert.deepEqual(htmlErrors, [])
  const proof = { ordinary, managed: { ...bg, hostReasoningSeen: true, hintsBeforeFinish, hintsAfterFinish,
    previewAfterCompletedLine: true, thoughtAfterFinish },
    pauseAdmissionMs, sealedAfterReleaseMs,
    clickToNextModelMs: Math.round(started.worker - resumeAt), replayedPriorRequests: false, completed: true }
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(proof, null, 2) + '\n')
  console.log(JSON.stringify(proof))
} finally {
  beforeNativeFinish.resolve()
  beforeLeafPause.resolve()
  completeFirstReasoningLine.resolve()
  beforeResumedFinish.resolve()
  await browser?.close()
  await harness?.stop()
}

