// Optional offline browser regression: real native Chat, synthetic log-only
// display records, zero model calls. Never loads the installed user profile.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import * as persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { Session, appendPluginRecord } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { DISPLAY_EVENT } from '../client.source.mjs'
import { startWorkflowWeb, until } from './web-workflow-harness.mjs'

if (!process.env.DSH_TEST_BROWSER_MODULE) throw Error('Set DSH_TEST_BROWSER_MODULE to the isolated Playwright index.mjs')
const { chromium } = await import(pathToFileURL(process.env.DSH_TEST_BROWSER_MODULE))
const output = path.resolve(process.argv[2] ?? 'compaction-browser-results')
fs.mkdirSync(output, { recursive: true })
const id = 'session-00000000-0000-4000-8000-000000000016', title = '离线压缩摘要显示回归'
const summary = '## 压缩后的工作摘要\n\n**正文完整保留**。可通过证据工具查阅历史原件。\n\n'
  + Array.from({ length: 80 }, (_, i) => `- 历史事项 ${i + 1}：只描述已发生的执行结果，不追加权限或改变当前任务。`).join('\n')
  + '\n\n```json\n{"verdict":"CURRENT","detail":"summary-json-marker"}\n```\n\nsummary-tail-marker'
const rows = [
  { id: 'summary', stage: 'compaction', state: 'complete', text: summary },
  { id: 'stream', stage: 'compaction', state: 'running', text: 'stream-hidden-marker：部分压缩内容' },
  { id: 'interrupted', stage: 'compaction', state: 'interrupted', text: 'interrupted-hidden-marker：保留中断前片段' },
  { id: 'error', stage: 'compaction', state: 'error', text: 'error-hidden-marker：不能声称压缩成功' },
  { id: 'json-summary', stage: 'compaction', state: 'complete', text: '{"verdict":"CURRENT","detail":"pure-json-summary-marker"}' },
  { id: 'normal', stage: 'EXECUTING', state: 'complete', text: '普通执行说明保持直接显示。' },
  { id: 'report', stage: 'result_repair', state: 'complete', text: '{"executionReport":{"detail":"normal-report-hidden-marker"}}' },
]
let h, browser, page
try {
  h = await startWorkflowWeb({ respond: () => { throw Error('NO_MODEL_REQUEST_ALLOWED') }, beforeStart: async ({ home, workspace }) => {
    const ctx = new Context(), scope = await ctx.plugin(persistence, { root: path.join(home, 'sessions'), compression: 'zstd' })
    let handle
    try {
      const session = Session.create(id, undefined, { version: 4, id, createdAt: Date.now(), cwd: workspace,
        isSeeded: false, agentPreset: 'standard' })
      session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: title }] }), { surfaceOp: 'append' })
      session.append('turn/start', { turn: 1 })
      for (const [index, row] of rows.entries()) appendPluginRecord(session, DISPLAY_EVENT, {
        version: 1, workflowId: 'workflow-offline-display', turn: 1, offset: 0, reset: true, text: row.text,
        row: { id: row.id, stage: row.stage, kind: 'message', title: 'message', state: row.state, step: index + 1,
          revision: 1, bytes: Buffer.byteLength(row.text), at: new Date().toISOString() },
      })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      handle = await ctx.sessionPersistence.create(session.header)
      await handle.append(session.snapshotEvents()); await handle.flush()
    } finally { await handle?.close(); await scope.dispose() }
  } })
  await h.call('session/rename', { sessionId: id, title })
  browser = await chromium.launch({ headless: true, executablePath: process.env.DSH_TEST_CHROME,
    env: { ...process.env, TMPDIR: '/tmp' }, args: ['--no-sandbox'] })
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
  const outside = [], errors = []
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== h.origin) { outside.push(route.request().url()); return route.abort() }
    return route.continue()
  })
  page = await context.newPage(); page.setDefaultTimeout(8000)
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(h.readyUrl)
  await until(() => page.locator('body').innerText(), text => text.includes('描述你想要'), 'browser ready')
  if (await page.getByText('预览版说明', { exact: true }).isVisible()) await page.getByRole('button', { name: '继续', exact: true }).click()
  await page.getByText(title, { exact: true }).click()
  const finishedSteps = page.getByRole('button', { name: /^上下文压缩 · 已结束的内部步骤/ }).first()
  await finishedSteps.waitFor()
  assert.equal(await finishedSteps.getAttribute('aria-expanded'), 'false', 'finished step starts collapsed')
  await finishedSteps.press('Enter')
  const folded = page.locator('[data-context-compaction="result"]')
  await until(() => folded.count(), count => count === 5, 'five named compaction disclosures')
  for (const marker of ['summary-tail-marker', 'stream-hidden-marker', 'interrupted-hidden-marker', 'error-hidden-marker', 'pure-json-summary-marker'])
    assert.ok(!(await page.locator('body').innerText()).includes(marker), 'summary body must start collapsed: ' + marker)
  assert.ok((await page.locator('body').innerText()).includes('普通执行说明保持直接显示。'))
  for (const suffix of ['（生成中）', '（已中断）', '（失败）']) assert.ok((await folded.allTextContents()).join('\n').includes('上下文压缩结果' + suffix))
  const report = page.locator('[data-structured-content="执行报告 · JSON"]')
  await report.waitFor(); assert.ok(!(await report.innerText()).includes('normal-report-hidden-marker'))
  await page.screenshot({ path: path.join(output, 'desktop-collapsed.png'), animations: 'disabled' })
  const first = folded.nth(0)
  await first.getByText('上下文压缩结果 · 第 1 步', { exact: true }).click()
  await first.getByText('summary-tail-marker', { exact: true }).waitFor()
  assert.equal(await first.locator('strong').filter({ hasText: '正文完整保留' }).count(), 1)
  assert.ok((await first.innerText()).includes('summary-json-marker'))
  assert.equal(await folded.nth(1).getByText('stream-hidden-marker', { exact: false }).count(), 0, 'disclosures are independent')
  await page.screenshot({ path: path.join(output, 'desktop-expanded.png'), animations: 'disabled' })
  await first.getByText('上下文压缩结果 · 第 1 步', { exact: true }).click()
  assert.ok(!(await first.innerText()).includes('summary-tail-marker'))
  const pureJson = folded.nth(4)
  await pureJson.getByText('上下文压缩结果 · 第 5 步', { exact: true }).click()
  await until(() => pureJson.innerText(), text => text.includes('pure-json-summary-marker'), 'JSON summary expands under the compaction name')
  assert.equal(await pureJson.locator('[data-structured-content]').count(), 0, 'no second generic JSON disclosure')
  await page.reload(); await folded.first().waitFor()
  assert.ok(!(await folded.allTextContents()).join('\n').includes('pure-json-summary-marker'))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: path.join(output, 'mobile-collapsed.png'), animations: 'disabled' })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
  assert.equal(h.backend.requests.length, 0); assert.deepEqual(errors, []); assert.deepEqual(outside, [])
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ status: 'PASS', realNativeChat: true, syntheticSessionOnly: true,
    namedDisclosures: 5, defaultCollapsed: true, independentExpansion: true, nativeMarkdownPreserved: true,
    mixedAndPureJSONSummaries: true, ordinaryProseAndReportsUnchanged: true, reloadCollapsed: true,
    statuses: ['complete', 'running', 'interrupted', 'error'], viewports: ['1440x1000', '390x844'],
    modelRequests: h.backend.requests.length, externalBrowserRequests: outside, browserErrors: errors }, null, 2) + '\n')
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png') }); fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText()) }
  if (h) fs.writeFileSync(path.join(output, 'fixture-sessions.json'), JSON.stringify(await h.call('session/list', {}), null, 2))
  throw error
} finally {
  if (h) fs.writeFileSync(path.join(output, 'server.log'), h.logs.join('\n'))
  await browser?.close(); await h?.stop()
}
