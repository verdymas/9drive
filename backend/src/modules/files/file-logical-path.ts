import { prisma } from '../../config/prisma.js'
import { buildLogicalPath } from '../telegram/telegram-metadata.js'

/**
 * Compute the logical path of a 9Drive file from its DB state.
 *
 * The logical path is the NFC-normalized, slash-joined ancestry of the
 * file's virtual folder + the file's filename. It is independent of any
 * provider: Telegram uses it as caption metadata; Google/S3 will use it
 * (or already do, silently) as a logical-location field in future
 * audit/migration flows.
 *
 * Returns `null` when the filename is empty or contains characters that
 * would make a valid caption impossible (LF, `:`, etc.) — the caller
 * decides whether to log + skip or to abort.
 */

export type FolderLike = {
  id: string
  name: string
  parentId: string | null
}

/**
 * Pure helper: walk an arbitrary folder ancestry shape. Used in isolation
 * by tests + by the `logicalPathFromFile` resolver below.
 */
export function pathFromAncestry(file: { name: string; folder: FolderLike | null }): string | null {
  if (!file.folder) {
    return buildLogicalPath([file.name])
  }
  const chain: string[] = []
  let cursor: FolderLike | null = file.folder
  // Bound the walk defensively in case of a corrupt tree.
  const seen = new Set<string>()
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    chain.unshift(cursor.name)
    if (!cursor.parentId) break
    // We need the next parent. In the pure form, callers must supply
    // the full ancestry via `lookup`; otherwise we just terminate.
    cursor = null
  }
  chain.push(file.name)
  return buildLogicalPath(chain)
}

/**
 * Resolve a file's full logical path by reading its folder ancestry from
 * the DB. Loads every ancestor folder in one query so a deep tree
 * doesn't trigger N+1.
 *
 * Returns `null` when the path would be invalid; callers can fall back
 * to omitting the path from the metadata (the stable id alone is enough
 * for re-ingest).
 */
export async function logicalPathForFileId(userId: string, fileId: string): Promise<string | null> {
  const file = await prisma.file.findFirst({
    where: { id: fileId, userId },
    select: { name: true, folderId: true },
  })
  if (!file) return null
  if (!file.folderId) {
    return buildLogicalPath([file.name])
  }
  const folderRows = await prisma.folder.findMany({
    where: { userId, deletedAt: null },
    select: { id: true, name: true, parentId: true },
  })
  const byId = new Map<string, FolderLike>(folderRows.map((f) => [f.id, f]))
  const chain: string[] = []
  const visited = new Set<string>()
  let cursor: FolderLike | null = byId.get(file.folderId) ?? null
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id)
    chain.unshift(cursor.name)
    cursor = cursor.parentId ? byId.get(cursor.parentId) ?? null : null
  }
  chain.push(file.name)
  return buildLogicalPath(chain)
}