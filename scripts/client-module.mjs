// SPDX-License-Identifier: GPL-3.0-only
import { parse } from 'acorn'

export function flattenClientModules(modules) {
  const exportsByModule = new Map()
  return modules.map(([id, source]) => {
    const edits = [], names = new Set()
    const { body } = parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
    const unsupported = kind => { throw new Error(`${id}: unsupported bundled ${kind}`) }
    for (const statement of body) {
      const { type, start, end } = statement
      if (type === 'ImportDeclaration') {
        const dependency = statement.source.value, published = exportsByModule.get(dependency)
        if (!published) unsupported(`dependency ${dependency}`)
        if (!statement.specifiers.length || !statement.specifiers.every(({ type, imported, local }) =>
          type === 'ImportSpecifier' && imported.name === local.name && published.has(local.name)))
          unsupported(`binding from ${dependency}`)
        edits.push([start, end, ';'])
      } else if (type === 'ExportNamedDeclaration' && !statement.source) {
        const declaration = statement.declaration
        if (declaration) {
          const bindings = declaration.type === 'VariableDeclaration' ? declaration.declarations.map(row => row.id) : [declaration.id]
          if (!bindings.every(binding => binding?.type === 'Identifier')) unsupported('export declaration')
          for (const binding of bindings) names.add(binding.name)
          edits.push([start, declaration.start])
        } else {
          if (!statement.specifiers.every(({ local, exported }) => local.name && local.name === exported.name))
            unsupported('export binding')
          for (const { local } of statement.specifiers) names.add(local.name)
          edits.push([start, end, ';'])
        }
      } else if (type.startsWith('Export')) unsupported('export')
    }
    exportsByModule.set(id, names)
    for (const [start, end, replacement = ''] of edits.reverse())
      source = source.slice(0, start) + replacement + source.slice(end)
    return source
  }).join('\n;\n')
}
