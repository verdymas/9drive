import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConnectedStorageAccountsCard } from './ConnectedStorageAccountsCard'
import type { ConnectedAccount } from '@/hooks/useSettings'

const account: ConnectedAccount = {
  id: 'account-1',
  email: 'drive@example.com',
  provider: 'google_drive',
  status: 'connected',
  autoAllocationEnabled: true,
  storageAccount: { totalBytes: '1000', usedBytes: '200', availableBytes: '800', lastSyncedAt: null },
}

describe('ConnectedStorageAccountsCard', () => {
  it('renders the selected account and delegates account actions', () => {
    const onSync = vi.fn()
    render(
      <ConnectedStorageAccountsCard
        accounts={[account]}
        selectedAccount={account}
        onSelectAccount={vi.fn()}
        connecting={false}
        onReconnect={vi.fn()}
        onSync={onSync}
        syncingAccountId={null}
        onSetChannel={vi.fn()}
        onTestTelegram={vi.fn()}
        testingTelegramId={null}
        testResult=""
        onDisconnect={vi.fn()}
      />,
    )

    expect(screen.getByText('drive@example.com')).toBeInTheDocument()
    expect(screen.getByText('Google Drive · Connected')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Sync' }))
    expect(onSync).toHaveBeenCalledWith('account-1')
  })
})
