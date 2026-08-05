import { GetObjectCommand } from '@aws-sdk/client-s3'
import type { ConnectedAccount, File } from '@prisma/client'
import { Readable, type Writable } from 'node:stream'
import { v2 } from 'webdav-server'
import { prisma } from '../../config/prisma.js'
import { googleDownloadExportMimeTypes, normalizeHeaders } from '../files/stream-google-file.js'
import { getAuthedGoogleClient } from '../google/google.service.js'
import { createS3Client, getS3ConfigForAccount } from '../s3/s3.service.js'

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

/** Maps to HTTP 403 by webdav-server's defaultErrorStatusCodes. */
const READ_ONLY_ERROR = v2.Errors.Forbidden

const noopSerializer: FileSystemSerializer = {
  uid: () => '9drive-virtual-fs',
  serialize: (_fs, callback) => callback(undefined, {}),
  unserialize: (_data, callback) => callback(new Error('Not supported.')),
}

/** Parse a virtual path into a segment list. */
function parsePath(path: Path | string): string[] {
  const raw = typeof path === 'string' ? path : path.toString()
  const cleaned = raw.startsWith(ROOT_PATH) ? raw.slice(1) : raw
  return cleaned.split('/').filter((segment) => segment.length > 0)
}

export class VirtualFileSystem extends FileSystem {
  constructor() {
    super(noopSerializer)
  }

  /** Root is a directory; folders are directories; files are files. */
  protected _type(path: Path, _ctx: unknown, callback: ReturnCallback<ResourceTypeInstance>): void {
    const segments = parsePath(path)
    if (segments.length === 0 || (segments[0] === 'folders' && segments.length === 2)) {
      callback(undefined, ResourceType.Directory)
      return
    }
    if (segments[0] === 'files' && segments.length === 2) {
      callback(undefined, ResourceType.File)
      return
    }
    callback(new Error('Resource not found'), undefined)
  }

  /** File size in bytes; directories report 0. */
  protected _size(path: Path, _ctx: unknown, callback: ReturnCallback<number>): void {
    const segments = parsePath(path)
    if (segments[0] === 'files' && segments.length === 2) {
      this.fileById(segments[1])
        .then((file) => callback(undefined, Number(file?.sizeBytes ?? 0n)))
        .catch((error) => callback(error, undefined))
      return
    }
    callback(undefined, 0)
  }

  protected _creationDate(path: Path, _ctx: unknown, callback: ReturnCallback<number>): void {
    this.rowByPath(path)
      .then((row) => callback(undefined, (row?.createdAt ?? new Date(0)).getTime()))
      .catch((error) => callback(error, undefined))
  }

  protected _lastModifiedDate(path: Path, _ctx: unknown, callback: ReturnCallback<number>): void {
    this.rowByPath(path)
      .then((row) => callback(undefined, (row?.updatedAt ?? new Date(0)).getTime()))
      .catch((error) => callback(error, undefined))
  }

  /** Opaque stable ETag built from id + updatedAt. */
  protected _etag(path: Path, _ctx: unknown, callback: ReturnCallback<string>): void {
    const segments = parsePath(path)
    if (segments.length === 0) {
      callback(undefined, '"9drive-root"')
      return
    }
    if (segments.length !== 2) {
      callback(undefined, '"9drive"')
      return
    }
    this.rowByPath(path)
      .then((row) => callback(undefined, row ? `"${row.id}:${row.updatedAt.getTime()}"` : '""'))
      .catch((error) => callback(error, undefined))
  }

  protected _displayName(path: Path, _ctx: unknown, callback: ReturnCallback<string>): void {
    const segments = parsePath(path)
    if (segments.length === 0) {
      callback(undefined, '9Drive')
      return
    }
    if (segments.length === 1) {
      callback(undefined, segments[0] === 'folders' ? 'Folders' : 'Files')
      return
    }
    this.rowByPath(path)
      .then((row) => callback(undefined, row?.name ?? segments[segments.length - 1]))
      .catch((error) => callback(error, undefined))
  }

  protected _webName(path: Path, _ctx: unknown, callback: ReturnCallback<string>): void {
    this._displayName(path, _ctx, callback)
  }

  protected _mimeType(path: Path, _ctx: unknown, callback: ReturnCallback<string>): void {
    const segments = parsePath(path)
    if (segments[0] === 'files' && segments.length === 2) {
      this.fileById(segments[1])
        .then((file) => callback(undefined, file?.mimeType ?? 'application/octet-stream'))
        .catch((error) => callback(error, undefined))
      return
    }
    callback(undefined, undefined)
  }

  /** List children: root → folders/ + files/; folder → subfolders + files; file → empty. */
  protected _readDir(path: Path, _ctx: unknown, callback: ReturnCallback<string[]>): void {
    const segments = parsePath(path)
    if (segments.length === 0) {
      callback(undefined, ['folders', 'files'])
      return
    }
    if (segments[0] === 'folders' && segments.length === 2) {
      this.folderChildren(segments[1])
        .then((children) => callback(undefined, children))
        .catch((error) => callback(error, undefined))
      return
    }
    callback(undefined, [])
  }

  /** Open a read stream for a file, honoring HTTP Range for seeking (Jellyfin). */
  protected _openReadStream(path: Path, ctx: unknown, callback: ReturnCallback<Readable>): void {
    const segments = parsePath(path)
    if (segments[0] !== 'files' || segments.length !== 2) {
      callback(new Error('Not a file'), undefined)
      return
    }

    const requestContext = ctx as { context?: { headers?: { find: (name: string) => string | undefined } } }
    const range = requestContext?.context?.headers?.find('range')

    this.fileById(segments[1])
      .then(async (file) => {
        if (!file) throw new Error('File not found')
        const stream = await streamProviderFileToReadable(file, range)
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

  // --- helpers ---

  private async rowByPath(path: Path): Promise<{ id: string; name: string; createdAt: Date; updatedAt: Date } | null> {
    const segments = parsePath(path)
    if (segments.length !== 2) return null
    const id = segments[1]
    if (segments[0] === 'folders') {
      const folder = await prisma.folder.findFirst({ where: { id, deletedAt: null } })
      if (!folder) return null
      return { id: folder.id, name: folder.name, createdAt: folder.createdAt, updatedAt: folder.updatedAt }
    }
    if (segments[0] === 'files') {
      const file = await prisma.file.findFirst({ where: { id, status: 'active' } })
      if (!file) return null
      return { id: file.id, name: file.name, createdAt: file.createdAt, updatedAt: file.updatedAt }
    }
    return null
  }

  private async fileById(id: string): Promise<FileWithAccount | null> {
    return prisma.file.findFirst({ where: { id, status: 'active' }, include: { connectedAccount: true } })
  }

  private async folderChildren(folderId: string): Promise<string[]> {
    const subfolders = await prisma.folder.findMany({ where: { parentId: folderId, deletedAt: null }, select: { id: true } })
    const files = await prisma.file.findMany({ where: { folderId, status: 'active' }, select: { id: true } })
    return [
      ...subfolders.map((folder) => `/folders/${folder.id}`),
      ...files.map((file) => `/files/${file.id}`),
    ]
  }
}

/** Stream a provider file's bytes as a Node Readable, honoring HTTP Range. */
export async function streamProviderFileToReadable(file: FileWithAccount, range?: string): Promise<Readable> {
  if (file.provider === 's3') {
    const config = await getS3ConfigForAccount(file.connectedAccountId)
    const client = createS3Client(config)
    const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: file.providerFileId, Range: range }))
    const body = response.Body as Readable | undefined
    if (!body) return Readable.from([])
    return body
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
