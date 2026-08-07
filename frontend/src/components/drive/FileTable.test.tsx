import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FileTable } from './FileTable'
import type { FileItem } from '@/data/drive-data'

// Mock apiFetch — FileTable only calls it from hover shortcuts we never click.
vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))

const files: FileItem[] = [
  { id: '1', name: 'bravo.txt', date: 'May 5, 2026', size: '2.1 MB', sizeBytes: '2202009', access: 'Only You', kind: 'doc', shared: 1, createdAt: '2026-05-05T00:00:00.000Z' },
  { id: '2', name: 'alpha.txt', date: 'May 1, 2026', size: '1.1 MB', sizeBytes: '1153434', access: 'Only You', kind: 'doc', shared: 1, createdAt: '2026-05-01T00:00:00.000Z' },
  { id: '3', name: 'charlie.txt', date: 'Jun 1, 2026', size: '3.1 MB', sizeBytes: '3250586', access: 'Only You', kind: 'doc', shared: 1, createdAt: '2026-06-01T00:00:00.000Z' },
]

/** Read the row file names in current DOM order (desktop table). */
function rowNames() {
  const table = screen.getByRole('table')
  return within(table).getAllByRole('row').slice(1).map((row) => within(row).getByText(/\.txt$/).textContent)
}

describe('FileTable sorting', () => {
  it('sorts by Name ascending then descending on repeat clicks', async () => {
    const user = userEvent.setup()
    render(<FileTable files={files} />)

    // Initial order is the server order.
    expect(rowNames()).toEqual(['bravo.txt', 'alpha.txt', 'charlie.txt'])

    await user.click(screen.getByRole('button', { name: /sort by name/i }))
    expect(rowNames()).toEqual(['alpha.txt', 'bravo.txt', 'charlie.txt'])

    await user.click(screen.getByRole('button', { name: /sort by name/i }))
    expect(rowNames()).toEqual(['charlie.txt', 'bravo.txt', 'alpha.txt'])
  })

  it('sorts by Last Modified using createdAt when available', async () => {
    const user = userEvent.setup()
    render(<FileTable files={files} />)

    await user.click(screen.getByRole('button', { name: /sort by last modified/i }))
    // Earliest first.
    expect(rowNames()).toEqual(['alpha.txt', 'bravo.txt', 'charlie.txt'])

    await user.click(screen.getByRole('button', { name: /sort by last modified/i }))
    expect(rowNames()).toEqual(['charlie.txt', 'bravo.txt', 'alpha.txt'])
  })

  it('sorts by Size numerically using sizeBytes', async () => {
    const user = userEvent.setup()
    render(<FileTable files={files} />)

    await user.click(screen.getByRole('button', { name: /sort by size/i }))
    expect(rowNames()).toEqual(['alpha.txt', 'bravo.txt', 'charlie.txt'])

    await user.click(screen.getByRole('button', { name: /sort by size/i }))
    expect(rowNames()).toEqual(['charlie.txt', 'bravo.txt', 'alpha.txt'])
  })

  it('renders sortable headers in every mode', () => {
    render(<FileTable files={files} mode="archived" />)
    expect(screen.getByRole('button', { name: /sort by name/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /sort by size/i })).toBeInTheDocument()
  })
})