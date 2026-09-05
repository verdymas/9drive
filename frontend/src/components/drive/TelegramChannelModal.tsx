import { useEffect, useState } from 'react'
import { CheckCircle2, Loader2, Send, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DummyModal } from '@/components/drive/DummyModal'
import { cn } from '@/lib/utils'
import {
  createTelegramChannel,
  listTelegramChannels,
  selectTelegramChannel,
  testTelegramConnection,
  telegramChannelStatusLabel,
  type TelegramChannelCandidate,
  type TelegramChannelInfo,
  type TelegramConnectionTest,
} from '@/lib/telegram'

type TelegramAccount = {
  id: string
  email: string
  displayName?: string | null
  provider: string
  status: string
  telegram?: TelegramChannelInfo | null
}

export function TelegramChannelModal({
  account,
  onClose,
  onSaved,
}: {
  account: TelegramAccount | null
  onClose: () => void
  onSaved: () => void
}) {
  const [mode, setMode] = useState<'create' | 'select'>('create')
  const [title, setTitle] = useState('')
  const [channels, setChannels] = useState<TelegramChannelCandidate[]>([])
  const [selectedChannelId, setSelectedChannelId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Set when the previous save attempt 409'd on a claimed channel. Surfaces
  // a 'Take over this channel' button so the user can opt in to the transfer.
  const [takenChannelId, setTakenChannelId] = useState<string | null>(null)
  const [test, setTest] = useState<TelegramConnectionTest | null>(null)
  const [testing, setTesting] = useState(false)

  const open = Boolean(account)

  useEffect(() => {
    if (open) {
      setMode('create')
      setTitle('')
      setChannels([])
      setSelectedChannelId('')
      setError('')
      setTest(null)
      setTakenChannelId(null)
    }
  }, [open, account?.id])

  async function runTest() {
    if (!account) return
    setTesting(true)
    setError('')
    try {
      const result = await testTelegramConnection(account.id)
      setTest(result)
      if (result.ok) onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Test connection failed.')
    } finally {
      setTesting(false)
    }
  }

  async function loadChannels() {
    if (!account || channels.length > 0) return
    setBusy(true)
    setError('')
    try {
      const data = await listTelegramChannels(account.id)
      setChannels(data.channels)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to list channels.')
    } finally {
      setBusy(false)
    }
  }

  async function save(transfer = false) {
    if (!account) return
    setBusy(true)
    setError('')
    try {
      if (mode === 'create') {
        await createTelegramChannel(account.id, title || undefined)
      } else {
        if (!selectedChannelId) {
          setError('Select a channel first.')
          setBusy(false)
          return
        }
        await selectTelegramChannel(account.id, selectedChannelId, transfer || undefined)
      }
      onSaved()
      onClose()
    } catch (err) {
      const code = (err as { code?: string } | null)?.code
      if (!transfer && mode === 'select' && code === 'TELEGRAM_CHANNEL_IN_USE') {
        setTakenChannelId(selectedChannelId)
        setError('This storage channel is already used by another 9Drive account. Take over to move its files to this account.')
      } else {
        setError(err instanceof Error ? err.message : 'Failed to configure the storage channel.')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <DummyModal
      open={open}
      title={account?.telegram?.channelId ? 'Change Storage Channel' : 'Set Up Storage Channel'}
      description={
        account?.telegram?.channelId
          ? `Currently storing in "${account.telegram.channelTitle ?? 'your channel'}". Files are stored as documents in a private channel only your account can access.`
          : '9Drive stores your files as documents in a private Telegram channel. Create a new one, or use a private channel you already own.'
      }
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <div className="grid gap-4">
        {account?.telegram?.channelId ? (
          <div className="rounded-xl bg-emerald-50 p-3 text-xs text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300">
            <p className="font-bold">Current channel: {account.telegram.channelTitle ?? account.telegram.channelId}</p>
            <p className="mt-0.5">{telegramChannelStatusLabel(account.telegram.status)}</p>
          </div>
        ) : (
          <div className="rounded-xl bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
            <p className="font-bold">Storage Channel Required</p>
            <p className="mt-0.5">Uploads will be paused for this account until a storage channel is set.</p>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setMode('create')}
            className={cn(
              'rounded-xl border p-3 text-sm font-semibold transition',
              mode === 'create'
                ? 'border-blue-600 bg-blue-50 text-blue-700 dark:bg-blue-500/10'
                : 'border-slate-200 text-slate-500 hover:border-slate-300 dark:border-slate-800',
            )}
          >
            Create new
          </button>
          <button
            type="button"
            onClick={() => {
              setMode('select')
              loadChannels()
            }}
            className={cn(
              'rounded-xl border p-3 text-sm font-semibold transition',
              mode === 'select'
                ? 'border-blue-600 bg-blue-50 text-blue-700 dark:bg-blue-500/10'
                : 'border-slate-200 text-slate-500 hover:border-slate-300 dark:border-slate-800',
            )}
          >
            Use existing
          </button>
        </div>

        {mode === 'create' ? (
          <label className="grid gap-1.5 text-xs font-bold text-slate-500">
            Channel title
            <input
              className="h-11 rounded-xl border border-slate-200 px-3 text-sm focus:border-blue-600 focus:outline-none dark:border-slate-800 dark:bg-slate-950"
              placeholder="9drive storage"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
        ) : busy ? (
          <p className="flex items-center gap-2 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading your channels…
          </p>
        ) : channels.length === 0 ? (
          <p className="text-sm text-slate-500">No private channels found. Create a new one instead.</p>
        ) : (
          <div className="grid max-h-56 gap-2 overflow-y-auto">
            {channels.map((channel) => (
              <button
                key={channel.channelId}
                type="button"
                onClick={() => setSelectedChannelId(channel.channelId)}
                className={cn(
                  'flex items-center gap-2 rounded-xl border p-3 text-left text-sm transition',
                  selectedChannelId === channel.channelId
                    ? 'border-blue-600 bg-blue-50 text-blue-700 dark:bg-blue-500/10'
                    : 'border-slate-200 hover:border-slate-300 dark:border-slate-800',
                )}
              >
                <Send className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{channel.title}</span>
                {selectedChannelId === channel.channelId ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : null}
              </button>
            ))}
          </div>
        )}

        {test ? (
          <div
            className={cn(
              'rounded-xl p-3 text-xs',
              test.ok
                ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300'
                : 'bg-red-50 text-red-800 dark:bg-red-500/10 dark:text-red-300',
            )}
          >
            <p className="flex items-center gap-1.5 font-bold">
              {test.ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
              {test.ok ? 'Connection OK' : 'Connection failed'}
            </p>
            {test.checks ? (
              <ul className="mt-1.5 grid grid-cols-2 gap-1">
                <li>Account: {test.checks.account ? 'OK' : 'FAIL'}</li>
                <li>Channel: {test.checks.channel === null ? '—' : test.checks.channel ? 'OK' : 'FAIL'}</li>
                <li>Read: {test.checks.read === null ? '—' : test.checks.read ? 'OK' : 'FAIL'}</li>
                <li>Write: {test.checks.write === null ? '—' : test.checks.write ? 'OK' : 'FAIL'}</li>
                <li>Delete: {test.checks.delete === null ? '—' : test.checks.delete ? 'OK' : 'FAIL'}</li>
              </ul>
            ) : null}
            {test.details ? <p className="mt-1">{test.details}</p> : null}
          </div>
        ) : null}

        {error ? <p className="rounded-xl bg-red-50 p-3 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</p> : null}

        {takenChannelId ? (
          <Button type="button" variant="danger" onClick={() => save(true)} disabled={busy || testing}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Take over this channel
          </Button>
        ) : null}
        <div className="grid gap-3 sm:flex sm:justify-end">
          <Button variant="outline" type="button" onClick={runTest} disabled={busy || testing}>
            {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            {testing ? 'Testing…' : 'Test Connection'}
          </Button>
          <Button type="button" onClick={() => save(false)} disabled={busy || testing}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {busy ? 'Saving…' : 'Save Channel'}
          </Button>
        </div>
      </div>
    </DummyModal>
  )
}
