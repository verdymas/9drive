import type { ContainerChoice } from './hls/output.js'

export type HlsPipelineSelection = {
  variantId: string | null
  audioTrackId: string | null
  outputContainer: ContainerChoice
}

export function buildHlsPipelineSelection(input: {
  variantId: string | null
  audioTrackId: string | null
  outputContainer: string | null
}): HlsPipelineSelection {
  return {
    variantId: input.variantId,
    audioTrackId: input.audioTrackId,
    outputContainer: (input.outputContainer as ContainerChoice) ?? 'auto',
  }
}
