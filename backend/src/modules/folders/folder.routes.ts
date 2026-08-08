import { Router } from 'express'
import { google } from 'googleapis'
import { z } from 'zod'
import { prisma } from '../../config/prisma.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { getAuthedGoogleClient, syncGoogleQuota } from '../google/google.service.js'
import { deleteS3Object, syncS3Quota } from '../s3/s3.service.js'
import { createAuditLog } from '../../utils/audit.js'
import { deleteProviderFolder, ensureProviderRoot, moveProviderFolder, renameProviderFolder } from '../storage/provider-folder.service.js'
import { ensureFolderStorageLocation } from '../storage/folder-materialization.service.js'
import { normalizeFolderName } from '../sync/normalize-folder-name.js'

export const folderRouter = Router()
folderRouter.use(requireAuth)

const defaultFolderColor = '#3b82f6'
const defaultFolderIconUrl = 'https://api.iconify.design/lucide:folder.svg'
const iconUrlSchema = z.string().url().startsWith('https://api.iconify.design/lucide:').max(2048)
const colorSchema = z.string().regex(/^(#[0-9a-fA-F]{6}|text-[a-z]+-[0-9]+)$/).max(64)

const createSchema = z.object({
  name: z.string().min(1).max(255),
  color: colorSchema.optional(),
  iconUrl: iconUrlSchema.nullable().optional(),
  parentId: z.string().nullable().optional(),
})

type FolderRow = {
  id: string
  name: string
  color: string
  iconUrl: string | null
  parentId: string | null
  providerFolderId: string | null
  createdAt: Date
  updatedAt: Date
  storageLocationCount?: number
  primaryLocation?: { connectedAccountId: string; provider: string; providerFolderId: string } | null
}

function serializeFolder(folder: FolderRow) {
  return {
    id: folder.id,
    name: folder.name,
    color: folder.color,
    iconUrl: folder.iconUrl,
    parentId: folder.parentId,
    providerFolderId: folder.providerFolderId ?? null,
    storageLocationCount: folder.storageLocationCount ?? 0,
    primaryLocation: folder.primaryLocation ?? null,
    createdAt: folder.createdAt.toISOString(),
    updatedAt: folder.updatedAt.toISOString(),
  }
}

folderRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const query = z.object({ parentId: z.string().nullable().optional(), all: z.string().optional() }).parse(req.query)
    const folders = await prisma.folder.findMany({
      where: { userId: req.user!.id, deletedAt: null, ...(query.all === '1' ? {} : { parentId: query.parentId ?? null }) },
      select: {
        id: true,
        name: true,
        color: true,
        iconUrl: true,
        parentId: true,
        providerFolderId: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { storageLocations: true } },
      },
      orderBy: { updatedAt: 'desc' },
    })

    // Attach the primary (most recent) physical location per folder in one query.
    const folderIds = folders.map((f) => f.id)
    const locations = folderIds.length
      ? await prisma.folderStorageLocation.findMany({
          where: { folderId: { in: folderIds } },
          select: { folderId: true, connectedAccountId: true, provider: true, providerFolderId: true, updatedAt: true },
        })
      : []
    const locationByFolderId = new Map<string, { connectedAccountId: string; provider: string; providerFolderId: string; updatedAt: Date }>()
    for (const loc of locations) {
      const prev = locationByFolderId.get(loc.folderId)
      if (!prev || loc.updatedAt > prev.updatedAt) {
        locationByFolderId.set(loc.folderId, { connectedAccountId: loc.connectedAccountId, provider: loc.provider, providerFolderId: loc.providerFolderId, updatedAt: loc.updatedAt })
      }
    }

    const serialized = folders.map((f) => {
      const primary = locationByFolderId.get(f.id)
      return serializeFolder({ ...f, storageLocationCount: f._count.storageLocations, primaryLocation: primary ?? null })
    })
    return res.json({ folders: serialized })
  } catch (error) {
    return next(error)
  }
})

folderRouter.get('/recent', async (req: AuthRequest, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 4), 4)
    const folders = await prisma.folder.findMany({
      where: { userId: req.user!.id, deletedAt: null },
      select: {
        id: true,
        name: true,
        color: true,
        iconUrl: true,
        parentId: true,
        providerFolderId: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { storageLocations: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    })
    return res.json({ folders: folders.map((f) => serializeFolder({ ...f, storageLocationCount: f._count.storageLocations })) })
  } catch (error) {
    return next(error)
  }
})

folderRouter.post('/', async (req: AuthRequest, res, next) => {
  try {
    const body = createSchema.parse(req.body)
    if (body.parentId) {
      await prisma.folder.findFirstOrThrow({
        where: { id: body.parentId, userId: req.user!.id, deletedAt: null },
      })
    }

    // A duplicated sibling name (same virtual parent) is allowed for
    // user-created folders — the folder unique index `folders_user_parent_normalized_name_unique`
    // permits multiple NULL normalized_names. Only write the normalized name
    // when it does not already exist under this parent, so the index stays
    // truthful and the new folder remains valid.
    const normalizedName = await normalizedNameIfFree(req.user!.id, body.name, body.parentId ?? null)

    // Virtual-first: a folder exists only in the virtual tree until an upload
    // (or a move) needs a physical location on some storage account.
    const folder = await prisma.folder.create({
      data: {
        userId: req.user!.id,
        name: body.name,
        color: body.color ?? defaultFolderColor,
        iconUrl: body.iconUrl ?? defaultFolderIconUrl,
        parentId: body.parentId ?? null,
        ...(normalizedName ? { normalizedName } : {}),
      },
      select: { id: true, name: true, color: true, iconUrl: true, parentId: true, providerFolderId: true, createdAt: true, updatedAt: true },
    })
    await createAuditLog(req.user!.id, 'CREATE_FOLDER', 'folder', folder.id, { name: folder.name })
    return res.status(201).json({ folder: serializeFolder({ ...folder, storageLocationCount: 0, primaryLocation: null }) })
  } catch (error) {
    return next(error)
  }
})

folderRouter.patch('/:id', async (req: AuthRequest, res, next) => {
  try {
    const body = createSchema.partial().parse(req.body)
    const folderId = String(req.params.id)
    if (body.parentId === folderId) return res.status(400).json({ code: 'FOLDER_INVALID_PARENT', message: 'Folder cannot be moved into itself.' })

    const folderRecord = await prisma.folder.findFirstOrThrow({
      where: { id: folderId, userId: req.user!.id, deletedAt: null },
      include: { storageLocations: { include: { connectedAccount: true } } },
    })

    if (body.parentId) {
      await prisma.folder.findFirstOrThrow({ where: { id: body.parentId, userId: req.user!.id, deletedAt: null } })
      const folders = await prisma.folder.findMany({ where: { userId: req.user!.id, deletedAt: null }, select: { id: true, parentId: true } })
      const descendantIds = new Set<string>([folderId])
      let changed = true
      while (changed) {
        changed = false
        for (const folder of folders) {
          if (folder.parentId && descendantIds.has(folder.parentId) && !descendantIds.has(folder.id)) {
            descendantIds.add(folder.id)
            changed = true
          }
        }
      }
      if (descendantIds.has(body.parentId)) return res.status(400).json({ code: 'FOLDER_INVALID_PARENT', message: 'Folder cannot be moved into itself or a child folder.' })
    }

    // Rename keeps the normalized name index truthful; a name that collides
    // with an existing sibling (or a parent move that would collide) leaves
    // normalizedName NULL so both rows coexist under MySQL NULL semantics.
    let normalizedName: string | null | undefined
    const renameWith = body.name ?? (body.parentId !== undefined ? folderRecord.name : undefined)
    if (renameWith) {
      const norm = await normalizedNameIfFree(
        req.user!.id,
        renameWith,
        body.parentId !== undefined ? (body.parentId ?? null) : (folderRecord.parentId ?? null),
        folderId,
      )
      normalizedName = norm
    }

    const folder = await prisma.folder.updateMany({
      where: { id: folderId, userId: req.user!.id, deletedAt: null },
      data: {
        ...(body.name ? { name: body.name } : {}),
        ...(normalizedName !== undefined ? { normalizedName } : {}),
        ...(body.color ? { color: body.color } : {}),
        ...(body.iconUrl !== undefined ? { iconUrl: body.iconUrl } : {}),
        ...(body.parentId !== undefined ? { parentId: body.parentId } : {}),
      },
    })
    if (folder.count === 0) return res.status(404).json({ code: 'FOLDER_NOT_FOUND', message: 'Folder not found.' })

    // Provider sync (best-effort — the virtual tree remains authoritative).
    // Rename: every physical location is renamed on its own account.
    if (body.name && folderRecord.storageLocations.length > 0) {
      for (const location of folderRecord.storageLocations) {
        try {
          await renameProviderFolder(location.connectedAccount, location.providerFolderId, body.name)
        } catch (error: any) {
          console.error(`Failed provider rename for folder ${folderId} on account ${location.connectedAccountId}:`, error.message || error)
        }
      }
    }

    // Move: for each existing location, ensure the new virtual parent exists
    // physically on the same account, then move the physical folder under it.
    if (body.parentId !== undefined && folderRecord.storageLocations.length > 0) {
      const parentId = body.parentId ?? null
      for (const location of folderRecord.storageLocations) {
        try {
          if (parentId) {
            const parentLocation = await ensureFolderStorageLocation(req.user!.id, parentId, location.connectedAccountId)
            await moveProviderFolder(location.connectedAccount, location.providerFolderId, parentLocation.location.providerFolderId)
          } else {
            const rootId = await ensureProviderRoot(location.connectedAccount)
            await moveProviderFolder(location.connectedAccount, location.providerFolderId, rootId)
          }
        } catch (error: any) {
          console.error(`Failed provider move for folder ${folderId} on account ${location.connectedAccountId}:`, error.message || error)
        }
      }
    }

    const updated = await prisma.folder.findFirstOrThrow({
      where: { id: folderId, userId: req.user!.id },
      select: { id: true, name: true, color: true, iconUrl: true, parentId: true, providerFolderId: true, createdAt: true, updatedAt: true },
    })
    await createAuditLog(req.user!.id, 'UPDATE_FOLDER', 'folder', updated.id, { name: updated.name, updates: body })
    return res.json({ folder: serializeFolder(updated) })
  } catch (error) {
    return next(error)
  }
})

folderRouter.delete('/:id', async (req: AuthRequest, res, next) => {
  try {
    const rootId = String(req.params.id)
    const root = await prisma.folder.findFirstOrThrow({ where: { id: rootId, userId: req.user!.id, deletedAt: null } })
    const folders = await prisma.folder.findMany({ where: { userId: req.user!.id, deletedAt: null }, select: { id: true, parentId: true } })
    const folderIds = new Set<string>([root.id])
    let changed = true
    while (changed) {
      changed = false
      for (const folder of folders) {
        if (folder.parentId && folderIds.has(folder.parentId) && !folderIds.has(folder.id)) {
          folderIds.add(folder.id)
          changed = true
        }
      }
    }
    const folderIdArray = [...folderIds]

    const files = await prisma.file.findMany({ where: { userId: req.user!.id, status: 'active', folderId: { in: folderIdArray } }, include: { connectedAccount: true } })
    const syncedAccountIds = new Set<string>()
    for (const file of files) {
      try {
        if (file.provider === 's3') {
          await deleteS3Object(file)
        } else {
          const auth = await getAuthedGoogleClient(file.connectedAccount)
          const drive = google.drive({ version: 'v3', auth })
          await drive.files.delete({ fileId: file.providerFileId })
        }
        syncedAccountIds.add(file.connectedAccountId)
      } catch {
        // Keep going so one failure does not block the whole deletion
      }
    }

    // Delete physical folder locations per account (S3: no-op; the objects
    // under the prefixes were deleted with their files above).
    const locations = await prisma.folderStorageLocation.findMany({
      where: { folderId: { in: folderIdArray } },
      include: { connectedAccount: true },
    })
    for (const location of locations) {
      try {
        await deleteProviderFolder(location.connectedAccount, location.providerFolderId)
        syncedAccountIds.add(location.connectedAccountId)
      } catch (error: any) {
        console.error(`Failed provider folder delete for location ${location.id}:`, error.message || error)
      }
    }

    await prisma.folderStorageLocation.deleteMany({ where: { folderId: { in: folderIdArray } } })
    await prisma.file.updateMany({ where: { id: { in: files.map((file) => file.id) } }, data: { status: 'deleted', deletedAt: new Date() } })
    await prisma.folder.updateMany({ where: { id: { in: folderIdArray }, userId: req.user!.id }, data: { deletedAt: new Date() } })

    for (const accountId of syncedAccountIds) {
      const account = await prisma.connectedAccount.findUnique({ where: { id: accountId } })
      if (account?.provider === 's3') await syncS3Quota(accountId).catch(() => undefined)
      else await syncGoogleQuota(accountId).catch(() => undefined)
    }

    await createAuditLog(req.user!.id, 'DELETE_FOLDER', 'folder', root.id, { name: root.name })
    return res.json({ status: 'ok' })
  } catch (error) {
    return next(error)
  }
})

/**
 * Compute the normalized name for a folder being created/renamed under a
 * virtual parent, or `null` when the normalized name would collide with an
 * existing sibling. The folder unique index allows multiple NULL normalized
 * names, so a user-created duplicate simply stays unconstrained instead of
 * failing the create/update.
 */
async function normalizedNameIfFree(
  userId: string,
  name: string,
  parentId: string | null,
  excludeId?: string,
): Promise<string | null> {
  const normalizedName = normalizeFolderName(name)
  if (normalizedName === '') return null
  const existing = await prisma.folder.findFirst({
    where: { userId, parentId, normalizedName, deletedAt: null, id: excludeId ? { not: excludeId } : undefined },
    select: { id: true },
  })
  return existing ? null : normalizedName
}
