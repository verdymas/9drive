import { describe, expect, it } from 'vitest'
import {
  isValidShareName,
  parseConfigFile,
  parseExistingConfig,
  parseNameList,
  renderConfig,
  renderShareBlock,
} from './smb-config.js'

describe('smb-config', () => {
  describe('isValidShareName', () => {
    it('accepts plain names', () => {
      expect(isValidShareName('Movies')).toBe(true)
      expect(isValidShareName('media_share 2')).toBe(true)
      expect(isValidShareName('a'.repeat(80))).toBe(true)
    })
    it('rejects invalid names', () => {
      expect(isValidShareName('')).toBe(false)
      expect(isValidShareName('[x]')).toBe(false)
      expect(isValidShareName('a'.repeat(81))).toBe(false)
      expect(isValidShareName('x=y')).toBe(false)
      expect(isValidShareName('[bracket]')).toBe(false)
    })
  })

  describe('parseNameList', () => {
    it('splits space-separated lists', () => {
      expect(parseNameList('alice bob, carol')).toEqual(['alice', 'bob', 'carol'])
    })
    it('supports quoted names with spaces', () => {
      expect(parseNameList('"John Doe" @group1, "eve smith"')).toEqual(['John Doe', '@group1', 'eve smith'])
    })
  })

  describe('renderShareBlock', () => {
    it('renders a read-only share with valid users', () => {
      const block = renderShareBlock({
        name: 'Movies',
        path: '/srv/data/media/movies',
        description: 'Movie library',
        readOnly: true,
        guestAccess: false,
        browsable: true,
        validUsers: ['media'],
        validGroups: [],
        hideFiles: '',
      })
      expect(block).toContain('[Movies]')
      expect(block).toContain('path = /srv/data/media/movies')
      expect(block).toContain('read only = yes')
      expect(block).toContain('writeable = no')
      expect(block).toContain('guest ok = no')
      expect(block).toContain('valid users = media')
    })
    it('renders guest access and groups', () => {
      const block = renderShareBlock({
        name: 'Public',
        path: '/srv/data/public',
        description: '',
        readOnly: false,
        guestAccess: true,
        browsable: true,
        validUsers: [],
        validGroups: ['family', 'friends'],
        hideFiles: '',
      })
      expect(block).toContain('guest ok = yes')
      expect(block).toContain('read only = no')
      expect(block).toContain('valid groups = @family, @friends')
    })
    it('escapes special characters in paths and comments', () => {
      const block = renderShareBlock({
        name: 'Data',
        path: '/srv/data;test',
        description: 'a "quoted" comment',
        readOnly: true,
        guestAccess: false,
        browsable: true,
        validUsers: [],
        validGroups: [],
        hideFiles: '',
      })
      expect(block).toContain('path = /srv/data\\;test')
      expect(block).toContain('comment = a \\"quoted\\" comment')
    })
  })

  describe('parseConfigFile / parseExistingConfig', () => {
    const sample = `# Samba config
[global]
   workgroup = WORKGROUP
   server string = %h server

[Movies]
   path = /srv/data/media/movies
   read only = yes
   valid users = media

[printers]
   comment = All Printers
   browseable = no`

    it('marks [global] and non-path sections as foreign', () => {
      const { sections } = parseConfigFile(sample)
      const global = sections.find((section) => section.name === 'global')
      const movies = sections.find((section) => section.name === 'Movies')
      const printers = sections.find((section) => section.name === 'printers')
      expect(global?.isShare).toBe(false)
      expect(movies?.isShare).toBe(true)
      expect(printers?.isShare).toBe(false)
    })

    it('preserves foreign sections and parses shares', () => {
      const parsed = parseExistingConfig(sample)
      expect(parsed.foreignSections).toContain('[global]')
      expect(parsed.foreignSections).toContain('workgroup = WORKGROUP')
      expect(parsed.foreignSections).toContain('[printers]')
      expect(parsed.shares).toHaveLength(1)
      expect(parsed.shares[0]).toMatchObject({
        name: 'Movies',
        path: '/srv/data/media/movies',
        readOnly: true,
        validUsers: ['media'],
      })
    })

    it('round-trips foreign sections + shares through renderConfig', () => {
      const parsed = parseExistingConfig(sample)
      const rendered = renderConfig(parsed)
      expect(rendered).toContain('workgroup = WORKGROUP')
      expect(rendered).toContain('[Movies]')
      expect(rendered).toContain('valid users = media')
      // The foreign section text is preserved byte-for-byte.
      expect(rendered).toContain('[printers]\n   comment = All Printers\n   browseable = no')
    })

    it('parses writeable = no as readOnly', () => {
      const parsed = parseExistingConfig('[X]\npath = /tmp\nwriteable = no\n')
      expect(parsed.shares[0].readOnly).toBe(true)
    })

    it('handles an empty file', () => {
      const parsed = parseExistingConfig('')
      expect(parsed.foreignSections).toBe('')
      expect(parsed.shares).toEqual([])
    })

    it('treats the [global] section without path as foreign even with a path-like line', () => {
      const parsed = parseExistingConfig('[global]\n   path = /var/lib/samba\n')
      expect(parsed.foreignSections).toContain('[global]')
      expect(parsed.shares).toEqual([])
    })
  })
})
