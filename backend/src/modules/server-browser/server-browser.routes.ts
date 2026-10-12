import { Router } from 'express'
import type { NextFunction, Request, Response } from 'express'
import type { Server } from 'node:http'
import tls from 'node:tls'
import { Agent, request as undiciRequest } from 'undici'
import { env } from '../../config/env.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { AppError } from '../../utils/app-error.js'
import {
  createSession,
  getSession,
  listSessions,
  mintViewToken,
  resolveDisplayTarget,
  stopSession,
} from './server-browser.service.js'

/**
 * Server Browser routes (Stage 1 MVP).
 *
 * Control routes (`/sessions*`) require bearer auth and enforce ownership.
 * The display gateway (`/sessions/:id/display*`) is public-by-token: the
 * iframe embeds a short-lived one-time view token (preview-token pattern), so
 * the app access token never travels in a URL. The gateway proxies ONLY to
 * the owning session's own container on the isolated browser network, ONLY on
 * the KasmVNC display port — the DevTools port is never mapped on any
 * container and no route can reach it.
 */

export const serverBrowserRouter = Router()

/** KasmVNC serves HTTPS with a container-generated self-signed certificate.
 *  Verification is disabled ONLY for this private-network dispatcher — never
 *  for public fetches (Remote Import, Google, workers). */
const browserDispatcher = new Agent({ connect: { rejectUnauthorized: false } })

/** Headers that must never cross the gateway in either direction. */
const STRIPPED_REQUEST_HEADERS = new Set(['proxy-authorization', 'host', 'content-length'])
const STRIPPED_RESPONSE_HEADERS = new Set([
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'content-security-policy',
  'x-frame-options',
])

/**
 * Pipe an undici response body into the Express response. Undici v7 hands us
 * its own Node Readable (`BodyReadable`) — pipe it directly. Anything else
 * stream-shaped (WHATWG) is converted; anything else ends the response.
 */
export function pipeUpstreamBody(body: unknown, res: NodeJS.WritableStream): void {
  if (body && typeof (body as NodeJS.ReadableStream).pipe === 'function') {
    ;(body as NodeJS.ReadableStream).pipe(res)
    return
  }
  if (body && typeof (body as ReadableStream).getReader === 'function') {
    import('node:stream').then(({ Readable }) => {
      Readable.fromWeb(body as never).pipe(res)
    }).catch(() => {
      try {
        res.end()
      } catch {
        /* client already gone */
      }
    })
    return
  }
  try {
    res.end()
  } catch {
    /* client already gone */
  }
}

/**
 * Validate the upstream path derived from the mount-stripped request URL.
 * Only same-origin path+query is forwarded — absolute URLs and
 * protocol-relative `//host` overrides are rejected so a crafted token URL
 * can never turn the gateway into an open proxy.
 */
export function buildUpstreamPath(strippedUrl: string): string {
  if (!strippedUrl.startsWith('/')) throw new AppError('INVALID_REQUEST', 'Invalid display path.', 400)
  if (strippedUrl.startsWith('//')) throw new AppError('INVALID_REQUEST', 'Invalid display path.', 400)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(strippedUrl.slice(1))) {
    throw new AppError('INVALID_REQUEST', 'Invalid display path.', 400)
  }
  return strippedUrl
}

/** The gateway target is always the session's own container display port. */
export function buildDisplayBase(containerName: string): string {
  return `https://${containerName}:${env.SERVER_BROWSER_DISPLAY_PORT}`
}

/**
 * Shape the forwarded headers for undici's low-level `request()`, which
 * accepts records, flat arrays, or Headers — NOT tuple arrays (it throws
 * `headers array must be even`). Multi-valued headers are merged into arrays.
 */
export function toUndiciHeaders(
  input: Record<string, string | string[] | undefined>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [name, value] of buildUpstreamHeaders(input)) {
    const existing = out[name]
    if (existing === undefined) out[name] = value
    else out[name] = [...(Array.isArray(existing) ? existing : [existing]), value]
  }
  return out
}

/**
 * Select the request headers forwarded to the browser container. The embedded
 * KasmVNC UI protects itself with HTTP Basic (`WWW-Authenticate: Basic
 * realm="Websockify"`) and the dashboard iframe answers that challenge — so
 * Basic credentials MUST be forwarded or the login loops on 401 forever.
 * Every other `Authorization` scheme (notably `Bearer`, the 9Drive session
 * credential) is stripped: the app access token must never reach a browser
 * container. Pure — unit-tested.
 */
export function buildUpstreamHeaders(
  input: Record<string, string | string[] | undefined>,
): Array<[string, string]> {
  return Object.entries(input)
    .filter(([name, value]) => {
      if (value === undefined) return false
      if (name.toLowerCase() === 'authorization') {
        const first = Array.isArray(value) ? value[0] : value
        return typeof first === 'string' && /^Basic /i.test(first.trim())
      }
      return !STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())
    })
    .flatMap(([name, value]) => {
      if (Array.isArray(value)) return value.map((v) => [name, v] as [string, string])
      return [[name, value] as [string, string]]
    })
}

function sendAppError(res: Response, error: AppError) {
  return res.status(error.status).json({ code: error.code, message: error.message })
}

serverBrowserRouter.post('/sessions', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    // The VNC credential is revealed once, here, to the session owner.
    return res.status(201).json(await createSession(req.user!.id))
  } catch (error) {
    if (error instanceof AppError) return sendAppError(res, error)
    return next(error)
  }
})

serverBrowserRouter.get('/sessions', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    return res.json({ sessions: await listSessions(req.user!.id) })
  } catch (error) {
    return next(error)
  }
})

serverBrowserRouter.get('/sessions/:id', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    return res.json({ session: await getSession(req.user!.id, String(req.params.id)) })
  } catch (error) {
    if (error instanceof AppError) return sendAppError(res, error)
    return next(error)
  }
})

serverBrowserRouter.delete('/sessions/:id', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    return res.json({ session: await stopSession(req.user!.id, String(req.params.id)) })
  } catch (error) {
    if (error instanceof AppError) return sendAppError(res, error)
    return next(error)
  }
})

serverBrowserRouter.post('/sessions/:id/view-token', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    return res.status(201).json(await mintViewToken(req.user!.id, String(req.params.id)))
  } catch (error) {
    if (error instanceof AppError) return sendAppError(res, error)
    return next(error)
  }
})

/**
 * Authenticated display gateway. Mounted under `/sessions/:id/display` so
 * `req.url` is the KasmVNC sub-path. Streams the remote Chromium UI into the
 * dashboard iframe. Cookies crossing here belong to the Kasm UI session only
 * and are never logged.
 */
export async function handleDisplayRequest(req: Request, res: Response) {
  try {
    const token = typeof req.query.token === 'string' ? req.query.token : ''
    const target = await resolveDisplayTarget(String(req.params.id), token)
    const upstreamPath = buildUpstreamPath(req.url || '/')
    const upstream = await undiciRequest(`${buildDisplayBase(target.containerName)}${upstreamPath}`, {
      method: (req.method || 'GET').toUpperCase() as never,
      dispatcher: browserDispatcher,
      headersTimeout: 20_000,
      bodyTimeout: 0,
      headers: toUndiciHeaders(req.headers as Record<string, string | string[] | undefined>),
    }).catch(() => null)
    if (!upstream) {
      return res.status(502).json({ code: 'BROWSER_DISPLAY_UNAVAILABLE', message: 'Browser display is unavailable.' })
    }
    res.status(upstream.statusCode)
    for (const [name, value] of Object.entries(upstream.headers)) {
      if (STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) continue
      if (Array.isArray(value)) {
        for (const v of value) res.append(name, String(v))
      } else if (value !== undefined) {
        res.setHeader(name, String(value))
      }
    }
    // Allow the dashboard to embed the remote UI. The gateway is token-bound
    // to one session, so framing it is the intended use — unlike arbitrary
    // third-party sites, which are never iframed locally.
    res.setHeader('X-Frame-Options', 'SAMEORIGIN')
    pipeUpstreamBody(upstream.body, res)
  } catch (error) {
    if (error instanceof AppError) return sendAppError(res, error)
    return res.status(500).json({ code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' })
  }
}

serverBrowserRouter.use('/sessions/:id/display', (req: Request, res: Response) => void handleDisplayRequest(req, res))

/**
 * Build the raw HTTP upgrade head replayed to the browser container. The
 * `host` header is always rewritten to the upstream authority: forwarding the
 * client's Host would misroute, and sending none makes KasmVNC answer 400
 * (HTTP/1.1 requires one). Authorization handling matches the HTTP gateway
 * (Basic forwarded, Bearer stripped). Pure — unit-tested.
 */
export function buildUpgradeHead(args: {
  method: string
  httpVersion: string
  upstreamPath: string
  headers: Record<string, string | string[] | undefined>
  upstreamHost: string
}): string {
  const lines = [`${args.method} ${args.upstreamPath} HTTP/${args.httpVersion}`]
  for (const [name, value] of buildUpstreamHeaders(args.headers)) {
    lines.push(`${name}: ${value}`)
  }
  lines.push(`host: ${args.upstreamHost}`, '', '')
  return lines.join('\r\n')
}

/**
 * Parse a raw `upgrade` request URL into its display parts. Returns null when
 * the URL is not a server-browser display upgrade or the upstream path is
 * unsafe (host-override attempts). The returned path is gateway-relative —
 * the `/server-browser/sessions/:id/display` mount prefix is stripped, mirroring
 * the HTTP gateway: the KasmVNC client builds its WebSocket URL relative to
 * the page (`<scheme>://<host>:<port>/websockify`), so forwarding the mount
 * prefix would 404. Pure — unit-tested.
 */
export function parseDisplayUpgrade(rawUrl: string): { sessionId: string; upstreamPath: string; token: string } | null {
  let url: URL
  try {
    url = new URL(rawUrl, 'http://localhost')
  } catch {
    return null
  }
  const match = url.pathname.match(/^\/server-browser\/sessions\/([^/]+)\/display(\/.*)?$/)
  if (!match) return null
  const rest = match[2] ?? '/'
  if (!rest.startsWith('/') || rest.startsWith('//')) return null
  return { sessionId: match[1], upstreamPath: `${rest}${url.search}`, token: url.searchParams.get('token') ?? '' }
}
/**
 * WebSocket relay for the KasmVNC display (the remote UI requires WS).
 * Registered on the HTTP server in `server.ts` because Express routers never
 * see `upgrade` events. Flow: parse `/server-browser/sessions/:id/display…`
 * `?token=`, verify the one-time token (same checks as HTTP), open a TLS
 * connection to the session's own container display port, replay the upgrade
 * head, then pipe both directions. Raw tokens, cookies, and URLs are never
 * logged; only the Kasm UI's own Basic credential crosses (Bearer stripped).
 */
export function attachServerBrowserUpgrade(server: Server): void {
  server.on('upgrade', (req, socket) => {
    void (async () => {
      try {
        const parsed = parseDisplayUpgrade(req.url || '/')
        if (!parsed) return socket.destroy()
        const target = await resolveDisplayTarget(parsed.sessionId, parsed.token).catch(() => null)
        if (!target) return socket.destroy()

        const upstream = tls.connect({
          port: env.SERVER_BROWSER_DISPLAY_PORT,
          host: target.containerName,
          // Self-signed container certificate on the isolated browser network.
          rejectUnauthorized: false,
        })
        const fail = () => {
          try {
            upstream.destroy()
          } catch {
            /* noop */
          }
          try {
            socket.destroy()
          } catch {
            /* noop */
          }
        }
        const timeout = setTimeout(fail, 10_000)
        upstream.on('error', () => {
          clearTimeout(timeout)
          fail()
        })
        socket.on('error', () => {
          clearTimeout(timeout)
          fail()
        })
        // NOTE: `secureConnect`, not `connect` — writing the HTTP head before
        // the TLS handshake completes corrupts the session and the handshake
        // always fails.
        upstream.on('secureConnect', () => {
          clearTimeout(timeout)
          upstream.write(
            buildUpgradeHead({
              method: req.method ?? 'GET',
              httpVersion: req.httpVersion,
              upstreamPath: parsed.upstreamPath,
              headers: req.headers as Record<string, string | string[] | undefined>,
              upstreamHost: `${target.containerName}:${env.SERVER_BROWSER_DISPLAY_PORT}`,
            }),
          )
          socket.pipe(upstream).pipe(socket)
        })
      } catch {
        try {
          socket.destroy()
        } catch {
          /* noop */
        }
      }
    })()
  })
}
