/**
 * Capture filter settings for 9Drive Browser Capture.
 *
 * Pure functions — testable in Node without a browser. Defaults focus on
 * useful downloadable media; image and "other" (archives + unknown-extension
 * files) resources are opt-in because they are noisy.
 *
 * Filtering MUST happen before a capture is saved (never "capture everything
 * then hide in the popup") — filtered resources consume no storage, no badge
 * count, and no server rows.
 */

/** The 7 user-facing toggles. `archive`/`other` classify.js types both gate on `other`. */
export const CAPTURE_TYPES = ['video', 'hls', 'dash', 'audio', 'documents', 'images', 'other']

export const DEFAULT_FILTERS = Object.freeze({
  video: true,
  hls: true,
  dash: true,
  audio: true,
  documents: true,
  images: false,
  other: false,
})

/**
 * True when a classify.js resource type passes the capture filters.
 * `filters` may be a partial object (e.g. the raw stored value); it is always
 * merged over the defaults so a missing key never accidentally blocks a type.
 */
export function isTypeAllowed(type, filters = {}) {
  const f = { ...DEFAULT_FILTERS, ...(filters ?? {}) }
  switch (type) {
    case 'hls':      return Boolean(f.hls)
    case 'dash':     return Boolean(f.dash)
    case 'video':    return Boolean(f.video)
    case 'audio':    return Boolean(f.audio)
    case 'document': return Boolean(f.documents)
    case 'image':    return Boolean(f.images)
    case 'archive':
    case 'other':    return Boolean(f.other) // Archives live under "Other Files"
    default:         return false
  }
}
