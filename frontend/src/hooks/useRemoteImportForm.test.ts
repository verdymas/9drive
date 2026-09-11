import { describe, expect, it } from 'vitest'

import { curlParseErrorMessage, probeErrorMessage } from '@/hooks/useRemoteImportForm'

describe('Remote Import form policy helpers', () => {
  it('maps stable probe and cURL codes to safe user-facing messages', () => {
    expect(probeErrorMessage('HLS_MANIFEST_FORBIDDEN')).toContain('access headers')
    expect(curlParseErrorMessage('REMOTE_IMPORT_CURL_MULTIPLE_URLS')).toBe('Paste a cURL command with a single URL.')
    expect(probeErrorMessage('INTERNAL_ERROR')).toBeNull()
  })
})
