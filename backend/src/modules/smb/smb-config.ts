import type { ProtocolShare, ProtocolUser } from '../storage/storage-protocol.js'

/**
 * Parsing and generation of smb.conf.
 *
 * The parser is deliberately tolerant: it round-trips the file while only
 * understanding share sections. Any global `[section]` that is not a share
 * (e.g. [global], [printers], [homes]) is treated as a "foreign section" and
 * preserved verbatim, so unrelated Samba configuration is never touched.
 */

const SHARE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,79}$/

/** Characters that break a smb.conf value when written literally. */
function escapeConfigValue(value: string): string {
  return value.replace(/(["\\#;=:])/g, (match) => `\\${match}`)
}

function unescapeConfigValue(value: string): string {
  return value.replace(/\\(["\\#;=:])/g, '$1')
}

/** Split `valid users = a b, "c d", e` into a list of names. */
export function parseNameList(value: string): string[] {
  const names: string[] = []
  const pattern = /"([^"]*)"|([^",\s]+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(value)) !== null) {
    const name = (match[1] ?? match[2]).trim()
    if (name) names.push(name)
  }
  return names
}

export function isValidShareName(name: string): boolean {
  return SHARE_NAME_PATTERN.test(name)
}

/** Normalize a share name for use as a Samba section name. */
export function normalizeShareName(name: string): string {
  return name.trim().replace(/\s+/g, ' ')
}

type RawSection = {
  name: string
  isShare: boolean
  lines: string[]
  startIndex: number
}

/** Parse smb.conf into its raw lines + the position of each [section]. */
export function parseConfigFile(content: string): { lines: string[]; sections: RawSection[] } {
  const lines = content.split('\n')
  const sections: RawSection[] = []
  let current: RawSection | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const match = /^\s*\[([^\]]+)\]\s*$/.exec(line)
    if (match) {
      current = { name: match[1], isShare: true, lines: [], startIndex: i }
      sections.push(current)
    } else if (current) {
      current.lines.push(line)
    }
  }

  // A section is treated as a share only when it contains a `path = ...`
  // directive; [global], [printers], [homes] and other system sections are
  // preserved as foreign sections.
  for (const section of sections) {
    if (section.name === 'global') {
      section.isShare = false
      continue
    }
    section.isShare = section.lines.some((line) => /^\s*path\s*=/.test(line))
  }

  return { lines, sections }
}

/** Build a share block for a managed share (as written to smb.conf). */
export function renderShareBlock(share: Omit<ProtocolShare, 'id'>): string {
  const lines: string[] = [`[${share.name}]`]
  lines.push(`    path = ${escapeConfigValue(share.path)}`)
  lines.push(`    comment = ${escapeConfigValue(share.description || share.name)}`)
  lines.push(`    browseable = ${share.browsable ? 'yes' : 'no'}`)
  lines.push(`    read only = ${share.readOnly ? 'yes' : 'no'}`)
  lines.push(`    writeable = ${share.readOnly ? 'no' : 'yes'}`)
  lines.push(`    guest ok = ${share.guestAccess ? 'yes' : 'no'}`)
  if (share.hideFiles) lines.push(`    hide files = ${escapeConfigValue(share.hideFiles)}`)
  if (share.validUsers.length > 0) lines.push(`    valid users = ${share.validUsers.map(escapeConfigValue).join(', ')}`)
  if (share.validGroups.length > 0) lines.push(`    valid groups = ${share.validGroups.map((group) => `@${escapeConfigValue(group)}`).join(', ')}`)
  return lines.join('\n')
}

export type ManagedConfig = {
  /** Existing, non-share configuration blocks (e.g. [global]) preserved verbatim. */
  foreignSections: string
  shares: Array<Omit<ProtocolShare, 'id'>>
}

/**
 * Read the existing smb.conf and extract (a) the foreign sections that must be
 * preserved and (b) the shares currently declared (managed or hand-written).
 */
export function parseExistingConfig(content: string): ManagedConfig {
  const { lines, sections } = parseConfigFile(content)
  const foreignBlocks: string[] = []
  const shares: Array<Omit<ProtocolShare, 'id'>> = []

  let pointer = 0
  for (const section of sections) {
    const before = lines.slice(pointer, section.startIndex).filter((line) => line.trim() !== '')
    if (before.length > 0) foreignBlocks.push(before.join('\n'))
    if (section.isShare) {
      shares.push(parseShareBlock(section.name, section.lines))
    } else {
      const endIndex = sections.find((candidate) => candidate.startIndex > section.startIndex)?.startIndex
      const block = lines.slice(section.startIndex, endIndex)
      if (block.length > 0) foreignBlocks.push(block.join('\n'))
    }
    pointer = section.startIndex + 1 + section.lines.length
  }
  const tail = lines.slice(pointer).filter((line) => line.trim() !== '')
  if (tail.length > 0) foreignBlocks.push(tail.join('\n'))

  return { foreignSections: foreignBlocks.join('\n\n'), shares }
}

/** Parse the body of a single share section into a ProtocolShare. */
export function parseShareBlock(name: string, bodyLines: string[]): Omit<ProtocolShare, 'id'> {
  let path = ''
  let description = ''
  let readOnly = false
  let guestAccess = false
  let browsable = true
  const validUsers: string[] = []
  const validGroups: string[] = []
  let hideFiles = ''

  // smb.conf parameters can be one or two words, e.g. `valid users = ...`,
  // `read only = yes`, `hide files = ...`.
  const directive = /^\s*([a-z]+(?:\s+[a-z]+)?)\s*=\s*(.*)$/i

  for (const line of bodyLines) {
    const match = directive.exec(line)
    if (!match) continue
    const key = match[1].toLowerCase().trim()
    const rawValue = unescapeConfigValue(match[2].trim())

    switch (key) {
      case 'path':
        path = rawValue
        break
      case 'comment':
        description = rawValue
        break
      case 'read only':
      case 'writeable':
      case 'writable':
        readOnly = key === 'read only' ? rawValue === 'yes' : rawValue === 'no'
        break
      case 'guest ok':
      case 'public':
        guestAccess = rawValue === 'yes'
        break
      case 'browseable':
      case 'browsable':
        browsable = rawValue === 'yes'
        break
      case 'valid users':
        validUsers.push(...parseNameList(rawValue))
        break
      case 'valid groups':
        validGroups.push(...parseNameList(rawValue).map((value) => value.replace(/^@/, '')))
        break
      case 'hide files':
        hideFiles = rawValue
        break
    }
  }

  return { name, path, description, readOnly, guestAccess, browsable, validUsers, validGroups, hideFiles }
}

/** Render the full configuration: preserved foreign sections + managed shares. */
export function renderConfig(config: ManagedConfig): string {
  const blocks: string[] = []
  const foreign = config.foreignSections.trim()
  if (foreign) blocks.push(foreign)
  blocks.push(...config.shares.map(renderShareBlock))
  return blocks.join('\n\n') + '\n'
}

/** Filter out shares that carry no `path` — they cannot be managed shares. */
export function isManageableShare(share: Omit<ProtocolShare, 'id'>): boolean {
  return share.path.trim() !== ''
}
