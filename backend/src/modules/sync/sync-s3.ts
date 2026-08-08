import { ListObjectsV2Command } from '@aws-sdk/client-s3'
import { getS3ConfigForAccount, createS3Client } from '../s3/s3.service.js'
import type { DiscoveredPhysicalFile } from './file-reconciler.js'
import type { DiscoveredPhysicalFolder } from './folder-reconciler.js'
import type { SyncStats } from './sync-run.service.js'

/**
 * S3 scanner — S3 has no real folders: "folders" are object-key prefixes.
 *
 * The scan derives the physical folder tree from object keys of the shape
 * (`buildS3ObjectKey`, s3.service.ts):
 *
 *   9drive/Mov/Action/{userId}/{fileId}/{safeName}
 *   9drive/{userId}/{fileId}/{safeName}          (flat root uploads)
 *
 * The `{userId}/{fileId}/{safeName}` tail is the file segment; everything
 * before it is the folder path (`9drive`, `9drive/Mov`, `9drive/Mov/Action`).
 * Each unique prefix becomes a physical folder with identity
 * `providerFolderId = <normalized prefix>` — the same two-level resolution as
 * Drive, with the caveat that S3 prefix identity cannot see renames (only the
 * missing reconciler notices a moved subtree — honest by construction, §37).
 *
 * Only keys under THIS account's prefix AND the user's `userId` segment are
 * reconciled; foreign-user keys under a shared prefix are documented and
 * skipped (never stamped, never deleted).
 *
 * Streaming: ListObjectsV2 with continuation tokens, one page at a time (§38).
 * READ-ONLY: no provider writes ever (§29).
 */

type S3ObjectSummary = {
  Key?: string
  Size?: number
  ContentType?: string
}

export type ScanS3Options = {
  accountId: string
  /** The configured account prefix (e.g. `9drive`). */
  rootPrefix: string
  /** The user whose keys are reconciled under the prefix. */
  userId: string
  bucket: string
  onFolder: (physical: DiscoveredPhysicalFolder, virtualParentId: string | null) => Promise<string>
  onFilePage: (virtualParentId: string | null, files: DiscoveredPhysicalFile[]) => Promise<void>
  isCancelled?: () => boolean
  stats?: SyncStats
}

/** Trim slashes and normalize a key to a stable folder-prefix identity. */
export function normalizeS3Prefix(prefix: string): string {
  return prefix.replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/')
}

/**
 * Split a full object key into `{ folderPrefix, userId, fileId, safeName }`.
 * Returns null when the key is not under the user's segment.
 */
export function parseS3Key(key: string, rootPrefix: string, userId: string): {
  folderPrefix: string
  fileId: string
  safeName: string
} | null {
  const parts = key.split('/').filter(Boolean)
  const root = rootPrefix.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
  // Must start with the account root.
  for (let i = 0; i < root.length; i++) {
    if (parts[i] !== root[i]) return null
  }
  // Find the userId segment after the root.
  const afterRoot = parts.slice(root.length)
  const userIdx = afterRoot.indexOf(userId)
  if (userIdx === -1) return null // not this user's key
  const fileSegments = afterRoot.slice(userIdx + 1)
  // {fileId}/{safeName}
  const fileId = fileSegments[0]
  const safeName = fileSegments.slice(1).join('/')
  if (!fileId || !safeName) return null // malformed
  const folderPrefix = afterRoot.slice(0, userIdx).join('/') // '' for root files
  return { folderPrefix, fileId, safeName }
}

/**
 * Streaming folder+file discovery from S3 object listings. The whole account
 * is never loaded into memory: each page of objects is folded into the tree
 * immediately and reconciled via the callbacks.
 */
export async function scanS3Folders(opts: ScanS3Options): Promise<void> {
  const config = await getS3ConfigForAccount(opts.accountId)
  const client = createS3Client(config)
  const root = config.prefix.replace(/^\/+|\/+$/g, '')

  // Prefix → virtual folder id cache during this scan.
  const folderByPrefix = new Map<string, string | null>()

  let continuationToken: string | undefined
  do {
    if (opts.isCancelled?.()) return
    const page = await client.send(new ListObjectsV2Command({
      Bucket: opts.bucket,
      Prefix: root ? `${root}/` : undefined,
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
    }))

    // 1) Collect the folder prefixes from this page (derive ancestors lazily).
    //    The root prefix itself is the virtual root (like Drive's app folder):
    //    never an `onFolder` discovery, only a file grouping key.
    const pageFolders = new Map<string, string | null>()
    const pageFiles: Array<{ path: string; file: DiscoveredPhysicalFile }> = []

    for (const obj of page.Contents ?? []) {
      const key = obj.Key
      if (!key) continue
      const parsed = parseS3Key(key, root, opts.userId)
      if (!parsed) continue // not our user / malformed
      const { folderPrefix, fileId, safeName } = parsed

      // Folder prefix → its own ancestors (chain until the root prefix).
      if (folderPrefix) {
        const segments = folderPrefix.split('/')
        for (let i = 1; i <= segments.length; i++) {
          const p = segments.slice(0, i).join('/')
          if (folderByPrefix.has(p)) continue // already resolved this scan
          if (!pageFolders.has(p)) pageFolders.set(p, parentPrefix(segments, i))
        }
      } else {
        pageFolders.set('', null) // root files → virtual root
      }

      pageFiles.push({
        path: folderPrefix,
        file: {
          providerFileId: key,
          name: safeName,
          mimeType: 'application/octet-stream',
          sizeBytes: BigInt(obj.Size ?? 0),
          providerParentId: folderPrefix ? `${root}/${folderPrefix}` : root,
        },
      })
    }

    // 2. Resolve folders depth-first (parents before children). The root
    //    prefix maps straight to the virtual root (null parent) without
    //    becoming a virtual folder itself.
    const sortedFolders = [...pageFolders.entries()].sort((a, b) => a[0].length - b[0].length)
    const thisPageResolved = new Map<string, string | null>()
    for (const [prefix, parentPrefixId] of sortedFolders) {
      if (thisPageResolved.has(prefix)) continue
      if (prefix === '') {
        thisPageResolved.set('', null)
        continue
      }
      if (opts.stats) opts.stats.foldersDiscovered += 1
      const virtualParent = parentPrefixId === null ? null : (thisPageResolved.get(parentPrefixId) ?? folderByPrefix.get(parentPrefixId) ?? null)
      const id = await opts.onFolder({ providerFolderId: normalizePrefixId(root, prefix), name: lastSegment(prefix) }, virtualParent)
      thisPageResolved.set(prefix, id)
      folderByPrefix.set(prefix, id)
    }

    // 3) Files: batch per folder page (resolve path → virtual parent).
    const filesByFolder = new Map<string, DiscoveredPhysicalFile[]>()
    for (const { path, file } of pageFiles) {
      const arr = filesByFolder.get(path) ?? []
      arr.push(file)
      filesByFolder.set(path, arr)
    }
    for (const [path, files] of filesByFolder) {
      const virtualParentId = thisPageResolved.get(path) ?? folderByPrefix.get(path) ?? null
      await opts.onFilePage(virtualParentId, files)
    }

    continuationToken = page.NextContinuationToken
  } while (continuationToken)
}

function parentPrefix(segments: string[], len: number): string | null {
  if (len <= 1) return null
  return segments.slice(0, len - 1).join('/')
}

function lastSegment(prefix: string): string {
  const parts = prefix.split('/')
  return parts[parts.length - 1] ?? prefix
}

/** Stable folder identity: the full normalized key prefix (S3 has no ids). */
function normalizePrefixId(root: string, prefix: string): string {
  return `${root}/${prefix}`.replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '')
}