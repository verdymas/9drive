/**
 * Minimal ambient types for `m3u8-parser` (videojs/m3u8-parser). The package
 * ships no type declarations; we only use the `Parser` surface documented below.
 * The parser is used strictly as a *parser* — it never fetches anything — so
 * every URI the manifest references still goes through 9Drive's SSRF-safe
 * fetcher before any socket is opened.
 */
declare module 'm3u8-parser' {
  export type KeyAttributes = {
    METHOD?: string
    URI?: string
    IV?: string
    KEYFORMAT?: string
    KEYFORMATVERSIONS?: string
  }

  export type Byterange = { length: number; offset: number }

  export type Segment = {
    uri: string
    duration: number
    title?: string
    byterange?: Byterange
    key?: KeyAttributes
    map?: { uri?: string; byterange?: Byterange; key?: KeyAttributes }
    discontinuity?: boolean
    dateTimeString?: string
  }

  export type Playlist = {
    uri: string
    attributes?: {
      BANDWIDTH?: number
      'AVERAGE-BANDWIDTH'?: number
      RESOLUTION?: { width: number; height: number }
      'FRAME-RATE'?: number
      CODECS?: string
      AUDIO?: string
      SUBTITLES?: string
    }
  }

  export type MediaRendition = {
    uri?: string
    language?: string
    name?: string
    default?: boolean
    autoselect?: boolean
    forced?: boolean
    characteristics?: string
    instreamId?: string
  }

  export type Manifest = {
    version?: number
    allowCache?: boolean
    mediaSequence?: number
    discontinuitySequence?: number
    playlistType?: 'VOD' | 'EVENT'
    endList?: boolean
    targetDuration?: number
    dateTimeString?: string
    segments: Segment[]
    playlists: Playlist[]
    mediaGroups: {
      AUDIO?: Record<string, Record<string, MediaRendition>>
      VIDEO?: Record<string, Record<string, MediaRendition>>
      SUBTITLES?: Record<string, Record<string, MediaRendition>>
      'CLOSED-CAPTIONS'?: Record<string, Record<string, MediaRendition>>
    }
    discontinuityStarts?: number[]
    contentProtection?: Record<string, unknown>
  }

  export class Parser {
    manifest: Manifest
    push(line: string): void
    end(): void
  }
}