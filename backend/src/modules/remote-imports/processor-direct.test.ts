import { describe, expect, it, vi } from 'vitest'

const decryptText = vi.hoisted(() => vi.fn((value: string) => value))
vi.mock('../../utils/crypto.js', () => ({ decryptText }))

import { readGoogleStreamState } from './processor-direct.js'

describe('Remote Import direct phase state decoding', () => {
  it('accepts only a valid Google resumable state', () => {
    expect(readGoogleStreamState(JSON.stringify({ provider: 'google_drive', sessionUri: 'https://upload.test', nextOffset: '12' }))).toEqual({
      provider: 'google_drive', sessionUri: 'https://upload.test', nextOffset: '12',
    })
    expect(readGoogleStreamState(JSON.stringify({ provider: 'google_drive', sessionUri: 'https://upload.test', nextOffset: 'not-a-number' }))).toBeNull()
  })
})

