import test from 'node:test'
import assert from 'node:assert/strict'
import { installToolAdmission } from '../tool-admission.mjs'

test('step admission filters local tools for one owner, retains native executor and disposal', async () => {
  const owner = {}, other = {}, read = {}, write = {}; let disposed = 0
  const original = async () => Object.freeze({ view: () => new Map([['read', read], ['write', write]]), dispose() { disposed++ } })
  const ctx = { tools: { resolve: original } }
  const release = installToolAdmission(ctx, agent => agent === owner ? new Set(['read']) : null)
  const admitted = await ctx.tools.resolve({ agent: owner })
  assert.deepEqual([...admitted.view(owner)], [['read', read]])
  assert.deepEqual([...((await ctx.tools.resolve({ agent: other })).view(other))], [['read', read], ['write', write]])
  admitted.dispose(); assert.equal(disposed, 1)
  release(); release(); assert.equal(ctx.tools.resolve, original)
})
test('independent admission owners intersect, release separately, and keep an empty denial', async () => {
  const owner = {}, original = async () => ({ view: () => new Map([['read', {}], ['write', {}]]), dispose() {} })
  const ctx = { tools: { resolve: original } }
  const first = installToolAdmission(ctx, () => new Set(['read']))
  const second = installToolAdmission(ctx, () => new Set())
  assert.equal((await ctx.tools.resolve({ agent: owner })).view(owner).size, 0)
  second(); assert.deepEqual([...(await ctx.tools.resolve({ agent: owner })).view(owner).keys()], ['read'])
  first(); assert.equal(ctx.tools.resolve, original)
})
