import { Router, type Request } from 'express'
import { v2 } from 'webdav-server'
import { requireWebDavAuth } from './webdav-auth.middleware.js'
import { env } from '../../config/env.js'
import { streamProviderFileToReadable, VirtualFileSystem } from './webdav-virtual-fs.js'
import PropfindCommand from 'webdav-server/lib/server/v2/commands/Propfind.js'
import { Workflow } from 'webdav-server/lib/helper/Workflow.js'
import { XMLElementBuilder } from 'xml-js-builder'

type HTTPMethod = v2.HTTPMethod
type HTTPRequestContext = v2.HTTPRequestContext

/**
 * Parse a single `bytes=` HTTP Range header into a `{ start, end }` pair
 * (inclusive, end-exclusive when applied to the provider).
 *
 * Returns null when the header is absent, malformed, or unsatisfiable — the
 * caller then serves the full file (200). Only single ranges are handled;
 * multi-range requests fall back to a full download, which stays correct.
 */
function parseRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=([0-9]+)-([0-9]*)$/.exec(header.trim())
  if (!match) return null
  if (size <= 0) return null
  let start = parseInt(match[1], 10)
  const endRaw = match[2]
  if (start >= size) return null
  let end = endRaw === '' ? size - 1 : Math.min(parseInt(endRaw, 10), size - 1)
  if (end < start) return null
  return { start, end }
}

/** Resolve the resource backing a request and stream it, honoring HTTP Range (Jellyfin seeking). */
async function streamFile(ctx: v2.HTTPRequestContext, fs: VirtualFileSystem): Promise<void> {
  const path = ctx.requested.path
  const node = await fs.resolvePath(path)
  if (!node) {
    ctx.setCodeFromError(v2.Errors.ResourceNotFound)
    ctx.exit()
    return
  }
  if (node.type !== 'file') {
    ctx.setCode(v2.HTTPCodes.MethodNotAllowed)
    ctx.exit()
    return
  }

  const file = await fs.getFileForStreaming(node.id)
  if (!file) {
    ctx.setCodeFromError(v2.Errors.ResourceNotFound)
    ctx.exit()
    return
  }

  const size = Number(file.sizeBytes ?? 0n)
  const rangeHeader = ctx.headers.find('Range')
  const range = parseRange(rangeHeader ?? '', size)

  ctx.response.setHeader('Content-Type', file.mimeType ?? 'application/octet-stream')
  ctx.response.setHeader('Accept-Ranges', 'bytes')
  if (size > 0) ctx.response.setHeader('Content-Length', String(size))
  ctx.response.setHeader('ETag', `"${file.id}:${file.updatedAt.getTime()}"`)
  ctx.response.setHeader('Last-Modified', file.updatedAt.toUTCString())

  const stream = await streamProviderFileToReadable(file, range ? `bytes=${range.start}-${range.end}` : undefined)
  stream.on('error', () => {
    ctx.setCode(v2.HTTPCodes.InternalServerError)
    ctx.response.destroy()
  })
  if (range) {
    ctx.setCode(v2.HTTPCodes.PartialContent)
    ctx.response.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
    ctx.response.setHeader('Content-Length', String(range.end - range.start + 1))
    stream.pipe(ctx.response)
  } else {
    ctx.setCode(v2.HTTPCodes.OK)
    stream.pipe(ctx.response)
  }
  stream.on('end', () => ctx.exit())
}

/** Serve GET without using the library's own range re-slicing, which drops ranged provider streams. */
function getHandler(): HTTPMethod {
  return {
    isValidFor(ctx: v2.HTTPRequestContext) {
      return ctx.request.method === 'GET'
    },
    unchunked(ctx: v2.HTTPRequestContext, _data: Buffer, _callback: () => void) {
      const fs = ctx.server.rootFileSystem()
      if (!(fs instanceof VirtualFileSystem)) {
        ctx.setCode(v2.HTTPCodes.InternalServerError)
        ctx.exit()
        return
      }
      streamFile(ctx, fs).catch((error) => {
        console.error('[webdav] GET failed:', error)
        if (!ctx.response.headersSent) {
          ctx.setCode(v2.HTTPCodes.InternalServerError)
          ctx.exit()
        } else {
          ctx.response.destroy()
        }
      })
    },
  }
}

/** Serve HEAD with metadata only — never opens a provider stream. */
function headHandler(): HTTPMethod {
  return {
    isValidFor(ctx: v2.HTTPRequestContext) {
      return ctx.request.method === 'HEAD'
    },
    unchunked(ctx: v2.HTTPRequestContext, _data: Buffer, callback: () => void) {
      const fs = ctx.server.rootFileSystem()
      if (!(fs instanceof VirtualFileSystem)) {
        ctx.setCode(v2.HTTPCodes.InternalServerError)
        ctx.exit()
        return
      }
      fs.resolvePath(ctx.requested.path)
        .then(async (node) => {
          if (!node) {
            ctx.setCodeFromError(v2.Errors.ResourceNotFound)
            ctx.exit()
            return
          }
          if (node.type !== 'file') {
            ctx.setCode(v2.HTTPCodes.MethodNotAllowed)
            ctx.exit()
            return
          }
          const file = await fs.getFileForStreaming(node.id)
          if (!file) {
            ctx.setCodeFromError(v2.Errors.ResourceNotFound)
            ctx.exit()
            return
          }
          const size = Number(file.sizeBytes ?? 0n)
          ctx.response.setHeader('Content-Type', file.mimeType ?? 'application/octet-stream')
          ctx.response.setHeader('Accept-Ranges', 'bytes')
          if (size > 0) ctx.response.setHeader('Content-Length', String(size))
          ctx.response.setHeader('ETag', `"${file.id}:${file.updatedAt.getTime()}"`)
          ctx.response.setHeader('Last-Modified', file.updatedAt.toUTCString())
          ctx.setCode(v2.HTTPCodes.OK)
          callback()
        })
        .catch((error) => {
          console.error('[webdav] HEAD failed:', error)
          ctx.setCode(v2.HTTPCodes.InternalServerError)
          ctx.exit()
        })
    },
  }
}

/** Replace the library's PROPFIND to add recursive Depth:infinity support. */
function propfindHandler(): HTTPMethod {
  const original = new PropfindCommand()
  return {
    isValidFor(ctx: v2.HTTPRequestContext) {
      return ctx.request.method === 'PROPFIND'
    },
    unchunked(ctx: v2.HTTPRequestContext, data: Buffer, callback: () => void) {
      if (ctx.headers.depth === -1) {
        const fs = ctx.server.rootFileSystem()
        if (!(fs instanceof VirtualFileSystem)) {
          ctx.setCode(v2.HTTPCodes.InternalServerError)
          ctx.exit()
          return
        }
        recursivePropfind(ctx, fs, data, original).then(callback).catch((error) => {
          console.error('[webdav] PROPFIND (recursive) failed:', error)
          ctx.setCode(v2.HTTPCodes.InternalServerError)
          ctx.exit()
        })
        return
      }
      original.unchunked(ctx, data, callback)
    },
  }
}

/** Fully recursive Depth:infinity enumeration: the resource, then every descendant. */
async function recursivePropfind(ctx: v2.HTTPRequestContext, fs: VirtualFileSystem, data: Buffer, original: PropfindCommand): Promise<void> {
  const entries: Array<{ path: v2.Path; node: { type: string } | null }> = []
  const root = ctx.requested.path
  const rootNode = await fs.resolvePath(root)
  if (!rootNode && !root.isRoot()) {
    ctx.setCodeFromError(v2.Errors.ResourceNotFound)
    ctx.exit()
    return
  }
  entries.push({ path: root, node: rootNode })

  async function walk(dirPath: v2.Path, dirId: string): Promise<void> {
    const [folders, files] = await Promise.all([
      fs.listFoldersUnder(dirId),
      fs.listFilesUnder(dirId),
    ])
    const childPaths: Array<{ path: v2.Path; id: string }> = []
    for (const folder of folders) {
      const childPath = dirPath.getChildPath(folder.name)
      childPaths.push({ path: childPath, id: folder.id })
      entries.push({
        path: childPath,
        node: { type: 'folder' },
      })
    }
    for (const file of files) {
      const childPath = dirPath.getChildPath(file.name)
      entries.push({
        path: childPath,
        node: { type: 'file' },
      })
    }
    for (const child of childPaths) {
      await walk(child.path, child.id)
    }
  }

  if (root.isRoot()) {
    const topLevel = await fs.listFoldersUnder(null)
    for (const folder of topLevel) {
      const childPath = root.getChildPath(folder.name)
      entries.push({ path: childPath, node: { type: 'folder' } })
    }
    for (const folder of topLevel) {
      await walk(root.getChildPath(folder.name), folder.id)
    }
  } else if (rootNode?.type === 'folder') {
    await walk(root, rootNode.id)
  }

  // Build the multistatus response from the captured entries via the library's own XML writer.
  const multistatus = new XMLElementBuilder('D:multistatus', { 'xmlns:D': 'DAV:' })
  await new Promise<void>((resolve, reject) => {
    new Workflow()
      .each(entries, (entry, cb) => {
        ctx.server.getResource(ctx, entry.path, (e, resource) => {
          if (e || !resource) {
            cb(null)
            return
          }
          original.addXMLInfo(ctx, data, resource, multistatus, (addError?: Error) => {
            cb(addError ?? null)
          })
        })
      })
      .error(reject)
      .done(() => resolve())
  })
  ctx.setCode(v2.HTTPCodes.MultiStatus)
  ctx.writeBody(multistatus)
  ctx.exit()
}

// Express middleware already enforces the shared WEBDAV_PASSWORD, so the
// WebDAV protocol layer accepts every request without challenging for Basic
// auth a second time. This custom HTTPAuthentication always resolves a user.
const noChallengeAuthentication: v2.HTTPAuthentication = {
  askForAuthentication() {
    return {}
  },
  getUser(_ctx, callback) {
    callback(null as unknown as Error, new v2.SimpleUser('9drive', '', false, true))
  },
}

/** Read-only: deny every write privilege at the protocol layer (403). */
class ReadOnlyPrivilegeManager extends v2.PrivilegeManager {
  protected _can(_fullPath: v2.Path, _user: v2.IUser, _resource: v2.Resource, privilege: string, callback: v2.PrivilegeManagerCallback): void {
    if (privilege.startsWith('canWrite')) {
      callback(v2.Errors.Forbidden, false)
      return
    }
    callback(null as unknown as Error, true)
  }
}

/**
 * Returns a clean 403 for a write method without consuming the request body.
 * Replaces the library's own write command handlers so the read-only contract
 * holds even where the library skips its privilege check (e.g. PUT).
 */
function readOnlyHandler(): v2.HTTPMethod {
  return {
    isValidFor(): boolean {
      return true
    },
    unchunked(ctx: v2.HTTPRequestContext, _data: Buffer, _callback: () => void) {
      ctx.setCode(v2.HTTPCodes.Forbidden)
      ctx.exit()
    },
    chunked(ctx: v2.HTTPRequestContext, _input: NodeJS.ReadableStream, _callback: () => void) {
      ctx.setCode(v2.HTTPCodes.Forbidden)
      ctx.exit()
    },
    // Copy the defaultOptions HTTPCodes for full access
  }
}

const webdavServer = new v2.WebDAVServer({
  requireAuthentification: false,
  httpAuthentication: noChallengeAuthentication,
  privilegeManager: new ReadOnlyPrivilegeManager(),
})

// Enforce read-only at the method level: every write returns 403.
for (const method of ['put', 'mkcol', 'delete', 'move', 'copy', 'proppatch', 'lock', 'unlock']) {
  webdavServer.method(method, readOnlyHandler())
}

webdavServer.method('get', getHandler())
webdavServer.method('head', headHandler())
webdavServer.method('propfind', propfindHandler())

webdavServer.setFileSystem('/', new VirtualFileSystem(), (successed) => {
  console.log(successed ? '[webdav] virtual filesystem mounted at /' : '[webdav] failed to mount virtual filesystem at /')
})

export const webdavRouter = Router()

/** GET /webdav/status — whether the WebDAV interface is configured (no auth). */
webdavRouter.get('/status', (_req: Request, res) => {
  res.json({ configured: Boolean(env.WEBDAV_PASSWORD) })
})

webdavRouter.use(requireWebDavAuth)
webdavRouter.use((req, res) => {
  const fs = webdavServer.rootFileSystem()
  if (fs instanceof VirtualFileSystem) fs.reset()
  // req.baseUrl is the Express mount path ('/webdav', see app.ts). It becomes
  // the WebDAV server's rootPath, which prefixes every href the library
  // generates (fullUri/prefixUri). Without it the XML would advertise
  // 'http://host/Movie/' and clients (rclone, Jellyfin) could not correlate
  // the listing with the URL they requested. FS path resolution is unaffected:
  // it uses request.url, which Express already strips of the mount prefix.
  webdavServer.executeRequest(req, res, req.baseUrl)
})
