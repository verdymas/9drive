import { Link2, RefreshCw, Send, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { accountStatusLabel, isReauthRequired, reauthMessage } from '@/lib/connectedAccounts'
import { formatBytes } from '@/lib/api'
import { telegramChannelStatusLabel } from '@/lib/telegram'
import { providerLabel, type ConnectedAccount } from '@/hooks/useSettings'

function storageLimitLabel(account: ConnectedAccount) {
  if ((account.provider === 's3' || account.provider === 'telegram') && account.storageAccount?.totalBytes === null) return 'Unlimited'
  return formatBytes(account.storageAccount?.totalBytes)
}

function availableLabel(account: ConnectedAccount) {
  if ((account.provider === 's3' || account.provider === 'telegram') && account.storageAccount?.availableBytes === null) return '—'
  return formatBytes(account.storageAccount?.availableBytes)
}

type ConnectedStorageAccountsCardProps = {
  accounts: ConnectedAccount[]
  selectedAccount: ConnectedAccount | null
  onSelectAccount: (accountId: string) => void
  connecting: boolean
  onReconnect: (account: ConnectedAccount) => void
  onSync: (accountId: string) => void
  syncingAccountId: string | null
  onSetChannel: (account: ConnectedAccount) => void
  onTestTelegram: (account: ConnectedAccount) => void
  testingTelegramId: string | null
  testResult: string
  onDisconnect: (account: ConnectedAccount) => void
}

export function ConnectedStorageAccountsCard({
  accounts,
  selectedAccount,
  onSelectAccount,
  connecting,
  onReconnect,
  onSync,
  syncingAccountId,
  onSetChannel,
  onTestTelegram,
  testingTelegramId,
  testResult,
  onDisconnect,
}: ConnectedStorageAccountsCardProps) {
  return (
    <Card className="p-4">
      <h2 className="text-[16px] font-bold">Connected Storage Accounts</h2>
      <div className="mt-3.5 grid gap-3">
        {accounts.length === 0 ? <p className="text-xs text-slate-500">No connected storage account yet.</p> : <>
          <label className="grid gap-1.5 text-xs font-semibold text-slate-500">Choose Account<select className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm focus:outline-none" value={selectedAccount?.id ?? ''} onChange={(event) => onSelectAccount(event.target.value)}>{accounts.map((account) => <option key={account.id} value={account.id}>{providerLabel(account.provider)} - {account.displayName || account.email} ({accountStatusLabel(account.status)})</option>)}</select></label>
          {selectedAccount ? <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-900/60 border border-slate-100 dark:border-slate-800">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0"><p className="break-all font-semibold text-sm">{selectedAccount.displayName || selectedAccount.email}</p><p className="text-xs text-slate-500 mt-0.5">{providerLabel(selectedAccount.provider)} · {accountStatusLabel(selectedAccount.status)}</p></div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                {isReauthRequired(selectedAccount) ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700" title={reauthMessage(selectedAccount)}>Reconnection Required</span> : null}
                {!selectedAccount.autoAllocationEnabled ? <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-500" title="Excluded from Automatic storage allocation. Existing files and Sync are not affected.">Allocation Disabled</span> : null}
                <div className="grid grid-cols-2 gap-2 sm:flex">
                  {isReauthRequired(selectedAccount) || selectedAccount.status === 'disconnected' ? <Button className="w-full" size="sm" onClick={() => onReconnect(selectedAccount)} disabled={connecting}><Link2 className="h-4 w-4" />{connecting ? 'Opening...' : selectedAccount.provider === 'telegram' ? 'Reconnect Telegram' : 'Reconnect Google Drive'}</Button> : null}
                  <Button className="w-full" size="sm" variant="outline" onClick={() => onSync(selectedAccount.id)} disabled={syncingAccountId === selectedAccount.id}><RefreshCw className={syncingAccountId === selectedAccount.id ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />{syncingAccountId === selectedAccount.id ? 'Syncing...' : 'Sync'}</Button>
                  {selectedAccount.provider === 'telegram' ? <Button className="w-full" size="sm" variant="outline" onClick={() => onSetChannel(selectedAccount)}><Send className="h-4 w-4" />{selectedAccount.telegram?.channelId ? 'Change Channel' : 'Set Up Channel'}</Button> : null}
                  {selectedAccount.provider === 'telegram' ? <Button className="w-full" size="sm" variant="outline" onClick={() => onTestTelegram(selectedAccount)} disabled={testingTelegramId === selectedAccount.id}><RefreshCw className={testingTelegramId === selectedAccount.id ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />{testingTelegramId === selectedAccount.id ? 'Testing...' : 'Test Connection'}</Button> : null}
                  <Button className="w-full" size="sm" variant="danger" onClick={() => onDisconnect(selectedAccount)}><Trash2 className="h-4 w-4" />Disconnect</Button>
                </div>
              </div>
            </div>
            {selectedAccount.provider === 'telegram' ? <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              {selectedAccount.telegram?.channelId ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-semibold text-emerald-700" title={`Channel: ${selectedAccount.telegram.channelTitle ?? selectedAccount.telegram.channelId}`}>Channel: {selectedAccount.telegram.channelTitle ?? selectedAccount.telegram.channelId}</span> : <span className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-700">Storage Channel Required — set one up to enable uploads.</span>}
              <span className={selectedAccount.telegram?.status === 'connected' || selectedAccount.telegram?.status === 'ready' ? 'rounded-full bg-emerald-100 px-2 py-0.5 font-semibold text-emerald-700' : 'rounded-full bg-slate-100 px-2 py-0.5 font-semibold text-slate-500'}>{selectedAccount.telegram ? telegramChannelStatusLabel(selectedAccount.telegram.status) : '—'}</span>
            </div> : null}
            {testResult ? <p className="mt-2 rounded-xl bg-blue-50 p-2.5 text-xs text-blue-700">{testResult}</p> : null}
            {isReauthRequired(selectedAccount) ? <p className="mt-2 rounded-xl bg-amber-50 p-2.5 text-xs text-amber-800">{reauthMessage(selectedAccount)}</p> : null}
            <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
              <div className="rounded-xl bg-white dark:bg-slate-950 p-2 border border-slate-100 dark:border-slate-800"><p className="font-extrabold text-slate-950">{formatBytes(selectedAccount.storageAccount?.usedBytes)}</p><p className="mt-0.5 text-[10px] text-slate-500">Used</p></div>
              {selectedAccount.provider === 'telegram' ? <div className="rounded-xl bg-white dark:bg-slate-950 p-2 border border-slate-100 dark:border-slate-800"><p className="font-extrabold text-slate-950">{selectedAccount.storageAccount?.fileCount ?? '—'}</p><p className="mt-0.5 text-[10px] text-slate-500">Files</p></div> : <div className="rounded-xl bg-white dark:bg-slate-950 p-2 border border-slate-100 dark:border-slate-800"><p className="font-extrabold text-slate-950">{storageLimitLabel(selectedAccount)}</p><p className="mt-0.5 text-[10px] text-slate-500">Total</p></div>}
              <div className="rounded-xl bg-white dark:bg-slate-950 p-2 border border-slate-100 dark:border-slate-800"><p className="font-extrabold text-slate-950">{availableLabel(selectedAccount)}</p><p className="mt-0.5 text-[10px] text-slate-500">Free</p></div>
            </div>
          </div> : null}
        </>}
      </div>
    </Card>
  )
}
