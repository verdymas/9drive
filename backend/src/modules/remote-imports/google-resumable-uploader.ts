import { google } from 'googleapis'
import fs from 'node:fs'
import { Readable } from 'node:stream'
import { prisma } from '../../config/prisma.js'
import { decryptText, encryptText } from '../../utils/crypto.js'
import { getAuthedGoogleClient } from '../google/google.service.js'
import { AppError } from '../../utils/app-error.js'

/**
 * Upload a temp part file to Google Drive via a resumable session so large
 * Remote Import files stream to Drive without buffering in memory. The
 * session URI is stored encrypted on the `remote_imports` row
 * (`resume_session_encrypted`) so a worker crash can resume with the same
 * session instead of re-uploading.
 *
 * Credentials note: the resumable session URI contains an upload session id —
 * it is never logged (per "no resumable upload session secrets in logs").
 */

export type GoogleResumableResult = {
  providerFileId: string
  name: string
  mimeType: string
  sizeBytes: bigint
}

export type GoogleStreamUploadState = {
  provider: 'google_drive'
  sessionUri: string
  nextOffset: string
}

function acknowledgedOffset(range: string | null): bigint {
  const match = /^bytes=0-(\d+)$/.exec(range ?? '')
  return match ? BigInt(match[1]) + 1n : 0n
}

/**
 * Upload bounded, externally-read source chunks to a Google resumable
 * session. The caller owns encrypted state persistence; this module receives
 * and returns only the live session URI and acknowledged byte offset.
 */
export async function uploadGoogleResumableStream(
  input: {
    accountId: string
    fileName: string
    mimeType: string
    parentProviderFolderId: string
    totalBytes: bigint
    chunkBytes: bigint
    state: GoogleStreamUploadState | null
    readChunk(offset: bigint, length: bigint): Promise<Buffer>
    saveState(state: GoogleStreamUploadState): Promise<void>
    onProgress?(uploadedBytes: bigint): void
  },
): Promise<GoogleResumableResult> {
  const account = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: input.accountId } })
  const auth = await getAuthedGoogleClient(account)
  const drive = google.drive({ version: 'v3', auth })
  const token = await auth.getAccessToken()
  if (!token.token) throw new AppError('GOOGLE_UPLOAD_FAILED', 'Google Drive access token is unavailable.', 502)

  let state = input.state
  if (!state) {
    const initHeaders = new Headers({
      Authorization: `Bearer ${token.token}`,
      'Content-Type': 'application/json',
      'X-Upload-Content-Type': input.mimeType,
      'X-Upload-Content-Length': String(input.totalBytes),
    })
    const init = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
      method: 'POST',
      headers: initHeaders,
      body: JSON.stringify({ name: input.fileName, parents: [input.parentProviderFolderId] }),
    })
    const sessionUri = init.headers.get('location')
    if (!init.ok || !sessionUri) throw new AppError('GOOGLE_UPLOAD_FAILED', `Google Drive init failed (${init.status}).`, 502)
    state = { provider: 'google_drive', sessionUri, nextOffset: '0' }
    await input.saveState(state)
  } else {
    // Query the server session instead of trusting a stale persisted offset.
    const probe = await fetch(state.sessionUri, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token.token}`, 'Content-Range': `bytes */${input.totalBytes}` },
    })
    if (probe.status === 308) {
      state = { ...state, nextOffset: acknowledgedOffset(probe.headers.get('range')).toString() }
      await input.saveState(state)
    } else if (!probe.ok) {
      throw new AppError('GOOGLE_UPLOAD_FAILED', `Google Drive resume probe failed (${probe.status}).`, 502)
    }
  }

  let offset = BigInt(state.nextOffset)
  while (offset < input.totalBytes) {
    const length = input.totalBytes - offset > input.chunkBytes ? input.chunkBytes : input.totalBytes - offset
    const chunk = await input.readChunk(offset, length)
    if (BigInt(chunk.byteLength) !== length) throw new AppError('STREAM_SOURCE_RANGE_INVALID', 'The remote source returned an incomplete byte range.', 502)
    const end = offset + length - 1n
    const response = await fetch(state.sessionUri, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token.token}`,
        'Content-Type': input.mimeType,
        'Content-Range': `bytes ${offset}-${end}/${input.totalBytes}`,
      },
      body: chunk,
      duplex: 'half',
    } as any)
    if (response.status === 308) {
      offset = acknowledgedOffset(response.headers.get('range'))
      state = { ...state, nextOffset: offset.toString() }
      await input.saveState(state)
      input.onProgress?.(offset)
      continue
    }
    if (!response.ok) throw new AppError('GOOGLE_UPLOAD_FAILED', `Google Drive upload failed (${response.status}).`, 502)
    const meta = (await response.json()) as { id?: string; name?: string; mimeType?: string; size?: string }
    if (!meta.id) throw new AppError('GOOGLE_UPLOAD_FAILED', 'Google Drive returned no file id.', 502)
    try {
      await drive.permissions.create({ fileId: meta.id, requestBody: { role: 'writer', type: 'anyone' } })
    } catch (error) {
      console.error('[remote-import] failed to make Google Drive file public:', error instanceof Error ? error.message : String(error))
    }
    input.onProgress?.(input.totalBytes)
    return { providerFileId: meta.id, name: meta.name ?? input.fileName, mimeType: meta.mimeType ?? input.mimeType, sizeBytes: BigInt(meta.size ?? input.totalBytes) }
  }
  throw new AppError('GOOGLE_UPLOAD_FAILED', 'Google Drive resumable upload ended without a completion response.', 502)
}

/**
 * Create the resumable session and stream the file at `tempPath` into it.
 * Returns the created Drive file metadata. Throws AppError('GOOGLE_UPLOAD_FAILED')
 * on a terminal provider error.
 */
export async function uploadToGoogleResumable(
  importId: string,
  accountId: string,
  userId: string,
  fileName: string,
  mimeType: string,
  tempPath: string,
  parentProviderFolderId: string,
  onProgress?: (uploadedBytes: bigint) => void,
): Promise<GoogleResumableResult> {
  const account = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: accountId } })
  const auth = await getAuthedGoogleClient(account)
  const drive = google.drive({ version: 'v3', auth })
  // The physical parent is resolved by placement BEFORE the upload starts:
  // for a virtual folder it is the folder's storage location on this account
  // (lazily materialized); for a root upload it is the account's 9drive root.
  const targetParentId = parentProviderFolderId

  const fileSize = fs.statSync(tempPath).size
  const token = await auth.getAccessToken()

  // 1. Initialize the resumable session.
  const initHeaders = new Headers()
  initHeaders.set('Authorization', `Bearer ${token.token}`)
  initHeaders.set('Content-Type', 'application/json')
  initHeaders.set('X-Upload-Content-Type', mimeType)
  initHeaders.set('X-Upload-Content-Length', String(fileSize))

  const initRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
    method: 'POST',
    headers: initHeaders,
    body: JSON.stringify({ name: fileName, parents: [targetParentId] }),
  })
  if (!initRes.ok) {
    const errText = await initRes.text().catch(() => '')
    throw new AppError('GOOGLE_UPLOAD_FAILED', `Google Drive init failed (${initRes.status}).`, 502)
  }
  const sessionUri = initRes.headers.get('location')
  if (!sessionUri) throw new AppError('GOOGLE_UPLOAD_FAILED', 'Google Drive did not return an upload session.', 502)

  // Persist the session (encrypted) for potential resume.
  await prisma.remoteImport.update({ where: { id: importId }, data: { resumeSessionEncrypted: encryptText(sessionUri) } }).catch(() => undefined)

  // 2. Stream the file body to the session with Content-Range. Progress is
  // reported from the Web stream's data events (throttled by the caller) so
  // the UI can show a real upload percentage instead of 0% → 100%.
  const stream = fs.createReadStream(tempPath)
  let uploaded = 0n
  const putHeaders = new Headers()
  putHeaders.set('Authorization', `Bearer ${token.token}`)
  putHeaders.set('Content-Type', mimeType)
  putHeaders.set('Content-Range', `bytes 0-${fileSize - 1}/${fileSize}`)

  const webStream = Readable.toWeb(stream) as ReadableStream
  const countingStream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      uploaded += BigInt(chunk.byteLength)
      onProgress?.(uploaded)
      controller.enqueue(chunk)
    },
  })
  const putRes = await fetch(sessionUri, {
    method: 'PUT',
    headers: putHeaders,
    // Node 18+ supports web ReadableStream bodies; convert fs stream.
    body: webStream.pipeThrough(countingStream),
    duplex: 'half',
  } as any)

  if (!putRes.ok) {
    const errText = await putRes.text().catch(() => '')
    throw new AppError('GOOGLE_UPLOAD_FAILED', `Google Drive upload failed (${putRes.status}).`, 502)
  }

  const meta = (await putRes.json()) as { id?: string; name?: string; mimeType?: string; size?: string }
  if (!meta.id) throw new AppError('GOOGLE_UPLOAD_FAILED', 'Google Drive returned no file id.', 502)

  // Make the file public (anyone with link can edit/download) — same as
  // direct uploads.
  try {
    await drive.permissions.create({ fileId: meta.id, requestBody: { role: 'writer', type: 'anyone' } })
  } catch (err: any) {
    console.error('[remote-import] failed to make Google Drive file public:', err.message || err)
  }

  return {
    providerFileId: meta.id,
    name: meta.name ?? fileName,
    mimeType: meta.mimeType ?? mimeType,
    sizeBytes: BigInt(meta.size ?? fileSize),
  }
}
