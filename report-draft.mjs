// SPDX-License-Identifier: GPL-3.0-only
// A role-local editable declaration, never an execution or graph capability.
import { z } from 'zod'
import { parseModelJSON, diagnostic, located, validationBoundary } from 'dsh-better-task-grapth/validation'
import { digest } from 'dsh-better-task-grapth/core'
import { dispositionSchema, executionReportSchema } from './supervision-state.mjs'
import { parseExecutionDisposition } from './report-evidence.mjs'

export const REPORT_READ = 'dynamic_context_read_report'
export const REPORT_EDIT = 'dynamic_context_rewrite_report'
export const REPORT_SUBMIT = 'dynamic_context_submit_report'
export const REPORT_GENERATE = 'dynamic_context_generate_report'
const revision = z.number().int().nonnegative()
const editSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set'), path: z.string().min(1), value: z.unknown() }).strict(),
  z.object({ op: z.literal('remove'), path: z.string().min(1) }).strict(),
  z.object({ op: z.literal('replace_text'), oldText: z.string().min(1), newText: z.string() }).strict(),
])
const rewriteSchema = z.object({ expectedRevision: revision, edits: z.array(editSchema).min(1) }).strict()
const readSchema = z.union([
  z.object({ path: z.string() }).strict(),
  z.object({ start: revision, end: revision }).strict(),
])
const submitSchema = z.object({ expectedRevision: revision }).strict()
const generateSchema = z.object({ report: z.record(z.string(), z.unknown()) }).strict()
const tool = (name, description, schema, example) => ({ type: 'function', function: { name,
  description: description + '\nStandard template (replace example values):\n' + JSON.stringify(example, null, 2),
  parameters: z.toJSONSchema(schema, { target: 'draft-7' }) } })
export const reportTools = [
  tool(REPORT_READ, 'Read the current report draft only. path is a JSON Pointer (empty reads the full object); start/end read exact UTF-16 text, end exclusive. Returns revision. No filesystem access.', readSchema, { path: '/executionReport/tests/0' }),
  tool(REPORT_EDIT, 'Atomically rewrite selected report fields. expectedRevision starts at 0. set replaces/adds an object field or existing array item; /- appends an array item. remove deletes a field/item. replace_text replaces exactly one matching span, including in malformed JSON. Zero or multiple matches return an error without changing anything. Preserve all unrelated fields. This edits only this draft, not execution evidence or either graph.', rewriteSchema,
    { expectedRevision: 0, edits: [{ op: 'set', path: '/executionReport/tests/0/quote', value: 'exact recorded output' }] }),
  tool(REPORT_SUBMIT, 'Submit the current draft and end report repair without reprinting it. Shape validation runs here; original host evidence checks and independent acceptance still run afterwards. This is not acceptance or permission to execute work.', submitSchema, { expectedRevision: 1 }),
]
export const REPORT_DRAFT_INSTRUCTION = `previousSubmission 已装入当前报告草稿，初始 revision 为 0。把它作为本轮交付的底稿。先把本轮逐项反馈定位到必须更正的最小字段，核对这些字段所需的实际证据。保留其他字段的原值、引文、措辞和数组顺序。例如只退回证据编号时，只改编号；只有引文本身也被退回或与更正后的证据确实矛盾时，才改引文。已经满足的反馈直接沿用当前值。
当反馈逐条给出 path 时，将 edits 逐一对应到这些路径。能够从证据额外推导出的可选字段，保留原来的有无和值。例如一条反馈改第一项、另一条改第二项时，每项分别只动被指出的属性。工具若随后退回新的必填路径，再补该处。
用 dynamic_context_read_report 按需读取当前草稿。用 dynamic_context_rewrite_report(expectedRevision, edits) 在最小 JSON Pointer 上 set 或 remove；同一反馈涉及多处时可一起更正。只有 JSON 语法妨碍按路径编辑时才用 replace_text 精确替换一处原文。有歧义或 revision 已变就重读该处。完成后单独调用 dynamic_context_submit_report，传入当前 revision；若程序再退回具体路径，接着改这些路径。仅当前申报可编辑，证据、轨迹和图均只读。草稿工具不可用时按相同原则提交完整 JSON。申报的结构校验之后仍由独立流程验收。`
export const FORMATTED_REPORT_INSTRUCTION = `Use dynamic_context_generate_report alone to submit this role's structured output: {"report": <the exact JSON object required by this role's template>}. It validates the declaration immediately. On rejection the draft is retained with a revision and exact rejection paths. Read or rewrite only those paths using dynamic_context_read_report/dynamic_context_rewrite_report, then call dynamic_context_submit_report alone with expectedRevision. Do not regenerate the entire report merely to fix one field. Successful submission ends this role without reprinting JSON. These tools only edit this declaration; they never grant work, graph mutation or acceptance authority. The legacy final-JSON path remains supported for compatibility.`
export function standardReportTemplate(instruction) {
  const fenced = [...instruction.matchAll(/```(?:json)?\n[\s\S]*?```/g)].map(row => row[0])
  const inline = instruction.split('\n').filter(line => line.includes('模板') && line.includes('{'))
  return [...fenced, ...inline].join('\n\n') || instruction
}
const reasons = {
  REPORT_POINTER_INVALID: 'Use a JSON Pointer with / separators and ~0/~1 escapes; prototype properties are not editable.',
  REPORT_POINTER_PARENT_MISSING: 'The selected parent is not an object or array; read the draft and choose an existing parent.',
  REPORT_POINTER_MISSING: 'This selected field does not exist in the current draft.',
  REPORT_ARRAY_INDEX_INVALID: 'Use an existing zero-based array index, or /- only when appending with set.',
  REPORT_ALREADY_SUBMITTED: 'This draft has already been submitted; further edits are not accepted.',
  REPORT_READ_RANGE_INVALID: 'Read offsets must satisfy 0 <= start < end <= the current text length.',
  REPORT_STALE_REVISION: 'expectedRevision does not match the current report draft revision.',
  REPORT_SET_VALUE_REQUIRED: 'A set edit must contain value, including when the intended value is null.',
  REPORT_TEXT_NOT_FOUND: 'oldText does not occur verbatim in the current draft; read the target span first.',
  REPORT_TEXT_AMBIGUOUS: 'oldText occurs more than once; include enough neighboring text to select one span.',
  REPORT_TOOL_UNKNOWN: 'Only the report read, rewrite and submit tools are supported in this draft.',
}
const problem = (code, details = {}) => { throw located(code, { reason: reasons[code] ?? code, ...details }) }
function parts(pointer) {
  if (pointer === '') return []
  if (!pointer.startsWith('/') || /~(?![01])/u.test(pointer)) problem('REPORT_POINTER_INVALID', { path: pointer })
  const keys = pointer.slice(1).split('/').map(key => key.replaceAll('~1', '/').replaceAll('~0', '~'))
  if (keys.some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) problem('REPORT_POINTER_INVALID', { path: pointer })
  return keys
}
function keyOf(owner, key, append = false) {
  if (!owner || typeof owner !== 'object') problem('REPORT_POINTER_PARENT_MISSING')
  if (!Array.isArray(owner)) return key
  if (append && key === '-') return owner.length
  if (!/^(0|[1-9]\d*)$/.test(key) || !Number.isSafeInteger(Number(key)) || Number(key) >= owner.length) problem('REPORT_ARRAY_INDEX_INVALID')
  return Number(key)
}
function locate(value, keys) {
  for (const key of keys) {
    const actual = keyOf(value, key)
    if (!Object.hasOwn(value, actual)) problem('REPORT_POINTER_MISSING', { segment: key })
    value = value[actual]
  }
  return value
}
export function createReportDraft(previousSubmission, { requireReport = true, generate = false, template, validateResult, replayReceipts = [] } = {}) {
  let text = previousSubmission, currentRevision = 0, submitted
  const history = []
  const receipts = []; let replay, validation
  const parse = source => {
    try { return parseExecutionDisposition(source).value } catch (error) { error.code = 'REPORT_JSON_INVALID'; error.diagnostic.code = error.code; throw error }
  }
  const validate = value => {
    validation = { inputHash: digest(value) }
    if (replay?.validation) {
      if (replay.validation.inputHash !== validation.inputHash) problem('REPORT_RECEIPT_CHANGED')
      validation = structuredClone(replay.validation)
      if (validation.rejected) throw Object.assign(new Error('REPORT_RECORDED_REJECTION'), { recordedRejection: true })
      return structuredClone(validation.value)
    }
    try {
      const result = validateFresh(value)
      validation.value = structuredClone(result); return result
    } catch (error) { validation.rejected = true; throw error }
  }
  const validateFresh = value => {
    if (validateResult) return validateResult(value)
    const result = dispositionSchema.parse(value)
    if (requireReport) validationBoundary({ path: '/executionReport' }, () => executionReportSchema.parse(result.executionReport))
    return result
  }
  const perform = (name, raw) => {
    let changed = false
    try {
      if (submitted !== undefined) problem('REPORT_ALREADY_SUBMITTED')
      const parsedArguments = parseModelJSON(raw)
      const args = parsedArguments.value
      if (name === REPORT_GENERATE && generate) {
        const input = generateSchema.parse(args)
        text = JSON.stringify(input.report); currentRevision++; changed = true
        history.push({ revision: currentRevision, generated: true, sha256: digest(text) })
        submitted = validate(parse(text))
        return { revision: currentRevision, submitted: true, resultHash: digest(submitted), acceptance: 'PENDING_ORIGINAL_CHECKS' }
      }
      if (name === REPORT_READ) {
        const input = readSchema.parse(args)
        if ('path' in input) return { revision: currentRevision, path: input.path, value: locate(parse(text), parts(input.path)) }
        if (input.end <= input.start || input.end > text.length) problem('REPORT_READ_RANGE_INVALID', { path: '/end', start: input.start, end: input.end, characters: text.length })
        return { revision: currentRevision, ...input, characters: text.length, text: text.slice(input.start, input.end) }
      }
      if (name === REPORT_EDIT) {
        const input = rewriteSchema.parse(args)
        if (input.expectedRevision !== currentRevision) problem('REPORT_STALE_REVISION', { path: '/expectedRevision', expectedRevision: currentRevision, observed: input.expectedRevision })
        let next = text
        for (const [index, edit] of input.edits.entries()) {
          try {
            if (edit.op === 'set' && !Object.hasOwn(edit, 'value')) problem('REPORT_SET_VALUE_REQUIRED')
            if (edit.op === 'replace_text') {
              const start = next.indexOf(edit.oldText)
              if (start < 0) problem('REPORT_TEXT_NOT_FOUND')
              const second = next.indexOf(edit.oldText, start + 1)
              if (second >= 0) problem('REPORT_TEXT_AMBIGUOUS', { path: '/edits/' + index + '/oldText', offsets: [start, second] })
              next = next.slice(0, start) + edit.newText + next.slice(start + edit.oldText.length)
            } else {
              const value = parse(next), keys = parts(edit.path), owner = locate(value, keys.slice(0, -1))
              const key = keyOf(owner, keys.at(-1), edit.op === 'set')
              if (edit.op === 'set') owner[key] = structuredClone(edit.value)
              else {
                if (!Object.hasOwn(owner, key)) problem('REPORT_POINTER_MISSING')
                if (Array.isArray(owner)) owner.splice(key, 1); else delete owner[key]
              }
              next = JSON.stringify(value)
            }
          } catch (error) {
            error.details = { ...error.details, editIndex: index, ...(edit.path ? { selectedReportPath: edit.path } : {}) }
            error.diagnostic = { ...diagnostic(error), issues: diagnostic(error).issues.map(issue => ({ ...issue,
              path: '/edits/' + index + (edit.path ? '/path' : '/oldText'), ...(edit.path ? { selectedReportPath: edit.path } : {}), editIndex: index })) }
            throw error
          }
        }
        text = next; currentRevision++
        history.push({ revision: currentRevision, edits: input.edits, sha256: digest(text) })
        return { revision: currentRevision, sha256: digest(text), changed: input.edits.map(edit => edit.path ?? 'selected text'), submitted: false }
      }
      if (name === REPORT_SUBMIT) {
        const input = submitSchema.parse(args)
        if (input.expectedRevision !== currentRevision) problem('REPORT_STALE_REVISION', { path: '/expectedRevision', expectedRevision: currentRevision, observed: input.expectedRevision })
        const value = validate(parse(text))
        submitted = value
        return { revision: currentRevision, submitted: true, resultHash: digest(value), acceptance: 'PENDING_ORIGINAL_CHECKS' }
      }
      problem('REPORT_TOOL_UNKNOWN')
    } catch (error) {
      if (error.recordedRejection) return structuredClone(replay.result)
      return { error: error.code ?? 'REPORT_TOOL_INVALID_ARGUMENTS', diagnostic: diagnostic(error, { stage: name }), revision: currentRevision,
        ...(error.issues ? { fields: error.issues.map(issue => ({ path: issue.path, message: issue.message })) }
          : { message: error.message, ...error.details }), unchanged: !changed, draftRetained: true }
    }
  }
  const execute = (name, raw) => {
    replay = generate ? replayReceipts[receipts.length] : undefined; validation = undefined
    if (replay && (replay.name !== name || replay.argumentsHash !== digest(raw))) problem('REPORT_RECEIPT_CHANGED')
    const result = perform(name, raw)
    if (generate) {
      const receipt = { name, rawArguments: raw, argumentsHash: digest(raw), result, draftHash: digest(text), revision: currentRevision, ...(validation ? { validation } : {}) }
      if (replay && digest(receipt) !== digest(replay)) problem('REPORT_RECEIPT_CHANGED')
      receipts.push(receipt)
    }
    replay = undefined
    return result
  }
  const tools = generate ? [tool(REPORT_GENERATE, 'Generate and submit the structured output required by this role. Wrap its exact schema/template in report. Program checks run inside this call; rejection retains the draft for local rewrite. Must be called alone. Never use another role\'s template.', generateSchema, { report: {} }), ...reportTools] : reportTools
  if (generate && template) {
    tools[0].function.description += '\nHost-owned output format for this role; put the selected object inside report. Keep this format even when a Skill replaces work instructions:\n' + template
  }
  return { tools, execute, reopen: () => { submitted = undefined }, result: () => submitted, declaredDirectories: () => { try { return parse(text).executionReport?.directories?.map(row => row.path).filter(value => typeof value === 'string') ?? [] } catch { return [] } },
    snapshot: () => ({ protocol: 'report-draft-v1', baseHash: digest(previousSubmission), revision: currentRevision,
      sha256: digest(text), edits: history, ...(generate ? { receipts } : {}), ...(submitted === undefined ? {} : { submittedHash: digest(submitted) }) }) }
}
