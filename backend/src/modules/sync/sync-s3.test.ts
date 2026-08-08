import { beforeEach, describe, expect, it, vi } from 'vitest'
import { scanS3Folders, parseS3Key, normalizeS3Prefix } from './sync-s3.js'

/**
 * S3 scanner — spec §37 (prefix identity), §38 (continuation tokens), §29
 * (read-only). The S3Client is stubbed via the s3.service factory mock.
 */
const h = vi.hoisted(() => {
  const s3Config = {
    id: 'cfg-1', connectedAccountId: 'acc-s3', bucket: 'bucket-a', prefix: '9drive',
    region: 'us-east-1', accessKeyIdEncrypted: 'ak', secretAccessKeyEncrypted: 'sk',
    endpoint: null, forcePathStyle: false, status: 'active', userId: 'user-1',
  }
  const onFolder = vi.fn(async (_p: any, _v: string | null) => _v ?? 'vf-root')
  const onFilePage = vi.fn(async () => undefined)
  // sendImpl holds the actual response-producing impl; tests override it.
  const sent: unknown[] = []
  const sendImpl = vi.fn(async () => ({ Contents: [], NextContinuationToken: undefined }))
  return { s3Config, onFolder, onFilePage, sent, sendImpl }
})

vi.mock('../s3/s3.service.js', () => ({
  getS3ConfigForAccount: () => Promise.resolve(h.s3Config),
  createS3Client: () => ({
    send: async (cmd: any) => {
      h.sent.push(cmd)
      return h.sendImpl(cmd)
    },
  }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  h.sent.length = 0
  h.sendImpl.mockImplementation(async () => ({ Contents: [], NextContinuationToken: undefined }))
  h.onFolder.mockImplementation(async (_p: any, _v: string | null) => _v ?? 'vf-root')
  h.onFilePage.mockImplementation(async () => undefined)
})

function runScan(opts: Partial<Omit<import('./sync-s3.js').ScanS3Options, 'accountId' | 'bucket' | 'rootPrefix' | 'userId'>> = {}) {
  return scanS3Folders({
    accountId: 'acc-s3',
    rootPrefix: '9drive',
    userId: 'u-1',
    bucket: 'bucket-a',
    onFolder: h.onFolder as any,
    onFilePage: h.onFilePage as any,
    ...opts,
  })
}

describe('parseS3Key', () => {
  it('parses a folder file key', () => {
    expect(parseS3Key('9drive/Mov/Action/u1/file-1/a.mkv', '9drive', 'u1')).toEqual({
      folderPrefix: 'Mov/Action',
      fileId: 'file-1',
      safeName: 'a.mkv',
    })
  })

  it('parses a root file key (no folder segment)', () => {
    expect(parseS3Key('9drive/u1/file-1/a.mkv', '9drive', 'u1')).toEqual({
      folderPrefix: '',
      fileId: 'file-1',
      safeName: 'a.mkv',
    })
  })

  it('returns null for keys under a different user', () => {
    expect(parseS3Key('9drive/u2/file-1/a.mkv', '9drive', 'u1')).toBeNull()
  })

  it('returns null for keys outside the account root', () => {
    expect(parseS3Key('other/a.mkv', '9drive', 'u1')).toBeNull()
  })

  it('returns null for malformed keys (no safeName)', () => {
    expect(parseS3Key('9drive/u1/file-1', '9drive', 'u1')).toBeNull()
  })
})

describe('normalizeS3Prefix', () => {
  it('trims slashes and collapses doubles', () => {
    expect(normalizeS3Prefix('/9drive/Mov//Action/')).toBe('9drive/Mov/Action')
  })
})

describe('scanS3Folders', () => {
  it('discovers folders + files from object keys, merging by prefix', async () => {
    h.sendImpl.mockImplementation(async () => ({
      Contents: [
        { Key: '9drive/Mov/Action/u-1/f-1/a.mkv', Size: 100, ContentType: 'video/x-matroska' },
        { Key: '9drive/u-1/f-2/root.mkv', Size: 200, ContentType: 'application/octet-stream' },
        { Key: '9drive/u-2/f-3/other.mkv', Size: 999, ContentType: 'application/octet-stream' },
      ],
    }))
    const seenFolders: string[] = []
    h.onFolder.mockImplementation(async (p: any) => {
      seenFolders.push(p.name)
      return 'vf-' + p.providerFolderId
    })
    const fileNames: string[] = []
    h.onFilePage.mockImplementation(async (_v: string | null, files: any[]) => {
      for (const f of files) fileNames.push(f.name)
    })

    await runScan()

    // Mov + Mov/Action discovered (root prefix itself is not a virtual folder).
    expect(seenFolders.sort()).toEqual(['Action', 'Mov'])
    expect(fileNames.sort()).toEqual(['a.mkv', 'root.mkv']) // foreign user skipped
  })

  it('follows continuation tokens', async () => {
    const pages: any[] = [
      { Contents: [{ Key: '9drive/Mov/u-1/f-1/a.mkv' }], NextContinuationToken: 'tok1' },
      { Contents: [{ Key: '9drive/Mov/u-1/f-2/b.mkv' }], NextContinuationToken: undefined },
    ]
    let pageCount = 0
    h.sendImpl.mockImplementation(async () => pages[Math.min(pageCount++, pages.length - 1)])

    await runScan()

    expect(pageCount).toBe(2)
    // One onFilePage per page of objects (batched by prefix).
    expect(h.onFilePage).toHaveBeenCalledTimes(2)
    const allFiles = h.onFilePage.mock.calls.flatMap((c) => c[1] as any[])
    expect(allFiles.map((f) => f.name).sort()).toEqual(['a.mkv', 'b.mkv'])
  })

  it('does not re-discover a folder already resolved in an earlier page', async () => {
    const pages: any[] = [
      { Contents: [{ Key: '9drive/Mov/u-1/f-1/a.mkv' }], NextContinuationToken: 'tok1' },
      { Contents: [{ Key: '9drive/Mov/u-1/f-2/b.mkv' }], NextContinuationToken: undefined },
    ]
    let pageCount = 0
    h.sendImpl.mockImplementation(async () => pages[Math.min(pageCount++, pages.length - 1)])
    const discovered: string[] = []
    h.onFolder.mockImplementation(async (p: any) => {
      discovered.push(p.providerFolderId)
      return 'vf-' + p.providerFolderId
    })

    await runScan()

    expect(discovered).toEqual(['9drive/Mov'])
  })

  it('stops on cancellation before more listing', async () => {
    // Only call send once per page; assert no second page after cancel.
    let pageCount = 0
    h.sendImpl.mockImplementation(async () => {
      pageCount += 1
      if (pageCount === 1) return { Contents: [], NextContinuationToken: 'tok' }
      return { Contents: [], NextContinuationToken: undefined }
    })
    const cancelled = vi.fn(() => pageCount >= 1)
    await runScan({ isCancelled: cancelled })
    expect(pageCount).toBe(1)
  })
})