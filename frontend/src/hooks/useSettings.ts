import { useEffect, useState, type FormEvent } from 'react'
import { apiFetch } from '@/lib/api'
import { testTelegramConnection, type TelegramChannelInfo } from '@/lib/telegram'

export type ConnectedAccount = {
  id: string
  provider: string
  email: string
  displayName?: string | null
  status: string
  autoAllocationEnabled: boolean
  storageAccount?: {
    totalBytes: string | null
    usedBytes: string
    availableBytes: string | null
    fileCount?: number | null
    lastSyncedAt: string | null
  } | null
  telegram?: TelegramChannelInfo | null
}

export type S3Form = {
  name: string
  bucket: string
  region: string
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle: boolean
  quotaBytes: string
}

export const initialS3Form: S3Form = {
  name: '',
  bucket: '',
  region: 'us-east-1',
  endpoint: '',
  accessKeyId: '',
  secretAccessKey: '',
  forcePathStyle: false,
  quotaBytes: '',
}

type TelegramForm = { phone: string; apiId: string; apiHash: string; code: string; password: string }

export function providerLabel(provider: string) {
  if (provider === 's3') return 'S3 Storage'
  if (provider === 'telegram') return 'Telegram Drive'
  return 'Google Drive'
}

function storageChanged() {
  window.dispatchEvent(new Event('9drive:storage-changed'))
}

type UseSettingsOptions = { onMessage: (message: string) => void }

export function useSettings({ onMessage }: UseSettingsOptions) {
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([])
  const [connecting, setConnecting] = useState(false)
  const [s3Open, setS3Open] = useState(false)
  const [connectingS3, setConnectingS3] = useState(false)
  const [s3Form, setS3Form] = useState<S3Form>(initialS3Form)
  const [telegramOpen, setTelegramOpen] = useState(false)
  const [telegramStep, setTelegramStep] = useState<'credentials' | 'code' | 'password'>('credentials')
  const [telegramAuthId, setTelegramAuthId] = useState('')
  const [telegramAccountId, setTelegramAccountId] = useState<string | null>(null)
  const [telegramForm, setTelegramForm] = useState<TelegramForm>({ phone: '', apiId: '', apiHash: '', code: '', password: '' })
  const [connectingTelegram, setConnectingTelegram] = useState(false)
  const [channelAccount, setChannelAccount] = useState<ConnectedAccount | null>(null)
  const [testingTelegramId, setTestingTelegramId] = useState<string | null>(null)
  const [testResult, setTestResult] = useState('')
  const [syncingAccountId, setSyncingAccountId] = useState<string | null>(null)
  const [disconnectingAccountId, setDisconnectingAccountId] = useState<string | null>(null)
  const [accountToDisconnect, setAccountToDisconnect] = useState<ConnectedAccount | null>(null)
  const [selectedAccountId, setSelectedAccountId] = useState('')

  async function load() {
    // Disconnected Telegram accounts retain their channel claim and remain
    // visible here so users can reconnect or recover an abandoned channel.
    const data = await apiFetch<{ accounts: ConnectedAccount[] }>('/connected-accounts?includeDisconnected=1')
    setAccounts(data.accounts)
  }

  useEffect(() => {
    load().catch((error) => onMessage(error instanceof Error ? error.message : 'Failed to load settings'))
  }, [])

  useEffect(() => {
    if (accounts.length === 0) {
      setSelectedAccountId('')
      return
    }
    if (!accounts.some((account) => account.id === selectedAccountId)) setSelectedAccountId(accounts[0].id)
  }, [accounts, selectedAccountId])

  useEffect(() => {
    function onMessageEvent(event: MessageEvent) {
      if (event.origin !== window.location.origin || event.data?.type !== 'GOOGLE_CONNECTED') return
      onMessage(event.data.status === 'success' ? 'Google Drive connected.' : 'Google Drive connection failed.')
      load().then(storageChanged).catch(() => undefined)
    }
    window.addEventListener('message', onMessageEvent)
    return () => window.removeEventListener('message', onMessageEvent)
  }, [])

  async function connectDrive() {
    setConnecting(true)
    onMessage('')
    const popup = window.open('', 'google-drive-connect', 'width=540,height=720')
    if (popup) popup.document.write('<html><head><title>Connecting...</title><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f8fafc;color:#64748b;}</style></head><body><div style="text-align:center;"><h2>Connecting to Google...</h2><p>Please wait while we redirect you.</p></div></body></html>')
    try {
      const data = await apiFetch<{ url: string }>('/connected-accounts/google/connect-url')
      if (popup) popup.location.href = data.url
      else window.location.href = data.url
    } catch (error) {
      if (popup) popup.close()
      onMessage(error instanceof Error ? error.message : 'Failed to start Google Drive connection')
    } finally {
      setConnecting(false)
    }
  }

  async function reconnectDrive(accountId: string) {
    setConnecting(true)
    onMessage('')
    const popup = window.open('', 'google-drive-connect', 'width=540,height=720')
    if (popup) popup.document.write('<html><head><title>Connecting...</title><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f8fafc;color:#64748b;}</style></head><body><div style="text-align:center;"><h2>Reconnecting to Google...</h2><p>Please wait while we redirect you.</p></div></body></html>')
    try {
      const data = await apiFetch<{ url: string }>(`/connected-accounts/${accountId}/reconnect`, { method: 'POST' })
      if (popup) popup.location.href = data.url
      else window.location.href = data.url
    } catch (error) {
      if (popup) popup.close()
      onMessage(error instanceof Error ? error.message : 'Failed to start Google Drive reconnect')
    } finally {
      setConnecting(false)
    }
  }

  async function sync(accountId: string) {
    setSyncingAccountId(accountId)
    try {
      await apiFetch(`/connected-accounts/${accountId}/sync-quota`, { method: 'POST' })
      await load()
      storageChanged()
    } finally {
      setSyncingAccountId(null)
    }
  }

  async function disconnect() {
    if (!accountToDisconnect) return
    setDisconnectingAccountId(accountToDisconnect.id)
    onMessage('')
    try {
      await apiFetch(`/connected-accounts/${accountToDisconnect.id}`, { method: 'DELETE' })
      setAccountToDisconnect(null)
      onMessage('Storage account disconnected.')
      await load()
      storageChanged()
    } catch (error) {
      onMessage(error instanceof Error ? error.message : 'Failed to disconnect storage account')
    } finally {
      setDisconnectingAccountId(null)
    }
  }

  async function purgeAccount() {
    if (!accountToDisconnect) return
    if (!window.confirm('Delete this storage account from 9Drive forever? File records, sync history and encrypted credentials will be removed. The remote storage (e.g. your Telegram channel and its documents) is not touched.')) return
    setDisconnectingAccountId(accountToDisconnect.id)
    onMessage('')
    try {
      await apiFetch(`/connected-accounts/${accountToDisconnect.id}?purge=1`, { method: 'DELETE' })
      setAccountToDisconnect(null)
      onMessage('Storage account deleted.')
      await load()
      storageChanged()
    } catch (error) {
      onMessage(error instanceof Error ? error.message : 'Failed to delete storage account')
    } finally {
      setDisconnectingAccountId(null)
    }
  }

  async function connectS3(event: FormEvent) {
    event.preventDefault()
    setConnectingS3(true)
    onMessage('')
    try {
      await apiFetch('/connected-accounts/s3', { method: 'POST', body: JSON.stringify({ ...s3Form, endpoint: s3Form.endpoint || undefined, quotaBytes: s3Form.quotaBytes || null }) })
      setS3Open(false)
      setS3Form(initialS3Form)
      onMessage('S3 storage connected.')
      await load()
      storageChanged()
    } catch (error) {
      onMessage(error instanceof Error ? error.message : 'Failed to connect S3 storage')
    } finally {
      setConnectingS3(false)
    }
  }

  function openTelegramConnect(accountId?: string) {
    setTelegramAccountId(accountId ?? null)
    setTelegramStep('credentials')
    setTelegramAuthId('')
    setTelegramForm({ phone: '', apiId: '', apiHash: '', code: '', password: '' })
    onMessage('')
    setTelegramOpen(true)
  }

  async function startTelegramAuth(event: FormEvent) {
    event.preventDefault()
    setConnectingTelegram(true)
    onMessage('')
    try {
      const data = await apiFetch<{ authId: string; nextStep: 'code' }>('/telegram/auth/start', {
        method: 'POST',
        body: JSON.stringify({ ...(telegramAccountId ? { accountId: telegramAccountId } : {}), phone: telegramForm.phone, apiId: telegramAccountId ? undefined : telegramForm.apiId, apiHash: telegramAccountId ? undefined : telegramForm.apiHash }),
      })
      setTelegramAuthId(data.authId)
      setTelegramStep('code')
      setTelegramForm((form) => ({ ...form, code: '', password: '' }))
    } catch (error) {
      onMessage(error instanceof Error ? error.message : 'Failed to request Telegram login code')
    } finally {
      setConnectingTelegram(false)
    }
  }

  async function submitTelegramCode(event: FormEvent) {
    event.preventDefault()
    setConnectingTelegram(true)
    onMessage('')
    try {
      const data = await apiFetch<{ nextStep: 'password' | 'done' }>('/telegram/auth/verify', { method: 'POST', body: JSON.stringify({ authId: telegramAuthId, code: telegramForm.code }) })
      if (data.nextStep === 'password') setTelegramStep('password')
      else {
        setTelegramOpen(false)
        onMessage('Telegram Drive connected.')
        await load()
        storageChanged()
      }
    } catch (error) {
      onMessage(error instanceof Error ? error.message : 'Failed to verify Telegram code')
    } finally {
      setConnectingTelegram(false)
    }
  }

  async function submitTelegramPassword(event: FormEvent) {
    event.preventDefault()
    setConnectingTelegram(true)
    onMessage('')
    try {
      const data = await apiFetch<{ nextStep: 'password' | 'done' }>('/telegram/auth/verify', { method: 'POST', body: JSON.stringify({ authId: telegramAuthId, password: telegramForm.password }) })
      if (data.nextStep === 'password') onMessage('Two-step verification password was not accepted.')
      else {
        setTelegramOpen(false)
        onMessage('Telegram Drive connected.')
        await load()
        storageChanged()
      }
    } catch (error) {
      onMessage(error instanceof Error ? error.message : 'Failed to verify Telegram password')
    } finally {
      setConnectingTelegram(false)
    }
  }

  async function runTelegramTest(account: ConnectedAccount) {
    setTestingTelegramId(account.id)
    setTestResult('')
    try {
      const result = await testTelegramConnection(account.id)
      setTestResult(result.ok ? 'Telegram connection OK.' : (result.details || 'Telegram connection failed.'))
      await load()
    } catch (error) {
      setTestResult(error instanceof Error ? error.message : 'Telegram connection test failed.')
    } finally {
      setTestingTelegramId(null)
    }
  }

  return {
    accounts,
    connecting,
    s3Open,
    setS3Open,
    connectingS3,
    s3Form,
    setS3Form,
    telegramOpen,
    setTelegramOpen,
    telegramStep,
    telegramAccountId,
    telegramForm,
    setTelegramForm,
    connectingTelegram,
    channelAccount,
    setChannelAccount,
    testingTelegramId,
    testResult,
    syncingAccountId,
    disconnectingAccountId,
    accountToDisconnect,
    setAccountToDisconnect,
    selectedAccountId,
    setSelectedAccountId,
    selectedAccount: accounts.find((account) => account.id === selectedAccountId) ?? accounts[0] ?? null,
    load,
    connectDrive,
    reconnectDrive,
    sync,
    disconnect,
    purgeAccount,
    connectS3,
    openTelegramConnect,
    startTelegramAuth,
    submitTelegramCode,
    submitTelegramPassword,
    runTelegramTest,
  }
}
