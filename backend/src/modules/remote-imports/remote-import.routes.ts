import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { AppError } from '../../utils/app-error.js'
import { env } from '../../config/env.js'
import { probeRemoteUrl, probeResultForWire } from './probe.js'
import { parseCurl } from './curl-parser.js'
import { serializeRequestContext, validateRequestContext, type RemoteImportRequestContext } from './request-context.js'
import {
  cancelRemoteImport,
  createRemoteImport,
  deleteRemoteImport,
  getRemoteImportForUser,
  listRemoteImportsForUser,
  retryRemoteConvert,
  retryRemoteImport,
  serializeRemoteImport,
} from './remote-import.service.js'
import { HLS_ERROR_CODES, HLS_ERROR_MESSAGES } from './hls/errors.js'

export const remoteImportRouter = Router()

/**
 * Request context from the probe / create API body. The backend validates
 * authoritatively (CR/LF rejection + per-field caps); unknown keys are
 * rejected by `.strict()`. Values are stored encrypted and never serialized.
 */
const requestContextSchema = z
  .object({
    referer: z.string().max(4096).optional(),
    origin: z.string().max(2048).optional(),
    userAgent: z.string().max(2048).optional(),
    cookie: z.string().max(env.REMOTE_IMPORT_REQUEST_CONTEXT_MAX_COOKIE_BYTES).optional(),
  })
  .strict()
  .optional()

/** Fail-closed gate: context disabled → 403, never a silent drop. */
function assertRequestContextEnabled() {
  if (!env.REMOTE_IMPORT_REQUEST_CONTEXT_ENABLED) {
    throw new AppError('REMOTE_IMPORT_REQUEST_CONTEXT_INVALID', 'Request context support is disabled.', 403)
  }
}

/** Fail-closed gate for paste-as-cURL mode. */
function assertCurlInputEnabled() {
  if (!env.REMOTE_IMPORT_CURL_INPUT_ENABLED) {
    throw new AppError('REMOTE_IMPORT_CURL_INVALID', 'Paste-as-cURL input is disabled.', 403)
  }
}

/** Shared validation: normalize + validate a raw body context (or null). */
function validateBodyContext(raw: unknown): RemoteImportRequestContext | null {
  if (raw == null) return null
  return validateRequestContext(raw as Partial<RemoteImportRequestContext>)
}

/**
 * Probe a remote URL for filename + metadata without downloading the file.
 * Registered BEFORE the `/:id` routes so the literal segment `probe` never
 * matches a record id. Authenticated; the probe is user-scoped by design (no
 * record is touched). The returned URLs have sensitive query params redacted.
 */
remoteImportRouter.post('/probe', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({
      url: z.string().min(1).max(4096),
      requestContext: requestContextSchema,
    }).parse(req.body)

    assertRequestContextEnabled()
    const requestContext = validateBodyContext(body.requestContext)
    const result = await probeRemoteUrl(body.url, req.user!.id, requestContext ?? undefined)
    // The internal signed fetch URL must never cross the API boundary.
    return res.json({ data: probeResultForWire(result) })
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ code: 'INVALID_REQUEST', message: error.issues[0]?.message ?? 'Invalid request.' })
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})

/**
 * Backend-authoritative cURL parsing (spec §19). Never stores anything; never
 * executes anything. Returns the extracted URL + a boolean-only context summary
 * (values are never echoed back). Registered BEFORE `/:id` like `/probe`.
 */
remoteImportRouter.post('/parse-curl', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    assertCurlInputEnabled()
    const body = z.object({
      input: z.string().min(1).max(env.REMOTE_IMPORT_REQUEST_CONTEXT_MAX_CURL_BYTES),
    }).parse(req.body)

    const parsed = parseCurl(body.input)
    return res.json({
      data: {
        url: parsed.url,
        requestContext: serializeRequestContext(parsed.requestContext),
        unsupportedOptions: parsed.unsupportedOptions,
      },
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ code: HLS_ERROR_CODES.REMOTE_IMPORT_CURL_INVALID, message: HLS_ERROR_MESSAGES.REMOTE_IMPORT_CURL_INVALID })
    }
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})

const hlsOptionsSchema = z
  .object({
    // SourceType from the probe: 'hls_master' | 'hls_media'.
    sourceType: z.enum(['hls_master', 'hls_media']),
    variantId: z.string().max(64).optional(),
    audioTrackId: z.string().max(64).optional(),
    outputContainer: z.enum(['auto', 'mkv', 'mp4']).optional(),
    // True when the selected media playlist is live/event (no ENDLIST).
    isLive: z.boolean().optional(),
    // Live-only: the RECORDING length the worker should capture; a finite
    // source must reject this. Enforced server-side (§19).
    recordingDurationSeconds: z.number().int().min(60).max(21600).optional(),
  })
  .superRefine((hls, ctx) => {
    if (hls.isLive && hls.recordingDurationSeconds == null) {
      ctx.addIssue({
        code: 'custom',
        path: ['hls', 'recordingDurationSeconds'],
        message: 'A live HLS source requires a recording duration.',
      })
    }
    if (!hls.isLive && hls.recordingDurationSeconds != null) {
      ctx.addIssue({
        code: 'custom',
        path: ['hls', 'recordingDurationSeconds'],
        message: 'A finite HLS source must not carry a recording duration.',
      })
    }
  })
  .nullable()
  .optional()

remoteImportRouter.post('/', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const body = z
      .object({
        sourceMode: z.enum(['url', 'curl']).default('url'),
        url: z.string().min(1).max(4096).optional(),
        // Paste-as-cURL mode: the backend parses this (never the frontend) and
        // derives the URL + request context; nothing is ever executed.
        curl: z.string().min(1).max(env.REMOTE_IMPORT_REQUEST_CONTEXT_MAX_CURL_BYTES).optional(),
        requestContext: requestContextSchema,
        folderId: z.string().nullable().optional(),
        connectedAccountId: z.string().nullable().optional(),
        fileName: z.string().max(255).nullable().optional(),
        // Server-side detected name from the probe; used only when the user did
        // not type one. Never trusted as-is — sanitized again at creation.
        detectedFileName: z.string().max(255).nullable().optional(),
        mimeType: z.string().max(191).nullable().optional(),
        // HLS import knobs (from the probe's `sourceType` classification).
        hls: hlsOptionsSchema,
      })
      .superRefine((val, ctx) => {
        if (val.sourceMode === 'url' && !val.url) {
          ctx.addIssue({ code: 'custom', path: ['url'], message: 'A URL is required in URL mode.' })
        }
        if (val.sourceMode === 'curl' && !val.curl) {
          ctx.addIssue({ code: 'custom', path: ['curl'], message: 'A cURL command is required in cURL mode.' })
        }
      })
      .parse(req.body)

    // URL mode: use the supplied URL + optional context.
    // cURL mode: the backend parses the command (authoritative — spec §19);
    // the extracted URL + context are used for the import.
    let sourceUrl: string
    let requestContext: RemoteImportRequestContext | null = null
    if (body.sourceMode === 'curl') {
      assertCurlInputEnabled()
      const parsed = parseCurl(body.curl!)
      sourceUrl = parsed.url
      requestContext = parsed.requestContext
    } else {
      assertRequestContextEnabled()
      sourceUrl = body.url!
      requestContext = validateBodyContext(body.requestContext)
    }

    const created = await createRemoteImport({
      userId: req.user!.id,
      sourceUrl,
      requestContext,
      folderId: body.folderId,
      connectedAccountId: body.connectedAccountId,
      fileName: body.fileName,
      detectedFileName: body.detectedFileName,
      mimeType: body.mimeType,
      hls: body.hls,
    })
    return res.status(201).json(serializeRemoteImport(created))
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ code: 'INVALID_REQUEST', message: error.issues[0]?.message ?? 'Invalid request.' })
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})

remoteImportRouter.get('/', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const limit = Number(req.query.limit) || 50
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined
    const rows = await listRemoteImportsForUser(req.user!.id, limit, cursor)
    return res.json({ items: rows.map(serializeRemoteImport), cursor: rows.length ? rows[rows.length - 1].id : null })
  } catch (error) {
    return next(error)
  }
})

remoteImportRouter.get('/:id', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const row = await getRemoteImportForUser(String(req.params.id), req.user!.id)
    return res.json(serializeRemoteImport(row))
  } catch (error) {
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})

remoteImportRouter.post('/:id/cancel', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const row = await cancelRemoteImport(String(req.params.id), req.user!.id)
    return res.json(serializeRemoteImport(row))
  } catch (error) {
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})

remoteImportRouter.post('/:id/retry', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const row = await retryRemoteImport(String(req.params.id), req.user!.id)
    return res.json(serializeRemoteImport(row))
  } catch (error) {
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})

/**
 * Retry only the conversion step of a failed HLS import. Reuses the already
 * downloaded segments (the job dir is kept for this purpose); requires the
 * failure to be remux/verify-related. Re-registered before any catch-all.
 */
remoteImportRouter.post('/:id/retry-convert', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const row = await retryRemoteConvert(String(req.params.id), req.user!.id)
    return res.json(serializeRemoteImport(row))
  } catch (error) {
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})

remoteImportRouter.delete('/:id', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    await deleteRemoteImport(String(req.params.id), req.user!.id)
    return res.status(204).end()
  } catch (error) {
    if (error instanceof AppError) return res.status(error.status).json({ code: error.code, message: error.message })
    return next(error)
  }
})