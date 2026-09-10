import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { PassThrough, Readable } from 'stream'
import { afterEach, describe, expect, it } from 'vitest'
import { multipartTempUploadPath, removeMultipartTemp, removeStagedFile, spoolMultipartFile, stagedUploadPath } from './upload-temp-files.js'

describe('upload temp files', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('spools a lazy multipart stream to its session-scoped path while counting bytes', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), '9drive-upload-test-'))
    tempDirs.push(tempDir)
    let pulled = 0
    const source = Readable.from((async function * () {
      for (const chunk of ['one', 'two', 'three']) {
        pulled++
        yield Buffer.from(chunk)
      }
    })())

    const result = await spoolMultipartFile(tempDir, 'session-1', source)

    expect(result).toEqual({ path: multipartTempUploadPath(tempDir, 'session-1'), sizeBytes: 11n, limited: false })
    expect(pulled).toBe(3)
    await expect(readFile(result.path, 'utf8')).resolves.toBe('onetwothree')
  })

  it('handles a large lazy source without constructing a complete-file Buffer', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), '9drive-upload-test-'))
    tempDirs.push(tempDir)
    const chunkSize = 64 * 1024
    const chunkCount = 32
    let yielded = 0
    const source = Readable.from((async function * () {
      for (let index = 0; index < chunkCount; index++) {
        yielded++
        yield Buffer.alloc(chunkSize, index)
      }
    })())

    const result = await spoolMultipartFile(tempDir, 'large-session', source)

    expect(yielded).toBe(chunkCount)
    expect(result.sizeBytes).toBe(BigInt(chunkSize * chunkCount))
    await expect(stat(result.path)).resolves.toMatchObject({ size: chunkSize * chunkCount })
  })

  it('records a Busboy limit and removes a partial spool after cancellation', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), '9drive-upload-test-'))
    tempDirs.push(tempDir)
    const source = new PassThrough()
    const controller = new AbortController()
    const work = spoolMultipartFile(tempDir, 'session-1', source, controller.signal)
    source.write('partial')
    source.emit('limit')
    controller.abort()

    await expect(work).rejects.toMatchObject({ name: 'AbortError' })
    await expect(readFile(multipartTempUploadPath(tempDir, 'session-1'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes resumable and multipart staged paths without affecting adjacent sessions', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), '9drive-upload-test-'))
    tempDirs.push(tempDir)
    const resumablePath = stagedUploadPath(tempDir, 'session-1')
    const multipartPath = multipartTempUploadPath(tempDir, 'session-1')
    const adjacentPath = multipartTempUploadPath(tempDir, 'session-2')
    await writeFile(multipartPath, 'multipart')
    await writeFile(adjacentPath, 'adjacent')
    // The resumable path is deliberately distinct from the multipart path.
    await writeFile(resumablePath, 'resumable')

    await removeStagedFile(tempDir, 'session-1')
    await expect(readFile(resumablePath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(multipartPath)).resolves.toEqual(Buffer.from('multipart'))

    await removeMultipartTemp(tempDir, 'session-1')
    await expect(readFile(multipartPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(adjacentPath)).resolves.toEqual(Buffer.from('adjacent'))
  })
})
