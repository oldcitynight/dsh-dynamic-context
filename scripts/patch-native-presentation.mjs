// SPDX-License-Identifier: GPL-3.0-only
// Compatibility seam for the byte-identical DSH 0.2.1 renderer line. It retains
// the native entry and its child ownership; plugins only adapt its component.
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
const digest = value => createHash('sha256').update(value).digest('hex')
export const presentationHosts = Object.freeze(['0.2.1-rc.5', '0.2.1-rc.4', '0.2.1-rc.3', '0.2.1-rc.2', '0.2.1-rc.1', '0.2.1-alpha.5'])
const component = 'const Comp = entry.component;'
const componentBridge = 'const Comp = host.presentation?.component(slotKey, entry) ?? entry.component;'
const locale = '\t\t\t\t\tget locale() {'
const getter = '\t\t\t\t\t// dsh-dynamic-context native-presentation-v1: optional, display-only.\n'
  + '\t\t\t\t\tget presentation() { return service.ctx.get("dynamicContextPresentation"); },\n'
export function patchNativePresentation(modules) {
  const directory = path.join(modules, '@deepseek-ai/dsh-client-ui-renderer')
  const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
  if (!presentationHosts.includes(pkg.version)) throw Error('NATIVE_PRESENTATION_ADAPTER_VERSION_UNSUPPORTED:' + pkg.version)
  const file = path.join(directory, 'lib/client.js'), source = fs.readFileSync(file, 'utf8')
  const restored = source.replaceAll(componentBridge, component).replace(getter, '')
  if (restored.split(component).length !== 4 || restored.split(locale).length !== 2) throw Error('NATIVE_PRESENTATION_ADAPTER_LAYOUT_CHANGED')
  // Byte-exact upstream identity: refuse to overwrite a different local patch.
  if (digest(restored) !== 'dbdb3f26bfbc1d143bc8a0eed5982a2507c4f0cf8027e7c170f3bed3604be356') throw Error('NATIVE_PRESENTATION_ADAPTER_SOURCE_CHANGED')
  const patched = restored.replaceAll(component, componentBridge).replace(locale, getter + locale)
  if (source !== restored && source !== patched) throw Error('NATIVE_PRESENTATION_ADAPTER_PARTIAL_PATCH')
  if (source !== patched) {
    const tmp = file + '.' + randomUUID() + '.tmp'
    fs.writeFileSync(tmp, patched); fs.renameSync(tmp, file)
  }
  return { version: pkg.version, file, upstreamSHA256: digest(restored), patchedSHA256: digest(patched), changed: source !== patched }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw Error('Usage: node patch-native-presentation.mjs /path/to/runtime/node_modules')
  process.stdout.write(JSON.stringify(patchNativePresentation(path.resolve(process.argv[2]))) + '\n')
}
