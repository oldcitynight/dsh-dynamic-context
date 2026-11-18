// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { createInflateRaw, crc32 } from 'node:zlib'
import { located } from 'dsh-better-task-grapth/validation'
const readAsync = promisify(fs.read)

/** Inspect a caller-owned, pinned fd without loading the archive or expanded
 * members into memory. ZIP32 format limits remain explicit, not size quotas. */
export async function zipInventoryFile(fd, size, signal) {
  const bad = reason => { throw located('DELIVERY_EVIDENCE_INVALID', { path: '/archive', reason }) }
  const read = (start, count) => {
    signal?.throwIfAborted()
    if (start < 0 || count < 0 || start + count > size) bad('ZIP record is truncated.')
    const bytes = Buffer.alloc(count); let done = 0
    while (done < count) { const n = fs.readSync(fd, bytes, done, count - done, start + done); if (!n) bad('ZIP record is truncated.'); done += n }
    return bytes
  }
  const tailStart = Math.max(0, size - 65557), tail = read(tailStart, size - tailStart)
  let end = -1
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = i; break }
  if (end < 0) bad('ZIP end record is missing or truncated.')
  const count = tail.readUInt16LE(end + 10), centralSize = tail.readUInt32LE(end + 12), centralStart = tail.readUInt32LE(end + 16)
  if (tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6) || tail.readUInt16LE(end + 8) !== count
    || count === 65535 || centralSize === 0xffffffff || centralStart === 0xffffffff) bad('Only single-disk ZIP32 is supported; this is a format limitation, not a file-size budget.')
  const centralEnd = tailStart + end
  if (centralStart + centralSize !== centralEnd) bad('ZIP central directory boundaries do not match.')
  let cursor = centralStart; const entries = [], names = new Set()
  for (let i = 0; i < count; i++) {
    const header = read(cursor, 46)
    if (header.readUInt32LE(0) !== 0x02014b50) bad('ZIP central entry is malformed.')
    const flags = header.readUInt16LE(8), method = header.readUInt16LE(10), expectedCRC = header.readUInt32LE(16), compressed = header.readUInt32LE(20), expanded = header.readUInt32LE(24)
    const nameLength = header.readUInt16LE(28), extra = header.readUInt16LE(30), comment = header.readUInt16LE(32), local = header.readUInt32LE(42), mode = header.readUInt32LE(38) >>> 16
    if (cursor + 46 + nameLength + extra + comment > centralEnd) bad('ZIP central entry is truncated.')
    const nameBytes = read(cursor + 46, nameLength)
    if (!(flags & 2048) && nameBytes.some(byte => byte > 127)) bad('Non-ASCII ZIP member names require UTF-8 encoding.')
    let name; try { name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes) } catch { bad('ZIP member name is invalid UTF-8.') }
    if (!name || name.includes('\\') || name.includes('\0') || path.posix.isAbsolute(name) || /^[a-z]:/i.test(name)
        || name.split('/').some(part => part === '..' || part === '.')) bad('ZIP member path must be normalized, relative, and contain no traversal.')
    if (names.has(name) || flags & 1 || ![0, 8].includes(method) || (mode & 0xf000) === 0xa000 || header.readUInt16LE(34)
        || [compressed, expanded, local].includes(0xffffffff)) bad('Duplicate, encrypted, linked, split, ZIP64 or unsupported ZIP entry.')
    names.add(name)
    if (local + 30 > centralStart) bad('ZIP local header is outside the member region.')
    const localHeader = read(local, 30), localName = localHeader.readUInt16LE(26), localExtra = localHeader.readUInt16LE(28), dataStart = local + 30 + localName + localExtra
    if (localHeader.readUInt32LE(0) !== 0x04034b50 || localHeader.readUInt16LE(6) !== flags || localHeader.readUInt16LE(8) !== method
        || !read(local + 30, localName).equals(nameBytes) || dataStart + compressed > centralStart) bad('ZIP local and central entry identities disagree.')
    if (!(flags & 8) && (localHeader.readUInt32LE(14) !== expectedCRC || localHeader.readUInt32LE(18) !== compressed || localHeader.readUInt32LE(22) !== expanded)) bad('ZIP local and central sizes or CRC disagree.')
    if (method === 8 && !compressed) bad('A deflated ZIP member is missing its compressed stream.')
    const hash = createHash('sha256'); let crc = 0, total = 0
    if (compressed) {
      // Own the stream, never the caller's fd. ReadStream.destroy() can close a
      // supplied descriptor even with autoClose:false; multiple members and
      // post-read identity checks must keep this same pinned descriptor alive.
      const source = Readable.from((async function* () {
        let offset = 0
        while (offset < compressed) {
          signal?.throwIfAborted()
          const buffer = Buffer.allocUnsafe(Math.min(65536, compressed - offset))
          const { bytesRead } = await readAsync(fd, buffer, 0, buffer.length, dataStart + offset)
          if (!bytesRead) bad('ZIP member is truncated.')
          offset += bytesRead; yield buffer.subarray(0, bytesRead)
        }
      })(), { objectMode: false, highWaterMark: 65536 })
      const inflate = method === 8 ? createInflateRaw({ chunkSize: 65536 }) : null
      const stream = inflate ? source.pipe(inflate) : source
      const forwardError = error => inflate?.destroy(error); source.on('error', forwardError)
      const abort = () => { source.destroy(signal.reason); inflate?.destroy(signal.reason) }; signal?.addEventListener('abort', abort, { once: true })
      try {
        for await (const chunk of stream) {
          signal?.throwIfAborted(); total += chunk.length
          if (total > expanded) bad('ZIP member expands beyond its declared size.')
          hash.update(chunk); crc = crc32(chunk, crc)
        }
        if (inflate && inflate.bytesWritten !== compressed) bad('ZIP compressed member has trailing unaccounted bytes.')
      } catch (error) { signal?.throwIfAborted(); if (error.code === 'DELIVERY_EVIDENCE_INVALID') throw error; bad('ZIP member decompression failed.') }
      finally { signal?.removeEventListener('abort', abort); source.destroy(); inflate?.destroy() }
    }
    if (total !== expanded || crc !== expectedCRC) bad('ZIP member size or CRC mismatch.')
    entries.push({ path: name, kind: name.endsWith('/') ? 'directory' : 'file', sha256: hash.digest('hex') })
    cursor += 46 + nameLength + extra + comment
  }
  if (cursor !== centralEnd) bad('ZIP central directory contains unaccounted entries.')
  return entries
}
