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
