import { API_URL, apiFetch } from '@/lib/api'
import { getAccessToken } from '@/lib/auth'

export type DirectS3InitResult =
  | {
      mode: 'direct-s3'
      sessionId: string
      partSizeBytes: number
      targetAccountId?: string | null
      targetAccountEmail?: string | null
    }
  | { mode: 'server' }

export type ResumableInitResult = {
  sessionId: string
  provider: string
  targetAccountId?: string | null
  targetAccountEmail?: string | null
}

export type ResumableStatusResult = { status: string; offset: string }

export async function initResumableUpload(input: {
  fileName: string
  mimeType: string
  sizeBytes: number
  folderId?: string | null
  targetAccountId?: string | null
}) {
  return apiFetch<ResumableInitResult>('/uploads/resumable/init', {
    method: 'POST',
    body: JSON.stringify({
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: String(input.sizeBytes),
      folderId: input.folderId || undefined,
      targetAccountId: input.targetAccountId || undefined,
    }),
  })
}

export async function getResumableUploadStatus(sessionId: string) {
  return apiFetch<ResumableStatusResult>(`/uploads/resumable/status/${sessionId}`)
}

export async function uploadResumableChunk(input: {
  sessionId: string
  chunk: BodyInit
  startOffset: number
  endOffset: number
  totalBytes: number
}) {
  const response = await fetch(`${API_URL}/uploads/resumable/chunk/${input.sessionId}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${getAccessToken()}`,
      'Content-Range': `bytes ${input.startOffset}-${input.endOffset - 1}/${input.totalBytes}`,
      'Content-Length': String(input.endOffset - input.startOffset),
    },
    body: input.chunk,
  })

  if (!response.ok) {
    let message = `Chunk upload failed (HTTP ${response.status})`
    try {
      const errorBody = await response.json() as { message?: string; code?: string }
      if (errorBody?.code === 'GOOGLE_REAUTH_REQUIRED') {
        message = 'Google Drive connection expired. Reconnect this account to continue uploading files.'
      } else if (errorBody?.message) {
        message = errorBody.message
        if (errorBody.code) message = `${errorBody.code}: ${errorBody.message}`
      }
    } catch {
      // Non-JSON error body; retain the HTTP status message.
    }
    throw new Error(message)
  }

  return response.json() as Promise<{ status: string; offset?: string }>
}

export async function initDirectS3Upload(input: {
  fileName: string
  mimeType: string
  sizeBytes: number
  folderId?: string | null
  targetAccountId?: string | null
}) {
  return apiFetch<DirectS3InitResult>('/uploads/direct-s3/init', {
    method: 'POST',
    body: JSON.stringify({
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: String(input.sizeBytes),
      folderId: input.folderId || undefined,
      targetAccountId: input.targetAccountId || undefined,
    }),
  })
}

export async function uploadDirectS3File(
  file: File,
  init: Extract<DirectS3InitResult, { mode: 'direct-s3' }>,
  onProgress: (percent: number) => void,
  notice?: () => void,
) {
  const parts: Array<{ partNumber: number; etag: string; sizeBytes: number }> = []
  try {
    for (let start = 0, partNumber = 1; start < file.size; start += init.partSizeBytes, partNumber += 1) {
      const end = Math.min(start + init.partSizeBytes, file.size)
      const signed = await apiFetch<{ url: string }>(`/uploads/direct-s3/${init.sessionId}/parts/${partNumber}`, { method: 'POST' })
      const response = await fetch(signed.url, { method: 'PUT', body: file.slice(start, end) })
      if (!response.ok) throw new Error(`Direct S3 part upload failed (HTTP ${response.status})`)
      const etag = response.headers.get('etag')
      if (!etag) throw new Error('Direct S3 part upload did not return an ETag.')
      parts.push({ partNumber, etag, sizeBytes: end - start })
      onProgress(Math.min(99, Math.round((end / file.size) * 100)))
    }
    await apiFetch(`/uploads/direct-s3/${init.sessionId}/complete`, {
      method: 'POST',
      body: JSON.stringify({ parts }),
    })
    onProgress(100)
    notice?.()
  } catch (error) {
    await apiFetch(`/uploads/direct-s3/${init.sessionId}/abort`, { method: 'POST' }).catch(() => undefined)
    throw error
  }
}
