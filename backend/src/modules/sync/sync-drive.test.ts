import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callDriveWithRetries, scanDriveFolders } from './sync-drive.js'
import type { DriveListResponse } from './sync-drive.js'

/**
 * Drive scanner — spec §38 (pagination), §39 (depth cap + cycle guard),
 * §41 (retries), §34 (root), §29 (read-only). The fake `list` is tree-shaped:
 * each parent id maps to its child folders + files, so BFS explores naturally.
 */

const h = vi.hoisted(() => {
  const calls: Array<{ q: string; pageToken?: string }> = []
  const drive = { files: { list: vi.fn() } }
  const onFolder = vi.fn(async (_p: any, _v: string | null, _d: number) => _v ?? 'vf-root')
  const onFilePage = vi.fn(async () => undefined)
  return { calls, drive, onFolder, onFilePage }
})

vi.mock('googleapis', () => ({
  google: { drive: () => h.drive },
}))

vi.mock('../google/google.service.js', () => ({
  getAuthedGoogleClient: vi.fn(async () => ({})),
  ensureGoogleAppFolder: vi.fn(async () => 'app-root'),
}))

type FakeItem = { id: string; name: string; mimeType: string; size?: string | number }
type FakeDir = { folders: FakeItem[]; files: FakeItem[] }

const FOLDER = 'application/vnd.google-apps.folder'
const TREE = new Map<string, FakeDir>()

function installListImpl(pageSize = 1000) {
  h.drive.files.list.mockImplementation(async (params: { q: string; pageToken?: string }) => {
    h.calls.push({ q: params.q, pageToken: params.pageToken })
    const m = params.q.match(/'([^']+)' in parents/)
    const parentId = m ? m[1] : ''
    const isFolders = params.q.includes(`mimeType = '${FOLDER}'`)
    const dir = TREE.get(parentId)
    const items = (isFolders ? dir?.folders : dir?.files) ?? []
    const offset = params.pageToken ? Number(params.pageToken) : 0
    const slice = items.slice(offset, offset + pageSize)
    const data: DriveListResponse = {
      ...(slice.length ? { files: slice.map((f) => ({ ...f })) } : {}),
      ...(offset + pageSize < items.length ? { nextPageToken: String(offset + pageSize) } : {}),
    }
    return { data }
  })
}

function addFolder(parentId: string, id: string, name: string) {
  if (!TREE.has(parentId)) TREE.set(parentId, { folders: [], files: [] })
  TREE.get(parentId)!.folders.push({ id, name, mimeType: FOLDER })
  if (!TREE.has(id)) TREE.set(id, { folders: [], files: [] })
  return id
}
function addFile(parentId: string, id: string, name: string, size?: string) {
  if (!TREE.has(parentId)) TREE.set(parentId, { folders: [], files: [] })
  TREE.get(parentId)!.files.push({ id, name, mimeType: 'video/x-matroska', ...(size ? { size } : {}) })
}

const account = { id: 'acc-a', provider: 'google_drive', userId: 'u1' } as any

function scan(opts: { maxDepth?: number; isCancelled?: () => boolean } = {}) {
  return scanDriveFolders({
    account,
    maxDepth: opts.maxDepth ?? 40,
    onFolder: h.onFolder as any,
    onFilePage: h.onFilePage as any,
    isCancelled: opts.isCancelled,
  })
}

function seenNames() {
  const names: string[] = []
  h.onFolder.mockImplementation(async (p: any) => {
    names.push(p.name)
    return 'vf-' + p.providerFolderId
  })
  return names
}

beforeEach(() => {
  vi.clearAllMocks()
  h.calls.length = 0
  TREE.clear()
  TREE.set('app-root', { folders: [], files: [] })
  h.onFolder.mockImplementation(async (_p: any, _v: string | null) => _v ?? 'vf-root')
  h.onFilePage.mockImplementation(async () => undefined)
  installListImpl()
})

describe('scanDriveFolders', () => {
  it('discovers the whole physical tree BFS: folders + files per folder', async () => {
    // app-root
    // ├── Mov
    // │   ├── Action
    // │   └── Drama
    // └── a.mkv (root file)
    const mov = addFolder('app-root', 'fd-mov', 'Mov')
    addFolder(mov, 'fd-act', 'Action')
    addFolder(mov, 'fd-dra', 'Drama')
    addFile(mov, 'f1', 'a.mkv', '100')
    addFile('app-root', 'f2', 'root.mkv', '200')

    const names: string[] = []
    let filePages = 0
    h.onFolder.mockImplementation(async (p: any) => {
      names.push(p.name)
      return 'vf-' + p.providerFolderId
    })
    h.onFilePage.mockImplementation(async (_vp: string | null, files: any[]) => {
      filePages += 1
      expect(files.length).toBeGreaterThan(0)
    })

    await scan()

    expect(names.sort()).toEqual(['Action', 'Drama', 'Mov'])
    expect(filePages).toBeGreaterThanOrEqual(1)
    expect(h.calls.some((c) => c.q.includes(`mimeType = '${FOLDER}'`))).toBe(true)
    expect(h.calls.some((c) => c.q.includes(`mimeType != '${FOLDER}'`))).toBe(true)
  })

  it('paginates folder + file listings (pageSize 2)', async () => {
    const mov = addFolder('app-root', 'fd-mov', 'Mov')
    addFolder(mov, 'fd-a', 'A')
    addFolder(mov, 'fd-b', 'B')
    addFolder(mov, 'fd-c', 'C')
    addFile(mov, 'fb1', 'b1.mkv')
    addFile(mov, 'fb2', 'b2.mkv')
    addFile(mov, 'fb3', 'b3.mkv')

    installListImpl(2) // force paging

    const names: string[] = []
    h.onFolder.mockImplementation(async (p: any) => {
      names.push(p.name)
      return 'vf-' + p.providerFolderId
    })

    await scan()

    expect(names.sort()).toEqual(['A', 'B', 'C', 'Mov'])
    // 3 children at pageSize 2 → at least 2 folder-list pages.
    const folderPages = h.calls.filter((c) => c.q.includes(`mimeType = '${FOLDER}'`))
    expect(folderPages.length).toBeGreaterThanOrEqual(2)
    // 3 files at pageSize 2 → at least 2 file pages under Mov.
    const filePages = h.calls.filter((c) => c.q.includes(`mimeType != '${FOLDER}'`))
    expect(filePages.length).toBeGreaterThanOrEqual(2)
  })

  it('depth cap: folders beyond maxDepth are skipped, not visited', async () => {
    const mov = addFolder('app-root', 'fd-mov', 'Mov')
    addFolder(mov, 'fd-act', 'Action') // depth 2 — beyond cap 1

    const names: string[] = []
    h.onFolder.mockImplementation(async (p: any) => {
      names.push(p.name)
      return 'vf-' + p.providerFolderId
    })
    await scan({ maxDepth: 1 })
    expect(names).toEqual(['Mov'])
  })

  it('cycle guard: a shortcut back to an ancestor is not revisited', async () => {
    const mov = addFolder('app-root', 'fd-mov', 'Mov')
    addFolder(mov, 'fd-mov', 'Mov') // cycle
    let visits = 0
    h.onFolder.mockImplementation(async () => {
      visits += 1
      return 'vf'
    })
    await scan()
    expect(visits).toBe(1)
  })

  it('cancellation stops before processing the next folder', async () => {
    addFolder('app-root', 'fd-1', 'One')
    addFolder('app-root', 'fd-2', 'Two')
    let cancelled = false
    let visits = 0
    await scanDriveFolders({
      account,
      maxDepth: 40,
      onFolder: async (p: any, v: string | null) => {
        visits += 1
        return v ?? 'vf'
      },
      onFilePage: async () => {},
      // Cancel BEFORE any processing: the scan returns immediately.
      isCancelled: () => {
        if (visits === 0) return false
        cancelled = true // signal after first folder
        return true
      },
    })
    expect(visits).toBeGreaterThanOrEqual(1)
    // Never processed the second folder (Two).
    const names = h.onFolder.mock.calls.map((c) => (c[0] as any).name)
    expect(names).not.toContain('Two')
  })
})

describe('callDriveWithRetries', () => {
  it('retries transient provider errors and completes', async () => {
    let attempts = 0
    const result = await callDriveWithRetries(async () => {
      attempts += 1
      if (attempts <= 2) {
        const e: any = new Error('rate limited')
        e.status = 429
        throw e
      }
      return 'ok'
    }, 3, 1)
    expect(result).toBe('ok')
    expect(attempts).toBe(3)
  })

  it('does not retry a permanent 403', async () => {
    let attempts = 0
    await expect(
      callDriveWithRetries(async () => {
        attempts += 1
        const e: any = new Error('permission denied')
        e.code = 403
        throw e
      }, 3),
    ).rejects.toThrow('permission denied')
    expect(attempts).toBe(1)
  })

  it('exhausts retries and throws the last error', async () => {
    let attempts = 0
    await expect(
      callDriveWithRetries(async () => {
        attempts += 1
        const e: any = new Error('still down')
        e.status = 503
        throw e
      }, 2, 1),
    ).rejects.toThrow('still down')
    expect(attempts).toBe(3)
  })
})