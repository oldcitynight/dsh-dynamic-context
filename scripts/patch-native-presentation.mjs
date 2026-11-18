// SPDX-License-Identifier: GPL-3.0-only
// Compatibility seam for the byte-identical DSH 0.2.1 renderer line. It retains
// the native entry and its child ownership; plugins only adapt its component.
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
const digest = value => createHash('sha256').update(value).digest('hex')
export const presentationHashes = Object.freeze({"0.2.2-rc.4": "6facb89754f0d21af91491a32646be87ff1b4a25891e44cce1732b02b0fe123b", "0.2.2-rc.3": "6facb89754f0d21af91491a32646be87ff1b4a25891e44cce1732b02b0fe123b", "0.2.2-rc.2": "6facb89754f0d21af91491a32646be87ff1b4a25891e44cce1732b02b0fe123b"})
export const presentationHosts = Object.freeze(Object.keys(presentationHashes))
const component = 'const Comp=entry.component;'
const componentBridge = 'const Comp=host.presentation?.component(slotKey,entry)??entry.component;'
const locale = 'get locale(){'
const getter = '/* dsh-dynamic-context native-presentation-v1 */get presentation(){return service.ctx.get("dynamicContextPresentation")},'
export function patchNativePresentation(modules) {
  const directory = path.join(modules, '@deepseek-ai/dsh-client-ui-renderer')
  const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
  if (!presentationHosts.includes(pkg.version)) throw Error('NATIVE_PRESENTATION_ADAPTER_VERSION_UNSUPPORTED:' + pkg.version)
  const file = path.join(directory, 'lib/client.js'), source = fs.readFileSync(file, 'utf8')
  const restored = source.replaceAll(componentBridge, component).replace(getter, '')
  if (restored.split(component).length !== 4 || restored.split(locale).length !== 2) throw Error('NATIVE_PRESENTATION_ADAPTER_LAYOUT_CHANGED')
  // Byte-exact upstream identity: refuse to overwrite a different local patch.
  if (digest(restored) !== presentationHashes[pkg.version]) throw Error('NATIVE_PRESENTATION_ADAPTER_SOURCE_CHANGED')
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
