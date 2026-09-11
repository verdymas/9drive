import cors from 'cors'
import express, { type Express } from 'express'
import { env } from './config/env.js'
import { errorMiddleware } from './middleware/error.middleware.js'
import { publicRouter } from './modules/public/public.routes.js'
import { fileRouter, createFileMediaRouter } from './modules/files/file.routes.js'
import { webdavRouter } from './modules/webdav/webdav.routes.js'

/**
 * Shared composition for both delivery shapes of 9Drive:
 *
 * - All-in-one (default): the control app serves every route, byte streams
 *   included — identical behavior to the historical single `app`.
 * - Split plane (optional): `createMediaPlaneApp()` mounts ONLY the
 *   stream-heavy routes (file download/preview/archive, public share streams,
 *   WebDAV) on the same external path prefixes. A reverse proxy directs those
 *   paths (or everything, since both planes serve the same routes) to the
 *   media process; public URLs, auth semantics, and handlers are unchanged,
 *   and moving all traffic back to the control plane is a pure rollback.
 *
 * Routers are mounted, never copied: both planes bind the SAME handler
 * functions, so business logic exists exactly once. Control-only routers are
 * loaded dynamically so the media process never imports BullMQ workers,
 * FFmpeg jobs, SMB managers, or other control-plane machinery at startup.
 */
function applySharedMiddleware(app: Express) {
  app.set('trust proxy', true)

  // Dashboard origin plus browser-extension origins (the capture extension
  // pairs and submits from chrome-extension://<id>; Edge/Firefox/Safari use
  // their own schemes). Everything else is refused a CORS grant.
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || origin === env.FRONTEND_URL || /^(chrome|moz|safari-web)-extension:\/\//.test(origin)) {
          return callback(null, true)
        }
        return callback(null, false)
      },
    }),
  )
  app.use(express.json({ limit: '1mb' }))
}

export async function createControlPlaneApp(): Promise<Express> {
  const [{ authRouter }, { providerConfigRouter }, { connectedAccountRouter }, { telegramRouter }, { telegramSyncRouter }, { telegramSecurityRouter }, { storageRouter }, { uploadRouter }, { folderRouter }, { inviteRouter }, { apiKeyRouter }, { publicApiRouter }, { auditLogRouter }, { systemRouter }, { createSmbRouter }, { remoteImportRouter }, { syncRouter }, { browserCaptureRouter }, { remoteFetchWorkerRouter }] =
    await Promise.all([
      import('./modules/auth/auth.routes.js'),
      import('./modules/provider-configs/provider-config.routes.js'),
      import('./modules/connected-accounts/connected-account.routes.js'),
      import('./modules/telegram/telegram.routes.js'),
      import('./modules/telegram/telegram-sync.routes.js'),
      import('./modules/telegram/telegram-security.routes.js'),
      import('./modules/storage/storage.routes.js'),
      import('./modules/uploads/upload.routes.js'),
      import('./modules/folders/folder.routes.js'),
      import('./modules/invites/invite.routes.js'),
      import('./modules/api-keys/api-key.routes.js'),
      import('./modules/public-api/public-api.routes.js'),
      import('./modules/audit-logs/audit-log.routes.js'),
      import('./modules/system/system.routes.js'),
      import('./modules/smb/smb.routes.js'),
      import('./modules/remote-imports/remote-import.routes.js'),
      import('./modules/sync/sync.routes.js'),
      import('./modules/browser-capture/browser-capture.routes.js'),
      // Import registers the installed worker drivers (cloudflare) into the
      // registry before any route handler can resolve them.
      import('./modules/remote-fetch-workers/index.js'),
    ])

  const app = express()
  applySharedMiddleware(app)

  app.get('/health', async (_req, res) => {
    // Queue health is a control-plane concern; loading it here (rather than
    // at module scope) also keeps BullMQ/Redis out of the media graph, which
    // never evaluates this handler.
    const { remoteImportQueueHealth } = await import('./modules/remote-imports/queue.js')
    res.json({
      status: 'ok',
      remoteImportQueue: await remoteImportQueueHealth(),
    })
  })
  app.use('/api', publicApiRouter)
  app.use('/public', publicRouter)
  app.use('/auth', authRouter)
  app.use('/api-keys', apiKeyRouter)
  app.use('/provider-configs', providerConfigRouter)
  app.use('/telegram', telegramRouter)
  app.use('/telegram', telegramSyncRouter)
  app.use('/telegram', telegramSecurityRouter)
  app.use('/connected-accounts', connectedAccountRouter)
  app.use('/storage', storageRouter)
  app.use('/uploads', uploadRouter)
  app.use('/files', fileRouter)
  app.use('/folders', folderRouter)
  app.use('/invites', inviteRouter)
  app.use('/audit-logs', auditLogRouter)
  app.use('/system', systemRouter)
  app.use('/webdav', webdavRouter)
  app.use('/remote-imports', remoteImportRouter)
  app.use('/workers', remoteFetchWorkerRouter)
  app.use('/sync', syncRouter)
  app.use('/browser-capture', browserCaptureRouter)
  app.use(
    '/smb',
    createSmbRouter({
      sambaOptions: {
        ...(env.SMB_CONFIG_PATH ? { configFilePath: env.SMB_CONFIG_PATH } : {}),
        ...(env.SMB_ALLOWED_ROOT ? { allowedRoot: env.SMB_ALLOWED_ROOT } : {}),
      },
    }),
  )
  app.use(errorMiddleware)
  return app
}

/**
 * The optional media plane: streams get their own process so long-lived
 * provider transfers cannot starve short control-plane API requests. Auth
 * (bearer + public tokens + WebDAV Basic) and range behavior live in the same
 * handler functions the control plane mounts, so the processes cannot drift;
 * this app imports nothing from BullMQ/FFmpeg/SMB territory. Its health
 * endpoint deliberately skips queue probing.
 */
export function createMediaPlaneApp(): Express {
  const app = express()
  applySharedMiddleware(app)

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', plane: 'media' })
  })
  app.use('/files', createFileMediaRouter())
  app.use('/public', publicRouter)
  app.use('/webdav', webdavRouter)
  app.use(errorMiddleware)
  return app
}
