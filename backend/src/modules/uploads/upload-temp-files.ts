import { createWriteStream } from 'fs'
import { mkdir, stat, unlink } from 'fs/promises'
import path from 'path'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'

export function stagedUploadPath(tempDir: string, sessionId: string) {
  return path.join(tempDir, `${sessionId}.part`)
}

export function multipartTempUploadPath(tempDir: string, sessionId: string) {
  return path.join(tempDir, `${sessionId}.multi`)
}

export async function stagedBytes(tempDir: string, sessionId: string): Promise<bigint> {
  try {
    const info = await stat(stagedUploadPath(tempDir, sessionId))
    return BigInt(info.size)
  } catch {
    return 0n
  }
}

export async function appendStagedChunk(tempDir: string, sessionId: string, stream: NodeJS.ReadableStream): Promise<void> {
  await mkdir(tempDir, { recursive: true })
  const filePath = stagedUploadPath(tempDir, sessionId)
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(filePath, { flags: 'a' })
    stream.pipe(out)
    out.on('finish', resolve)
    out.on('error', reject)
    stream.on('error', reject)
  })
}

export async function removeStagedFile(tempDir: string, sessionId: string) {
  await unlink(stagedUploadPath(tempDir, sessionId)).catch(() => undefined)
}

export type MultipartSpoolResult = {
  path: string
  sizeBytes: bigint
  limited: boolean
}

/**
 * Copy one Busboy file stream to its session-scoped multipart staging file.
 * The counting transform keeps memory bounded to stream high-water marks; it
 * never retains complete file chunks in application memory.
 */
export async function spoolMultipartFile(
  tempDir: string,
  sessionId: string,
  stream: NodeJS.ReadableStream,
  signal?: AbortSignal,
): Promise<MultipartSpoolResult> {
  await mkdir(tempDir, { recursive: true })
  const filePath = multipartTempUploadPath(tempDir, sessionId)
  let sizeBytes = 0n
  let limited = false
  const onLimit = () => { limited = true }
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sizeBytes += BigInt(chunk.length)
      callback(null, chunk)
    },
  })
  stream.once('limit', onLimit)
  try {
    await pipeline(stream, counter, createWriteStream(filePath), { signal })
    return { path: filePath, sizeBytes, limited }
  } catch (error) {
    await unlink(filePath).catch(() => undefined)
    throw error
  } finally {
    stream.removeListener('limit', onLimit)
  }
}

export async function removeMultipartTemp(tempDir: string, sessionId: string) {
  await unlink(multipartTempUploadPath(tempDir, sessionId)).catch(() => undefined)
}
