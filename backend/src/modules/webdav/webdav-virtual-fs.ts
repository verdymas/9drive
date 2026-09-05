import { GetObjectCommand } from '@aws-sdk/client-s3'
import type { ConnectedAccount, File, Folder } from '@prisma/client'
import { Readable, type Writable } from 'node:stream'
import { v2 } from 'webdav-server'
import { prisma } from '../../config/prisma.js'
import { googleDownloadExportMimeTypes, normalizeHeaders } from '../files/stream-google-file.js'
import { getAuthedGoogleClient } from '../google/google.service.js'
import { createS3Client, getS3ConfigForAccount } from '../s3/s3.service.js'
import { isTelegramStreamConfigured } from '../telegram/telegram-stream-auth.js'
import { fetchTelegramStreamAsReadable } from '../telegram/telegram-stream-readable.js'

const { FileSystem, LocalLockManager, LocalPropertyManager, ResourceType } = v2

type FileSystemSerializer = v2.FileSystemSerializer
type ILockManager = v2.ILockManager
type IPropertyManager = v2.IPropertyManager
type ReturnCallback<T> = v2.ReturnCallback<T>
type SimpleCallback = v2.SimpleCallback
type Path = v2.Path
type ResourceTypeInstance = v2.ResourceType

type FileWithAccount = File & { connectedAccount: ConnectedAccount }

const ROOT_PATH = '/'

/** Maps to HTTP 404 by webdav-server's defaultErrorStatusCodes. */
const RESOURCE_NOT_FOUND = v2.Errors.ResourceNotFound

/** Maps to HTTP 403 by webdav-server's defaultErrorStatusCodes. */
const READ_ONLY_ERROR = v2.Errors.Forbidden

/** Opaque ETag for the virtual root (no backing database row). */
const ROOT_ETAG = '"9drive-root"'

const noopSerializer: FileSystemSerializer = {
  uid: () => '9drive-virtual-fs',
  serialize: (_fs, callback) => callback(undefined, {}),
  unserialize: (_data, callback) => callback(new Error('Not supported.')),
}

/** A node of the virtual filesystem, resolved from a WebDAV path. */
type VirtualNode = {
  /** Database id of the folder or file. Never exposed to WebDAV clients. */
  id: string
  /** Type of the node. */
  type: 'folder' | 'file'
  /** Storage provider backing this node ('google_drive' | 's3'). */
  provider: string
  /** Provider-side id of the file (files only). */
  providerFileId?: string
  /** Display name of the node (folder/file name). */
  name: string
  /** File size in bytes (files only). */
  sizeBytes?: bigint
  /** File mime type (files only). */
  mimeType?: string
  createdAt: Date
  updatedAt: Date
}

/** Parse a virtual path into a segment list (URL-decoding is applied by the caller when needed). */
function parsePath(path: Path | string): string[] {
  const raw = typeof path === 'string' ? path : path.toString()
  const cleaned = raw.startsWith(ROOT_PATH) ? raw.slice(1) : raw
  return cleaned.split('/').filter((segment) => segment.length > 0)
}

/**
 * Per-request cache of directory listings and id lookups so a single WebDAV
 * exchange (e.g. a PROPFIND over a deep tree) does not re-query the database
 * for every path segment it traverses.
 */
class VirtualFsCache {
  private readonly foldersByParent = new Map<string, Promise<Folder[]>>()
  private readonly foldersById = new Map<string, Promise<Folder | null>>()
  private readonly filesByFolder = new Map<string, Promise<FileWithAccount[]>>()
  private readonly filesById = new Map<string, Promise<FileWithAccount | null>>()

  private async loadFolder(id: string): Promise<Folder | null> {
    return prisma.folder.findFirst({ where: { id, deletedAt: null } })
  }

  private async loadFile(id: string): Promise<FileWithAccount | null> {
    return prisma.file.findFirst({ where: { id, status: 'active' }, include: { connectedAccount: true } })
  }

  folder(id: string): Promise<Folder | null> {
    if (!this.foldersById.has(id)) this.foldersById.set(id, this.loadFolder(id))
    return this.foldersById.get(id)!
  }

  file(id: string): Promise<FileWithAccount | null> {
    if (!this.filesById.has(id)) this.filesById.set(id, this.loadFile(id))
    return this.filesById.get(id)!
  }

  foldersUnder(parentId: string | null): Promise<Folder[]> {
    const key = parentId ?? '\0'
    if (!this.foldersByParent.has(key)) {
      const query = parentId === null ? { parentId: null } : { parentId }
      this.foldersByParent.set(key, prisma.folder.findMany({ where: { ...query, deletedAt: null } }))
    }
    return this.foldersByParent.get(key)!
  }

  filesUnder(folderId: string | null): Promise<FileWithAccount[]> {
    const key = folderId ?? '\0'
    if (!this.filesByFolder.has(key)) {
      const query = folderId === null ? { folderId: null } : { folderId }
      this.filesByFolder.set(key, prisma.file.findMany({ where: { ...query, status: 'active' }, include: { connectedAccount: true } }))
    }
    return this.filesByFolder.get(key)!
  }

  /** Clear all cached entries (called at the start of every request). */
  reset(): void {
    for (const map of [this.foldersByParent, this.foldersById, this.filesByFolder, this.filesById]) {
      map.clear()
    }
  }
}

export class VirtualFileSystem extends FileSystem {
  /** Request-scoped caches. Cleared at the start of every request. */
  private readonly cache = new VirtualFsCache()

  constructor() {
    super(noopSerializer)
  }

  /** Clear per-request caches. Called from the routes layer at the start of every request. */
  reset(): void {
    this.cache.reset()
  }

  /**
   * Resolve a virtual filesystem path to its database node.
   *
   * Walks the path segment by segment: the first segment must match a
   * top-level folder (parentId is null), then each following segment matches
   * a child of the previous folder. The last segment may be a folder or a
   * file. Supports unlimited depth. Returns null when any segment does not
   * match (the caller maps that to 404).
   */
  async resolvePath(path: Path | string): Promise<VirtualNode | null> {
    const segments = parsePath(path)
    if (segments.length === 0) return null // root is handled by the callers

    // Resolve each folder segment from the root down.
    let parentId: string | null = null
    for (let i = 0; i < segments.length - 1; ++i) {
      const segment = segments[i]
      const folders = await this.cache.foldersUnder(parentId)
      const folder = folders.find((candidate) => candidate.name === segment)
      if (!folder) return null
      parentId = folder.id
    }

    const last = segments[segments.length - 1]

    // The last segment may be a child folder of the resolved parent...
    const folders = await this.cache.foldersUnder(parentId)
    const childFolder = folders.find((candidate) => candidate.name === last)
    if (childFolder) {
      return {
        id: childFolder.id,
        type: 'folder',
        provider: childFolder.provider,
        name: childFolder.name,
        createdAt: childFolder.createdAt,
        updatedAt: childFolder.updatedAt,
      }
    }

    // ...or a file inside the resolved parent.
    const files = await this.cache.filesUnder(parentId)
    const file = files.find((candidate) => candidate.name === last)
    if (file) {
      return {
        id: file.id,
        type: 'file',
        provider: file.provider,
        providerFileId: file.providerFileId,
        name: file.name,
        sizeBytes: file.sizeBytes,
        mimeType: file.mimeType,
        createdAt: file.createdAt,
        updatedAt: file.updatedAt,
      }
    }

    return null
  }

  /** Resolve the path and return the backing database row (with provider account) when it is a file. */
  async getFileForStreaming(id: string): Promise<FileWithAccount | null> {
    return this.cache.file(id)
  }

  /** Child folders of a folder id (null = top-level folders). */
  async listFoldersUnder(parentId: string | null): Promise<Folder[]> {
    return this.cache.foldersUnder(parentId)
  }

  /** Child files of a folder id. */
  async listFilesUnder(folderId: string | null): Promise<FileWithAccount[]> {
    return this.cache.filesUnder(folderId)
  }

  /** Whether the path resolves to the virtual root. */
  private isRootPath(path: Path): boolean {
    return parsePath(path).length === 0
  }

  /** Root is a directory; every resolved node maps to its kind; anything else is 404. */
  protected _type(path: Path, _ctx: unknown, callback: ReturnCallback<ResourceTypeInstance>): void {
    if (this.isRootPath(path)) {
      callback(undefined, ResourceType.Directory)
      return
    }
    this.resolvePath(path)
      .then((node) => {
        if (!node) {
          callback(RESOURCE_NOT_FOUND, undefined)
          return
        }
        callback(undefined, node.type === 'folder' ? ResourceType.Directory : ResourceType.File)
      })
      .catch((error) => callback(error, undefined))
  }

  /** File size in bytes; directories report 0. */
  protected _size(path: Path, _ctx: unknown, callback: ReturnCallback<number>): void {
    if (this.isRootPath(path)) {
      callback(undefined, 0)
      return
    }
    this.resolvePath(path)
      .then((node) => {
        if (!node) {
          callback(RESOURCE_NOT_FOUND, undefined)
          return
        }
        callback(undefined, node.type === 'file' ? Number(node.sizeBytes ?? 0n) : 0)
      })
      .catch((error) => callback(error, undefined))
  }

  protected _creationDate(path: Path, _ctx: unknown, callback: ReturnCallback<number>): void {
    if (this.isRootPath(path)) {
      callback(undefined, 0)
      return
    }
    this.resolvePath(path)
      .then((node) => {
        if (!node) {
          callback(RESOURCE_NOT_FOUND, undefined)
          return
        }
        callback(undefined, node.createdAt.getTime())
      })
      .catch((error) => callback(error, undefined))
  }

  protected _lastModifiedDate(path: Path, _ctx: unknown, callback: ReturnCallback<number>): void {
    if (this.isRootPath(path)) {
      callback(undefined, 0)
      return
    }
    this.resolvePath(path)
      .then((node) => {
        if (!node) {
          callback(RESOURCE_NOT_FOUND, undefined)
          return
        }
        callback(undefined, node.updatedAt.getTime())
      })
      .catch((error) => callback(error, undefined))
  }

  /** Opaque stable ETag built from id + updatedAt. */
  protected _etag(path: Path, _ctx: unknown, callback: ReturnCallback<string>): void {
    if (this.isRootPath(path)) {
      callback(undefined, ROOT_ETAG)
      return
    }
    this.resolvePath(path)
      .then((node) => callback(undefined, node ? `"${node.id}:${node.updatedAt.getTime()}"` : '""'))
      .catch((error) => callback(error, undefined))
  }

  protected _displayName(path: Path, _ctx: unknown, callback: ReturnCallback<string>): void {
    if (this.isRootPath(path)) {
      callback(undefined, '9Drive')
      return
    }
    this.resolvePath(path)
      .then((node) => {
        const segments = parsePath(path)
        callback(undefined, node?.name ?? segments[segments.length - 1])
      })
      .catch((error) => callback(error, undefined))
  }

  protected _webName(path: Path, _ctx: unknown, callback: ReturnCallback<string>): void {
    this._displayName(path, _ctx, callback)
  }

  protected _mimeType(path: Path, _ctx: unknown, callback: ReturnCallback<string>): void {
    if (this.isRootPath(path)) {
      callback(undefined, undefined)
      return
    }
    this.resolvePath(path)
      .then((node) => {
        if (!node) {
          callback(RESOURCE_NOT_FOUND, undefined)
          return
        }
        callback(undefined, node.type === 'file' ? node.mimeType ?? 'application/octet-stream' : undefined)
      })
      .catch((error) => callback(error, undefined))
  }

  /**
   * List children by real names:
   * - root: every folder whose parentId is null
   * - folder: child folders, then child files
   * - file: nothing
   */
  protected _readDir(path: Path, _ctx: unknown, callback: ReturnCallback<string[]>): void {
    if (this.isRootPath(path)) {
      this.cache
        .foldersUnder(null)
        .then((folders) => callback(undefined, folders.map((folder) => folder.name)))
        .catch((error) => callback(error, undefined))
      return
    }
    this.resolvePath(path)
      .then(async (node) => {
        if (!node) {
          callback(RESOURCE_NOT_FOUND, undefined)
          return
        }
        if (node.type === 'file') {
          callback(undefined, [])
          return
        }
        const [folders, files] = await Promise.all([this.cache.foldersUnder(node.id), this.cache.filesUnder(node.id)])
        callback(undefined, [...folders.map((folder) => folder.name), ...files.map((file) => file.name)])
      })
      .catch((error) => callback(error, undefined))
  }

  /** Open a read stream for a file. Range handling happens in the routes layer. */
  protected _openReadStream(path: Path, _ctx: unknown, callback: ReturnCallback<Readable>): void {
    this.resolvePath(path)
      .then(async (node) => {
        if (!node) {
          throw RESOURCE_NOT_FOUND
        }
        if (node.type !== 'file') {
          throw new Error('Not a file')
        }
        const file = await this.cache.file(node.id)
        if (!file) throw RESOURCE_NOT_FOUND
        const stream = await streamProviderFileToReadable(file)
        callback(undefined, stream)
      })
      .catch((error) => callback(error, undefined))
  }

  /** Read-only: all write paths return an error. */
  protected _create(_path: Path, _ctx: unknown, callback: SimpleCallback): void {
    callback(READ_ONLY_ERROR)
  }

  protected _delete(_path: Path, _ctx: unknown, callback: SimpleCallback): void {
    callback(READ_ONLY_ERROR)
  }

  protected _move(_from: Path, _to: Path, _ctx: unknown, callback: ReturnCallback<boolean>): void {
    callback(READ_ONLY_ERROR, undefined)
  }

  protected _copy(_from: Path, _to: Path, _ctx: unknown, callback: ReturnCallback<boolean>): void {
    callback(READ_ONLY_ERROR, undefined)
  }

  protected _rename(_path: Path, _newName: string, _ctx: unknown, callback: ReturnCallback<boolean>): void {
    callback(READ_ONLY_ERROR, undefined)
  }

  protected _openWriteStream(_path: Path, _ctx: unknown, callback: ReturnCallback<Writable>): void {
    callback(READ_ONLY_ERROR, undefined)
  }

  protected _propertyManager(_path: Path, _ctx: unknown, callback: ReturnCallback<IPropertyManager>): void {
    callback(undefined, new LocalPropertyManager())
  }

  protected _lockManager(_path: Path, _ctx: unknown, callback: ReturnCallback<ILockManager>): void {
    callback(undefined, new LocalLockManager())
  }
}

/** Stream a provider file's bytes as a Node Readable. Range is applied by the routes layer. */
export async function streamProviderFileToReadable(file: FileWithAccount, range?: string): Promise<Readable> {
  if (file.provider === 's3') {
    const config = await getS3ConfigForAccount(file.connectedAccountId)
    const client = createS3Client(config)
    const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: file.providerFileId, Range: range }))
    const body = response.Body as Readable | undefined
    if (!body) return Readable.from([])
    return body
  }

  if (file.provider === 'telegram') {
    // Provider detection is from the DB mapping (file.provider), never from
    // filename heuristics (phase spec §07). When the streaming service is
    // configured, the gateway is the byte source; otherwise we fall through
    // to the legacy path (which can only do full-GET) so WebDAV still
    // returns a (200) body — better than a 500.
    if (isTelegramStreamConfigured()) {
      return fetchTelegramStreamAsReadable(file, range)
    }
    return Readable.from([])
  }

  // Google Drive
  const auth = await getAuthedGoogleClient(file.connectedAccount)
  const headers = normalizeHeaders(await auth.getRequestHeaders())
  const exportTarget = googleDownloadExportMimeTypes[file.mimeType]
  const url = exportTarget
    ? `https://www.googleapis.com/drive/v3/files/${file.providerFileId}/export?mimeType=${encodeURIComponent(exportTarget.mimeType)}`
    : `https://www.googleapis.com/drive/v3/files/${file.providerFileId}?alt=media`
  const response = await fetch(url, {
    headers: {
      ...headers,
      ...(range && !exportTarget ? { Range: range } : {}),
    },
  })
  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText)
    throw new Error(`Google file stream failed: ${message || response.statusText}`)
  }
  if (!response.body) return Readable.from([])
  return Readable.fromWeb(response.body as any)
}
