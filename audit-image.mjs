// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs'
import { apply, Config } from '@deepseek-ai/dsh-tool-fs'
import { located } from 'dsh-better-task-grapth/validation'

const imageOnly = Config({ read: false, readImage: true, write: false, edit: false })

function nativeDefinition(services) {
  let definition
  const view = {
    fs: {}, ...services, tools: { register(tool) { if (tool.name === 'read_image') definition = tool } },
    systemPrompt: { getSectionOrder: () => 0, section() {} },
    inject(_services, mount) { mount(view) },
  }
  apply(view, imageOnly)
  return definition
}
export const nativeImageDescription = nativeDefinition({}).description

// Background roles have a model route but no native Agent/filesystem scope.
// Mount the host's own image tool over this invocation's read-only evidence view.
export async function readAuditImage({ ctx, config }, requested, signal, locate, observe) {
  let identity
  const nativeTool = nativeDefinition({
    get: name => ctx?.get?.(name) ?? undefined,
    workingDirectory: { ensure: () => config.projectRoot },
    fs: {
      resolve: name => ({ ...locate(name), displayPath: name }),
      stat(target) {
        try {
          const stat = fs.lstatSync(target.file(), { bigint: true })
          return { type: stat.isFile() ? 'file' : 'other', version: String(stat.mtimeNs) }
        } catch (error) {
          if (error.code === 'ENOENT') return undefined
          throw error
        }
      },
      readBytes(target, _signal, byteLimit) {
        try {
          const result = observe(target.file, target.identityPath, true, byteLimit, target.sha256)
          identity = result.identity
          return result.bytes
        } catch (error) {
          if (error.code !== 'WORKSPACE_FILE_TOO_LARGE') throw error
          throw located('FS_TOO_LARGE', { path: '/file_path', item: target.displayPath, bytes: error.details.bytes, maxBytes: byteLimit,
            reason: `The image file is ${error.details.bytes} bytes and the attachment read limit is ${byteLimit} bytes.` })
        }
      },
      processPath: target => target.displayPath,
    },
    // The enclosing role persists this observation with its hash and citation.
    emit() {},
  })
  const agent = { session: { header: { cwd: config.projectRoot }, requestHeader: () => ({ config: { provider: config.provider, model: config.model } }) } }
  const args = { file_path: requested }
  try {
    const value = await nativeTool.execute(args, { agent, signal })
    signal?.throwIfAborted()
    const display = nativeTool.output.render(args, value).find(block => block.type === 'text').text
    return { identity, image: value.image, display }
  } catch (error) {
    if (signal?.aborted || error.details) throw error
    throw located(error.cause?.code ?? error.code ?? 'IMAGE_READ_FAILED', { path: '/file_path', reason: error.message })
  }
}
