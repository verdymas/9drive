import { describe, expect, it } from 'vitest'

import { buildHlsPipelineSelection } from './processor-hls-selection.js'

describe('Remote Import HLS selection boundary', () => {
  it('preserves selected tracks and normalizes an absent container to auto', () => {
    expect(buildHlsPipelineSelection({
      variantId: 'variant-1',
      audioTrackId: 'audio-1',
      outputContainer: null,
    })).toEqual({
      variantId: 'variant-1',
      audioTrackId: 'audio-1',
      outputContainer: 'auto',
    })
  })

  it('passes an explicit output container through unchanged', () => {
    expect(buildHlsPipelineSelection({
      variantId: null,
      audioTrackId: null,
      outputContainer: 'mp4',
    })).toEqual({
      variantId: null,
      audioTrackId: null,
      outputContainer: 'mp4',
    })
  })
})
