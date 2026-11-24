// SPDX-License-Identifier: GPL-3.0-only
// Scripted model, using only the information actually returned on the wire.
export function withBlockageReports(payload, decide, { all = false } = {}) {
  const input = JSON.parse(payload.messages[1].content)
  const receipts = payload.messages.filter(row => row.role === 'tool').map(row => JSON.parse(row.content))
  const request = (name, args) => ({ tools: [{ name, arguments: args }] })
  const index = receipts.find(row => Array.isArray(row.sources))
  if (all && !index) return request('dynamic_context_blockage_reports', { kind: 'report' })
  const ids = all ? index.sources.map(row => row.source) : [...new Set(input.situation.groups.flatMap(group =>
    group.blockers.filter(blocker => blocker.attemptId).map(blocker => 'report:' + blocker.attemptId)))]
  const reports = []
  for (const source of ids) {
    const receipt = receipts.find(row => row.source === source && row.path === '')
    if (!receipt) return request('dynamic_context_blockage_report', { source })
    if (receipt.next !== null) throw Error('Test fixture report exceeded one page.')
    reports.push({ source, sha256: receipt.sourceSha256, value: JSON.parse(receipt.text) })
  }
  return decide(reports, input)
}
