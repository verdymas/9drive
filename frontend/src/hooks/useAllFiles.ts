import { useCallback, useEffect, useState } from 'react'
import { apiFetch, formatBytes, formatDate } from '@/lib/api'
import type { FileItem, FolderItem } from '@/data/drive-data'

export type BackendFile = {
  id: string
  name: string
  mimeType: string
  sizeBytes: string
  createdAt: string
  folderId?: string | null
  connectedAccount?: { email: string; provider: string }
  folder?: { id: string; name: string } | null
}

export type BackendFolder = {
  id: string
  name: string
  color: string
  iconUrl?: string | null
  parentId?: string | null
  providerFolderId?: string | null
  storageLocationCount?: number
  primaryLocation?: { connectedAccountId: string; provider: string; providerFolderId: string } | null
  updatedAt: string
}

export type ConnectedAccount = {
  id: string
  provider: string
  email: string
  displayName?: string | null
  status: string
  autoAllocationEnabled: boolean
}

function storageProviderLabel(provider: string | undefined) {
  if (provider === 's3') return 'S3 Storage'
  if (provider === 'telegram') return 'Telegram Drive'
  return 'Google Drive'
}

export function mimeToKind(mimeType: string): FileItem['kind'] {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.includes('pdf')) return 'pdf'
  return 'doc'
}

export function mapFile(file: BackendFile): FileItem {
  const accountProvider = storageProviderLabel(file.connectedAccount?.provider)
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    createdAt: file.createdAt,
    accountEmail: file.connectedAccount?.email,
    accountProvider,
    date: formatDate(file.createdAt),
    size: formatBytes(file.sizeBytes),
    access: file.connectedAccount?.email ?? accountProvider,
    kind: mimeToKind(file.mimeType),
    shared: 1,
    folderId: file.folderId,
    folderName: file.folder?.name,
  }
}

export function mapFolder(folder: BackendFolder): FolderItem {
  return {
    id: folder.id,
    name: folder.name,
    color: folder.color,
    iconUrl: folder.iconUrl,
    parentId: folder.parentId,
    providerFolderId: folder.providerFolderId,
    primaryLocation: folder.primaryLocation ?? null,
    storageLocationCount: folder.storageLocationCount ?? 1,
    updated: `Updated ${formatDate(folder.updatedAt)}`,
  }
}

export function buildFilesQuery(activeFolderId: string | null, searchQuery: string, searchParams: URLSearchParams): string {
  const params = new URLSearchParams()
  if (activeFolderId) params.set('folderId', activeFolderId)
  if (searchQuery) params.set('q', searchQuery)

  for (const key of ['kind', 'accountId', 'minSize', 'maxSize', 'startDate', 'endDate']) {
    const value = searchParams.get(key)
    if (value) params.set(key, value)
  }

  const query = params.toString()
  return query ? `/files?${query}` : '/files'
}

type UseAllFilesOptions = {
  activeFolderId: string | null
  searchQuery: string
  searchParams: URLSearchParams
  onMessage: (message: string) => void
}

export function useAllFiles({ activeFolderId, searchQuery, searchParams, onMessage }: UseAllFilesOptions) {
  const [files, setFiles] = useState<FileItem[]>([])
  const [folders, setFolders] = useState<FolderItem[]>([])
  const [allFolders, setAllFolders] = useState<FolderItem[]>([])
  const [connectedAccounts, setConnectedAccounts] = useState<ConnectedAccount[]>([])
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set())
  const [moving, setMoving] = useState(false)

  const loadFiles = useCallback(async () => {
    const data = await apiFetch<{ files: BackendFile[] }>(buildFilesQuery(activeFolderId, searchQuery, searchParams))
    setFiles(data.files.map(mapFile))
  }, [activeFolderId, searchParams, searchQuery])

  const loadFolders = useCallback(async () => {
    const visiblePath = activeFolderId ? `/folders?parentId=${activeFolderId}` : '/folders'
    const [visibleData, allData] = await Promise.all([
      apiFetch<{ folders: BackendFolder[] }>(visiblePath),
      apiFetch<{ folders: BackendFolder[] }>('/folders?all=1'),
    ])
    setFolders(visibleData.folders.map(mapFolder))
    setAllFolders(allData.folders.map(mapFolder))
  }, [activeFolderId])

  const loadAll = useCallback(async () => {
    await Promise.all([loadFiles(), loadFolders()])
  }, [loadFiles, loadFolders])

  useEffect(() => {
    loadAll().catch((error) => onMessage(error instanceof Error ? error.message : 'Failed to load files'))
    setSelectedFileIds(new Set())
  }, [loadAll, onMessage])

  useEffect(() => {
    apiFetch<{ accounts: ConnectedAccount[] }>('/connected-accounts')
      .then((data) => setConnectedAccounts(data.accounts || []))
      .catch((error) => console.error('Failed to load connected accounts:', error))
  }, [])

  const handleDropItem = useCallback(async (fileId: string, targetFolderId: string) => {
    const fileIds = selectedFileIds.has(fileId) ? Array.from(selectedFileIds) : [fileId]
    setMoving(true)
    onMessage('')
    try {
      await apiFetch('/files/batch', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileIds, folderId: targetFolderId }),
      })
      onMessage(`Successfully moved ${fileIds.length} item(s).`)
      loadAll().catch(() => undefined)
      setSelectedFileIds(new Set())
    } catch (error) {
      onMessage(error instanceof Error ? error.message : 'Failed to move items')
    } finally {
      setMoving(false)
    }
  }, [loadAll, onMessage, selectedFileIds])

  const toggleFileSelection = useCallback((file: FileItem) => {
    if (!file.id) return
    setSelectedFileIds((current) => {
      const next = new Set(current)
      if (next.has(file.id!)) next.delete(file.id!)
      else next.add(file.id!)
      return next
    })
  }, [])

  const toggleAllVisibleFiles = useCallback(() => {
    const visibleIds = files.map((file) => file.id).filter(Boolean) as string[]
    const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedFileIds.has(id))
    setSelectedFileIds(allSelected ? new Set() : new Set(visibleIds))
  }, [files, selectedFileIds])

  const clearSelection = useCallback(() => setSelectedFileIds(new Set()), [])

  return {
    files,
    folders,
    allFolders,
    connectedAccounts,
    selectedFileIds,
    moving,
    loadFiles,
    loadFolders,
    loadAll,
    handleDropItem,
    toggleFileSelection,
    toggleAllVisibleFiles,
    clearSelection,
  }
}
