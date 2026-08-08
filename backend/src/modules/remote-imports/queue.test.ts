import { describe, expect, it } from 'vitest'
import { remoteImportJobId } from './queue.js'

/**
 * The Remote Import job id scheme (§ queue.ts / remoteImportJobId).
 *
 * BullMQ v5 rejects custom job ids containing a colon ("Custom Id cannot
 * contain :" — only the legacy repeatable-jobs `a:b:c` form is allowed) and
 * ids that are bare integers ("Custom Id cannot be integers"). The id used to
 * be `${uuid}:${attempt}`, which threw on EVERY enqueue — every Remote Import
 * failed with REMOTE_IMPORT_QUEUE_ENQUEUE_FAILED. These tests pin the format
 * so a regressive separator can never return.
 */
describe('remoteImportJobId', () => {
  it('uses a `~` separator — never a colon (BullMQ rejects `:` in custom ids)', () => {
    const id = remoteImportJobId('645917d6-0592-46d1-ae21-3d039e9f5638', 1)
    expect(id).toBe('645917d6-0592-46d1-ae21-3d039e9f5638~1')
    expect(id).not.toContain(':')
  })

  it('is never a bare integer (BullMQ rejects integer custom ids)', () => {
    const id = remoteImportJobId('abc', 1)
    expect(`${parseInt(id, 10)}`).not.toBe(id)
  })

  it('produces a distinct id per attempt (retries enqueue fresh jobs)', () => {
    const importId = '645917d6-0592-46d1-ae21-3d039e9f5638'
    expect(remoteImportJobId(importId, 1)).not.toBe(remoteImportJobId(importId, 2))
  })
})