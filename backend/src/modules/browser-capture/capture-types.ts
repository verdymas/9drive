/** Shared constants + types for the Browser Capture feature. */

/** Pending resources expire after this long (spec: TTL/expiration). */
export const CAPTURED_RESOURCE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Normalized resource types. `unknown` is reserved for API completeness (a
 * resource that looks capturable but has no reliable signal); the extension
 * never submits it — its classifier returns null (not capturable) for
 * ambiguous responses.
 */
export const RESOURCE_TYPES = ['video', 'audio', 'hls', 'dash', 'document', 'archive', 'image', 'unknown'] as const
export type CapturedResourceType = (typeof RESOURCE_TYPES)[number]

/**
 * Filename priority for imports from a captured resource:
 * 1. explicit user filename → 2. captured filename → 3. Content-Disposition
 * (Remote Import probe) → 4. page title → 5. Remote Import fallbacks.
 * Page-title derivation happens in the extension; the backend chain starts at
 * the captured filename.
 */
