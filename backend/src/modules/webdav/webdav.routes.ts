import { Router } from 'express'
import { v2 } from 'webdav-server'
import { requireWebDavAuth } from './webdav-auth.middleware.js'
import { VirtualFileSystem } from './webdav-virtual-fs.js'

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

webdavServer.setFileSystem('/', new VirtualFileSystem(), (successed) => {
  console.log(successed ? '[webdav] virtual filesystem mounted at /' : '[webdav] failed to mount virtual filesystem at /')
})

export const webdavRouter = Router()

webdavRouter.use(requireWebDavAuth)
webdavRouter.use((req, res) => {
  webdavServer.executeRequest(req, res)
})