import { createContext, useContext, useState, type ReactNode } from 'react'
import { API_URL, apiFetch } from '@/lib/api'
import { getAccessToken } from '@/lib/auth'

export type UploadProgressStatus = 'uploading' | 'done' | 'error' | 'partial'
export type UploadProgressFile = { name: string; size: number; percent: number; status: UploadProgressStatus; errorMessage?: string; accountName?: string }
export type UploadProgressState = { open: boolean; fileName: string; percent: number; status: UploadProgressStatus; files: UploadProgressFile[] }

type ResumableSession = { sessionId: string; file: File; folderId?: string | null; targetAccountId?: string | null; errorMessage?: string }

type PreflightPlan = {
  fileName: string
  accountId: string | null
  provider: 'google_drive' | null
  reason: 'insufficient' | 'no_accounts' | 's3_only' | 'duplicate' | null
}

type PreflightResult = {
  plans: PreflightPlan[]
  totalBytes: string
  totalRoutedBytes: string
  unroutedBytes: string
}

/** Thrown when the space preflight itself fails (not when a file doesn't fit). */
export type UploadPreflightError = { message: string; unroutedFiles: string[] }

type UploadContextType = {
  uploadProgress: UploadProgressState
  setUploadProgress: React.Dispatch<React.SetStateAction<UploadProgressState>>
  uploadFiles: (files: File[], folderId: string | null, targetAccountId?: string | null, pinnedAccountName?: string) => Promise<void>
  retryFailedUpload: (fileName: string) => Promise<void>
}

const UploadContext = createContext<UploadContextType | undefined>(undefined)

export function UploadProvider({ children }: { children: ReactNode }) {
  const [uploadProgress, setUploadProgress] = useState<UploadProgressState>({
    open: false,
    fileName: '',
    percent: 0,
    status: 'uploading',
    files: []
  })
  const [resumableSessions, setResumableSessions] = useState<Record<string, ResumableSession>>({})

  async function uploadSingleFileResumable(file: File, folderId: string | null, onProgress: (percent: number) => void, sessionIdToRetry?: string, targetAccountId?: string | null, pinnedAccountName?: string, onNotice?: (message: string) => void) {
    const CHUNK_SIZE = 5 * 1024 * 1024 // 5MB chunks (must be multiple of 256KB for Google Drive)
    let sessionId = sessionIdToRetry || ''
    let startOffset = 0

    // Pre-save session parameters so that retry is functional even if the init API call fails
    setResumableSessions(prev => ({
      ...prev,
      [file.name]: { sessionId, file, folderId, targetAccountId, errorMessage: undefined }
    }))

    // 1. Initialize or get status
    if (!sessionId) {
      const initData = await apiFetch<{ sessionId: string; provider: string }>('/uploads/resumable/init', {
        method: 'POST',
        body: JSON.stringify({
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          sizeBytes: String(file.size),
          folderId: folderId || undefined,
          targetAccountId: targetAccountId || undefined
        })
      })
      sessionId = initData.sessionId
      // Update session with the active sessionId
      setResumableSessions(prev => ({
        ...prev,
        [file.name]: { sessionId, file, folderId, targetAccountId, errorMessage: undefined }
      }))

      // The user chose a specific account but the server routed elsewhere
      // (picked account is full or missing): surface it right on the row.
      const routedAccount = (initData as { targetAccountId?: string | null }).targetAccountId
      if (targetAccountId && routedAccount && routedAccount !== targetAccountId && pinnedAccountName && onNotice) {
        const routedName = (initData as { targetAccountEmail?: string | null }).targetAccountEmail
        onNotice(`No space on ${pinnedAccountName} — uploaded to ${routedName ?? 'another account'} instead`)
      }
    } else {
      const statusData = await apiFetch<{ status: string; offset: string }>(`/uploads/resumable/status/${sessionId}`)
      startOffset = Number(statusData.offset)
      if (statusData.status === 'completed') {
        onProgress(100)
        return
      }
    }

    // 2. Upload chunk by chunk
    while (startOffset < file.size) {
      const endOffset = Math.min(startOffset + CHUNK_SIZE, file.size)
      const chunk = file.slice(startOffset, endOffset)

      // We use raw fetch with authorization header for binary stream upload
      const response = await fetch(`${API_URL}/uploads/resumable/chunk/${sessionId}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${getAccessToken()}`,
          'Content-Range': `bytes ${startOffset}-${endOffset - 1}/${file.size}`,
          'Content-Length': String(chunk.size)
        },
        body: chunk
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
          // Non-JSON error body; keep the HTTP status message
        }
        throw new Error(message)
      }

      const resData = await response.json() as { status: string; offset?: string }
      if (resData.status === 'completed') {
        onProgress(100)
        break
      }

      startOffset = Number(resData.offset)
      const percent = Math.min(99, Math.round((startOffset / file.size) * 100))
      onProgress(percent)
    }
  }

  async function uploadFiles(filesToUpload: File[], targetFolderId: string | null, targetAccountId?: string | null, pinnedAccountName?: string) {
    if (filesToUpload.length === 0) return

    // Setup initial status
    setUploadProgress({
      open: true,
      fileName: filesToUpload.length === 1 ? filesToUpload[0].name : `${filesToUpload.length} files`,
      percent: 0,
      status: 'uploading',
      files: filesToUpload.map(f => ({ name: f.name, size: f.size, percent: 0, status: 'uploading' }))
    })

    // Batch preflight: check available space across all connected accounts and
    // plan per-file routing with reservations, so a batch never dies mid-way
    // because one account ran out. A preflight failure is not fatal — uploads
    // continue with automatic per-file routing (best-effort optimization).
    const plannedIds = new Map<string, string>()
    const unrouted: Array<{ name: string; message: string }> = []
    if (filesToUpload.length > 1) {
      try {
        const preflight = await apiFetch<PreflightResult>('/uploads/resumable/preflight', {
          method: 'POST',
          body: JSON.stringify({
            files: filesToUpload.map(f => ({
              fileName: f.name,
              mimeType: f.type || 'application/octet-stream',
              sizeBytes: String(f.size)
            })),
            targetAccountId: targetAccountId || undefined
          })
        })
        for (const plan of preflight.plans) {
          if (plan.accountId) {
            plannedIds.set(plan.fileName, plan.accountId)
          } else if (plan.reason === 'duplicate') {
            unrouted.push({ name: plan.fileName, message: 'Duplicate file name in batch' })
          } else if (plan.reason === 'insufficient' || plan.reason === 'no_accounts' || plan.reason === 's3_only') {
            unrouted.push({ name: plan.fileName, message: 'Not enough space on any connected account' })
          }
        }
      } catch (err) {
        // Optional optimization: never block an upload because preflight failed.
        console.error('Upload preflight failed, continuing without plans:', err)
      }
    }

    // Upload files sequentially
    for (let i = 0; i < filesToUpload.length; i++) {
      const file = filesToUpload[i]
      const unroutedFile = unrouted.find(u => u.name === file.name)
      if (unroutedFile) {
        // Preflight already determined this file cannot be stored — mark it
        // failed up-front instead of starting an upload doomed to fail.
        setUploadProgress((current) => {
          const nextFiles = [...current.files]
          if (nextFiles[i]) {
            nextFiles[i] = { ...nextFiles[i], status: 'error', errorMessage: unroutedFile.message }
          }
          return {
            ...current,
            status: 'partial',
            files: nextFiles
          }
        })
        continue
      }
      try {
        await uploadSingleFileResumable(
          file,
          targetFolderId,
          (filePercent) => {
            setUploadProgress((current) => {
              const nextFiles = [...current.files]
              if (nextFiles[i]) {
                nextFiles[i] = { ...nextFiles[i], percent: filePercent, status: filePercent >= 100 ? 'done' : 'uploading' }
              }
              const overallPercent = Math.round(nextFiles.reduce((sum, f) => sum + f.percent, 0) / nextFiles.length)
              return {
                ...current,
                percent: overallPercent,
                files: nextFiles
              }
            })
          },
          undefined,
          plannedIds.get(file.name) ?? targetAccountId,
          pinnedAccountName,
          (notice) => {
            // Soft-pin reroute notice: the chosen account was full, so the
            // server routed this file elsewhere — keep the row marked done
            // but attach the explanation for the progress panel.
            setUploadProgress((current) => {
              const nextFiles = [...current.files]
              if (nextFiles[i]) {
                nextFiles[i] = { ...nextFiles[i], errorMessage: notice }
              }
              return { ...current, files: nextFiles }
            })
          },
        )
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Upload failed'
        console.error('File upload failed:', file.name, err)
        setUploadProgress((current) => {
          const nextFiles = [...current.files]
          if (nextFiles[i]) {
            nextFiles[i] = { ...nextFiles[i], status: 'error', errorMessage }
          }
          return {
            ...current,
            status: 'partial',
            files: nextFiles
          }
        })
      }
    }

    // Dispatch global events so active pages reload their data
    window.dispatchEvent(new Event('9drive:storage-changed'))
    window.dispatchEvent(new Event('9drive:upload-completed'))
  }

  async function retryFailedUpload(fileName: string) {
    const session = resumableSessions[fileName]
    if (!session) return

    setUploadProgress((current) => {
      const nextFiles = current.files.map(f => f.name === fileName ? { ...f, status: 'uploading' as const, errorMessage: undefined } : f)
      return {
        ...current,
        status: 'uploading',
        files: nextFiles
      }
    })

    try {
      const fileIndex = uploadProgress.files.findIndex(f => f.name === fileName)
      await uploadSingleFileResumable(session.file, session.folderId || null, (filePercent) => {
        setUploadProgress((current) => {
          const nextFiles = [...current.files]
          if (nextFiles[fileIndex]) {
            nextFiles[fileIndex] = { ...nextFiles[fileIndex], percent: filePercent, status: filePercent >= 100 ? 'done' : 'uploading' }
          }
          const overallPercent = Math.round(nextFiles.reduce((sum, f) => sum + f.percent, 0) / nextFiles.length)
          const allDone = nextFiles.every(f => f.status === 'done')
          return {
            ...current,
            percent: overallPercent,
            status: allDone ? 'done' : 'uploading',
            files: nextFiles
          }
        })
      }, session.sessionId, session.targetAccountId)

      window.dispatchEvent(new Event('9drive:storage-changed'))
      window.dispatchEvent(new Event('9drive:upload-completed'))
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Retry upload failed'
      console.error('Retry upload failed:', fileName, err)
      setUploadProgress((current) => {
        const nextFiles = current.files.map(f => f.name === fileName ? { ...f, status: 'error' as const, errorMessage } : f)
        return {
          ...current,
          status: 'partial',
          files: nextFiles
        }
      })
    }
  }

  return (
    <UploadContext.Provider value={{ uploadProgress, setUploadProgress, uploadFiles, retryFailedUpload }}>
      {children}
    </UploadContext.Provider>
  )
}

export function useUpload() {
  const context = useContext(UploadContext)
  if (context === undefined) {
    throw new Error('useUpload must be used within an UploadProvider')
  }
  return context
}
