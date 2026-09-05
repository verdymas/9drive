import { describe, expect, it } from 'vitest'
import {
  buildTelegramRemoteId,
  channelLookupCandidates,
  classifyTelegramError,
  isStorageChannelCandidate,
  maskPhone,
  normalizeChannelId,
  parseTelegramRemoteId,
  resolveConfiguredChannel,
  telegramDisplayName,
} from './telegram.service.js'
import type { TelegramClient } from 'teleproto'

describe('telegram remote ids', () => {
  it('round-trips a remote id', () => {
    const id = buildTelegramRemoteId('-1001234567890', 42)
    expect(parseTelegramRemoteId(id)).toEqual({ channelId: '-1001234567890', messageId: 42 })
  })

  it('rejects malformed references', () => {
    expect(() => parseTelegramRemoteId('https://example.com/file')).toThrowError(/invalid/i)
    expect(() => parseTelegramRemoteId('telegram://channel/nope')).toThrowError(/invalid/i)
  })

  it('normalizes numeric and string channel ids', () => {
    expect(normalizeChannelId(-1001234567890)).toBe('-1001234567890')
    expect(normalizeChannelId('-100123')).toBe('-100123')
    expect(() => normalizeChannelId(undefined)).toThrowError(/did not return a channel id/i)
  })
})

describe('classifyTelegramError', () => {
  it('maps revoked/unauthorized sessions to a 401', () => {
    const err = classifyTelegramError({ name: 'SessionRevokedError', errorCode: 403, message: 'auth key unregistered' })
    expect(err.status).toBe(401)
    expect(err.code).toBe('TELEGRAM_SESSION_INVALID')
  })

  it('maps a real RPC AUTH_KEY_UNREGISTERED (code + message, generic name) to a 401', () => {
    const err = classifyTelegramError({ name: 'RPCError', code: 401, errorMessage: 'AUTH_KEY_UNREGISTERED' })
    expect(err.status).toBe(401)
    expect(err.code).toBe('TELEGRAM_SESSION_INVALID')
  })

  it('maps a bare 401 during connect (revoked session) to a 401', () => {
    const err = classifyTelegramError({ name: 'Error', code: 401, message: 'Unauthorized' })
    expect(err.status).toBe(401)
    expect(err.code).toBe('TELEGRAM_SESSION_INVALID')
  })

  it('keeps FloodWait text detection with seconds as a numeric string', () => {
    const err = classifyTelegramError({ name: 'RPCError', code: 420, errorMessage: 'FLOOD_WAIT_65' })
    expect(err.status).toBe(429)
    expect(err.code).toBe('TELEGRAM_FLOOD_WAIT')
  })

  it('maps FloodWait to a retryable 429', () => {
    const err = classifyTelegramError({ name: 'FloodWaitError', seconds: 65, message: 'wait' })
    expect(err.status).toBe(429)
    expect(err.code).toBe('TELEGRAM_FLOOD_WAIT')
  })

  it('maps invalid API credentials', () => {
    const err = classifyTelegramError({ name: 'ApiIdInvalidError', message: 'api id invalid' })
    expect(err.code).toBe('TELEGRAM_CREDENTIALS_INVALID')
  })

  it('maps missing documents to 404', () => {
    const err = classifyTelegramError({ name: 'Error', errorCode: 400, message: 'MEDIA_EMPTY' })
    expect(err.code).toBe('TELEGRAM_FILE_NOT_FOUND')
    expect(err.status).toBe(404)
  })

  it('falls back to a generic code for unknown errors', () => {
    const err = classifyTelegramError(new Error('something else'))
    expect(err.status).toBe(502)
  })
})

describe('storage channel candidate checks', () => {
  // Teleproto returns raw TL entities: Api.Channel carries the channel flags
  // and a POSITIVE raw id; users/basic groups carry neither flag.
  const broadcastChannel = { id: 4458806678, title: '9Drive Storage', broadcast: true, megagroup: false }
  const megagroup = { id: -100123, title: 'A Group', broadcast: false, megagroup: true }
  const basicGroupChat = { id: 12345, title: 'Old Chat' }
  const userEntity = { id: 12346, firstName: 'Someone', lastName: '' }
  const savedMessagesSelf = { id: 12346, title: 'Saved Messages' }

  it('accepts a broadcast channel with a raw positive id', () => {
    expect(isStorageChannelCandidate(broadcastChannel)).toBe(true)
  })

  it('rejects megagroups, basic groups, users and Saved Messages', () => {
    expect(isStorageChannelCandidate(megagroup)).toBe(false)
    expect(isStorageChannelCandidate(basicGroupChat)).toBe(false)
    expect(isStorageChannelCandidate(userEntity)).toBe(false)
    expect(isStorageChannelCandidate(savedMessagesSelf)).toBe(false)
  })

  it('rejects entities without an id or without a title', () => {
    expect(isStorageChannelCandidate({ ...broadcastChannel, id: undefined })).toBe(false)
    expect(isStorageChannelCandidate({ ...broadcastChannel, title: '' })).toBe(false)
    expect(isStorageChannelCandidate(null)).toBe(false)
  })
})

describe('channel lookup candidates', () => {
  it('marks a bare positive (raw) channel id with the -100 peer prefix', () => {
    expect(channelLookupCandidates('4458806678')).toEqual(['-1004458806678', '4458806678'])
  })

  it('passes an already-marked id through unchanged', () => {
    expect(channelLookupCandidates('-1001234567890')).toEqual(['-1001234567890'])
  })

  it('fails hard when no channel is configured', () => {
    expect(() => channelLookupCandidates(null)).toThrowError(/no telegram storage channel is configured/i)
    expect(() => channelLookupCandidates('')).toThrowError(/no telegram storage channel is configured/i)
  })
})

describe('resolveConfiguredChannel (marked-peer fallback)', () => {
  function fakeClient(resolve: (candidate: string) => unknown) {
    return {
      async getInputEntity(candidate: string) {
        const entity = resolve(candidate)
        if (!entity) throw new Error(`Could not find the input entity for ${JSON.stringify({ candidate, className: 'PeerUser' })}.`)
        return {}
      },
      async getEntity(candidate: string) {
        const entity = resolve(candidate)
        if (!entity) throw new Error(`Could not find the input entity for ${JSON.stringify({ candidate, className: 'PeerUser' })}.`)
        return entity
      },
    } as unknown as TelegramClient
  }

  const channelEntity = { id: 4458806678, title: '9Drive Storage', broadcast: true, megagroup: false }

  it('resolves a legacy bare (raw) channel id through the -100 marked candidate', async () => {
    // Only the marked form resolves (fresh session, empty entity cache) — the
    // exact failure mode behind "Could not find the input entity for PeerUser".
    const client = fakeClient((candidate) => (candidate === '-1004458806678' ? channelEntity : undefined))
    await expect(resolveConfiguredChannel(client, '4458806678')).resolves.toBe(channelEntity)
  })

  it('resolves an already-marked channel id directly', async () => {
    const client = fakeClient((candidate) => (candidate === '-1001234567890' ? { ...channelEntity, id: 1234567890 } : undefined))
    await expect(resolveConfiguredChannel(client, '-1001234567890')).resolves.toMatchObject({ id: 1234567890 })
  })

  it('propagates a definitive channel error instead of trying the bare form', async () => {
    const client = fakeClient(() => {
      throw { name: 'RPCError', code: 400, errorMessage: 'CHANNEL_PRIVATE' }
    })
    await expect(resolveConfiguredChannel(client, '4458806678')).rejects.toMatchObject({ code: 'TELEGRAM_CHANNEL_UNAVAILABLE', status: 410 })
  })
})

describe('maskPhone', () => {
  it('keeps the country prefix and the last four digits, hides everything between', () => {
    expect(maskPhone('+6281234567890')).toBe('+62•••••••7890')
  })
  it('masks a short number aggressively (only the last 2 may remain)', () => {
    const out = maskPhone('12345')
    expect(out.endsWith('45')).toBe(true)
    expect(out).not.toContain('123')
  })
  it('output length never reveals more digits than the input has', () => {
    // maskPhone never returns more real digits than the input carried; 2 digits
    // in means 2 digits out, the rest are bullets.
    const out = maskPhone('+62')
    expect(out).toBe('•••62')
    expect(out).not.toContain('+')
  })
  it('tolerates formatting (spaces, dashes, parens)', () => {
    const out = maskPhone('+62 (812) 345-67890')
    // Last 4 of the digit-only form are 7890; the prefix is +62.
    expect(out.endsWith('7890')).toBe(true)
    expect(out.startsWith('+62')).toBe(true)
  })
})

describe('telegramDisplayName', () => {
  it('uses masked phone when the channel has no title yet', () => {
    expect(telegramDisplayName('+6281234567890', null)).toBe('+62•••••••7890')
  })
  it('combines masked phone and channel title with the middot separator', () => {
    expect(telegramDisplayName('+6281234567890', 'Movies')).toBe('+62•••••••7890 · Movies')
  })
  it('falls back to the generic placeholder when no phone is stored', () => {
    expect(telegramDisplayName(null, 'Movies')).toBe('Telegram Drive · Movies')
    expect(telegramDisplayName(null, null)).toBe('Telegram Drive')
  })
})
