import { google } from 'googleapis'
import type { ConnectedAccount } from '@prisma/client'
import { getAuthedGoogleClient, ensureGoogleAppFolder } from '../google/google.service.js'
import type { DiscoveredPhysicalFile } from './file-reconciler.js'
import type { DiscoveredPhysicalFolder } from './folder-reconciler.js'
import type { SyncStats } from './sync-run.service.js'

/**
 * Google Drive scanner — the discovery half of Provider → Virtual sync.
 *
 * Iterative BFS over the physical folder tree under the account's `9drive`
 * app folder: an explicit queue replaces recursion (§39), a visited set guards
 * against provider cycles/shortcuts, and a configurable depth cap bounds deep
 * trees. Pages are processed one at a time — never the whole account in
 * memory (§38).
 *
 * The scan is READ-ONLY on the provider: `files.list` only. Provider writes
 * are never made to mirror the virtual tree (§29).
 */

type DriveListItem = {
  id?: string | null
  name?: string | null
  mimeType?: string | null
  size?: string | number | null
  parents?: string[] | null
}

export type DriveListResponse = {
  files?: DriveListItem[]
  nextPageToken?: string | null
}

export interface SyncDriveClient {
  files: {
    list(params: {
      q: string
      spaces?: string
      pageSize: number
      pageToken?: string
      fields?: string
    }): Promise<{ data: DriveListResponse }>
  }
}

const FOLDER_MIME = 'application/vnd.google-apps.folder'

/**
 * Retry policy for Drive calls: transient errors (429 / 5xx / network
 * ECONNRESET·ETIMEDOUT / unknown) retried with exponential backoff up to
 * `maxRetries`; permanent client errors propagate immediately (§41). Exhaustion
 * throws the last provider error — the caller then fails the run WITHOUT
 * missing cleanup.
 */
export async function callDriveWithRetries<T>(fn: () => Promise<T>, maxRetries = 3, retryDelayMs = 1000): Promise<T> {
  let attempts = 0
  for (;;) {
    try {
      return await fn()
    } catch (error: any) {
      const status = Number(error?.status ?? error?.code ?? 0)
      const transient =
        status === 429 ||
        (status >= 500 && status <= 599) ||
        status === 0 ||
        error?.code === 'ECONNRESET' ||
        error?.code === 'ETIMEDOUT'
      if (!transient || attempts >= maxRetries) throw error
      attempts += 1
      await wait(retryDelayMs * 2 ** attempts)
    }
  }
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** List one page of items under a Drive parent folder. */
function listPage(
  drive: SyncDriveClient,
  parentId: string,
  pageToken: string | undefined,
  foldersOnly: boolean,
): Promise<DriveListResponse> {
  const q = `'${parentId}' in parents and ${foldersOnly ? `mimeType = '${FOLDER_MIME}'` : `mimeType != '${FOLDER_MIME}'`} and trashed = false`
  return callDriveWithRetries(() =>
    drive.files.list({
      q,
      spaces: 'drive',
      fields: 'nextPageToken,files(id,name,mimeType,size,parents)',
      pageSize: 1000,
      ...(pageToken ? { pageToken } : {}),
    }),
  ).then((r) => r.data)
}

/** Page through ALL items of one kind under a parent (bounded memory). */
async function listAllOfDrive(
  drive: SyncDriveClient,
  parentId: string,
  foldersOnly: boolean,
): Promise<DriveListItem[]> {
  const all: DriveListItem[] = []
  let pageToken: string | undefined
  do {
    const page = await listPage(drive, parentId, pageToken, foldersOnly)
    all.push(...(page.files ?? []))
    pageToken = page.nextPageToken ?? undefined
    // Soft guard: a broken provider that never ends paging cannot loop forever.
    if (pageToken && all.length > 200_000) break
  } while (pageToken)
  return all
}

export type ScanDriveOptions = {
  account: ConnectedAccount & { provider: 'google_drive' }
  maxDepth: number
  /** Called per discovered physical folder. Returns the resolved virtual folder id. */
  onFolder: (physical: DiscoveredPhysicalFolder, virtualParentId: string | null, depth: number) => Promise<string>
  /** Called once per physical folder with its files page. */
  onFilePage: (virtualParentId: string | null, files: DiscoveredPhysicalFile[]) => Promise<void>
  isCancelled?: () => boolean
  stats?: SyncStats
}

/**
 * Iterative BFS scan of the account's physical tree, starting at the provider
 * app root (never the Drive root — §34: the provider root is not a virtual
 * Folder). Cancellation aborts between queue items; seen folders are never
 * revisited (cycle guard).
 */
export async function scanDriveFolders(opts: ScanDriveOptions): Promise<void> {
  const appFolderId = await ensureGoogleAppFolder(opts.account)
  const auth = await getAuthedGoogleClient(opts.account)
  const drive = google.drive({ version: 'v3', auth }) as unknown as SyncDriveClient

  const queue: Array<{ providerId: string; virtualParentId: string | null; depth: number }> = [
    { providerId: appFolderId, virtualParentId: null, depth: 0 },
  ]
  const visited = new Set<string>([appFolderId])

  while (queue.length > 0) {
    if (opts.isCancelled?.()) return
    const { providerId, virtualParentId, depth } = queue.shift()!

    // Depth cap (§39): folders deeper than the cap are skipped, not traversed.
    if (depth >= opts.maxDepth) {
      if (opts.stats) opts.stats.foldersDiscovered += 0
      continue
    }
    if (opts.stats) opts.stats.foldersDiscovered += 1

    // Children folders (only folders — files go to the file page below).
    const childFolders = await listAllOfDrive(drive, providerId, true)
    for (const child of childFolders) {
      if (!child.id || !child.name || visited.has(child.id)) continue
      visited.add(child.id)
      const resolvedId = await opts.onFolder(
        { providerFolderId: child.id, name: child.name },
        virtualParentId,
        depth + 1,
      )
      queue.push({ providerId: child.id, virtualParentId: resolvedId, depth: depth + 1 })
    }

    // Files under this folder.
    const childFiles = await listAllOfDrive(drive, providerId, false)
    if (childFiles.length > 0) {
      const physical: DiscoveredPhysicalFile[] = childFiles
        .filter((f) => f.id && f.name && f.mimeType)
        .map((f) => ({
          providerFileId: f.id!,
          name: f.name!,
          mimeType: f.mimeType!,
          sizeBytes: BigInt(f.size ?? 0),
          providerParentId: providerId,
        }))
      await opts.onFilePage(virtualParentId, physical)
    }
  }
}