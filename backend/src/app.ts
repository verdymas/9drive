import cors from 'cors'
import express from 'express'
import { env } from './config/env.js'
import { errorMiddleware } from './middleware/error.middleware.js'
import { authRouter } from './modules/auth/auth.routes.js'
import { providerConfigRouter } from './modules/provider-configs/provider-config.routes.js'
import { connectedAccountRouter } from './modules/connected-accounts/connected-account.routes.js'
import { storageRouter } from './modules/storage/storage.routes.js'
import { uploadRouter } from './modules/uploads/upload.routes.js'
import { fileRouter } from './modules/files/file.routes.js'
import { folderRouter } from './modules/folders/folder.routes.js'
import { publicRouter } from './modules/public/public.routes.js'
import { inviteRouter } from './modules/invites/invite.routes.js'
import { apiKeyRouter } from './modules/api-keys/api-key.routes.js'
import { publicApiRouter } from './modules/public-api/public-api.routes.js'
import { auditLogRouter } from './modules/audit-logs/audit-log.routes.js'
import { systemRouter } from './modules/system/system.routes.js'
import { webdavRouter } from './modules/webdav/webdav.routes.js'
import { createSmbRouter } from './modules/smb/smb.routes.js'
import { remoteImportRouter } from './modules/remote-imports/remote-import.routes.js'
import { remoteImportQueueHealth } from './modules/remote-imports/queue.js'
import { syncRouter } from './modules/sync/sync.routes.js'
// Importing the module registers the installed worker drivers (cloudflare)
// into the registry before any route handler can resolve them.
import { remoteFetchWorkerRouter } from './modules/remote-fetch-workers/index.js'

export const app = express()
app.set('trust proxy', true)

app.use(cors({ origin: env.FRONTEND_URL }))
app.use(express.json({ limit: '1mb' }))

app.get('/health', async (_req, res) => {
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
